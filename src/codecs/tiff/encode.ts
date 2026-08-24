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

	// The entries above are already in ascending order, which the format
	// requires and some readers rely on rather than sorting for themselves.
	// Sorted anyway, because that requirement is easy to break by adding one
	// entry in the obvious place.
	entries.sort((a, b) => a.tag - b.tag);

	// The directory ends on an even offset, so the first value after it starts
	// on one. Each value block is then padded to an even length rather than the
	// next one being aligned, which comes to the same thing and means the
	// writer below never has to know where it is.
	const valuesAt = directoryAt + 2 + entries.length * 12 + 4;
	const outOfLine: Uint8Array[] = [];
	const entryOffsets = new Map<number, number>();
	let valueAt = valuesAt;
	for (const entry of entries) {
		if (entry.data.length <= 4) continue;
		entryOffsets.set(entry.tag, valueAt);
		outOfLine.push(entry.data);
		valueAt += entry.data.length + (entry.data.length & 1);
	}

	const out = new ByteWriter(valueAt);
	out.ascii('II');
	out.u16le(42);
	out.u32le(directoryAt);
	for (let i = 0; i < strips.length; i += 1) {
		if (out.size < (offsets[i] as number)) out.u8(0);
		out.bytesOf(strips[i] as Uint8Array);
	}
	if (out.size < directoryAt) out.u8(0);

	out.u16le(entries.length);
	for (const entry of entries) {
		out.u16le(entry.tag);
		out.u16le(entry.type);
		out.u32le(entry.count);
		const offset = entryOffsets.get(entry.tag);
		if (offset === undefined) {
			// Four bytes or fewer live in the entry itself, written from the
			// front of the field with the rest left at zero.
			for (let i = 0; i < 4; i += 1) out.u8(i < entry.data.length ? (entry.data[i] as number) : 0);
		} else {
			out.u32le(offset);
		}
	}
	// No second directory. One page, and a reader that follows the chain finds
	// the end of it here rather than wherever the file happens to stop.
	out.u32le(0);

	for (const data of outOfLine) {
		out.bytesOf(data);
		if ((data.length & 1) === 1) out.u8(0);
	}
	return out.finish();
}
