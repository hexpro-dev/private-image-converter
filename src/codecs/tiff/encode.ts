/**
 * A TIFF encoder.
 *
 * Deliberately one shape of file rather than a way of writing all of them:
 * little endian, eight bit RGB or RGBA, chunky, in strips of about 64 KB,
 * Deflate compressed with horizontal differencing. That is the combination
 * every reader in the world handles, and writing anything cleverer would trade
 * compatibility for bytes in a format whose whole point is that the print shop
 * on the other end can open it.
 *
 * The one variable is the compressor. Deflate here is `CompressionStream`,
 * which is the only one available with no dependency, so a browser too old to
 * have it gets an uncompressed file instead of an error. An uncompressed TIFF
 * is large and completely valid, which is the right way round for a fallback.
 *
 * Horizontal differencing goes with the deflate and not without it. On its own
 * it makes the file no smaller; in front of a compressor it turns a gradient
 * into a run of near-zero bytes and takes a third off a photograph.
 *
 * Two kinds of metadata travel with the pixels: an ICC profile under tag 34675,
 * and as much of an EXIF payload as can be rebased into this file's own
 * directories. The second is a rebuild rather than a copy, and the note above
 * `planExif` sets out why a copy is not available and what it costs.
 */

import { ByteWriter } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';
import type { EncodeOptions, RasterImage } from '../../types.js';
import { deflate, hasCompressionStream } from '../png/deflate.js';

const ENCODER_ID = 'tiff-pure';

/**
 * Roughly how much a strip should hold.
 *
 * The TIFF 6.0 specification recommends about 8 KB, from an era when that was
 * a sensible amount of memory to ask a reader for. 64 KB compresses better,
 * costs a reader nothing it does not already have, and keeps the strip tables
 * small enough that they are not themselves a noticeable part of the file.
 */
const TARGET_STRIP_BYTES = 65536;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;

export interface TiffEncodeOptions extends EncodeOptions {
	/**
	 * Write a fourth sample carrying alpha.
	 *
	 * Defaults to whatever the raster carries. Setting it to false composites
	 * translucent pixels onto `background` first, because once the channel is
	 * gone nothing downstream can work out what was underneath it.
	 */
	readonly alpha?: boolean;
}

/** One directory entry, with its value already laid out in little endian. */
interface Entry {
	readonly tag: number;
	readonly type: number;
	readonly count: number;
	readonly data: Uint8Array;
}

function shorts(values: readonly number[]): Uint8Array {
	const out = new Uint8Array(values.length * 2);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setUint16(i * 2, value, true));
	return out;
}

function longs(values: readonly number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setUint32(i * 4, value, true));
	return out;
}

/** A rational is a numerator and a denominator, both unsigned longs. */
function rational(numerator: number, denominator: number): Uint8Array {
	return longs([numerator, denominator]);
}

/**
 * Replace each sample with the difference from the one a pixel to its left.
 *
 * Per sample rather than per byte, so red is differenced against red. Wrapped
 * to a byte, which is what makes it reversible: the reader adds with the same
 * wraparound and gets the original back.
 */
function difference(row: Uint8Array, channels: number): void {
	for (let i = row.length - 1; i >= channels; i -= 1) {
		row[i] = ((row[i] as number) - (row[i - channels] as number)) & 0xff;
	}
}

/* ── Directories ──────────────────────────────────────────────────────── */

/**
 * How many bytes `directoryBlock` will write for these entries.
 *
 * Asked before anything is written, because a sub-directory sits after the
 * directory that points at it and the pointer has to hold an offset rather
 * than a promise.
 */
function blockLength(entries: readonly Entry[]): number {
	let length = 2 + entries.length * 12 + 4;
	for (const entry of entries) {
		if (entry.data.length <= 4) continue;
		length += entry.data.length + (entry.data.length & 1);
	}
	return length;
}

/**
 * One image file directory, with the values too long to sit inside it.
 *
 * A single block starting at `at`: the entry count, twelve bytes an entry, the
 * offset of the next directory, then the long values. Each value is padded to
 * an even length rather than the next one being aligned, which comes to the
 * same thing and has one useful consequence: the count and the entries are
 * `6 + 12n` bytes, so the block as a whole is always an even number of bytes
 * long. That is what lets a caller lay one block straight after another and
 * still satisfy TIFF's rule that a directory begins on a word boundary.
 *
 * Entries are sorted here rather than by the caller. Ascending tag order is
 * required by the format and some readers rely on it instead of sorting for
 * themselves, and doing it in the one place means an entry added in the obvious
 * place cannot break it.
 */
function directoryBlock(entries: readonly Entry[], at: number): Uint8Array {
	const sorted = [...entries].sort((a, b) => a.tag - b.tag);
	const out = new ByteWriter(blockLength(sorted));
	// The directory ends on an even offset, so the first value after it starts
	// on one, and every value keeps that true for the one behind it.
	let valueAt = at + 2 + sorted.length * 12 + 4;

	out.u16le(sorted.length);
	for (const entry of sorted) {
		out.u16le(entry.tag);
		out.u16le(entry.type);
		out.u32le(entry.count);
		if (entry.data.length <= 4) {
			// Four bytes or fewer live in the entry itself, written from the
			// front of the field with the rest left at zero.
			for (let i = 0; i < 4; i += 1) out.u8(i < entry.data.length ? (entry.data[i] as number) : 0);
		} else {
			out.u32le(valueAt);
			valueAt += entry.data.length + (entry.data.length & 1);
		}
	}
	// Zero rather than the offset of anything else. A reader that follows the
	// chain finds the end of it here rather than wherever the file stops, and
	// that is as true of a sub-directory, which has no successor at all, as it
	// is of the one page this encoder writes.
	out.u32le(0);

	for (const entry of sorted) {
		if (entry.data.length <= 4) continue;
		out.bytesOf(entry.data);
		if ((entry.data.length & 1) === 1) out.u8(0);
	}
	return out.finish();
}

/* ── EXIF ─────────────────────────────────────────────────────────────── */

/**
 * Carrying EXIF into a TIFF, and what cannot be carried.
 *
 * `options.exif` is not a blob of metadata. It is a whole TIFF in miniature: a
 * two byte order mark, the number 42, and a chain of directories whose every
 * value longer than four bytes is stored at an offset counted from the first of
 * those bytes. TIFF's own home for EXIF is tag 34665, a pointer from IFD0 to a
 * sub-directory of *this* file, whose offsets are counted from this file's
 * header instead. So the payload cannot be spliced in whole. Point 34665 at a
 * copy of it and every string, rational and long inside resolves some hundreds
 * of bytes short of where it was put, which produces a file that opens and
 * reports a stranger's camera as whatever happens to sit at that offset.
 *
 * There are two honest ways out: store the payload self-contained under a
 * private tag, where nothing would ever look for it, or rebuild the directories
 * entry by entry with every offset rewritten. This does the second, and it
 * carries a subset rather than all of it, because two kinds of entry do not
 * survive being moved.
 *
 * MakerNote (37500) is a private block in the manufacturer's own layout, and
 * Canon, Nikon and Sony all put offsets inside it that are counted from the
 * original file's header. Rebasing the block does not rebase those, and nothing
 * outside the camera maker knows where they are, so a moved maker note decodes
 * to rubbish while still looking like a maker note. It is dropped by name.
 *
 * The Interoperability pointer (40965) is another directory, which is the same
 * problem one level further down for the sake of two tags nobody reads.
 *
 * From IFD0 only the descriptive tags below are carried. The rest of an EXIF
 * payload's IFD0 describes the picture that payload came off: its width, its
 * strip offsets, its compression. Copying those into the directory of a
 * different image would describe this file wrongly, and where the tag is one
 * this encoder already writes it would put two entries with the same tag in one
 * directory, which no reader is required to survive.
 *
 * Orientation (274) is excluded deliberately rather than by omission. The
 * pixels reaching an encoder here are upright by the decoder contract, so a tag
 * saying otherwise turns every portrait photograph sideways in anything that
 * honours it. `convert` already rewrites the payload's copy to 1; this does not
 * rely on that, because `encodeTiff` is also called on its own.
 *
 * Nothing here invents a tag that was not in the payload, including the ones
 * Exif 2.3 calls mandatory. A sub-directory with no ExifVersion in it is
 * strictly non-conformant, and writing a version this package did not read
 * would be asserting something about a file it did not produce. Every payload
 * off a camera carries it, so in practice the tag travels because it was there.
 */

/** The descriptive IFD0 tags carried across, and the only ones. */
const CARRIED_TAGS = new Set([
	270, // ImageDescription
	271, // Make
	272, // Model
	305, // Software
	306, // DateTime
	315, // Artist
	33432, // Copyright
]);

/** Sub-directories carried whole: the EXIF IFD and the GPS IFD. */
const CARRIED_DIRECTORIES = [34665, 34853];

/** Dropped from a carried sub-directory. The note above says why for each. */
const DROPPED_TAGS = new Set([
	34665, // an EXIF pointer nested inside one, which no real payload has
	34853, // likewise GPS
	37500, // MakerNote
	40965, // the Interoperability pointer
]);

/** Bytes per value, by field type, for the twelve TIFF 6.0 defines. */
const FIELD_SIZES: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8,
};

/**
 * Bytes per number inside a value, which is not bytes per value.
 *
 * A rational is eight bytes and two numbers, so reversing it as one eight byte
 * quantity would swap its numerator with its denominator and leave a shutter
 * speed of 1/200 reading as 200 seconds.
 */
const NUMBER_SIZES: Record<number, number> = { 3: 2, 4: 4, 5: 4, 8: 2, 9: 4, 10: 4, 11: 4, 12: 8 };

interface ExifSource {
	readonly view: DataView;
	readonly little: boolean;
	readonly length: number;
}

/** One entry of a payload directory, kept as where its value is rather than as the value. */
interface Located {
	readonly tag: number;
	readonly type: number;
	readonly count: number;
	readonly at: number;
	readonly size: number;
}

/**
 * The entries of one directory in the payload.
 *
 * Every entry that cannot be read is skipped rather than refused. These bytes
 * came off a stranger's camera by way of a file this package did not write, and
 * one unreadable tag is not a reason to drop the other thirty or to fail a
 * conversion that has already produced its pixels.
 */
function readPayloadIfd(source: ExifSource, start: number): Located[] {
	if (start < 8 || start + 2 > source.length) return [];
	const count = source.view.getUint16(start, source.little);
	const out: Located[] = [];
	for (let i = 0; i < count; i += 1) {
		const entry = start + 2 + i * 12;
		if (entry + 12 > source.length) break;
		const type = source.view.getUint16(entry + 2, source.little);
		const values = source.view.getUint32(entry + 4, source.little);
		// Zero is either a type this payload invented or a count of nothing, and
		// the comparison against the payload length also catches the multiply
		// running away, since the count is a full unsigned long.
		const size = (FIELD_SIZES[type] ?? 0) * values;
		if (size < 1 || size > source.length) continue;
		const at = size <= 4 ? entry + 8 : source.view.getUint32(entry + 8, source.little);
		if (at < 8 || at + size > source.length) continue;
		out.push({ tag: source.view.getUint16(entry, source.little), type, count: values, at, size });
	}
	return out;
}

function copyValue(source: ExifSource, located: Located): Entry {
	const data = new Uint8Array(located.size);
	for (let i = 0; i < data.length; i += 1) data[i] = source.view.getUint8(located.at + i);
	// A value is stored in its own file's byte order, and this encoder writes
	// little endian. A big endian payload copied byte for byte comes back with
	// every short and every rational reversed, and a reversed number is a
	// plausible number rather than visible damage.
	if (!source.little) {
		const unit = NUMBER_SIZES[located.type] ?? 1;
		for (let i = 0; i + unit <= data.length; i += unit) data.subarray(i, i + unit).reverse();
	}
	return { tag: located.tag, type: located.type, count: located.count, data };
}

interface SubDirectory {
	/** The IFD0 entry whose four bytes are filled in once the offset is known. */
	readonly pointer: Entry;
	readonly entries: readonly Entry[];
}

interface ExifPlan {
	/** Tags to add to this file's own IFD0. */
	readonly ifd0: readonly Entry[];
	readonly subs: readonly SubDirectory[];
}

/** What of an EXIF payload can be moved into this file, or nothing at all. */
function planExif(payload: Uint8Array): ExifPlan | undefined {
	if (payload.length < 8) return undefined;
	const order = ((payload[0] as number) << 8) | (payload[1] as number);
	if (order !== 0x4949 && order !== 0x4d4d) return undefined;
	const little = order === 0x4949;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	if (view.getUint16(2, little) !== 42) return undefined;
	const source: ExifSource = { view, little, length: payload.length };

	// A payload whose entries point at one shared value can describe more bytes
	// than it holds, so the copy stops at the size of the original. Nothing
	// legitimate reaches this: a rebased copy of a real block is smaller than
	// the block, because the largest thing in it is the maker note being
	// dropped.
	let spent = 0;
	const take = (located: Located): Entry | undefined => {
		if (spent + located.size > payload.length) return undefined;
		spent += located.size;
		return copyValue(source, located);
	};

	const ifd0: Entry[] = [];
	const subs: SubDirectory[] = [];
	// A directory with the same tag twice is invalid, and copying both would
	// make this file invalid in the same way rather than only the payload.
	const seen = new Set<number>();

	for (const located of readPayloadIfd(source, view.getUint32(4, little))) {
		if (seen.has(located.tag)) continue;
		if (CARRIED_TAGS.has(located.tag)) {
			const entry = take(located);
			if (!entry) continue;
			seen.add(located.tag);
			ifd0.push(entry);
			continue;
		}
		if (!CARRIED_DIRECTORIES.includes(located.tag)) continue;
		// A pointer is one LONG. Whatever else is under this tag, it is not a
		// directory offset, and following it would be reading a directory out of
		// the middle of a string.
		if (located.type !== TYPE_LONG || located.count !== 1) continue;

		const entries: Entry[] = [];
		for (const child of readPayloadIfd(source, view.getUint32(located.at, little))) {
			if (DROPPED_TAGS.has(child.tag)) continue;
			const entry = take(child);
			if (!entry) break;
			entries.push(entry);
		}
		if (entries.length === 0) continue;
		seen.add(located.tag);
		subs.push({
			pointer: { tag: located.tag, type: TYPE_LONG, count: 1, data: new Uint8Array(4) },
			entries,
		});
	}

	if (ifd0.length === 0 && subs.length === 0) return undefined;
	return { ifd0, subs };
}

export async function encodeTiff(
	image: RasterImage,
	options: TiffEncodeOptions = {},
): Promise<Uint8Array> {
	const { width, height } = image;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new EncodeFailedError('tiff', ENCODER_ID, 'the image has no pixels to write.');
	}
	if (image.data.length < width * height * 4) {
		throw new EncodeFailedError(
			'tiff',
			ENCODER_ID,
			'the pixel buffer is smaller than the width and height say it should be.',
		);
	}

	const wantsAlpha = options.alpha ?? image.hasAlpha;
	const source = wantsAlpha ? image : flatten(image, options.background);
	const channels = wantsAlpha ? 4 : 3;
	const rowBytes = width * channels;

	// Deflate is the only compressor available with no dependency, so its
	// absence decides the whole file rather than one field of it.
	const compressed = hasCompressionStream();
	const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(TARGET_STRIP_BYTES / rowBytes)));
	const stripCount = Math.ceil(height / rowsPerStrip);

	const strips: Uint8Array[] = [];
	for (let strip = 0; strip < stripCount; strip += 1) {
		const from = strip * rowsPerStrip;
		const rows = Math.min(rowsPerStrip, height - from);
		const raw = new Uint8Array(rows * rowBytes);
		for (let row = 0; row < rows; row += 1) {
			const at = (from + row) * width * 4;
			const to = row * rowBytes;
			if (channels === 4) {
				raw.set(source.data.subarray(at, at + rowBytes), to);
			} else {
				for (let x = 0; x < width; x += 1) {
					raw[to + x * 3] = source.data[at + x * 4] as number;
					raw[to + x * 3 + 1] = source.data[at + x * 4 + 1] as number;
					raw[to + x * 3 + 2] = source.data[at + x * 4 + 2] as number;
				}
			}
			if (compressed) difference(raw.subarray(to, to + rowBytes), channels);
		}
		strips.push(compressed ? await deflate(raw) : raw);
	}

	// Every offset in a TIFF has to sit on a word boundary, so a strip of odd
	// length is followed by a pad byte that belongs to nothing.
	const offsets: number[] = [];
	const counts: number[] = [];
	let at = 8;
	for (const strip of strips) {
		at += at & 1;
		offsets.push(at);
		counts.push(strip.length);
		at += strip.length;
	}
	at += at & 1;
	const directoryAt = at;

	const entries: Entry[] = [
		{ tag: 256, type: TYPE_LONG, count: 1, data: longs([width]) },
		{ tag: 257, type: TYPE_LONG, count: 1, data: longs([height]) },
		{
			tag: 258,
			type: TYPE_SHORT,
			count: channels,
			data: shorts(new Array<number>(channels).fill(8)),
		},
		{ tag: 259, type: TYPE_SHORT, count: 1, data: shorts([compressed ? 8 : 1]) },
		// 2 is RGB. A TIFF with no photometric tag is not a TIFF.
		{ tag: 262, type: TYPE_SHORT, count: 1, data: shorts([2]) },
		{ tag: 273, type: TYPE_LONG, count: stripCount, data: longs(offsets) },
		{ tag: 277, type: TYPE_SHORT, count: 1, data: shorts([channels]) },
		{ tag: 278, type: TYPE_LONG, count: 1, data: longs([rowsPerStrip]) },
		{ tag: 279, type: TYPE_LONG, count: stripCount, data: longs(counts) },
		// Baseline TIFF requires a resolution even where there is nothing
		// meaningful to say, and 72 per inch is what everything writes when the
		// image did not come from a scanner.
		{ tag: 282, type: TYPE_RATIONAL, count: 1, data: rational(72, 1) },
		{ tag: 283, type: TYPE_RATIONAL, count: 1, data: rational(72, 1) },
		{ tag: 284, type: TYPE_SHORT, count: 1, data: shorts([1]) },
		{ tag: 296, type: TYPE_SHORT, count: 1, data: shorts([2]) },
	];
	if (compressed) {
		entries.push({ tag: 317, type: TYPE_SHORT, count: 1, data: shorts([2]) });
	}
	if (channels === 4) {
		// 2 is unassociated alpha: the colours were not multiplied down, which
		// is what a straight RGBA raster holds.
		entries.push({ tag: 338, type: TYPE_SHORT, count: 1, data: shorts([2]) });
	}
	const profile = options.iccProfile;
	if (profile && profile.length > 0) {
		entries.push({ tag: 34675, type: TYPE_UNDEFINED, count: profile.length, data: profile });
	}

	// EXIF, where there is any of it that can be moved. `planExif` says what
	// "moved" costs and why the answer is a subset rather than the payload.
	const exif = options.exif && options.exif.length > 0 ? planExif(options.exif) : undefined;
	if (exif) {
		entries.push(...exif.ifd0);
		for (const sub of exif.subs) entries.push(sub.pointer);
	}

	// Sized and serialised before the directory that names them, so that each
	// pointer holds an offset rather than a hole to be patched later. Their
	// lengths follow from their entries alone, and a directory block is always
	// an even number of bytes, so one block sits straight after the one in front
	// of it and still begins on the word boundary TIFF asks for.
	const subs = exif?.subs ?? [];
	const subBlocks: Uint8Array[] = [];
	let nextBlockAt = directoryAt + blockLength(entries);
	for (const sub of subs) {
		const pointer = sub.pointer.data;
		new DataView(pointer.buffer, pointer.byteOffset, pointer.length).setUint32(
			0,
			nextBlockAt,
			true,
		);
		const block = directoryBlock(sub.entries, nextBlockAt);
		subBlocks.push(block);
		nextBlockAt += block.length;
	}
	// Serialised only now, because a pointer entry filled in afterwards would
	// have gone into the block as four zero bytes.
	const directory = directoryBlock(entries, directoryAt);

	const out = new ByteWriter(nextBlockAt);
	out.ascii('II');
	out.u16le(42);
	out.u32le(directoryAt);
	for (let i = 0; i < strips.length; i += 1) {
		if (out.size < (offsets[i] as number)) out.u8(0);
		out.bytesOf(strips[i] as Uint8Array);
	}
	if (out.size < directoryAt) out.u8(0);

	// No second page. The chain ends inside the block above, and everything
	// after it is a sub-directory that nothing walks to by accident.
	out.bytesOf(directory);
	for (const block of subBlocks) out.bytesOf(block);
	return out.finish();
}
