import { describe, expect, it } from 'vitest';

import { findRawPreview, jpegDimensions } from '../../src/codecs/raw/preview.js';
import { DecodeFailedError } from '../../src/errors.js';

/* ── Building JPEG streams ────────────────────────────────────────────── */

const SOF0 = 0xc0;
const SOF1 = 0xc1;
const SOF2 = 0xc2;
const SOF3 = 0xc3;
const DHT = 0xc4;
const DQT = 0xdb;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
/** Type 13, IFD: a LONG whose value is the offset of a directory. */
const TYPE_IFD = 13;

function segment(marker: number, payload: readonly number[]): number[] {
	const length = payload.length + 2;
	return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

function frame(marker: number, width: number, height: number): number[] {
	// Precision, height, width, one component, then that component's three
	// bytes. None of it is decoded here, so the sampling factors are whatever
	// is shortest.
	return segment(marker, [
		8,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		1,
		1,
		0x11,
		0,
	]);
}

interface JpegSpec {
	readonly width?: number;
	readonly height?: number;
	/** The frame header marker. SOF0, a baseline frame, by default. */
	readonly marker?: number;
	/** Leave the frame header out, as an abbreviated table stream does. */
	readonly withoutFrame?: boolean;
	/** Leave the tables out, the way a TIFF strip with a JPEGTables tag does. */
	readonly withoutTables?: boolean;
	/** Segments written between the tables and the frame header. */
	readonly before?: readonly number[];
	/** The entropy coded bytes after the scan header. */
	readonly entropy?: readonly number[];
	/** Stop before the EOI, as a truncated file does. */
	readonly withoutEnd?: boolean;
	/** Bytes written after the EOI. */
	readonly trailing?: readonly number[];
}

/**
 * Assemble a JPEG as a sequence of marker segments.
 *
 * Nothing here decodes a JPEG, so the tables and the entropy data are the
 * shortest byte runs that are structurally what they claim to be. What the
 * reader looks at is the marker sequence, and this builds that from the
 * specification rather than from an encoder.
 */
function buildJpeg(spec: JpegSpec = {}): Uint8Array {
	const out: number[] = [0xff, 0xd8];
	if (!spec.withoutTables) {
		out.push(...segment(DQT, [0, ...new Array<number>(64).fill(16)]));
		out.push(...segment(DHT, [0, ...new Array<number>(17).fill(0)]));
	}
	if (spec.before) out.push(...spec.before);
	if (!spec.withoutFrame) {
		out.push(...frame(spec.marker ?? SOF0, spec.width ?? 4, spec.height ?? 3));
	}
	out.push(...segment(0xda, [1, 1, 0, 0, 63, 0]));
	out.push(...(spec.entropy ?? [0x12, 0x34, 0x56]));
	if (!spec.withoutEnd) out.push(0xff, 0xd9);
	if (spec.trailing) out.push(...spec.trailing);
	return Uint8Array.from(out);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/* ── Building TIFF containers ─────────────────────────────────────────── */

interface EntrySpec {
	readonly tag: number;
	/** SHORT is 3, LONG is 4. LONG unless a test says otherwise. */
	readonly type?: number;
	readonly count?: number;
	readonly value: number;
}

/** Where everything landed, so an entry can point at it. */
interface Where {
	readonly directory: readonly number[];
	readonly blob: readonly number[];
	readonly end: number;
}

interface DirectorySpec {
	readonly entries: (where: Where) => readonly EntrySpec[];
	/** The link to the next directory. Zero, which ends the chain, by default. */
	readonly next?: (where: Where) => number;
	/** The entry count written to the file, when it should not match reality. */
	readonly claim?: number;
	/** Leave the four byte link off, as a writer that stops early does. */
	readonly withoutLink?: boolean;
}

/** A run of bytes placed after the directories, given the layout if it needs it. */
type BlobSpec = Uint8Array | ((where: Where) => Uint8Array);

interface TiffSpec {
	readonly little?: boolean;
	readonly version?: number;
	readonly firstIfd?: (where: Where) => number;
	readonly blobs?: readonly BlobSpec[];
	readonly directories: readonly DirectorySpec[];
}

/**
 * A TIFF laid out as a header, then each directory in turn, then each blob.
 *
 * The entries of a directory are written by a callback rather than given
 * directly, because an entry's value is nearly always an offset that is not
 * known until every directory has been sized. The callbacks therefore run
 * twice: once against an empty layout, only to count the entries, and again
 * against the real one.
 */
function buildTiff(spec: TiffSpec): Uint8Array {
	const nowhere: Where = { directory: [], blob: [], end: 0 };
	const resolve = (blobs: readonly BlobSpec[], where: Where): Uint8Array[] =>
		blobs.map((one) => (typeof one === 'function' ? one(where) : one));
	const counts = spec.directories.map((one) => one.entries(nowhere).length);
	const blobs = spec.blobs ?? [];

	let at = 8;
	const directory: number[] = [];
	spec.directories.forEach((one, i) => {
		directory.push(at);
		at += 2 + (counts[i] as number) * 12 + (one.withoutLink ? 0 : 4);
	});
	const blob: number[] = [];
	// A blob's length never depends on the layout, so sizing them against the
	// empty one is safe and is what lets a blob be written from it afterwards.
	for (const bytes of resolve(blobs, nowhere)) {
		blob.push(at);
		at += bytes.length;
	}
	const where: Where = { directory, blob, end: at };

	const out = new Uint8Array(at);
	const view = new DataView(out.buffer);
	const little = spec.little ?? true;
	out[0] = little ? 0x49 : 0x4d;
	out[1] = out[0] as number;
	view.setUint16(2, spec.version ?? 42, little);
	view.setUint32(4, spec.firstIfd ? spec.firstIfd(where) : (directory[0] ?? 0), little);

	spec.directories.forEach((one, i) => {
		const start = directory[i] as number;
		const entries = one.entries(where);
		view.setUint16(start, one.claim ?? entries.length, little);
		entries.forEach((entry, j) => {
			const to = start + 2 + j * 12;
			const type = entry.type ?? TYPE_LONG;
			view.setUint16(to, entry.tag, little);
			view.setUint16(to + 2, type, little);
			view.setUint32(to + 4, entry.count ?? 1, little);
			// A SHORT sits in the first two bytes of the four byte value field,
			// left justified, whichever way round the file is.
			if (type === TYPE_SHORT) view.setUint16(to + 8, entry.value, little);
			else view.setUint32(to + 8, entry.value, little);
		});
		if (!one.withoutLink) {
			view.setUint32(start + 2 + entries.length * 12, one.next ? one.next(where) : 0, little);
		}
	});
	resolve(blobs, where).forEach((bytes, i) => out.set(bytes, blob[i] as number));
	return out;
}

/** A run of LONGs, which is what a SubIFDs tag points at when it lists several. */
function longs(little: boolean, values: readonly number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setUint32(i * 4, value, little));
	return out;
}

/** The classic pair: JPEGInterchangeFormat and JPEGInterchangeFormatLength. */
function jpegPair(at: number, length: number): EntrySpec[] {
	return [
		{ tag: 0x0201, value: at },
		{ tag: 0x0202, value: length },
	];
}

/** A directory describing one JPEG compressed strip, which is a whole JPEG. */
function stripJpeg(at: number, length: number, compression = 6): EntrySpec[] {
	return [
		{ tag: 0x0103, type: TYPE_SHORT, value: compression },
		{ tag: 0x0111, value: at },
		{ tag: 0x0117, value: length },
	];
}

/* ── Building TIFF containers that are attacks ────────────────────────── */

/**
 * A TIFF whose one directory is nothing but SubIFDs tags.
 *
 * Every entry lists thirty two sub-directories, so the file names thirty two
 * of them for every twelve bytes it spends, and every offset it names is a
 * distinct in-bounds directory start rather than a repeat the visited set
 * would throw away. The preview goes on the end, past everything, where only
 * the buffer scan can reach it.
 *
 * `buildTiff` cannot write this: it sizes a directory from the entries its
 * callback returns, and sixteen thousand of them would be sixteen thousand
 * objects to describe two hundred bytes of pattern.
 */
function subIfdStorm(entries: number, preview: Uint8Array): Uint8Array {
	const listed = 32;
	const directory = 8;
	const entriesEnd = directory + 2 + entries * 12;
	const list = entriesEnd + 4;
	const out = new Uint8Array(list + listed * 4 + preview.length);
	const view = new DataView(out.buffer);
	out[0] = 0x49;
	out[1] = 0x49;
	// Olympus writes 0x4F52 where an ordinary TIFF writes 42, and this reader
	// keys off the byte order marker rather than the version, so a file that
	// sniffs as an ORF is walked like any other TIFF.
	view.setUint16(2, 0x4f52, true);
	view.setUint32(4, directory, true);
	view.setUint16(directory, entries, true);
	for (let i = 0; i < entries; i += 1) {
		const at = directory + 2 + i * 12;
		view.setUint16(at, 0x014a, true);
		view.setUint16(at + 2, TYPE_LONG, true);
		view.setUint32(at + 4, listed, true);
		view.setUint32(at + 8, list, true);
	}
	view.setUint32(entriesEnd, 0, true);
	for (let i = 0; i < listed; i += 1) view.setUint32(list + i * 4, directory + 2 + i * 12, true);
	out.set(preview, list + listed * 4);
	return out;
}

/**
 * A chain of sixty four directories that all read the same entries.
 *
 * The headers sit four bytes apart, each declaring the same run of entries and
 * linking to the next, so the same twelve bytes are parsed as an entry sixty
 * four times over. Aliasing is the only way a file can spend more steps than
 * it has bytes: an entry costs twelve bytes to write and the budget grants
 * four steps for each of them, so entries nobody reads twice can never run it
 * down. Everything the entries are read from is zero, the count words, or a
 * link, and none of those spells a tag this reader follows.
 */
function aliasedChain(entries: number, preview: Uint8Array): Uint8Array {
	const chain = 64;
	const first = 8;
	// Four bytes apart is what keeps one directory's link from overwriting the
	// next one's.
	const linkAt = (k: number): number => first + 4 * k + 2 + entries * 12;
	const out = new Uint8Array(linkAt(chain - 1) + 4 + preview.length);
	const view = new DataView(out.buffer);
	out[0] = 0x49;
	out[1] = 0x49;
	view.setUint16(2, 42, true);
	view.setUint32(4, first, true);
	for (let k = 0; k < chain; k += 1) {
		view.setUint16(first + 4 * k, entries, true);
		view.setUint32(linkAt(k), k + 1 < chain ? first + 4 * (k + 1) : 0, true);
	}
	out.set(preview, linkAt(chain - 1) + 4);
	return out;
}

/* ── Building Fujifilm RAF containers ─────────────────────────────────── */

interface RafSpec {
	/** Where the preview really goes. 92 is the first byte after the header. */
	readonly at?: number;
	/** What the header says, when that should differ from the truth. */
	readonly declaredAt?: number;
	readonly declaredLength?: number;
	/** Cut the file off after this many bytes. */
	readonly cut?: number;
}

function buildRaf(preview: Uint8Array, spec: RafSpec = {}): Uint8Array {
	const at = spec.at ?? 92;
	const out = new Uint8Array(at + preview.length);
	const magic = 'FUJIFILMCCD-RAW';
	for (let i = 0; i < magic.length; i += 1) out[i] = magic.charCodeAt(i);
	const view = new DataView(out.buffer);
	view.setUint32(84, spec.declaredAt ?? at);
	view.setUint32(88, spec.declaredLength ?? preview.length);
	out.set(preview, at);
	return spec.cut === undefined ? out : out.slice(0, spec.cut);
}

/* ── Assertions ───────────────────────────────────────────────────────── */

function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
	let thrown: unknown;
	try {
		findRawPreview(bytes);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DecodeFailedError);
	const error = thrown as DecodeFailedError;
	expect(error.code).toBe('decode/failed');
	expect(error.format).toBe('raw');
	expect(error.message).toMatch(pattern);
	// The message is shown to a person, so it has to be a whole sentence.
	expect(error.message.endsWith('.')).toBe(true);
}

/* ── jpegDimensions ───────────────────────────────────────────────────── */

describe('jpegDimensions', () => {
	it('reads the size out of a baseline frame header', () => {
		expect(jpegDimensions(buildJpeg({ width: 640, height: 480 }))).toEqual({
			width: 640,
			height: 480,
		});
	});

	it.each([
		['SOF0, baseline', SOF0],
		['SOF1, extended sequential', SOF1],
		['SOF2, progressive', SOF2],
		['SOF3, lossless', SOF3],
		['SOF5, differential sequential', 0xc5],
		['SOF6, differential progressive', 0xc6],
		['SOF7, differential lossless', 0xc7],
		['SOF9, arithmetic sequential', 0xc9],
		['SOF10, arithmetic progressive', 0xca],
		['SOF11, arithmetic lossless', 0xcb],
		['SOF13, differential arithmetic sequential', 0xcd],
		['SOF14, differential arithmetic progressive', 0xce],
		['SOF15, differential arithmetic lossless', 0xcf],
	])('reads the size out of a %s frame header', (_name, marker) => {
		expect(jpegDimensions(buildJpeg({ marker, width: 33, height: 17 }))).toEqual({
			width: 33,
			height: 17,
		});
	});

	it('does not mistake a Huffman table for a frame header', () => {
		// DHT sits at 0xC4, inside the run of frame header markers. Read as one,
		// its code length table gives a plausible width rather than an error.
		expect(jpegDimensions(buildJpeg({ withoutFrame: true }))).toBeUndefined();
	});

	it.each([
		['JPG at 0xC8', 0xc8],
		['DAC at 0xCC', 0xcc],
	])('does not mistake %s for a frame header', (_name, marker) => {
		const stream = buildJpeg({
			withoutFrame: true,
			before: segment(marker, [8, 0, 40, 0, 30, 1, 1, 0x11, 0]),
		});
		expect(jpegDimensions(stream)).toBeUndefined();
	});

	it('takes the first frame header when a stream carries two', () => {
		const stream = buildJpeg({ before: frame(SOF0, 90, 60), width: 10, height: 10 });
		expect(jpegDimensions(stream)).toEqual({ width: 90, height: 60 });
	});

	it('reads a frame header that follows padding bytes', () => {
		// Any number of 0xFF bytes may sit in front of a marker.
		const stream = buildJpeg({ before: [0xff, 0xff, 0xff], width: 12, height: 9 });
		expect(jpegDimensions(stream)).toEqual({ width: 12, height: 9 });
	});

	it('reads a frame header from a stream that never reaches an EOI', () => {
		// The dimensions are known long before the end of the file, and a caller
		// asking for the size of a truncated stream should still get it.
		const whole = buildJpeg({ width: 20, height: 14 });
		const cut = whole.subarray(0, whole.length - 8);
		expect(jpegDimensions(cut)).toEqual({ width: 20, height: 14 });
	});

	it('stops at the frame header rather than reading on', () => {
		// Everything after the frame header here is nonsense, which the reader
		// never looks at. `findRawPreview` does look, and refuses it.
		const stream = concat(
			Uint8Array.from([0xff, 0xd8]),
			Uint8Array.from(frame(SOF0, 50, 40)),
			Uint8Array.from([0x00, 0x11, 0x22, 0x33]),
		);
		expect(jpegDimensions(stream)).toEqual({ width: 50, height: 40 });
		expectRefusal(stream, /no JPEG preview/);
	});

	it('returns undefined for a frame header giving a zero height', () => {
		// A zero height means the real one arrives in a DNL marker after the
		// scan, which this does not follow.
		expect(jpegDimensions(buildJpeg({ width: 40, height: 0 }))).toBeUndefined();
	});

	it('returns undefined for a frame header giving a zero width', () => {
		expect(jpegDimensions(buildJpeg({ width: 0, height: 40 }))).toBeUndefined();
	});

	it('returns undefined for a frame header cut short by its own length', () => {
		const stream = buildJpeg({ withoutFrame: true, before: segment(SOF0, [8, 0, 40]) });
		expect(jpegDimensions(stream)).toBeUndefined();
	});

	it('returns undefined for bytes that do not begin with an SOI', () => {
		expect(jpegDimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeUndefined();
	});

	it('returns undefined for an empty buffer', () => {
		expect(jpegDimensions(new Uint8Array(0))).toBeUndefined();
	});

	it('returns undefined for an SOI with nothing after it', () => {
		expect(jpegDimensions(Uint8Array.from([0xff, 0xd8]))).toBeUndefined();
	});

	it('returns undefined when a segment length runs past the end of the buffer', () => {
		const stream = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
		expect(jpegDimensions(stream)).toBeUndefined();
	});

	it('returns undefined for a segment claiming a length below two', () => {
		// A length counts its own two bytes, so one would put the next marker
		// before this one and the walk would never move forward.
		const stream = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00]);
		expect(jpegDimensions(stream)).toBeUndefined();
	});

	it('reads a stream handed to it as a view into a larger buffer', () => {
		const stream = buildJpeg({ width: 7, height: 5 });
		const padded = new Uint8Array(stream.length + 16);
		padded.set(stream, 8);
		expect(jpegDimensions(padded.subarray(8, 8 + stream.length))).toEqual({ width: 7, height: 5 });
	});
});

/* ── The TIFF directory search ────────────────────────────────────────── */

describe('findRawPreview through a TIFF directory', () => {
	it.each([
		['little endian', true],
		['big endian', false],
	])('finds the classic JPEGInterchangeFormat pair in a %s file', (_name, little) => {
		const preview = buildJpeg({ width: 160, height: 120 });
		const file = buildTiff({
			little,
			blobs: [preview],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) }],
		});
		const found = findRawPreview(file);

		expect(found.source).toBe('ifd');
		expect(found.width).toBe(160);
		expect(found.height).toBe(120);
		expect(Array.from(found.bytes)).toEqual(Array.from(preview));
	});

	it.each([
		['a version of 42', 42],
		["Olympus' 0x4f52", 0x4f52],
		["Panasonic's 0x0055", 0x0055],
	])('keys off the byte order marker rather than %s', (_name, version) => {
		const preview = buildJpeg({ width: 60, height: 40 });
		const file = buildTiff({
			version,
			blobs: [preview],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) }],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it.each([
		['the old JPEG mode', 6],
		['the new JPEG mode', 7],
	])('finds a single strip declaring %s', (_name, compression) => {
		const preview = buildJpeg({ width: 200, height: 150 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => stripJpeg(where.blob[0] as number, preview.length, compression),
				},
			],
		});
		const found = findRawPreview(file);

		expect(found.source).toBe('ifd');
		expect(found.width).toBe(200);
	});

	it('leaves a strip alone when the directory does not call it JPEG', () => {
		// Compression 1 is uncompressed. The bytes at that offset happen to be a
		// JPEG, so the scan finds them, but the directory did not say so.
		const preview = buildJpeg({ width: 200, height: 150 });
		const file = buildTiff({
			blobs: [preview],
			directories: [{ entries: (where) => stripJpeg(where.blob[0] as number, preview.length, 1) }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a multi-strip image alone', () => {
		// Eleven strips is an ordinary TIFF image, and offering the first of them
		// would hand back a slice of a picture.
		const preview = buildJpeg({ width: 200, height: 150 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x0103, type: TYPE_SHORT, value: 7 },
						{ tag: 0x0111, value: where.blob[0] as number, count: 11 },
						{ tag: 0x0117, value: preview.length, count: 11 },
					],
				},
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('reads an offset stored as a SHORT', () => {
		const preview = buildJpeg({ width: 30, height: 20 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x0201, type: TYPE_SHORT, value: where.blob[0] as number },
						{ tag: 0x0202, type: TYPE_SHORT, value: preview.length },
					],
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('leaves an offset stored as a type it does not read alone', () => {
		const preview = buildJpeg({ width: 30, height: 20 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						// Type 5 is a RATIONAL, which is two longs at an offset.
						{ tag: 0x0201, type: 5, value: where.blob[0] as number },
						{ tag: 0x0202, value: preview.length },
					],
				},
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('needs both halves of the classic pair', () => {
		const preview = buildJpeg({ width: 30, height: 20 });
		const file = buildTiff({
			blobs: [preview],
			directories: [{ entries: (where) => [{ tag: 0x0201, value: where.blob[0] as number }] }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('walks past the tags it has no interest in', () => {
		// A real IFD0 is mostly tags this reader never looks at, and the preview
		// pointers are somewhere in the middle of them.
		const preview = buildJpeg({ width: 70, height: 50 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x0100, type: TYPE_SHORT, value: 6000 },
						{ tag: 0x0101, type: TYPE_SHORT, value: 4000 },
						...jpegPair(where.blob[0] as number, preview.length),
						{ tag: 0x0131, type: 2, count: 8, value: 0 },
					],
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows the chain to the next directory', () => {
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: () => [], next: (where) => where.directory[1] as number },
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows a SubIFD holding one offset', () => {
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: (where) => [{ tag: 0x014a, value: where.directory[1] as number }] },
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows a SubIFD tag pointing at a list of offsets', () => {
		// Two longs do not fit in an entry, so the tag points at them instead.
		// The preview is named by the second of the two sub-directories, so a
		// reader that only followed the first would miss it.
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [
				(where) => longs(true, [where.directory[1] as number, where.directory[2] as number]),
				preview,
			],
			directories: [
				{ entries: (where) => [{ tag: 0x014a, count: 2, value: where.blob[0] as number }] },
				{ entries: () => [] },
				{ entries: (where) => jpegPair(where.blob[1] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('leaves a SubIFD list that runs past the end of the file alone', () => {
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: () => [{ tag: 0x014a, count: 4096, value: 0x7fffff00 }] },
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a SubIFD stored as a type it does not read alone', () => {
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x014a, type: TYPE_SHORT, value: where.directory[1] as number },
					],
				},
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('follows a SubIFD written with the IFD type rather than LONG', () => {
		// TIFF Technical Note 1 and the DNG specification both give tag 330 as
		// "LONG or IFD", where IFD is type 13 and is a LONG carrying a directory
		// offset, and libtiff registers the tag that way. A reader that takes
		// only LONG walks past the sub-directories of a file written to the
		// letter of the specification and finds its preview, if at all, by
		// scanning for it.
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x014a, type: TYPE_IFD, value: where.directory[1] as number },
					],
				},
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows a SubIFD list written with the IFD type rather than LONG', () => {
		const preview = buildJpeg({ width: 90, height: 70 });
		const file = buildTiff({
			blobs: [
				(where) => longs(true, [where.directory[1] as number, where.directory[2] as number]),
				preview,
			],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x014a, type: TYPE_IFD, count: 2, value: where.blob[0] as number },
					],
				},
				{ entries: () => [] },
				{ entries: (where) => jpegPair(where.blob[1] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows an Exif directory pointer written with the IFD type', () => {
		const preview = buildJpeg({ width: 88, height: 66 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x8769, type: TYPE_IFD, value: where.directory[1] as number },
					],
				},
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('follows the Exif directory', () => {
		const preview = buildJpeg({ width: 88, height: 66 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: (where) => [{ tag: 0x8769, value: where.directory[1] as number }] },
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('reads a directory written without its link to the next one', () => {
		const preview = buildJpeg({ width: 44, height: 33 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => jpegPair(where.blob[0] as number, preview.length),
					withoutLink: true,
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('survives a directory whose link points at itself', () => {
		const preview = buildJpeg({ width: 44, height: 33 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => jpegPair(where.blob[0] as number, preview.length),
					next: (where) => where.directory[0] as number,
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('survives two directories pointing at each other', () => {
		const preview = buildJpeg({ width: 44, height: 33 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: () => [], next: (where) => where.directory[1] as number },
				{
					entries: (where) => jpegPair(where.blob[0] as number, preview.length),
					next: (where) => where.directory[0] as number,
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('survives a SubIFD pointing back at the directory that named it', () => {
		const preview = buildJpeg({ width: 44, height: 33 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x014a, value: where.directory[0] as number },
						...jpegPair(where.blob[0] as number, preview.length),
					],
				},
			],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('gives up after sixty four directories', () => {
		// A chain long enough to be a denial of service rather than a camera.
		// The preview is named by the last link in it, so a walk that reached it
		// would report `ifd` and the scan reports `scan` instead.
		const preview = buildJpeg({ width: 44, height: 33 });
		const length = 70;
		const file = buildTiff({
			blobs: [preview],
			directories: Array.from({ length }, (_unused, i) => ({
				entries: (where: Where) =>
					i === length - 1 ? jpegPair(where.blob[0] as number, preview.length) : [],
				next: (where: Where) => (where.directory[i + 1] as number) ?? 0,
			})),
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('gives up after thirty two sub-directories from one directory', () => {
		// The cap counts the directory rather than the tag. Thirty two of the
		// offsets below are the same sub-directory over and over, so the walk
		// visits two directories and still refuses to queue the thirty third
		// offset, which is the one naming the preview. A cap that counted one
		// tag at a time would queue it, and would also queue half a million
		// offsets from a file that carried enough of these tags.
		const preview = buildJpeg({ width: 44, height: 33 });
		const file = buildTiff({
			blobs: [
				(where) => longs(true, new Array<number>(32).fill(where.directory[1] as number)),
				preview,
			],
			directories: [
				{
					entries: (where) => [
						{ tag: 0x014a, count: 32, value: where.blob[0] as number },
						{ tag: 0x014a, value: where.directory[2] as number },
					],
				},
				{ entries: () => [] },
				{ entries: (where) => jpegPair(where.blob[1] as number, preview.length) },
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('walks a directory of sixteen thousand SubIFDs tags without hanging', () => {
		// 188 KiB, and half a million sub-directory offsets if nothing caps
		// them. This took 23 seconds on the machine that wrote the test, with 47
		// KiB taking 2 seconds and 94 KiB taking 25, which is the growth rather
		// than the constant: an ordinary 20 MiB raw file on that curve is
		// measured in days. There is no worker in this package, so all of it is
		// the browser's main thread. It now takes about two milliseconds, and
		// the bound below is three orders of magnitude of slack rather than a
		// measurement.
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = subIfdStorm(16_000, preview);
		const started = performance.now();
		const found = findRawPreview(file);
		const took = performance.now() - started;

		expect(found.source).toBe('scan');
		expect(found.width).toBe(64);
		expect(took).toBeLessThan(2000);
	});

	it('gives up when the directory walk spends the whole work budget', () => {
		// Sixty four directories reading the same four thousand entries, which
		// is 262,144 entries parsed from a 49 KiB file whose budget is 202,208
		// steps. The walk is charged for them, so it runs out and the preview on
		// the end of the file is never scanned for, exactly as a scan that runs
		// out stops rather than failing. A walk that charged nothing would reach
		// it and hand it back.
		const preview = buildJpeg({ width: 64, height: 48 });
		expectRefusal(aliasedChain(4096, preview), /no JPEG preview/);
	});

	it('takes the largest of two previews in the same file', () => {
		const thumbnail = buildJpeg({ width: 160, height: 120 });
		const full = buildJpeg({ width: 1600, height: 1200 });
		const file = buildTiff({
			blobs: [thumbnail, full],
			directories: [
				{
					entries: (where) => [
						...jpegPair(where.blob[0] as number, thumbnail.length),
						{ tag: 0x014a, value: where.directory[1] as number },
					],
				},
				{ entries: (where) => stripJpeg(where.blob[1] as number, full.length) },
			],
		});
		const found = findRawPreview(file);

		expect(found.width).toBe(1600);
		expect(found.source).toBe('ifd');
	});

	it('measures the stream rather than believing a length that includes padding', () => {
		// Cameras pad a preview out to a sector boundary and count the padding.
		const preview = buildJpeg({ width: 50, height: 50 });
		const padded = concat(preview, new Uint8Array(64));
		const file = buildTiff({
			blobs: [padded],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, padded.length) }],
		});
		const found = findRawPreview(file);

		expect(found.source).toBe('ifd');
		expect(found.bytes.length).toBe(preview.length);
		expect(Array.from(found.bytes.subarray(-2))).toEqual([0xff, 0xd9]);
	});

	it('leaves an offset that points into the header alone', () => {
		const preview = buildJpeg({ width: 50, height: 50 });
		const file = buildTiff({
			blobs: [preview],
			directories: [{ entries: () => jpegPair(4, preview.length) }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a length that runs past the end of the file alone', () => {
		const preview = buildJpeg({ width: 50, height: 50 });
		const file = buildTiff({
			blobs: [preview],
			directories: [
				{ entries: (where) => jpegPair(where.blob[0] as number, preview.length + 4096) },
			],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves an offset that points at something other than a JPEG alone', () => {
		const preview = buildJpeg({ width: 50, height: 50 });
		const file = buildTiff({
			blobs: [preview],
			directories: [{ entries: () => jpegPair(8, 16) }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('ignores a first directory offset that points inside the header', () => {
		const preview = buildJpeg({ width: 50, height: 50 });
		const file = buildTiff({
			firstIfd: () => 2,
			blobs: [preview],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('ignores a directory offset that points past the end of the file', () => {
		const preview = buildJpeg({ width: 50, height: 50 });
		const file = buildTiff({
			firstIfd: (where) => where.end + 64,
			blobs: [preview],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) }],
		});
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('is not fooled by a file too short to hold a TIFF header', () => {
		expectRefusal(Uint8Array.from([0x49, 0x49, 0x2a]), /no JPEG preview/);
	});
});

/* ── Fujifilm RAF ─────────────────────────────────────────────────────── */

describe('findRawPreview through a Fujifilm RAF header', () => {
	it('finds the preview the header points at', () => {
		const preview = buildJpeg({ width: 640, height: 480 });
		const found = findRawPreview(buildRaf(preview));

		expect(found.source).toBe('raf');
		expect(found.width).toBe(640);
		expect(found.height).toBe(480);
		expect(Array.from(found.bytes)).toEqual(Array.from(preview));
	});

	it('reads the two words as big endian, whatever the machine is', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { at: 256 });
		// 256 written the other way round is 65536, which is past the end.
		expect(Array.from(file.subarray(84, 88))).toEqual([0, 0, 1, 0]);
		expect(findRawPreview(file).source).toBe('raf');
	});

	it('leaves a header pointing past the end of the file alone', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { declaredAt: 4096 });
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a header whose length runs past the end of the file alone', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { declaredLength: 4096 });
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a header declaring a zero length alone', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { declaredLength: 0 });
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a header pointing back inside itself alone', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { declaredAt: 16 });
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('leaves a header pointing at something other than a JPEG alone', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview, { declaredAt: 100, declaredLength: 8 });
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('refuses a RAF cut off before its own header ends', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		expectRefusal(buildRaf(preview, { cut: 90 }), /no JPEG preview/);
	});

	it('is not fooled by fifteen bytes that are almost the magic', () => {
		const preview = buildJpeg({ width: 64, height: 48 });
		const file = buildRaf(preview);
		// The last byte of 'FUJIFILMCCD-RAW', which a shorter check would miss.
		file[14] = 0x58;
		expect(findRawPreview(file).source).toBe('scan');
	});
});

/* ── The buffer scan ──────────────────────────────────────────────────── */

describe('findRawPreview through the buffer scan', () => {
	it('finds a JPEG that is the whole file', () => {
		const preview = buildJpeg({ width: 12, height: 8 });
		const found = findRawPreview(preview);

		expect(found.source).toBe('scan');
		expect(found.width).toBe(12);
		expect(found.height).toBe(8);
		expect(found.bytes.length).toBe(preview.length);
	});

	it('finds a JPEG buried in bytes that are not one', () => {
		const preview = buildJpeg({ width: 12, height: 8 });
		const file = concat(new Uint8Array(64).fill(0x5a), preview, new Uint8Array(32).fill(0x17));
		expect(findRawPreview(file).width).toBe(12);
	});

	it('takes the largest of several streams', () => {
		const file = concat(
			buildJpeg({ width: 10, height: 10 }),
			buildJpeg({ width: 300, height: 200 }),
			buildJpeg({ width: 20, height: 20 }),
		);
		const found = findRawPreview(file);

		expect(found.width).toBe(300);
		expect(found.height).toBe(200);
	});

	it('walks over entropy data holding a stuffed 0xFF byte', () => {
		// 0xFF 0x00 is how compressed data spells a literal 0xFF, and reading it
		// as a marker ends the stream in the middle of the picture.
		const preview = buildJpeg({ width: 30, height: 20, entropy: [0xff, 0x00, 0x11, 0xff, 0x00] });
		expect(findRawPreview(preview).bytes.length).toBe(preview.length);
	});

	it('walks over entropy data holding an EOI that is really data', () => {
		// The whole reason for walking rather than searching for 0xFF 0xD9: those
		// two bytes occur inside the compressed data of most photographs.
		const preview = buildJpeg({ width: 30, height: 20, entropy: [0xff, 0x00, 0xd9, 0x22] });
		expect(findRawPreview(preview).bytes.length).toBe(preview.length);
	});

	it('walks over restart markers inside entropy data', () => {
		const preview = buildJpeg({
			width: 30,
			height: 20,
			entropy: [0x11, 0xff, 0xd0, 0x22, 0xff, 0xd1, 0x33],
		});
		expect(findRawPreview(preview).bytes.length).toBe(preview.length);
	});

	it('walks over a run of padding bytes inside entropy data', () => {
		const preview = buildJpeg({ width: 30, height: 20, entropy: [0x11, 0xff, 0xff, 0xd0, 0x22] });
		expect(findRawPreview(preview).bytes.length).toBe(preview.length);
	});

	it('walks over a TEM marker between segments', () => {
		const preview = buildJpeg({ width: 30, height: 20, before: [0xff, 0x01] });
		expect(findRawPreview(preview).width).toBe(30);
	});

	it('walks over a restart marker between segments', () => {
		const preview = buildJpeg({ width: 30, height: 20, before: [0xff, 0xd0] });
		expect(findRawPreview(preview).width).toBe(30);
	});

	it('stops at the EOI and does not carry the bytes after it', () => {
		const preview = buildJpeg({ width: 30, height: 20, trailing: [0x00, 0x11, 0x22] });
		const found = findRawPreview(preview);

		expect(found.bytes.length).toBe(preview.length - 3);
		expect(Array.from(found.bytes.subarray(-2))).toEqual([0xff, 0xd9]);
	});

	it('takes the outer stream when one JPEG carries another in a segment', () => {
		// An Exif thumbnail sits inside its parent's APP1 exactly like this. The
		// outer stream is stepped over whole, so the thumbnail is never offered
		// as a picture of its own.
		const thumbnail = buildJpeg({ width: 160, height: 120 });
		const outer = buildJpeg({
			width: 40,
			height: 30,
			before: segment(0xe1, Array.from(thumbnail)),
		});
		const found = findRawPreview(outer);

		expect(found.width).toBe(40);
		expect(found.bytes.length).toBe(outer.length);
	});

	it('ignores a stream that never reaches an EOI', () => {
		const good = buildJpeg({ width: 20, height: 20 });
		const file = concat(buildJpeg({ width: 400, height: 400, withoutEnd: true }), good);
		const found = findRawPreview(file);

		expect(found.width).toBe(20);
		expect(found.bytes.length).toBe(good.length);
	});

	it('ignores a stream whose entropy data runs off the end of the file', () => {
		// Nothing after the scan header but compressed data, which is what a file
		// that was cut short mid-download looks like.
		expectRefusal(buildJpeg({ withoutEnd: true }), /no JPEG preview/);
	});

	it('ignores a stream that runs into a second SOI', () => {
		// Two SOIs with one EOI between them: the first stream is not a stream,
		// and the second one is.
		const inner = buildJpeg({ width: 25, height: 15 });
		const file = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xd8, 0xff]), inner);
		const found = findRawPreview(file);

		expect(found.width).toBe(25);
		// The stream returned is the second one alone, not the whole file with
		// the false start glued to the front of it.
		expect(found.bytes.length).toBe(inner.length);
	});

	it('ignores a stream whose segment length runs past the end of the file', () => {
		const file = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0x00, 0x00]);
		expectRefusal(file, /no JPEG preview/);
	});

	it('ignores a stream cut off inside a segment header', () => {
		// The two length bytes are not both there, so the segment cannot even be
		// measured, let alone stepped over.
		expectRefusal(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), /no JPEG preview/);
	});

	it('ignores a stream with a stuffed byte where a marker belongs', () => {
		// 0xFF 0x00 only means anything inside entropy coded data. Between
		// segments it means this was never a stream.
		const good = buildJpeg({ width: 18, height: 12 });
		const file = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]), good);
		expect(findRawPreview(file).width).toBe(18);
	});

	it('ignores three bytes that look like a stream start and are the end of the file', () => {
		expectRefusal(Uint8Array.from([0x00, 0xff, 0xd8, 0xff]), /no JPEG preview/);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const preview = buildJpeg({ width: 33, height: 22 });
		const padded = new Uint8Array(preview.length + 24);
		padded.set(preview, 12);
		const found = findRawPreview(padded.subarray(12, 12 + preview.length));

		expect(found.width).toBe(33);
		expect(Array.from(found.bytes)).toEqual(Array.from(preview));
	});

	it('hands back a copy rather than a window onto the file', () => {
		// A window would hold the whole raw file, tens of megabytes of it, alive
		// for as long as anything kept the preview.
		const preview = buildJpeg({ width: 16, height: 16 });
		const file = concat(new Uint8Array(8), preview);
		const found = findRawPreview(file);
		file.fill(0);

		expect(Array.from(found.bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
	});

	it('hands back a copy when the file arrives as a Node Buffer', () => {
		// A Buffer is a Uint8Array as far as every type here says, and it is what
		// `readFileSync` returns, so it is how a raw file arrives outside a
		// browser. `Buffer.prototype.slice` is an alias for `subarray` rather
		// than the TypedArray method of the same name, so copying with `slice`
		// hands back the whole file as a window, which is the one thing the
		// contract says it does not do. The test above passes either way,
		// because a plain Uint8Array copies.
		const preview = buildJpeg({ width: 16, height: 16 });
		const file = Buffer.from(concat(new Uint8Array(8), preview));
		const found = findRawPreview(file);
		file.fill(0);

		expect(found.bytes.buffer).not.toBe(file.buffer);
		expect(found.bytes.byteLength).toBe(preview.length);
		expect(Array.from(found.bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
	});

	it('gives up when a file spends its whole work budget on false starts', () => {
		// Every one of the stream starts below points at the same long chain of
		// segments, which is what turns a linear scan into a quadratic one. The
		// real JPEG at the end is never reached, and that is the point: the tab
		// stays responsive and the file is refused.
		const file = trap(400, 400, buildJpeg({ width: 64, height: 64 }));
		expectRefusal(file, /no JPEG preview/);
	});

	it('gives up when a file spends its budget scanning entropy data', () => {
		// The same shape as above, but every false start declares a scan header
		// rather than an application segment, so each walk ends up reading the
		// same long run of compressed data a byte at a time.
		const file = entropyTrap(300, 2000, buildJpeg({ width: 64, height: 64 }));
		expectRefusal(file, /no JPEG preview/);
	});

	it('reaches a stream past a handful of false starts', () => {
		// The same shape, small enough to stay inside the budget, to show that
		// the refusal above is the budget rather than the shape of the file.
		const file = trap(2, 2, buildJpeg({ width: 64, height: 64 }));
		const found = findRawPreview(file);

		expect(found.source).toBe('scan');
		expect(found.width).toBe(64);
	});
});

/**
 * A buffer whose every stream start points at one long chain of segments.
 *
 * Each of the six byte starts declares a segment ending exactly where the
 * chain begins, so a walk from any of them traverses the whole chain before
 * failing. Walking all of them is quadratic in the length of the file.
 */
function trap(starts: number, chain: number, tail: Uint8Array): Uint8Array {
	const head = starts * 6;
	const out = new Uint8Array(head + chain * 4 + tail.length);
	const view = new DataView(out.buffer);
	for (let i = 0; i < starts; i += 1) {
		const at = i * 6;
		out.set([0xff, 0xd8, 0xff, 0xe1], at);
		view.setUint16(at + 4, head - (at + 4));
	}
	for (let i = 0; i < chain; i += 1) {
		const at = head + i * 4;
		out.set([0xff, 0xe1, 0x00, 0x02], at);
	}
	out.set(tail, head + chain * 4);
	return out;
}

/**
 * The same idea, aimed at the entropy scan instead.
 *
 * Each start declares a scan header ending where the compressed data begins,
 * so every walk reads the whole of that run a byte at a time before failing.
 */
function entropyTrap(starts: number, data: number, tail: Uint8Array): Uint8Array {
	const head = starts * 6;
	const out = new Uint8Array(head + data + tail.length);
	const view = new DataView(out.buffer);
	for (let i = 0; i < starts; i += 1) {
		const at = i * 6;
		out.set([0xff, 0xd8, 0xff, 0xda], at);
		view.setUint16(at + 4, head - (at + 4));
	}
	out.set(tail, head + data);
	return out;
}

/* ── Choosing between what the three searches found ───────────────────── */

describe('findRawPreview choosing between candidates', () => {
	it('prefers the directory entry when the scan finds the same stream', () => {
		const preview = buildJpeg({ width: 100, height: 100 });
		const file = buildTiff({
			blobs: [preview],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, preview.length) }],
		});
		expect(findRawPreview(file).source).toBe('ifd');
	});

	it('prefers a larger stream the scan found over a smaller one a directory named', () => {
		// Panasonic keeps its full size preview in a private tag this reader does
		// not read, and this is the shape of that file: a small preview in the
		// directory and a large one only the scan can find.
		const small = buildJpeg({ width: 160, height: 120 });
		const large = buildJpeg({ width: 4000, height: 3000 });
		const file = concat(
			buildTiff({
				blobs: [small],
				directories: [{ entries: (where) => jpegPair(where.blob[0] as number, small.length) }],
			}),
			large,
		);
		const found = findRawPreview(file);

		expect(found.source).toBe('scan');
		expect(found.width).toBe(4000);
	});

	it('prefers the Fujifilm header when the scan finds the same stream', () => {
		const preview = buildJpeg({ width: 200, height: 200 });
		expect(findRawPreview(buildRaf(preview)).source).toBe('raf');
	});

	it('passes over the sensor data of a compressed raw file', () => {
		// The trap in "largest wins". A compressed DNG stores its sensor data as
		// a lossless JPEG, which is a complete stream with a frame header giving
		// the full sensor size, and it is always the largest picture in the file.
		const sensor = buildJpeg({ marker: SOF3, width: 6000, height: 4000 });
		const preview = buildJpeg({ width: 1024, height: 768 });
		const file = buildTiff({
			blobs: [sensor, preview],
			directories: [
				{
					entries: (where) => [
						...stripJpeg(where.blob[0] as number, sensor.length, 7),
						{ tag: 0x014a, value: where.directory[1] as number },
					],
				},
				{ entries: (where) => stripJpeg(where.blob[1] as number, preview.length, 7) },
			],
		});
		const found = findRawPreview(file);

		expect(found.width).toBe(1024);
		expect(found.height).toBe(768);
	});

	it.each([
		['SOF1, extended sequential', SOF1],
		['SOF2, progressive', SOF2],
	])('offers a %s frame, which a browser decodes', (_name, marker) => {
		const preview = buildJpeg({ marker, width: 90, height: 60 });
		expect(findRawPreview(preview).width).toBe(90);
	});

	it.each([
		['SOF3, lossless', SOF3],
		['SOF5, differential sequential', 0xc5],
		['SOF9, arithmetic sequential', 0xc9],
		['SOF15, differential arithmetic lossless', 0xcf],
	])('passes over a %s frame, which no browser decodes', (_name, marker) => {
		const undecodable = buildJpeg({ marker, width: 6000, height: 4000 });
		const preview = buildJpeg({ width: 40, height: 30 });
		expect(findRawPreview(concat(undecodable, preview)).width).toBe(40);
	});
});

/* ── A JPEG from a real encoder ───────────────────────────────────────── */

describe('findRawPreview against a JPEG this package did not write', () => {
	/**
	 * A 16 by 8 JPEG of random noise, written by ImageMagick 7, byte for byte.
	 *
	 * Every other stream in this file is assembled from the marker sequence in
	 * the specification, which is a better test than a round trip but is still
	 * this package's reading of the format on both sides. This one is not: it
	 * came out of an encoder with no connection to this one, and it carries the
	 * two things a hand built fixture is least likely to get right, a restart
	 * interval and a stuffed 0xFF byte inside the entropy coded data.
	 *
	 * Noise rather than a picture, and generated rather than photographed. No
	 * file under `tests/` came out of a camera.
	 */
	const magick = Uint8Array.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03,
		0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06,
		0x06, 0x05, 0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a, 0x0c, 0x0f, 0x0c, 0x0a,
		0x0b, 0x0e, 0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d, 0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c,
		0x12, 0x13, 0x12, 0x10, 0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xdb, 0x00, 0x43, 0x01, 0x03, 0x03,
		0x03, 0x04, 0x03, 0x04, 0x08, 0x04, 0x04, 0x08, 0x10, 0x0b, 0x09, 0x0b, 0x10, 0x10, 0x10, 0x10,
		0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
		0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
		0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0xff, 0xc0,
		0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
		0x01, 0xff, 0xc4, 0x00, 0x15, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x04, 0xff, 0xc4, 0x00, 0x1d, 0x10, 0x00, 0x02, 0x03,
		0x00, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x01,
		0x04, 0x05, 0x06, 0x11, 0x13, 0x14, 0x12, 0xff, 0xc4, 0x00, 0x16, 0x01, 0x01, 0x01, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x02, 0x04, 0xff,
		0xc4, 0x00, 0x20, 0x11, 0x00, 0x03, 0x00, 0x02, 0x02, 0x02, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x11, 0x05, 0x12, 0x13, 0x21, 0x06, 0x14, 0x23,
		0x33, 0xff, 0xdd, 0x00, 0x04, 0x00, 0x01, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11,
		0x03, 0x11, 0x00, 0x3f, 0x00, 0x83, 0x4d, 0x7c, 0xeb, 0x32, 0x65, 0x56, 0x79, 0x35, 0xf6, 0x86,
		0x85, 0xb0, 0xcf, 0x3a, 0xb7, 0xa1, 0x83, 0xe0, 0x13, 0x66, 0xd2, 0x95, 0x49, 0xb2, 0x50, 0x4e,
		0xeb, 0xf6, 0x0e, 0x10, 0x06, 0xc3, 0x86, 0x5e, 0xd2, 0x85, 0x9c, 0x4a, 0x5b, 0xed, 0xbb, 0xeb,
		0xe1, 0x26, 0x33, 0xb2, 0x89, 0xb6, 0x6c, 0x95, 0x1f, 0x7d, 0x9b, 0x7d, 0x9a, 0x48, 0x0b, 0xce,
		0x32, 0x1f, 0xd1, 0xf7, 0x12, 0xd5, 0x1a, 0x5a, 0x6d, 0x1d, 0x49, 0xee, 0x02, 0x5e, 0x0f, 0x26,
		0xff, 0x00, 0x16, 0xc8, 0xcd, 0xcb, 0x38, 0xe9, 0x8e, 0xd2, 0xc7, 0xfc, 0xdb, 0xba, 0xd0, 0x07,
		0x9a, 0x8a, 0xb8, 0x57, 0x4f, 0x1a, 0x26, 0xe6, 0xcc, 0xb4, 0x33, 0x55, 0xdd, 0xe6, 0xd5, 0x0c,
		0x52, 0x88, 0xa9, 0xff, 0xd0, 0x6b, 0x3c, 0x27, 0xec, 0xd6, 0xd9, 0xe2, 0xb9, 0xba, 0x78, 0xe5,
		0xa1, 0x29, 0x1a, 0x95, 0xeb, 0xc5, 0x66, 0xe8, 0xc5, 0x5b, 0x93, 0xd1, 0x31, 0xaa, 0x59, 0x31,
		0x72, 0xfb, 0x56, 0x7e, 0x96, 0xd9, 0x82, 0x28, 0x9f, 0x35, 0xd0, 0x91, 0x99, 0x15, 0x80, 0x11,
		0x2f, 0xc8, 0xd8, 0x70, 0xf1, 0xc7, 0xe5, 0xb8, 0x68, 0xd1, 0x22, 0xbe, 0xfa, 0x7a, 0x1f, 0x99,
		0x46, 0x20, 0xe9, 0x19, 0x9f, 0x48, 0x4c, 0xd4, 0xbc, 0x1c, 0x48, 0xf9, 0x19, 0xe8, 0x5a, 0xe8,
		0x14, 0x1b, 0xc4, 0xfc, 0xa5, 0x39, 0x2c, 0xd1, 0xcc, 0x58, 0x8a, 0x51, 0x0e, 0x83, 0x6c, 0x20,
		0x92, 0x35, 0x8c, 0x96, 0x67, 0xd8, 0x1e, 0x33, 0x6e, 0xec, 0xc5, 0xdb, 0xb3, 0x4c, 0xbb, 0x78,
		0x77, 0x75, 0x12, 0xff, 0xd9,
	]);

	it('reads the size out of it', () => {
		expect(jpegDimensions(magick)).toEqual({ width: 16, height: 8 });
	});

	it('finds it whole by scanning', () => {
		const found = findRawPreview(magick);

		expect(found.source).toBe('scan');
		expect(found.width).toBe(16);
		expect(found.height).toBe(8);
		expect(found.bytes.length).toBe(magick.length);
		expect(Array.from(found.bytes)).toEqual(Array.from(magick));
	});

	it('finds it through a directory that points at it', () => {
		const file = buildTiff({
			blobs: [magick],
			directories: [{ entries: (where) => jpegPair(where.blob[0] as number, magick.length) }],
		});
		const found = findRawPreview(file);

		expect(found.source).toBe('ifd');
		expect(Array.from(found.bytes)).toEqual(Array.from(magick));
	});

	it('finds it through a Fujifilm header that points at it', () => {
		const found = findRawPreview(buildRaf(magick));

		expect(found.source).toBe('raf');
		expect(Array.from(found.bytes)).toEqual(Array.from(magick));
	});

	it('finds it inside a buffer that starts and ends with other bytes', () => {
		const file = concat(new Uint8Array(300).fill(0xff), magick, new Uint8Array(120).fill(0xd8));
		const found = findRawPreview(file);

		expect(found.width).toBe(16);
		expect(Array.from(found.bytes)).toEqual(Array.from(magick));
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('findRawPreview refusals', () => {
	it('refuses an empty file', () => {
		expectRefusal(new Uint8Array(0), /no JPEG preview/);
	});

	it('refuses a file with nothing in it that looks like a JPEG', () => {
		expectRefusal(new Uint8Array(512).fill(0x2a), /no JPEG preview/);
	});

	it('refuses a file that is nothing but 0xFF bytes', () => {
		expectRefusal(new Uint8Array(512).fill(0xff), /no JPEG preview/);
	});

	it('says that developing the sensor data is not on offer', () => {
		expectRefusal(new Uint8Array(64).fill(0x11), /developing the sensor data/);
	});

	it('names BigTIFF rather than reporting an unreadable file', () => {
		const file = buildTiff({ version: 43, directories: [{ entries: () => [] }] });
		expectRefusal(file, /BigTIFF/);
	});

	it('names BigTIFF whichever way round it is', () => {
		const file = buildTiff({ little: false, version: 43, directories: [{ entries: () => [] }] });
		expectRefusal(file, /64 bit image directories/);
	});

	it('still finds a preview in a BigTIFF by scanning for it', () => {
		const preview = buildJpeg({ width: 40, height: 30 });
		const file = concat(buildTiff({ version: 43, directories: [{ entries: () => [] }] }), preview);
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('names a directory that runs past the end of the file', () => {
		// The count is the first thing read out of a directory and the cheapest
		// thing to corrupt: four hundred entries in a fourteen byte file.
		const file = buildTiff({ directories: [{ entries: () => [], claim: 400 }] });
		expectRefusal(file, /image directories runs past the end/);
	});

	it('still finds a preview past a directory that runs past the end of the file', () => {
		const preview = buildJpeg({ width: 40, height: 30 });
		const file = concat(buildTiff({ directories: [{ entries: () => [], claim: 400 }] }), preview);
		expect(findRawPreview(file).source).toBe('scan');
	});

	it('names a lossless frame and says what it is', () => {
		const sensor = buildJpeg({ marker: SOF3, width: 6000, height: 4000 });
		expectRefusal(sensor, /lossless one \(SOF3\)/);
		expectRefusal(sensor, /sensor data/);
	});

	it.each([
		['SOF9', 0xc9, /arithmetic coded one \(SOF9\)/],
		['SOF10', 0xca, /arithmetic coded one \(SOF10\)/],
		['SOF5', 0xc5, /differential one \(SOF5\)/],
		['SOF6', 0xc6, /differential one \(SOF6\)/],
		['SOF7', 0xc7, /lossless one \(SOF7\)/],
		['SOF11', 0xcb, /lossless one \(SOF11\)/],
		['SOF15', 0xcf, /lossless one \(SOF15\)/],
	])('names a %s frame by number', (_name, marker, pattern) => {
		expectRefusal(buildJpeg({ marker, width: 100, height: 100 }), pattern);
	});

	it.each([
		['SOF3', SOF3, /is a lossless one/],
		['SOF5', 0xc5, /is a differential one/],
		['SOF9', 0xc9, /is an arithmetic coded one/],
		['SOF10', 0xca, /is an arithmetic coded one/],
		['SOF13', 0xcd, /is an arithmetic coded one/],
		['SOF14', 0xce, /is an arithmetic coded one/],
	])('puts the right article in front of the mode named for %s', (_name, marker, pattern) => {
		// The patterns above match from inside the phrase, so "a arithmetic
		// coded one" satisfied every one of them. This is a sentence somebody
		// reads in a bug report.
		expectRefusal(buildJpeg({ marker, width: 100, height: 100 }), pattern);
	});

	it('names JPEGTables when a stream carries none of its own tables', () => {
		// This is exactly what a TIFF strip looks like when the tables were
		// hoisted into a JPEGTables tag: a complete stream, with a frame header,
		// that no decoder can do anything with.
		const strip = buildJpeg({ width: 40, height: 30, withoutTables: true });
		expectRefusal(strip, /JPEGTables/);
	});

	it('names JPEGTables when a stream carries only a quantisation table', () => {
		const strip = buildJpeg({ width: 40, height: 30, withoutTables: true });
		const withDqt = concat(
			strip.subarray(0, 2),
			Uint8Array.from(segment(DQT, [0, ...new Array<number>(64).fill(16)])),
			strip.subarray(2),
		);
		expectRefusal(withDqt, /none of its own tables/);
	});

	it('accepts a stream whose coding table is an arithmetic one', () => {
		// DAC rather than DHT. Nothing decodes arithmetic coding, but the frame
		// mode is what refuses that, and this is about the table check alone.
		const stream = buildJpeg({
			width: 40,
			height: 30,
			withoutTables: true,
			before: [...segment(DQT, [0, ...new Array<number>(64).fill(16)]), ...segment(0xcc, [0x00])],
		});
		expect(findRawPreview(stream).width).toBe(40);
	});

	it('names a size no camera preview comes in', () => {
		expectRefusal(buildJpeg({ width: 60000, height: 60000 }), /60000 by 60000 pixels/);
	});

	it('names the DNL marker when a frame header gives no height', () => {
		expectRefusal(buildJpeg({ width: 40, height: 0 }), /DNL marker/);
	});

	it('names the DNL marker when a stream has no frame header at all', () => {
		expectRefusal(buildJpeg({ withoutFrame: true }), /never states its size/);
	});

	it('prefers a preview it can use over anything it would have refused', () => {
		const file = concat(
			buildJpeg({ marker: SOF3, width: 6000, height: 4000 }),
			buildJpeg({ width: 60000, height: 60000 }),
			buildJpeg({ width: 40, height: 0 }),
			buildJpeg({ width: 10, height: 10 }),
		);
		expect(findRawPreview(file).width).toBe(10);
	});
});
