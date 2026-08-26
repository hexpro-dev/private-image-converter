import { describe, expect, it } from 'vitest';

import { MsbBitWriter } from '../../src/bits.js';
import { decodePng } from '../../src/codecs/png/decode.js';
import { deflate } from '../../src/codecs/png/deflate.js';
import { decodeCcitt } from '../../src/codecs/tiff/ccitt.js';
import { decodeTiff, decodeTiffFloat, readTiffIccProfile } from '../../src/codecs/tiff/decode.js';
import { encodeTiff } from '../../src/codecs/tiff/encode.js';
import { convert } from '../../src/convert.js';
import { installDefaultCodecs, resetDefaultCodecs } from '../../src/defaults.js';
import { emptyCapabilities } from '../../src/detect/capabilities.js';
import { CodecUnavailableError, DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { readExif } from '../../src/metadata/exif.js';
import { createRaster } from '../../src/raster/image.js';
import { clearRegistry, registerDecoder } from '../../src/registry.js';
import type { ColourSpace, Orientation, RasterImage } from '../../src/types.js';

/* ── Building files by hand ───────────────────────────────────────────── */

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const SBYTE = 6;
const UNDEFINED = 7;
const SSHORT = 8;
const SLONG = 9;
const SRATIONAL = 10;
const FLOAT = 11;
const DOUBLE = 12;

interface FieldSpec {
	readonly tag: number;
	readonly type: number;
	/** One number per value, or two per value for the rational types. */
	readonly values: readonly number[];
	/** Overrides the count the values imply, for building a file that lies. */
	readonly count?: number;
}

interface PageSpec {
	readonly fields: readonly FieldSpec[];
	readonly data: Uint8Array;
}

function valueBytes(field: FieldSpec, little: boolean): Uint8Array {
	const perValue = field.type === RATIONAL || field.type === SRATIONAL ? 4 : 0;
	const width =
		perValue ||
		(field.type === BYTE || field.type === ASCII || field.type === UNDEFINED || field.type === SBYTE
			? 1
			: field.type === SHORT || field.type === SSHORT
				? 2
				: field.type === DOUBLE
					? 8
					: 4);
	const out = new Uint8Array(field.values.length * width);
	const view = new DataView(out.buffer);
	field.values.forEach((value, i) => {
		switch (field.type) {
			case BYTE:
			case ASCII:
			case UNDEFINED:
				view.setUint8(i, value);
				break;
			case SBYTE:
				view.setInt8(i, value);
				break;
			case SHORT:
				view.setUint16(i * 2, value, little);
				break;
			case SSHORT:
				view.setInt16(i * 2, value, little);
				break;
			case SLONG:
			case SRATIONAL:
				view.setInt32(i * 4, value, little);
				break;
			case FLOAT:
				view.setFloat32(i * 4, value, little);
				break;
			case DOUBLE:
				view.setFloat64(i * 8, value, little);
				break;
			default:
				view.setUint32(i * 4, value, little);
				break;
		}
	});
	return out;
}

function valueCount(field: FieldSpec): number {
	if (field.count !== undefined) return field.count;
	if (field.type === RATIONAL || field.type === SRATIONAL) return field.values.length / 2;
	return field.values.length;
}

/**
 * Assemble a TIFF from field values rather than from the encoder.
 *
 * The decoder tests have to read files this package did not write, so the
 * fixtures are built from the numbers in the specification directly. The
 * layout is fixed and simple: every page's pixel data comes first, starting at
 * offset 8 and padded to an even length, then the directories, then any values
 * too long to sit inside a directory entry. That means a single page file
 * always has its pixels at offset 8, which is what the fixtures below write
 * into their strip offsets.
 */
function buildTiff(pages: readonly PageSpec[], little = true, version = 42): Uint8Array {
	const sorted = pages.map((page) => [...page.fields].sort((a, b) => a.tag - b.tag));
	const blobs = pages.map((page) => page.data);

	const dataAt: number[] = [];
	let at = 8;
	for (const blob of blobs) {
		at += at & 1;
		dataAt.push(at);
		at += blob.length;
	}

	const directoryAt: number[] = [];
	for (const fields of sorted) {
		at += at & 1;
		directoryAt.push(at);
		at += 2 + fields.length * 12 + 4;
	}

	const outOfLine: { at: number; bytes: Uint8Array }[] = [];
	const encoded = sorted.map((fields) =>
		fields.map((field) => {
			const bytes = valueBytes(field, little);
			if (bytes.length <= 4) return { field, bytes, at: -1 };
			at += at & 1;
			const where = at;
			at += bytes.length;
			outOfLine.push({ at: where, bytes });
			return { field, bytes, at: where };
		}),
	);

	const out = new Uint8Array(at);
	const view = new DataView(out.buffer);
	out[0] = little ? 0x49 : 0x4d;
	out[1] = little ? 0x49 : 0x4d;
	view.setUint16(2, version, little);
	view.setUint32(4, directoryAt[0] as number, little);

	blobs.forEach((blob, i) => out.set(blob, dataAt[i] as number));

	encoded.forEach((fields, page) => {
		const start = directoryAt[page] as number;
		view.setUint16(start, fields.length, little);
		fields.forEach((entry, i) => {
			const to = start + 2 + i * 12;
			view.setUint16(to, entry.field.tag, little);
			view.setUint16(to + 2, entry.field.type, little);
			view.setUint32(to + 4, valueCount(entry.field), little);
			if (entry.at < 0) out.set(entry.bytes, to + 8);
			else view.setUint32(to + 8, entry.at, little);
		});
		const next = page + 1 < directoryAt.length ? (directoryAt[page + 1] as number) : 0;
		view.setUint32(start + 2 + fields.length * 12, next, little);
	});

	for (const value of outOfLine) out.set(value.bytes, value.at);
	return out;
}

interface Simple {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
	readonly bits?: number;
	readonly samples?: number;
	readonly photometric?: number;
	readonly compression?: number;
	readonly rowsPerStrip?: number;
	readonly little?: boolean;
	/** Added to the directory, replacing any default with the same tag. */
	readonly extra?: readonly FieldSpec[];
	readonly drop?: readonly number[];
	readonly offsets?: readonly number[];
	readonly counts?: readonly number[];
}

/** The nine tags every fixture needs, with anything else layered on top. */
function makeTiff(spec: Simple): Uint8Array {
	const samples = spec.samples ?? 3;
	const bits = spec.bits ?? 8;
	const fields: FieldSpec[] = [
		{ tag: 256, type: LONG, values: [spec.width] },
		{ tag: 257, type: LONG, values: [spec.height] },
		{ tag: 258, type: SHORT, values: new Array<number>(samples).fill(bits) },
		{ tag: 259, type: SHORT, values: [spec.compression ?? 1] },
		{ tag: 262, type: SHORT, values: [spec.photometric ?? 2] },
		{ tag: 273, type: LONG, values: [...(spec.offsets ?? [8])] },
		{ tag: 277, type: SHORT, values: [samples] },
		{ tag: 278, type: LONG, values: [spec.rowsPerStrip ?? spec.height] },
		{ tag: 279, type: LONG, values: [...(spec.counts ?? [spec.data.length])] },
	];
	const merged = new Map<number, FieldSpec>(fields.map((field) => [field.tag, field]));
	for (const field of spec.extra ?? []) merged.set(field.tag, field);
	for (const tag of spec.drop ?? []) merged.delete(tag);
	return buildTiff([{ fields: [...merged.values()], data: spec.data }], spec.little ?? true);
}

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

function raster(
	width: number,
	height: number,
	pixels: readonly number[],
	hasAlpha = false,
	colourSpace: ColourSpace = 'srgb',
): RasterImage {
	const image = createRaster(width, height, colourSpace, hasAlpha);
	image.data.set(pixels);
	return image;
}

/** A deterministic generator, so a failing round trip is the same one next run. */
function noise(width: number, height: number, hasAlpha: boolean): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	let state = 0x2545f491;
	for (let i = 0; i < image.data.length; i += 4) {
		for (let channel = 0; channel < 4; channel += 1) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			image.data[i + channel] = (state >> 16) & 0xff;
		}
		if (!hasAlpha) image.data[i + 3] = 255;
	}
	return image;
}

async function expectRefusal(file: Uint8Array, pattern: RegExp): Promise<void> {
	let thrown: unknown;
	try {
		await decodeTiff(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DecodeFailedError);
	const error = thrown as DecodeFailedError;
	expect(error.code).toBe('decode/failed');
	expect(error.format).toBe('tiff');
	expect(error.message).toMatch(pattern);
	// The message is shown to a person, so it has to be a whole sentence.
	expect(error.message.endsWith('.')).toBe(true);
}

/* ── Compressors, written here so the decoder is tested against something
      other than itself ────────────────────────────────────────────────── */

/**
 * The PackBits encoder from the TIFF 6.0 specification's own description.
 *
 * Deliberately naive: runs of three or more become a repeat, everything else
 * accumulates into a literal. It does not have to be good, only correct.
 */
function packBits(source: Uint8Array): Uint8Array {
	const out: number[] = [];
	let at = 0;
	while (at < source.length) {
		let run = 1;
		while (at + run < source.length && source[at + run] === source[at] && run < 128) run += 1;
		if (run >= 3) {
			out.push(257 - run, source[at] as number);
			at += run;
			continue;
		}
		const from = at;
		while (at < source.length && at - from < 128) {
			const same =
				at + 2 < source.length && source[at] === source[at + 1] && source[at] === source[at + 2];
			if (same && at > from) break;
			at += 1;
		}
		out.push(at - from - 1);
		for (let i = from; i < at; i += 1) out.push(source[i] as number);
	}
	return Uint8Array.from(out);
}

/**
 * A TIFF LZW compressor.
 *
 * `earlyChange` is the whole point of it being here: with it on, the code
 * width grows one code before it has to, which is what TIFF means and what
 * GIF does not. Both are written so that the decoder can be shown reading
 * each of them.
 */
function lzwCompress(source: Uint8Array, earlyChange = true): Uint8Array {
	const writer = new MsbBitWriter();
	const table = new Map<string, number>();
	let width = 9;
	let next = 258;
	let current = '';

	const reset = (): void => {
		table.clear();
		width = 9;
		next = 258;
	};

	writer.write(256, width);
	for (const byte of source) {
		const candidate = current + String.fromCharCode(byte);
		if (candidate.length === 1 || table.has(candidate)) {
			current = candidate;
			continue;
		}
		writer.write(
			current.length === 1 ? current.charCodeAt(0) : (table.get(current) as number),
			width,
		);
		table.set(candidate, next);
		next += 1;
		// One code later than the decoder, because a decoder only learns of an
		// entry from the code after the one that defined it. libtiff's encoder
		// counts the same way, and a writer that used GIF's timing instead is
		// one code later again, which is what `earlyChange` off produces.
		if (next >= (1 << width) + (earlyChange ? 0 : 1) && width < 12) width += 1;
		if (next >= 4094) {
			writer.write(256, width);
			reset();
		}
		current = String.fromCharCode(byte);
	}
	if (current.length > 0) {
		writer.write(
			current.length === 1 ? current.charCodeAt(0) : (table.get(current) as number),
			width,
		);
	}
	writer.write(257, width);
	return writer.finish();
}

/* ── The T.4 codes these fixtures use ─────────────────────────────────── */

/**
 * Just the run length codes the hand built fax rows below need, copied out of
 * the T.4 terminating code tables one at a time.
 */
const WHITE: Record<number, string> = {
	0: '00110101',
	1: '000111',
	2: '0111',
	4: '1011',
	6: '1110',
	8: '10011',
	16: '101010',
	64: '11011',
};
const BLACK: Record<number, string> = {
	0: '0000110111',
	1: '010',
	2: '11',
	4: '011',
	8: '000101',
	16: '0000010111',
};
const EOL = '000000000001';

/** Write a run of bits given as a string of '0' and '1'. */
function writeBits(writer: MsbBitWriter, code: string): void {
	for (const bit of code) writer.writeBit(bit === '1' ? 1 : 0);
}

/* ── Header and directory ─────────────────────────────────────────────── */

describe('decodeTiff header and directories', () => {
	const grey = { width: 2, height: 1, samples: 1, photometric: 1, data: bytes(10, 200) };

	it('reads a little endian file', async () => {
		const image = await decodeTiff(makeTiff({ ...grey, little: true }));

		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(image.colourSpace).toBe('srgb');
		expect(pixelsOf(image)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it('reads a big endian file', async () => {
		const image = await decodeTiff(makeTiff({ ...grey, little: false }));

		expect(pixelsOf(image)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', async () => {
		const file = makeTiff(grey);
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);
		const image = await decodeTiff(padded.subarray(8, 8 + file.length));

		expect(pixelsOf(image)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it.each([
		['a byte', BYTE, [2]],
		['ASCII', ASCII, [2]],
		['a short', SHORT, [2]],
		['a long', LONG, [2]],
		['a rational', RATIONAL, [4, 2]],
		['a signed byte', SBYTE, [2]],
		['an undefined', UNDEFINED, [2]],
		['a signed short', SSHORT, [2]],
		['a signed long', SLONG, [2]],
		['a signed rational', SRATIONAL, [-4, -2]],
		['a float', FLOAT, [2]],
		['a double', DOUBLE, [2]],
	])('reads a width written as %s', async (_label, type, values) => {
		const file = makeTiff({ ...grey, extra: [{ tag: 256, type, values }] });

		expect((await decodeTiff(file)).width).toBe(2);
	});

	it('reads a value that does not fit in a directory entry from its offset', async () => {
		// Three shorts are six bytes, so the depths live outside the entry while
		// the single short beside them lives inside it.
		const file = makeTiff({ width: 2, height: 1, data: bytes(1, 2, 3, 4, 5, 6) });

		expect(pixelsOf(await decodeTiff(file))).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	it('ignores a tag it has never heard of, whatever type it claims', async () => {
		const file = makeTiff({
			...grey,
			extra: [{ tag: 65000, type: 250, values: [1, 2, 3, 4] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it('ignores a tag it never reads whose values are not in the file', async () => {
		// A private tag claiming a hundred longs while its offset has eight
		// bytes behind it. Nothing here opens tag 65000, so the pixels are
		// entirely intact, and libtiff, ImageMagick and Pillow all warn and
		// carry on. Refusing the file over it discards a picture to protect a
		// read that never happens.
		const file = makeTiff({
			...grey,
			extra: [{ tag: 65000, type: LONG, count: 100, values: [1, 2] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it('refuses a tag it does read whose values are not in the file', async () => {
		// The same lie on the depths, which every pixel below depends on. This
		// is what the check is for, and moving it to the point of the read is
		// what keeps it here and off the tag above.
		const file = makeTiff({
			width: 2,
			height: 1,
			data: bytes(1, 2, 3, 4, 5, 6),
			extra: [{ tag: 258, type: SHORT, count: 40, values: [8, 8, 8] }],
		});

		await expectRefusal(file, /the values of its tag 258/);
	});

	it('reads a signed rational whose denominator is zero as zero', async () => {
		const file = makeTiff({ ...grey, extra: [{ tag: 274, type: SRATIONAL, values: [1, 0] }] });

		expect((await decodeTiff(file)).width).toBe(2);
	});

	it('reads a rational whose denominator is zero as zero', async () => {
		// Orientation is the only tag here that tolerates a nonsense value, so it
		// is the one that can show the arithmetic without failing for a different
		// reason.
		const file = makeTiff({ ...grey, extra: [{ tag: 274, type: RATIONAL, values: [1, 0] }] });

		expect((await decodeTiff(file)).width).toBe(2);
	});

	it('refuses a file with no byte order mark', async () => {
		const file = makeTiff(grey);
		file[0] = 0x4a;
		await expectRefusal(file, /II or MM/);
	});

	it('refuses a BigTIFF by name', async () => {
		const file = buildTiff(
			[{ fields: [{ tag: 256, type: LONG, values: [1] }], data: bytes() }],
			true,
			43,
		);
		await expectRefusal(file, /BigTIFF/);
	});

	it('refuses a version number that is neither 42 nor 43', async () => {
		const file = buildTiff(
			[{ fields: [{ tag: 256, type: LONG, values: [1] }], data: bytes() }],
			true,
			7,
		);
		await expectRefusal(file, /version number is 7/);
	});

	it.each([0, 1, 4, 7])('refuses a file cut off at %i bytes', async (length) => {
		await expectRefusal(makeTiff(grey).subarray(0, length), /too short/);
	});

	it('refuses a first directory offset past the end of the file', async () => {
		const file = makeTiff(grey);
		new DataView(file.buffer).setUint32(4, 0xfffff, true);
		await expectRefusal(file, /entry count of one of its directories/);
	});

	it('refuses a directory whose entries run past the end of the file', async () => {
		const file = makeTiff(grey);
		await expectRefusal(file.subarray(0, file.length - 20), /end of one of its directories/);
	});

	it('refuses a value offset that points past the end of the file', async () => {
		const file = makeTiff({ ...grey, extra: [{ tag: 258, type: SHORT, values: [8, 8, 8] }] });
		// The depths are the only out of line value in this fixture.
		const view = new DataView(file.buffer);
		for (let at = 8; at + 12 <= file.length; at += 2) {
			if (view.getUint16(at, true) === 258 && view.getUint16(at + 2, true) === SHORT) {
				view.setUint32(at + 8, 0xfffff, true);
				break;
			}
		}
		await expectRefusal(file, /values of its tag 258/);
	});

	it('refuses a directory chain that points back at itself', async () => {
		const file = makeTiff(grey);
		const view = new DataView(file.buffer);
		const start = view.getUint32(4, true);
		const count = view.getUint16(start, true);
		view.setUint32(start + 2 + count * 12, start, true);
		await expectRefusal(file, /points back at a directory/);
	});

	it('refuses a file whose first directory offset is zero', async () => {
		const file = makeTiff(grey);
		new DataView(file.buffer).setUint32(4, 0, true);
		await expectRefusal(file, /no image directory/);
	});

	it('refuses a field type TIFF does not define on a tag it needs', async () => {
		const file = makeTiff({ ...grey, extra: [{ tag: 256, type: 13, values: [2] }] });
		await expectRefusal(file, /type 13/);
	});
});

/* ── Geometry, strips and tiles ───────────────────────────────────────── */

describe('decodeTiff geometry', () => {
	const rows = bytes(1, 2, 3, 4, 5, 6, 7, 8);

	it('reads an image stored as several strips', async () => {
		const file = makeTiff({
			width: 2,
			height: 4,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 2,
			data: rows,
			offsets: [8, 12],
			counts: [4, 4],
		});
		const image = await decodeTiff(file);

		expect(image.height).toBe(4);
		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('reads a last strip that is shorter than the rest', async () => {
		const file = makeTiff({
			width: 2,
			height: 3,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 2,
			data: bytes(1, 2, 3, 4, 5, 6),
			offsets: [8, 12],
			counts: [4, 2],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
	});

	it('treats a missing rows per strip as one strip holding everything', async () => {
		const file = makeTiff({
			width: 2,
			height: 4,
			samples: 1,
			photometric: 1,
			data: rows,
			drop: [278],
		});

		expect((await decodeTiff(file)).height).toBe(4);
	});

	it('treats rows per strip larger than the image as one strip', async () => {
		const file = makeTiff({
			width: 2,
			height: 4,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 0xffffffff,
			data: rows,
		});

		expect((await decodeTiff(file)).height).toBe(4);
	});

	it('infers the length of an uncompressed strip that does not give one', async () => {
		const file = makeTiff({
			width: 2,
			height: 4,
			samples: 1,
			photometric: 1,
			data: rows,
			drop: [279],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		]);
	});

	it('reads a tiled image and crops the padding off its edges', async () => {
		// Four 2 by 2 tiles over a 4 by 3 image, so the bottom row of tiles hangs
		// over the edge by one row and half of each of those tiles is padding.
		const tiles = bytes(1, 2, 5, 6, 3, 4, 7, 8, 9, 10, 0, 0, 11, 12, 0, 0);
		const file = makeTiff({
			width: 4,
			height: 3,
			samples: 1,
			photometric: 1,
			data: tiles,
			drop: [273, 278, 279],
			extra: [
				{ tag: 322, type: SHORT, values: [2] },
				{ tag: 323, type: SHORT, values: [2] },
				{ tag: 324, type: LONG, values: [8, 12, 16, 20] },
				{ tag: 325, type: LONG, values: [4, 4, 4, 4] },
			],
		});
		const image = await decodeTiff(file);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
		]);
	});

	it('reads a planar file, one plane of samples after another', async () => {
		const planes = bytes(1, 2, 3, 4, 10, 20, 30, 40, 100, 200, 110, 210);
		const file = makeTiff({
			width: 2,
			height: 2,
			data: planes,
			offsets: [8, 12, 16],
			counts: [4, 4, 4],
			extra: [{ tag: 284, type: SHORT, values: [2] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			1, 10, 100, 255, 2, 20, 200, 255, 3, 30, 110, 255, 4, 40, 210, 255,
		]);
	});

	it('reads a planar tiled file', async () => {
		// One 2 by 2 tile per plane, over a 2 by 2 image.
		const file = makeTiff({
			width: 2,
			height: 2,
			data: bytes(1, 2, 3, 4, 10, 20, 30, 40, 100, 200, 110, 210),
			drop: [273, 278, 279],
			extra: [
				{ tag: 284, type: SHORT, values: [2] },
				{ tag: 322, type: SHORT, values: [2] },
				{ tag: 323, type: SHORT, values: [2] },
				{ tag: 324, type: LONG, values: [8, 12, 16] },
				{ tag: 325, type: LONG, values: [4, 4, 4] },
			],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			1, 10, 100, 255, 2, 20, 200, 255, 3, 30, 110, 255, 4, 40, 210, 255,
		]);
	});

	it('treats a missing bit depth as one bit, which is what the format says', async () => {
		const file = makeTiff({
			width: 4,
			height: 1,
			samples: 1,
			photometric: 1,
			data: bytes(0b10100000),
			drop: [258],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			255, 0, 255, 0,
		]);
	});

	it('infers a last strip that is shorter than the ones before it', async () => {
		// Three rows in strips of two, with no byte counts at all: the second
		// strip holds one row and is half the length of the first.
		const file = makeTiff({
			width: 2,
			height: 3,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 2,
			data: bytes(1, 2, 3, 4, 5, 6),
			offsets: [8, 12],
			drop: [279],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
	});

	it('infers the length of uncompressed tiles that do not give one', async () => {
		const file = makeTiff({
			width: 2,
			height: 2,
			samples: 1,
			photometric: 1,
			data: bytes(1, 2, 3, 4),
			drop: [273, 278, 279],
			extra: [
				{ tag: 322, type: SHORT, values: [2] },
				{ tag: 323, type: SHORT, values: [2] },
				{ tag: 324, type: LONG, values: [8] },
			],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			1, 2, 3, 4,
		]);
	});

	it('refuses a compressed tiled file that does not say how long its tiles are', async () => {
		const file = makeTiff({
			width: 2,
			height: 2,
			samples: 1,
			photometric: 1,
			compression: 32773,
			data: bytes(3, 1, 2, 3, 4),
			drop: [273, 278, 279],
			extra: [
				{ tag: 322, type: SHORT, values: [2] },
				{ tag: 323, type: SHORT, values: [2] },
				{ tag: 324, type: LONG, values: [8] },
			],
		});
		await expectRefusal(file, /0 tile lengths where it needs 1/);
	});

	it('refuses an image whose samples alone would not fit in memory', async () => {
		// Inside the pixel ceiling and far outside what six samples of it would
		// cost. Nothing is allocated to find that out.
		const file = makeTiff({
			width: 20000,
			height: 20000,
			samples: 6,
			photometric: 2,
			data: bytes(1, 2, 3, 4, 5, 6),
		});
		await expectRefusal(file, /more memory than this reader will ask for/);
	});

	it('refuses a directory with no width or height', async () => {
		const file = makeTiff({ width: 2, height: 1, data: rows, drop: [257] });
		await expectRefusal(file, /width and a height/);
	});

	it('refuses a width of zero', async () => {
		await expectRefusal(makeTiff({ width: 0, height: 1, data: rows }), /width and a height/);
	});

	it('refuses an image too large to allocate for, before allocating', async () => {
		const file = makeTiff({ width: 60000, height: 60000, data: rows });
		await expectRefusal(file, /far larger than anything/);
	});

	it('refuses a dimension that is not a number a TIFF can hold', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			data: rows,
			extra: [{ tag: 256, type: FLOAT, values: [Number.NaN] }],
		});
		await expectRefusal(file, /width is not a number/);
	});

	it('refuses zero rows per strip', async () => {
		const file = makeTiff({
			width: 2,
			height: 2,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 0,
			data: rows,
		});
		await expectRefusal(file, /zero rows per strip/);
	});

	it('refuses fewer strip offsets than the image needs', async () => {
		const file = makeTiff({
			width: 2,
			height: 4,
			samples: 1,
			photometric: 1,
			rowsPerStrip: 1,
			data: rows,
			counts: [2, 2, 2, 2],
		});
		await expectRefusal(file, /1 strip offsets/);
	});

	it('refuses a compressed file that does not say how long its strips are', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 1,
			photometric: 1,
			compression: 32773,
			data: bytes(1, 10, 200),
			drop: [279],
		});
		await expectRefusal(file, /strip lengths/);
	});

	it('refuses a strip that reaches past the end of the file', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 1,
			photometric: 1,
			data: rows,
			counts: [9999],
		});
		await expectRefusal(file, /end of one of its strips/);
	});

	it('refuses a strip shorter than the rows it holds', async () => {
		const file = makeTiff({
			width: 8,
			height: 4,
			samples: 1,
			photometric: 1,
			data: bytes(1, 2, 3, 4),
			counts: [4],
		});
		await expectRefusal(file, /shorter than the rows/);
	});

	it('refuses a tiled file with no tile size', async () => {
		const file = makeTiff({
			width: 4,
			height: 4,
			samples: 1,
			photometric: 1,
			data: rows,
			drop: [273, 279],
			extra: [{ tag: 324, type: LONG, values: [8] }],
		});
		await expectRefusal(file, /tile width and a tile height/);
	});

	it('refuses fewer tile offsets than the image needs', async () => {
		const file = makeTiff({
			width: 4,
			height: 4,
			samples: 1,
			photometric: 1,
			data: rows,
			drop: [273, 278, 279],
			extra: [
				{ tag: 322, type: SHORT, values: [2] },
				{ tag: 323, type: SHORT, values: [2] },
				{ tag: 324, type: LONG, values: [8] },
				{ tag: 325, type: LONG, values: [4] },
			],
		});
		await expectRefusal(file, /1 tile offsets/);
	});

	it('refuses more samples per pixel than it will read', async () => {
		const file = makeTiff({ width: 1, height: 1, samples: 20, data: new Uint8Array(20) });
		await expectRefusal(file, /20 samples per pixel/);
	});

	it('refuses a planar configuration that does not exist', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			data: rows,
			extra: [{ tag: 284, type: SHORT, values: [7] }],
		});
		await expectRefusal(file, /planar configuration 7/);
	});
});

/* ── Sample depths and formats ────────────────────────────────────────── */

describe('decodeTiff sample depths', () => {
	it('reads one bit samples, high bit first', async () => {
		// Eight pixels in one byte, then a row that needs padding to a whole byte.
		const file = makeTiff({
			width: 4,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 1,
			data: bytes(0b10100000, 0b01010000),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			255, 0, 255, 0, 0, 255, 0, 255,
		]);
	});

	it('reads two bit samples and scales them to full range', async () => {
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 2,
			samples: 1,
			photometric: 1,
			data: bytes(0b00011011),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0, 85, 170, 255,
		]);
	});

	it('reads four bit samples', async () => {
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 4,
			samples: 1,
			photometric: 1,
			data: bytes(0x0f, 0x80),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0, 255, 136,
		]);
	});

	it('reads sixteen bit samples by taking the high byte', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0x34, 0x12, 0xff, 0xff),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x12, 0xff,
		]);
	});

	it('reads sixteen bit samples in the file’s own byte order', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			little: false,
			data: bytes(0x12, 0x34, 0xff, 0xff),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x12, 0xff,
		]);
	});

	it('reads thirty-two bit integer samples by taking the high byte', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data: bytes(0, 0, 0, 0x40, 0xff, 0xff, 0xff, 0xff),
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x40, 0xff,
		]);
	});

	it('reads signed eight bit samples by biasing them, not clamping them', async () => {
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			data: bytes(0x80, 0x00, 0x7f),
			extra: [{ tag: 339, type: SHORT, values: [2] }],
		});

		// The most negative sample is black, zero is the middle, the most
		// positive is white.
		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0, 128, 255,
		]);
	});

	it('reads signed sixteen bit samples', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0x00, 0x80, 0xff, 0x7f),
			extra: [{ tag: 339, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0, 255,
		]);
	});

	it('reads signed thirty-two bit samples', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data: bytes(0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0x7f),
			extra: [{ tag: 339, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0, 255,
		]);
	});

	it('reads a sample format of 4, which means the writer did not say', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			data: bytes(10, 200),
			extra: [{ tag: 339, type: SHORT, values: [4] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			10, 200,
		]);
	});

	it('tone maps thirty-two bit floating point samples', async () => {
		const data = new Uint8Array(16);
		const view = new DataView(data.buffer);
		[0.05, 0.18, 0.5, 4].forEach((value, i) => view.setFloat32(i * 4, value, true));
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data,
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		const image = await decodeTiff(file);
		const greys = Array.from(image.data.filter((_, i) => i % 4 === 0));

		// The exposure is chosen from the picture, so the values are not fixed,
		// but the order and the ends of the range are.
		expect(greys[0]).toBeLessThan(greys[1] as number);
		expect(greys[1]).toBeLessThan(greys[2] as number);
		expect(greys[2]).toBeLessThan(greys[3] as number);
		expect(greys[3]).toBe(255);
		expect(image.hasAlpha).toBe(false);
	});

	it('scales floating point samples that never exceed 1 rather than metering them', async () => {
		// ImageMagick and GDAL both write ordinary pictures as float TIFFs, with
		// the eight bit value over 255 in every sample. Metering that against
		// middle grey re-exposes a picture that was never scene referred: these
		// four samples come back 0, 85, 118, 162 under the meter and 0, 64, 128,
		// 255 here, which is what ImageMagick reads back out of its own file.
		const data = new Uint8Array(16);
		const view = new DataView(data.buffer);
		[0, 0.25, 0.5, 1].forEach((value, i) => view.setFloat32(i * 4, value, true));
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data,
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		const image = await decodeTiff(file);

		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual([0, 64, 128, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('meters a float picture again as soon as one sample passes 1', async () => {
		// The same four samples with the last one just over the ceiling. One
		// value is the whole difference between a picture and a measurement, so
		// the highlight rolls off and nothing lands on the scaled values above.
		const data = new Uint8Array(16);
		const view = new DataView(data.buffer);
		[0, 0.25, 0.5, 1.5].forEach((value, i) => view.setFloat32(i * 4, value, true));
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data,
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		const greys = Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0));

		expect(greys[0]).toBe(0);
		expect(greys).not.toEqual([0, 64, 128, 255]);
		expect(greys[1]).toBeLessThan(greys[2] as number);
		expect(greys[2]).toBeLessThan(greys[3] as number);
	});

	it('reads sixteen bit half floats', async () => {
		// 0x3c00 is 1.0, 0x3800 is 0.5, 0x0000 is zero.
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0x00, 0x00, 0x00, 0x38, 0x00, 0x3c),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		const greys = Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0));

		// Nothing here passes 1, so the samples are scaled rather than metered
		// and the halves can be checked exactly. That is the assertion worth
		// having: a half read as two bytes rather than as a number would not
		// land on 128.
		expect(greys).toEqual([0, 128, 255]);
	});

	it('reads floating point colour with an alpha channel', async () => {
		const data = new Uint8Array(4 * 4 * 2);
		const view = new DataView(data.buffer);
		[0.2, 0.4, 0.6, 1, 0.8, 0.1, 0.3, 0.5].forEach((value, i) =>
			view.setFloat32(i * 4, value, true),
		);
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 4,
			data,
			extra: [
				{ tag: 338, type: SHORT, values: [2] },
				{ tag: 339, type: SHORT, values: [3, 3, 3, 3] },
			],
		});
		const image = await decodeTiff(file);

		expect(image.hasAlpha).toBe(true);
		expect(image.data[3]).toBe(255);
		expect(image.data[7]).toBe(128);
	});

	it('divides associated alpha out of floating point colour', async () => {
		const data = new Uint8Array(4 * 4 * 2);
		const view = new DataView(data.buffer);
		// The first pixel is half covered and was multiplied down when it was
		// written; the second is opaque. Both are the same colour underneath, so
		// they have to come back the same.
		[0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 1].forEach((value, i) =>
			view.setFloat32(i * 4, value, true),
		);
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 4,
			data,
			extra: [
				{ tag: 338, type: SHORT, values: [1] },
				{ tag: 339, type: SHORT, values: [3, 3, 3, 3] },
			],
		});
		const image = await decodeTiff(file);

		expect(image.data[0]).toBe(image.data[4]);
		expect(image.data[3]).toBe(128);
		expect(image.data[7]).toBe(255);
	});

	it('leaves alpha alone while metering a float picture that runs past 1', async () => {
		const data = new Uint8Array(4 * 4 * 2);
		const view = new DataView(data.buffer);
		[0.2, 0.4, 0.6, 1, 6, 0.1, 0.3, 0.5].forEach((value, i) => view.setFloat32(i * 4, value, true));
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 4,
			data,
			extra: [
				{ tag: 338, type: SHORT, values: [2] },
				{ tag: 339, type: SHORT, values: [3, 3, 3, 3] },
			],
		});
		const image = await decodeTiff(file);

		// Coverage is not light, so the exposure the highlight forces on the
		// colour must not touch it.
		expect(image.data[3]).toBe(255);
		expect(image.data[7]).toBe(128);
	});

	it('refuses a depth it does not know', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 24,
			samples: 1,
			photometric: 1,
			data: bytes(0, 0, 0),
		});
		await expectRefusal(file, /24 bits deep/);
	});

	it('refuses samples of different depths in one pixel', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			data: bytes(0, 0, 0, 0),
			extra: [{ tag: 258, type: SHORT, values: [8, 16, 8] }],
		});
		await expectRefusal(file, /8 and 16 bits deep/);
	});

	it('refuses complex samples by name', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data: new Uint8Array(4),
			extra: [{ tag: 339, type: SHORT, values: [5] }],
		});
		await expectRefusal(file, /complex numbers/);
	});

	it('refuses floating point samples at a size that is not a float', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			data: bytes(0),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		await expectRefusal(file, /8 bit floating point/);
	});

	it('refuses floating point samples under a palette', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 3,
			data: new Uint8Array(4),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});
		await expectRefusal(file, /palette or ink/);
	});
});

/* ── Colour interpretations ───────────────────────────────────────────── */

describe('decodeTiff colour interpretations', () => {
	it('reads RGB', async () => {
		const file = makeTiff({ width: 2, height: 1, data: bytes(255, 0, 0, 0, 128, 255) });

		expect(pixelsOf(await decodeTiff(file))).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
	});

	it('reads BlackIsZero greyscale', async () => {
		const file = makeTiff({ width: 2, height: 1, samples: 1, photometric: 1, data: bytes(0, 255) });

		expect(pixelsOf(await decodeTiff(file))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	});

	it('inverts WhiteIsZero greyscale', async () => {
		const file = makeTiff({ width: 2, height: 1, samples: 1, photometric: 0, data: bytes(0, 255) });

		expect(pixelsOf(await decodeTiff(file))).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
	});

	it('reads a palette, whose map is three runs rather than triples', async () => {
		// Four entries, so twelve values: four reds, then four greens, then four
		// blues. Read as triples this would be the right shapes in the wrong
		// colours, which is easy to miss.
		const map = [0, 65535, 0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535];
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 2,
			samples: 1,
			photometric: 3,
			data: bytes(0b00011011),
			extra: [{ tag: 320, type: SHORT, values: map }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
		]);
	});

	it('reads a palette whose writer filled a sixteen bit map with eight bit values', async () => {
		// Nothing in the map exceeds 255, so the writer meant eight bits. Taking
		// the high byte instead would make the whole image black.
		const map = [0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255];
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 2,
			samples: 1,
			photometric: 3,
			data: bytes(0b00011011),
			extra: [{ tag: 320, type: SHORT, values: map }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
		]);
	});

	it('reads an eight bit palette', async () => {
		const map = new Array<number>(768).fill(0);
		map[1] = 65535;
		map[256 + 1] = 32768;
		map[512 + 1] = 0;
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 3,
			data: bytes(0, 1),
			extra: [{ tag: 320, type: SHORT, values: map }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([0, 0, 0, 255, 255, 128, 0, 255]);
	});

	it('reads CMYK as ink coverage', async () => {
		// No ink at all is white, full black ink is black, and full cyan with no
		// black is what cyan looks like.
		const file = makeTiff({
			width: 3,
			height: 1,
			samples: 4,
			photometric: 5,
			data: bytes(0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0),
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255,
		]);
	});

	it('reads a transparency mask as coverage over nothing', async () => {
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 4,
			data: bytes(0b11000000),
		});
		const image = await decodeTiff(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it('defaults to RGB when three samples arrive with no photometric tag', async () => {
		const file = makeTiff({ width: 1, height: 1, data: bytes(1, 2, 3), drop: [262] });

		expect(pixelsOf(await decodeTiff(file))).toEqual([1, 2, 3, 255]);
	});

	it('defaults to greyscale when one sample arrives with no photometric tag', async () => {
		const file = makeTiff({ width: 1, height: 1, samples: 1, data: bytes(9), drop: [262] });

		expect(pixelsOf(await decodeTiff(file))).toEqual([9, 9, 9, 255]);
	});

	it.each([
		[6, /YCbCr/],
		[8, /CIELab/],
		[9, /ICCLab/],
		[10, /ITULab/],
		[42, /interpretation 42/],
	])('refuses photometric %i by name', async (photometric, pattern) => {
		const file = makeTiff({ width: 1, height: 1, photometric, data: bytes(1, 2, 3) });
		await expectRefusal(file, pattern);
	});

	it('refuses fewer samples than the colour interpretation spends', async () => {
		const file = makeTiff({ width: 1, height: 1, samples: 2, photometric: 5, data: bytes(1, 2) });
		await expectRefusal(file, /fewer than its colour interpretation/);
	});

	it('refuses separated samples that are not CMYK inks', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			samples: 4,
			photometric: 5,
			data: bytes(1, 2, 3, 4),
			extra: [{ tag: 332, type: SHORT, values: [2] }],
		});
		await expectRefusal(file, /not CMYK inks/);
	});

	it('refuses a palettised file with no colour map', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 4,
			samples: 1,
			photometric: 3,
			data: bytes(0),
		});
		await expectRefusal(file, /no colour map/);
	});

	it('refuses a colour map with fewer entries than the depth indexes', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 4,
			samples: 1,
			photometric: 3,
			data: bytes(0),
			extra: [{ tag: 320, type: SHORT, values: [0, 0, 0] }],
		});
		await expectRefusal(file, /colour map holds 3 values/);
	});

	it('refuses a palette deeper than eight bits', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 3,
			data: bytes(0, 0),
		});
		await expectRefusal(file, /palettised at 16 bits/);
	});

	it('refuses a palette with more than one sample per pixel', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 8,
			samples: 2,
			photometric: 3,
			data: bytes(0, 0),
		});
		await expectRefusal(file, /more than one sample/);
	});

	it('refuses a transparency mask that is not one bit', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 4,
			data: bytes(0),
		});
		await expectRefusal(file, /not one bit per pixel/);
	});
});

/* ── Alpha ────────────────────────────────────────────────────────────── */

describe('decodeTiff alpha', () => {
	const translucent = bytes(200, 100, 50, 128, 10, 20, 30, 255);

	it('reads an unassociated alpha channel as it stands', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 4,
			data: translucent,
			extra: [{ tag: 338, type: SHORT, values: [2] }],
		});
		const image = await decodeTiff(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual([200, 100, 50, 128, 10, 20, 30, 255]);
	});

	it('drops an extra sample the writer called unspecified rather than reading it as alpha', async () => {
		// ExtraSamples 0 is "unspecified data", which is the writer saying the
		// channel is not coverage. Reading it as alpha makes the first pixel of
		// this file, whose fourth sample is 4, all but invisible, and the same
		// mistake takes the left edge off any picture written with
		// `-define tiff:alpha=unspecified`. ImageMagick and Pillow both drop it.
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 4,
			data: bytes(200, 100, 50, 4, 10, 20, 30, 255),
			extra: [{ tag: 338, type: SHORT, values: [0] }],
		});
		const image = await decodeTiff(file);

		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual([200, 100, 50, 255, 10, 20, 30, 255]);
	});

	it('reads a fourth sample with no extra samples tag as alpha', async () => {
		const file = makeTiff({ width: 2, height: 1, samples: 4, data: translucent });

		expect(pixelsOf(await decodeTiff(file))).toEqual([200, 100, 50, 128, 10, 20, 30, 255]);
	});

	it('divides associated alpha back out', async () => {
		// 100 at half coverage was 200 before the writer multiplied it down.
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 4,
			data: bytes(100, 50, 25, 128, 10, 20, 30, 255),
			extra: [{ tag: 338, type: SHORT, values: [1] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([199, 100, 50, 128, 10, 20, 30, 255]);
	});

	it('leaves a fully transparent associated pixel with no colour', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			samples: 4,
			data: bytes(90, 90, 90, 0),
			extra: [{ tag: 338, type: SHORT, values: [1] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([0, 0, 0, 0]);
	});

	it('reads greyscale with an alpha channel', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 2,
			photometric: 1,
			data: bytes(200, 128, 50, 255),
			extra: [{ tag: 338, type: SHORT, values: [2] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([200, 200, 200, 128, 50, 50, 50, 255]);
	});

	it('reports no alpha for a file whose alpha channel is opaque throughout', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			samples: 4,
			data: bytes(1, 2, 3, 255),
			extra: [{ tag: 338, type: SHORT, values: [2] }],
		});

		expect((await decodeTiff(file)).hasAlpha).toBe(false);
	});
});

/* ── Compression ──────────────────────────────────────────────────────── */

describe('decodeTiff compression', () => {
	/** A row that PackBits and LZW both have something to say about. */
	const source = Uint8Array.from([
		1, 1, 1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
	]);

	function greyFile(data: Uint8Array, compression: number): Uint8Array {
		return makeTiff({
			width: source.length,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			compression,
			data,
		});
	}

	async function greysOf(file: Uint8Array): Promise<number[]> {
		return Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0));
	}

	it('reads uncompressed samples', async () => {
		expect(await greysOf(greyFile(source, 1))).toEqual(Array.from(source));
	});

	it('reads PackBits', async () => {
		expect(await greysOf(greyFile(packBits(source), 32773))).toEqual(Array.from(source));
	});

	it('reads a PackBits no-op byte', async () => {
		const data = Uint8Array.from([128, 1, 10, 20, 128, 0, 30]);
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			compression: 32773,
			data,
		});

		expect(await greysOf(file)).toEqual([10, 20, 30]);
	});

	it('discards PackBits output past the end of the rows', async () => {
		// A writer that padded the last row out to a whole run. Every other
		// reader takes the rows it asked for and drops the rest.
		const data = Uint8Array.from([0xfa, 7]);
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 1,
			compression: 32773,
			data,
		});

		expect(await greysOf(file)).toEqual([7, 7, 7]);
	});

	it('reads LZW', async () => {
		expect(await greysOf(greyFile(lzwCompress(source), 5))).toEqual(Array.from(source));
	});

	it('reads LZW that crosses every code width boundary', async () => {
		// Long enough to fill the table past 511, 1023 and 2047 entries, which
		// is where the early change matters and where a decoder that grows the
		// code width one step late starts producing plausible rubbish.
		const long = new Uint8Array(20000);
		let state = 12345;
		for (let i = 0; i < long.length; i += 1) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			long[i] = (state >> 16) & 0xff;
		}
		const file = makeTiff({
			width: 100,
			height: 200,
			bits: 8,
			samples: 1,
			photometric: 1,
			compression: 5,
			data: lzwCompress(long),
		});
		const image = await decodeTiff(file);

		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual(Array.from(long));
	});

	it('tolerates a writer that grew the code width one code late', async () => {
		// The GIF timing rather than the TIFF one. Read under the correct rule
		// this file fails, so the decoder falls back rather than handing back a
		// picture with a tear in it.
		const long = new Uint8Array(8000);
		for (let i = 0; i < long.length; i += 1) long[i] = (i * 7 + (i >> 5)) & 0xff;
		const file = makeTiff({
			width: 100,
			height: 80,
			bits: 8,
			samples: 1,
			photometric: 1,
			compression: 5,
			data: lzwCompress(long, false),
		});
		const image = await decodeTiff(file);

		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual(Array.from(long));
	});

	it('reads Deflate under both of its compression numbers', async () => {
		for (const compression of [8, 32946]) {
			const file = greyFile(await deflate(source), compression);
			expect(await greysOf(file)).toEqual(Array.from(source));
		}
	});

	it('reads a strip whose compressor emitted more bytes than the rows need', async () => {
		const padded = new Uint8Array(source.length + 10);
		padded.set(source);
		const file = greyFile(await deflate(padded), 8);

		expect(await greysOf(file)).toEqual(Array.from(source));
	});

	it('refuses a PackBits strip that ends early', async () => {
		await expectRefusal(greyFile(Uint8Array.from([0, 1]), 32773), /PackBits.*ends before/);
	});

	it('refuses a PackBits literal run that reaches past its strip', async () => {
		await expectRefusal(greyFile(Uint8Array.from([20, 1, 2]), 32773), /literal run reaches past/);
	});

	it('refuses a PackBits repeat with no byte to repeat', async () => {
		await expectRefusal(greyFile(Uint8Array.from([250]), 32773), /no byte to repeat/);
	});

	it('refuses an LZW strip that ends before its rows do', async () => {
		const short = lzwCompress(source).subarray(0, 3);
		await expectRefusal(greyFile(short, 5), /LZW.*ends before/);
	});

	it('refuses an LZW strip whose end of information arrives early', async () => {
		// A complete, well formed stream that simply holds fewer bytes than the
		// rows need. Nothing about it is corrupt until you ask how long it is.
		const short = lzwCompress(source.subarray(0, 4));
		await expectRefusal(greyFile(short, 5), /ends before its rows are complete/);
	});

	it('refuses an LZW code that names a table entry nothing defined', async () => {
		// A clear code, then a code far above anything the table can hold.
		const writer = new MsbBitWriter();
		writer.write(256, 9);
		writer.write(400, 9);
		writer.write(400, 9);
		await expectRefusal(greyFile(writer.finish(), 5), /has not been defined/);
	});

	it('refuses a deflate strip that does not begin with a zlib header', async () => {
		// The first byte's low nibble is the compression method and has to be 8.
		const junk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		await expectRefusal(greyFile(junk, 8), /zlib header/);
	});

	it('refuses a deflate strip whose header is not a multiple of 31', async () => {
		// The method nibble is right and the check bits are not, which is the
		// half of the header a corrupt byte is most likely to leave standing.
		const junk = Uint8Array.from([0x78, 0x9d, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		await expectRefusal(greyFile(junk, 8), /zlib header/);
	});

	it('says so when the browser cannot decompress at all', async () => {
		// A browser too old for DecompressionStream is a different problem from
		// a damaged file, and reporting it as a damaged file would send somebody
		// looking for a corrupt scanner.
		const file = greyFile(await deflate(source), 8);
		const original = globalThis.DecompressionStream;
		Reflect.deleteProperty(globalThis, 'DecompressionStream');
		try {
			await expect(decodeTiff(file)).rejects.toBeInstanceOf(CodecUnavailableError);
		} finally {
			globalThis.DecompressionStream = original;
		}
	});

	it('refuses a deflate strip that expands to less than its rows hold', async () => {
		const file = greyFile(await deflate(source.subarray(0, 4)), 8);
		await expectRefusal(file, /less than its rows hold/);
	});

	it.each([
		[6, /old style JPEG/],
		[7, /JPEG compression \(7\)/],
		[32771, /word boundaries/],
		[34712, /JPEG 2000/],
		[34925, /LZMA/],
		[50000, /Zstandard/],
		[50001, /WebP/],
		[9999, /compression method 9999/],
	])('refuses compression %i by name', async (compression, pattern) => {
		await expectRefusal(greyFile(source, compression), pattern);
	});
});

/* ── The predictor ────────────────────────────────────────────────────── */

describe('decodeTiff horizontal differencing', () => {
	it('undoes differencing across a chunky RGB row, per channel', async () => {
		// Two pixels, the second one three brighter in every channel.
		const file = makeTiff({
			width: 2,
			height: 2,
			data: bytes(10, 20, 30, 3, 3, 3, 200, 100, 50, 60, 60, 60),
			rowsPerStrip: 2,
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([
			10, 20, 30, 255, 13, 23, 33, 255, 200, 100, 50, 255, 4, 160, 110, 255,
		]);
	});

	it('wraps a difference that runs off the end of a byte', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 1,
			photometric: 1,
			data: bytes(250, 16),
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			250, 10,
		]);
	});

	it('differences sixteen bit samples as whole samples, not as bytes', async () => {
		// 0x1234 then a difference of 0x1111, which is 0x2345. Byte by byte it
		// would come out 0x2345 only by accident and 0x23FF here instead.
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0x34, 0x12, 0x11, 0x11),
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x12, 0x23,
		]);
	});

	it('differences sixteen bit samples in the file’s byte order', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			little: false,
			data: bytes(0x12, 0x34, 0x11, 0x11),
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x12, 0x23,
		]);
	});

	it('differences thirty-two bit samples', async () => {
		const data = new Uint8Array(8);
		const view = new DataView(data.buffer);
		view.setUint32(0, 0x40000000, true);
		view.setUint32(4, 0x10000000, true);
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data,
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			0x40, 0x50,
		]);
	});

	it('undoes differencing per plane in a planar file', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			data: bytes(10, 5, 20, 5, 30, 5),
			offsets: [8, 10, 12],
			counts: [2, 2, 2],
			extra: [
				{ tag: 284, type: SHORT, values: [2] },
				{ tag: 317, type: SHORT, values: [2] },
			],
		});

		expect(pixelsOf(await decodeTiff(file))).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
	});

	it('refuses the floating point predictor by name', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			data: bytes(1, 2, 3),
			extra: [{ tag: 317, type: SHORT, values: [3] }],
		});
		await expectRefusal(file, /floating point predictor/);
	});

	it('refuses a predictor it does not know', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			data: bytes(1, 2, 3),
			extra: [{ tag: 317, type: SHORT, values: [9] }],
		});
		await expectRefusal(file, /predictor 9/);
	});

	it('refuses differencing at a depth the format does not define it for', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 4,
			samples: 1,
			photometric: 1,
			data: bytes(0x12),
			extra: [{ tag: 317, type: SHORT, values: [2] }],
		});
		await expectRefusal(file, /4 bit samples/);
	});
});

/* ── CCITT ────────────────────────────────────────────────────────────── */

describe('decodeTiff CCITT', () => {
	/** A 16 pixel row: four white, four black, eight white. */
	function oneRow(writer: MsbBitWriter): void {
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, BLACK[4] as string);
		writeBits(writer, WHITE[8] as string);
	}

	function faxFile(data: Uint8Array, compression: number, extra: FieldSpec[] = []): Uint8Array {
		return makeTiff({
			width: 16,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression,
			data,
			extra,
		});
	}

	/** White is 255 under WhiteIsZero, which is how a fax is always tagged. */
	const expected = [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255];

	async function greysOf(file: Uint8Array): Promise<number[]> {
		return Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0));
	}

	it('reads modified Huffman, which has no end of line codes', async () => {
		const writer = new MsbBitWriter();
		oneRow(writer);
		expect(await greysOf(faxFile(writer.finish(), 2))).toEqual(expected);
	});

	it('restarts each modified Huffman row on a byte boundary', async () => {
		const writer = new MsbBitWriter();
		oneRow(writer);
		// The row above is 4 + 3 + 5 bits, so the rest of this byte is padding
		// that the next row must not read as data.
		writer.alignToByte();
		writeBits(writer, WHITE[16] as string);
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 2,
			data: writer.finish(),
		});

		expect((await greysOf(file)).slice(16)).toEqual(new Array<number>(16).fill(255));
	});

	it('reads Group 3 one dimensional rows separated by end of line codes', async () => {
		const writer = new MsbBitWriter();
		writeBits(writer, EOL);
		oneRow(writer);
		expect(await greysOf(faxFile(writer.finish(), 3))).toEqual(expected);
	});

	it('reads Group 3 with no leading end of line at all', async () => {
		const writer = new MsbBitWriter();
		oneRow(writer);
		expect(await greysOf(faxFile(writer.finish(), 3))).toEqual(expected);
	});

	it('reads Group 3 with fill bits before the end of line', async () => {
		const writer = new MsbBitWriter();
		writeBits(writer, '0000');
		writeBits(writer, EOL);
		oneRow(writer);
		const file = faxFile(writer.finish(), 3, [{ tag: 292, type: LONG, values: [4] }]);

		expect(await greysOf(file)).toEqual(expected);
	});

	it('reads a Group 3 row coded two dimensionally against the row above', async () => {
		const writer = new MsbBitWriter();
		// A one dimensional row first, then a row that says every transition is
		// exactly where it was, which is one bit each.
		writeBits(writer, EOL);
		writeBits(writer, '1');
		oneRow(writer);
		writeBits(writer, EOL);
		writeBits(writer, '0');
		writeBits(writer, '1'); // V0 at the first transition
		writeBits(writer, '1'); // V0 at the second
		writeBits(writer, '1'); // V0 at the end of the row
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 3,
			data: writer.finish(),
			extra: [{ tag: 292, type: LONG, values: [1] }],
		});

		expect(await greysOf(file)).toEqual([...expected, ...expected]);
	});

	it('reads a Group 4 row, which is two dimensional with no framing at all', async () => {
		const writer = new MsbBitWriter();
		// The reference row above the first row is imaginary and all white, so
		// its transitions are both at the end of the row. Horizontal mode gives
		// the two runs directly.
		writeBits(writer, '001'); // horizontal
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, BLACK[4] as string);
		writeBits(writer, '001'); // horizontal again
		writeBits(writer, WHITE[8] as string);
		writeBits(writer, BLACK[0] === undefined ? '0000110111' : '0000110111');
		const file = faxFile(writer.finish(), 4);

		expect(await greysOf(file)).toEqual(expected);
	});

	it('reads a Group 4 pass code, which runs through a mark that ended above', async () => {
		const writer = new MsbBitWriter();
		// Row one: white 4, black 4, white 8.
		writeBits(writer, '001');
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, BLACK[4] as string);
		writeBits(writer, '001');
		writeBits(writer, WHITE[8] as string);
		writeBits(writer, '0000110111');
		// Row two: a pass over both of the transitions above, leaving the row
		// entirely white.
		writeBits(writer, '0001');
		writeBits(writer, '1'); // V0 against the end of the row
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});

		expect((await greysOf(file)).slice(16)).toEqual(new Array<number>(16).fill(255));
	});

	it('reads a vertical code that steps back behind a pass code', async () => {
		// The one place the coding position moves backwards along the reference
		// row: a pass carries it forward to b2, and the vertical code after it
		// puts it up to three pixels behind where the pass left it. A search for
		// b1 that only ever walks forward reads the wrong element from there and
		// paints black from pixel 9 to pixel 15.
		const writer = new MsbBitWriter();
		// Row one: white 8, black 2, white 2, black 4, white to the end.
		writeBits(writer, '001');
		writeBits(writer, WHITE[8] as string);
		writeBits(writer, BLACK[2] as string);
		writeBits(writer, '001');
		writeBits(writer, WHITE[2] as string);
		writeBits(writer, BLACK[4] as string);
		writeBits(writer, '1');
		// Row two: pass over the first mark, then a vertical code three pixels
		// back, then the rest of the row where it was.
		writeBits(writer, '0001');
		writeBits(writer, '0000010');
		writeBits(writer, '1');
		writeBits(writer, '1');
		writeBits(writer, '1');
		writeBits(writer, '1');
		const file = makeTiff({
			width: 24,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});
		const rows = await greysOf(file);
		const marks = (row: readonly number[]): string =>
			row.map((v) => (v === 0 ? 'x' : '.')).join('');

		expect(marks(rows.slice(0, 24))).toBe('........xx..xxxx........');
		expect(marks(rows.slice(24))).toBe('.........x..xxxx........');
	});

	it.each([
		['011', 1],
		['000011', 2],
		['0000011', 3],
		['010', -1],
		['000010', -2],
		['0000010', -3],
	])('reads the vertical code %s as an offset of %i', async (code, offset) => {
		const writer = new MsbBitWriter();
		// Row one puts a transition to black at 8 and back at 12.
		writeBits(writer, '001');
		writeBits(writer, WHITE[8] as string);
		writeBits(writer, BLACK[4] as string);
		writeBits(writer, '1'); // V0 for the end of the row
		// Row two moves that first transition by the offset under test.
		writeBits(writer, code);
		writeBits(writer, '1'); // V0 for the second transition
		writeBits(writer, '1'); // V0 for the end
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});
		const second = (await greysOf(file)).slice(16);

		expect(second.indexOf(0)).toBe(8 + offset);
		expect(second.lastIndexOf(0)).toBe(11);
	});

	it('expands a wide Group 4 halftone in linear time', () => {
		// A halftone is the worst case the two dimensional coder has: every
		// pixel is a changing element, so a row 80000 across carries 80000 of
		// them, and the search along the row above runs once per element. A
		// search that restarts at the front of that row each time is quadratic:
		// this strip, which is 147 KiB, took 12.9 seconds on the machine that
		// wrote the test and takes 17 milliseconds now. There is no worker in
		// this package, so all of it is the browser's main thread, and the same
		// picture at the 400 megapixel ceiling would have run for minutes.
		//
		// Called straight rather than through `decodeTiff`, because the point is
		// the loop and not the megapixel of raster around it. The bound is slack
		// rather than a measurement: the slowest this has been measured at is
		// 190 milliseconds, under coverage alongside the rest of the suite.
		const columns = 80000;
		const rows = 10;
		const writer = new MsbBitWriter();
		// The first row has nothing above it but imaginary white, so every pair
		// of pixels is a horizontal code carrying two runs of one.
		for (let x = 0; x < columns; x += 2) {
			writeBits(writer, '001');
			writeBits(writer, WHITE[1] as string);
			writeBits(writer, BLACK[1] as string);
		}
		// Every row after it is the same row, so every changing element is a V0,
		// which is the single bit a page of text spends most of its time in.
		for (let row = 1; row < rows; row += 1) {
			for (let x = 0; x < columns; x += 1) writeBits(writer, '1');
		}
		const strip = writer.finish();

		const started = performance.now();
		const out = decodeCcitt(strip, { kind: 'group-4', columns, rows, options: 0 });
		const took = performance.now() - started;

		// White, black, white, black is 0x55, and every byte of every row is
		// that, top and bottom alike.
		expect(out.length).toBe((columns / 8) * rows);
		expect(new Set(out)).toEqual(new Set([0x55]));
		expect(took).toBeLessThan(1500);
	});

	it('reads a run longer than the tables code in one go', async () => {
		// 68 white pixels is a make-up code for 64 and a terminating code for 4.
		const writer = new MsbBitWriter();
		writeBits(writer, WHITE[64] as string);
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, BLACK[16] as string);
		writeBits(writer, WHITE[16] as string);
		const file = makeTiff({
			width: 100,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 2,
			data: writer.finish(),
		});
		const greys = await greysOf(file);

		expect(greys.slice(0, 68)).toEqual(new Array<number>(68).fill(255));
		expect(greys.slice(68, 84)).toEqual(new Array<number>(16).fill(0));
		expect(greys.slice(84)).toEqual(new Array<number>(16).fill(255));
	});

	it('pads the rest of a row that ends at an early end of line', async () => {
		const writer = new MsbBitWriter();
		writeBits(writer, WHITE[2] as string);
		writeBits(writer, BLACK[2] as string);
		writeBits(writer, EOL);
		writeBits(writer, WHITE[16] as string);
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 3,
			data: writer.finish(),
		});
		const greys = await greysOf(file);

		expect(greys.slice(0, 4)).toEqual([255, 255, 0, 0]);
		expect(greys.slice(4, 16)).toEqual(new Array<number>(12).fill(255));
	});

	it('honours a reversed fill order', async () => {
		const writer = new MsbBitWriter();
		oneRow(writer);
		const forward = writer.finish();
		const reversed = forward.map((byte) => {
			let out = 0;
			for (let i = 0; i < 8; i += 1) out |= ((byte >> i) & 1) << (7 - i);
			return out;
		});
		const file = faxFile(reversed, 2, [{ tag: 266, type: SHORT, values: [2] }]);

		expect(await greysOf(file)).toEqual(expected);
	});

	it('honours a reversed fill order on uncompressed bits as well', async () => {
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 1,
			data: bytes(0b00000101),
			extra: [{ tag: 266, type: SHORT, values: [2] }],
		});

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([
			255, 0, 255, 0,
		]);
	});

	it('refuses a fill order that does not exist', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			samples: 1,
			photometric: 1,
			bits: 8,
			data: bytes(1, 2),
			extra: [{ tag: 266, type: SHORT, values: [3] }],
		});
		await expectRefusal(file, /fill order 3/);
	});

	it('refuses CCITT uncompressed mode by name', async () => {
		const writer = new MsbBitWriter();
		writeBits(writer, '0000001');
		writeBits(writer, '111');
		await expectRefusal(faxFile(writer.finish(), 4), /uncompressed mode/);
	});

	it('refuses a run length code that is not in the tables', async () => {
		// Nine zero bits and then a one. Only an end of line begins with as many
		// as eleven zeros, and no code in either table begins with nine, so
		// fourteen bits go by without matching anything.
		const writer = new MsbBitWriter();
		writeBits(writer, '00000000010000000000');
		await expectRefusal(faxFile(writer.finish(), 2), /not in the CCITT tables/);
	});

	it('refuses compressed data that ends before the last row', async () => {
		const writer = new MsbBitWriter();
		oneRow(writer);
		const file = makeTiff({
			width: 16,
			height: 4,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 2,
			data: writer.finish(),
		});
		await expectRefusal(file, /ends after 1 of 4 rows/);
	});

	it('refuses a Group 4 image whose end of block arrives early', async () => {
		const writer = new MsbBitWriter();
		writeBits(writer, '001');
		writeBits(writer, WHITE[16] as string);
		writeBits(writer, '0000110111');
		writeBits(writer, EOL);
		writeBits(writer, EOL);
		const file = makeTiff({
			width: 16,
			height: 4,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});
		await expectRefusal(file, /ends after 1 of 4 rows/);
	});

	it('refuses a vertical code that moves back up its own row', async () => {
		const writer = new MsbBitWriter();
		// The first row changes colour at 4 and back at 5, so the second row's
		// first code puts a transition at 4 and its second finds b1 at 5. Three
		// to the left of that is 2, which is behind the transition this row has
		// already recorded, and a row whose changing elements run backwards
		// cannot be painted.
		writeBits(writer, '001');
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, BLACK[1] as string);
		writeBits(writer, '1');
		writeBits(writer, '1'); // V0, which lands on 4
		writeBits(writer, '0000010'); // VL3 against b1 at 5, which is 2
		const file = makeTiff({
			width: 16,
			height: 2,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});
		await expectRefusal(file, /back up its own row/);
	});

	it('refuses a run longer than any row could hold', async () => {
		// The make-up code for 2560 repeated. Runs longer than 2560 are written
		// as several of these, so nothing but the total bounds them.
		const writer = new MsbBitWriter();
		for (let i = 0; i < 30; i += 1) writeBits(writer, '000000011111');
		await expectRefusal(faxFile(writer.finish(), 2), /longer than any row could hold/);
	});

	it('refuses a row that holds more runs than it has pixels', async () => {
		// Runs of zero length are legal one at a time, at the start of a row that
		// begins in black. A row made of nothing else never reaches its own last
		// pixel, so the count of runs is what has to stop it.
		const writer = new MsbBitWriter();
		for (let i = 0; i < 16; i += 1) {
			writeBits(writer, i % 2 === 0 ? (WHITE[0] as string) : (BLACK[0] as string));
		}
		const file = makeTiff({
			width: 8,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 2,
			data: writer.finish(),
		});
		await expectRefusal(file, /more runs than it has pixels/);
	});

	it('refuses a two dimensional row with more changing elements than pixels', async () => {
		const writer = new MsbBitWriter();
		for (let i = 0; i < 10; i += 1) {
			writeBits(writer, '001');
			writeBits(writer, WHITE[0] as string);
			writeBits(writer, BLACK[0] as string);
		}
		const file = makeTiff({
			width: 8,
			height: 1,
			bits: 1,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: writer.finish(),
		});
		await expectRefusal(file, /more changing elements than it has pixels/);
	});

	it('refuses data that runs out in the middle of a code', async () => {
		// Four bits of a white run of 4, then twelve bits that are not a code and
		// are also all the file has left.
		const writer = new MsbBitWriter();
		writeBits(writer, WHITE[4] as string);
		writeBits(writer, '000000000100');
		await expectRefusal(faxFile(writer.finish(), 2), /ends before the last row is complete/);
	});

	it('refuses CCITT at a depth that cannot be coded', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 8,
			samples: 1,
			photometric: 0,
			compression: 4,
			data: bytes(1, 2),
		});
		await expectRefusal(file, /one bit per pixel/);
	});
});

/* ── Strips of CCITT from libtiff ─────────────────────────────────────── */

describe('decodeTiff against fax data another writer produced', () => {
	/**
	 * A 24 by 10 pattern and the three ways libtiff codes it.
	 *
	 * Every other CCITT fixture here is built from the code tables directly,
	 * which is a better test than a round trip but is still this package's
	 * reading of T.4 on both sides. These three are not: they came out of
	 * libtiff's encoder, which has no connection to this one, and between them
	 * they exercise the make-up codes, the pass and vertical modes and both
	 * framings.
	 */
	const pattern = [
		'...######...............',
		'########################',
		'........................',
		'..##......#.........####',
		'.#.#.#.#.#.#.#.#.#.#.#.#',
		'############............',
		'............############',
		'.....##.................',
		'########################',
		'.......................#',
	];

	const group4 = Uint8Array.from([
		48, 80, 68, 11, 154, 149, 1, 185, 124, 242, 52, 104, 34, 58, 35, 160, 64, 146, 35, 162, 58, 35,
		160, 69, 14, 80, 225, 42, 17, 17, 24, 136, 136, 178, 64, 115, 153, 172, 55, 38, 160, 92, 132,
		64, 2, 0, 32,
	]);

	const group3OneDimensional = Uint8Array.from([
		0, 24, 45, 64, 4, 212, 11, 128, 10, 128, 1, 127, 149, 24, 0, 142, 135, 67, 161, 208, 232, 116,
		58, 29, 14, 135, 67, 161, 208, 0, 154, 135, 32, 0, 72, 14, 0, 57, 214, 0, 38, 160, 92, 0, 66,
		32,
	]);

	const group3TwoDimensional = Uint8Array.from([
		0, 28, 22, 160, 2, 4, 64, 185, 168, 0, 212, 0, 8, 190, 121, 26, 48, 1, 142, 135, 67, 161, 208,
		232, 116, 58, 29, 14, 135, 67, 161, 208, 0, 144, 136, 136, 196, 68, 69, 128, 12, 128, 224, 2,
		57, 154, 195, 112, 1, 154, 129, 112, 1, 16, 136,
	]);

	/**
	 * libtiff wrote these with PhotometricInterpretation 1, where a set sample
	 * is white. The coder itself has no opinion about colour: it codes runs of
	 * zero bits and runs of one bits, and the photometric tag decides what each
	 * looks like.
	 */
	function expectedPixels(): number[] {
		const out: number[] = [];
		for (const row of pattern) {
			for (const cell of row) out.push(cell === '#' ? 255 : 0);
		}
		return out;
	}

	it.each([
		['Group 4', 4, 0],
		['Group 3, one dimensional', 3, 0],
		['Group 3, two dimensional', 3, 1],
	])('reads a strip of %s', async (_label, compression, options) => {
		const data =
			compression === 4 ? group4 : options === 1 ? group3TwoDimensional : group3OneDimensional;
		const file = makeTiff({
			width: 24,
			height: 10,
			bits: 1,
			samples: 1,
			photometric: 1,
			compression,
			data,
			extra: [{ tag: options === 1 ? 292 : 293, type: LONG, values: [options] }],
		});
		const image = await decodeTiff(file);

		expect(image.width).toBe(24);
		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual(expectedPixels());
	});
});

/* ── Orientation and pages ────────────────────────────────────────────── */

describe('decodeTiff orientation', () => {
	// Three wide, two tall, so a quarter turn is visible in the dimensions as
	// well as in the pixels.
	const data = bytes(1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6);

	async function greysOf(orientation: number): Promise<{ width: number; values: number[] }> {
		const file = makeTiff({
			width: 3,
			height: 2,
			data,
			extra: [{ tag: 274, type: SHORT, values: [orientation] }],
		});
		const image = await decodeTiff(file);
		return { width: image.width, values: Array.from(image.data.filter((_, i) => i % 4 === 0)) };
	}

	it('leaves an image whose first row is already the top alone', async () => {
		expect((await greysOf(1)).values).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('mirrors an image stored right to left', async () => {
		expect((await greysOf(2)).values).toEqual([3, 2, 1, 6, 5, 4]);
	});

	it('turns an image stored bottom right first by half a turn', async () => {
		expect((await greysOf(3)).values).toEqual([6, 5, 4, 3, 2, 1]);
	});

	it('mirrors an image stored bottom to top', async () => {
		expect((await greysOf(4)).values).toEqual([4, 5, 6, 1, 2, 3]);
	});

	it('transposes an image stored down its own left edge', async () => {
		const result = await greysOf(5);
		expect(result.width).toBe(2);
		expect(result.values).toEqual([1, 4, 2, 5, 3, 6]);
	});

	it('turns an image whose top is at the right', async () => {
		const result = await greysOf(6);
		expect(result.width).toBe(2);
		expect(result.values).toEqual([4, 1, 5, 2, 6, 3]);
	});

	it('transposes an image stored the other diagonal', async () => {
		const result = await greysOf(7);
		expect(result.width).toBe(2);
		expect(result.values).toEqual([6, 3, 5, 2, 4, 1]);
	});

	it('turns an image whose top is at the left', async () => {
		const result = await greysOf(8);
		expect(result.width).toBe(2);
		expect(result.values).toEqual([3, 6, 2, 5, 1, 4]);
	});

	it('ignores an orientation outside the eight the format defines', async () => {
		expect((await greysOf(0)).values).toEqual([1, 2, 3, 4, 5, 6]);
	});
});

describe('decodeTiff pages', () => {
	function page(fields: FieldSpec[], data: Uint8Array): PageSpec {
		return { fields, data };
	}

	function pageFields(width: number, height: number, at: number, length: number): FieldSpec[] {
		return [
			{ tag: 256, type: LONG, values: [width] },
			{ tag: 257, type: LONG, values: [height] },
			{ tag: 258, type: SHORT, values: [8] },
			{ tag: 259, type: SHORT, values: [1] },
			{ tag: 262, type: SHORT, values: [1] },
			{ tag: 273, type: LONG, values: [at] },
			{ tag: 277, type: SHORT, values: [1] },
			{ tag: 278, type: LONG, values: [height] },
			{ tag: 279, type: LONG, values: [length] },
		];
	}

	it('skips a reduced resolution page and decodes the full size one', async () => {
		const thumbnail = bytes(9, 9);
		const full = bytes(1, 2, 3, 4);
		const file = buildTiff([
			page([...pageFields(2, 1, 8, 2), { tag: 254, type: LONG, values: [1] }], thumbnail),
			page(pageFields(4, 1, 10, 4), full),
		]);
		const image = await decodeTiff(file);

		expect(image.width).toBe(4);
		expect(Array.from(image.data.filter((_, i) => i % 4 === 0))).toEqual([1, 2, 3, 4]);
	});

	it('decodes the first page when every page claims to be reduced', async () => {
		const file = buildTiff([
			page([...pageFields(2, 1, 8, 2), { tag: 254, type: LONG, values: [1] }], bytes(9, 9)),
			page([...pageFields(4, 1, 10, 4), { tag: 254, type: LONG, values: [1] }], bytes(1, 2, 3, 4)),
		]);

		expect((await decodeTiff(file)).width).toBe(2);
	});

	it('ignores the pages after the one it decodes', async () => {
		const file = buildTiff([
			page(pageFields(2, 1, 8, 2), bytes(9, 8)),
			page(pageFields(4, 1, 10, 4), bytes(1, 2, 3, 4)),
		]);

		expect(Array.from((await decodeTiff(file)).data.filter((_, i) => i % 4 === 0))).toEqual([9, 8]);
	});
});

/* ── The ICC profile ──────────────────────────────────────────────────── */

describe('readTiffIccProfile', () => {
	const profile = Uint8Array.from({ length: 40 }, (_, i) => i + 1);

	it('returns the profile a file carries', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			data: bytes(1, 2, 3),
			extra: [{ tag: 34675, type: UNDEFINED, values: Array.from(profile) }],
		});

		expect(Array.from(readTiffIccProfile(file) as Uint8Array)).toEqual(Array.from(profile));
		// The pixels still read, because the profile is nothing to do with them.
		expect(pixelsOf(await decodeTiff(file))).toEqual([1, 2, 3, 255]);
	});

	it('returns nothing when the file carries no profile', () => {
		expect(
			readTiffIccProfile(makeTiff({ width: 1, height: 1, data: bytes(1, 2, 3) })),
		).toBeUndefined();
	});

	it('returns nothing rather than throwing for something that is not a TIFF', () => {
		expect(readTiffIccProfile(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeUndefined();
	});

	it('returns nothing for a profile whose bytes are not in the file', () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			data: bytes(1, 2, 3),
			extra: [{ tag: 34675, type: UNDEFINED, values: Array.from(profile) }],
		});
		expect(readTiffIccProfile(file.subarray(0, file.length - 20))).toBeUndefined();
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeTiff', () => {
	it('writes a header a reader can follow', async () => {
		const out = await encodeTiff(raster(1, 1, [10, 20, 30, 255]));
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

		// 'II', then 42, then the offset of the only directory.
		expect([out[0], out[1]]).toEqual([0x49, 0x49]);
		expect(view.getUint16(2, true)).toBe(42);
		const directory = view.getUint32(4, true);
		expect(directory).toBeLessThan(out.length);
		// The chain ends here: one page, and a reader that follows it finds a
		// zero rather than whatever the file happens to end with.
		const count = view.getUint16(directory, true);
		expect(view.getUint32(directory + 2 + count * 12, true)).toBe(0);
	});

	it('writes its directory entries in ascending tag order', async () => {
		const out = await encodeTiff(raster(1, 1, [10, 20, 30, 255]));
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const directory = view.getUint32(4, true);
		const count = view.getUint16(directory, true);

		const tags: number[] = [];
		for (let i = 0; i < count; i += 1) tags.push(view.getUint16(directory + 2 + i * 12, true));
		expect(tags).toEqual([...tags].sort((a, b) => a - b));
		expect(new Set(tags).size).toBe(tags.length);
		// Every tag a baseline RGB file has to carry.
		for (const tag of [256, 257, 258, 259, 262, 273, 277, 278, 279, 282, 283, 296]) {
			expect(tags).toContain(tag);
		}
	});

	it('writes three samples for an opaque image and four for a translucent one', async () => {
		const opaque = await decodeTiff(await encodeTiff(raster(1, 1, [10, 20, 30, 255])));
		const translucent = await decodeTiff(await encodeTiff(raster(1, 1, [10, 20, 30, 128], true)));

		expect(opaque.hasAlpha).toBe(false);
		expect(translucent.hasAlpha).toBe(true);
		expect(pixelsOf(translucent)).toEqual([10, 20, 30, 128]);
	});

	it('writes an alpha channel when asked to, even for an opaque raster', async () => {
		const out = await encodeTiff(raster(1, 1, [10, 20, 30, 255]), { alpha: true });
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const directory = view.getUint32(4, true);
		const count = view.getUint16(directory, true);
		const tags: number[] = [];
		for (let i = 0; i < count; i += 1) tags.push(view.getUint16(directory + 2 + i * 12, true));

		expect(tags).toContain(338);
		expect(pixelsOf(await decodeTiff(out))).toEqual([10, 20, 30, 255]);
	});

	it('flattens onto white when alpha is turned off', async () => {
		const out = await encodeTiff(raster(1, 1, [0, 0, 0, 128], true), { alpha: false });

		expect(pixelsOf(await decodeTiff(out))).toEqual([127, 127, 127, 255]);
	});

	it('flattens onto the background it was given', async () => {
		const out = await encodeTiff(raster(1, 1, [0, 0, 0, 128], true), {
			alpha: false,
			background: [255, 0, 0],
		});

		expect(pixelsOf(await decodeTiff(out))).toEqual([127, 0, 0, 255]);
	});

	it('splits a tall image into strips of roughly the size it aims for', async () => {
		const image = noise(64, 600, false);
		const out = await encodeTiff(image);
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const directory = view.getUint32(4, true);
		const count = view.getUint16(directory, true);

		let rowsPerStrip = 0;
		let strips = 0;
		for (let i = 0; i < count; i += 1) {
			const entry = directory + 2 + i * 12;
			const tag = view.getUint16(entry, true);
			if (tag === 278) rowsPerStrip = view.getUint32(entry + 8, true);
			if (tag === 279) strips = view.getUint32(entry + 4, true);
		}

		expect(rowsPerStrip).toBe(Math.floor(65536 / (64 * 3)));
		expect(strips).toBe(Math.ceil(600 / rowsPerStrip));
		expect(pixelsOf(await decodeTiff(out))).toEqual(pixelsOf(image));
	});

	it('embeds an ICC profile where it was given one', async () => {
		const profile = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
		const out = await encodeTiff(raster(1, 1, [10, 20, 30, 255]), { iccProfile: profile });

		expect(Array.from(readTiffIccProfile(out) as Uint8Array)).toEqual(Array.from(profile));
	});

	it('writes no profile tag when it was given an empty one', async () => {
		const out = await encodeTiff(raster(1, 1, [1, 2, 3, 255]), { iccProfile: new Uint8Array(0) });

		expect(readTiffIccProfile(out)).toBeUndefined();
	});

	it('writes an uncompressed file where the browser cannot deflate', async () => {
		const image = noise(8, 8, false);
		const original = globalThis.CompressionStream;
		Reflect.deleteProperty(globalThis, 'CompressionStream');
		let out: Uint8Array;
		try {
			out = await encodeTiff(image);
		} finally {
			globalThis.CompressionStream = original;
		}
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const directory = view.getUint32(4, true);
		const count = view.getUint16(directory, true);
		const tags = new Map<number, number>();
		for (let i = 0; i < count; i += 1) {
			const entry = directory + 2 + i * 12;
			tags.set(view.getUint16(entry, true), view.getUint16(entry + 8, true));
		}

		// Compression 1, and no predictor tag: differencing on its own makes a
		// file no smaller, so writing it would only give a reader more to do.
		expect(tags.get(259)).toBe(1);
		expect(tags.has(317)).toBe(false);
		expect(pixelsOf(await decodeTiff(out))).toEqual(pixelsOf(image));
	});

	it('pads an ICC profile of odd length so what follows stays word aligned', async () => {
		const profile = Uint8Array.from({ length: 301 }, (_, i) => (i * 7) & 0xff);
		const out = await encodeTiff(raster(1, 1, [10, 20, 30, 255]), { iccProfile: profile });

		expect(out.length % 2).toBe(0);
		expect(Array.from(readTiffIccProfile(out) as Uint8Array)).toEqual(Array.from(profile));
	});

	it('refuses an image with no pixels', async () => {
		await expect(encodeTiff(createRaster(0, 0))).rejects.toThrow(EncodeFailedError);
		await expect(encodeTiff(createRaster(0, 0))).rejects.toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', async () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		await expect(encodeTiff(short)).rejects.toThrow(/smaller than the width and height/);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('TIFF round trips', () => {
	it.each([
		[1, 1],
		[1, 7],
		[7, 1],
		[3, 3],
		[7, 5],
		[16, 16],
		[17, 2],
		[64, 40],
	])('carries a %i by %i opaque image through unchanged', async (width, height) => {
		const source = noise(width, height, false);
		const back = await decodeTiff(await encodeTiff(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it.each([
		[1, 1],
		[3, 5],
		[9, 4],
		[33, 17],
	])('carries a %i by %i image with alpha through unchanged', async (width, height) => {
		const source = noise(width, height, true);
		// The generator can produce an opaque run by chance; pin one pixel so the
		// alpha assertion is about the codec rather than about the noise.
		source.data[3] = 64;
		const back = await decodeTiff(await encodeTiff(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('carries an image that is transparent everywhere through unchanged', async () => {
		const source = raster(2, 2, new Array<number>(16).fill(0), true);
		for (let i = 0; i < 16; i += 4) source.data.set([10, 20, 30, 0], i);
		const back = await decodeTiff(await encodeTiff(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('writes a Display P3 raster without claiming it is anything else', async () => {
		// TIFF can carry an ICC profile and nothing else, so a wide gamut raster
		// with no profile comes back with its numbers intact and no claim about
		// them either way.
		const source = raster(1, 1, [200, 100, 50, 255], false, 'display-p3');
		const back = await decodeTiff(await encodeTiff(source));

		expect(back.colourSpace).toBe('srgb');
		expect(pixelsOf(back)).toEqual([200, 100, 50, 255]);
	});
});

/* ── Reading a TIFF as light ──────────────────────────────────────────── */

/**
 * The environment the conversion below runs in.
 *
 * No canvas and no video decoder, so every rung of both ladders is a pure one.
 * `CompressionStream` is the exception because Node has it and the PNG on the
 * other end needs it.
 */
const PURE_ONLY = emptyCapabilities({ compressionStream: true });

/** What every decoder in this package reports: the pixels came back the right way up. */
const UPRIGHT: Orientation = { rotation: 0, mirror: 'none', source: 'none' };

function float32(values: readonly number[], little = true): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setFloat32(i * 4, value, little));
	return out;
}

/** A float TIFF, from the field values the specification defines and nothing else. */
function floatFile(
	width: number,
	height: number,
	samples: number,
	values: readonly number[],
	extra: readonly FieldSpec[] = [],
): Uint8Array {
	return makeTiff({
		width,
		height,
		samples,
		bits: 32,
		photometric: samples >= 3 ? 2 : 1,
		data: float32(values),
		extra: [{ tag: 339, type: SHORT, values: new Array<number>(samples).fill(3) }, ...extra],
	});
}

async function expectFloatRefusal(file: Uint8Array, pattern: RegExp): Promise<void> {
	let thrown: unknown;
	try {
		await decodeTiffFloat(file);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DecodeFailedError);
	const error = thrown as DecodeFailedError;
	expect(error.code).toBe('decode/failed');
	expect(error.message).toMatch(pattern);
	expect(error.message.endsWith('.')).toBe(true);
}

/** Positions in the sorted order, so two arrangements can be compared without their values. */
function ranks(values: readonly number[]): number[] {
	const sorted = [...values].sort((a, b) => a - b);
	return values.map((value) => sorted.indexOf(value));
}

function reds(image: { data: Float32Array | Uint8ClampedArray }): number[] {
	return Array.from(image.data).filter((_, i) => i % 4 === 0);
}

describe('decodeTiffFloat', () => {
	it('refuses an integer TIFF from its directory alone, before a strip is touched', async () => {
		// The strip offset points past the end of the file, so a reader that
		// expanded the samples before it looked at the sample format would fail
		// with the second sentence rather than the first. That ordering is what
		// keeps `convert` from unpacking every ordinary TIFF twice on its way to
		// a PNG, because the light ladder runs first and unconditionally.
		const file = makeTiff({ width: 1, height: 1, data: bytes(1, 2, 3), offsets: [0xffff] });

		await expectFloatRefusal(file, /integers rather than IEEE floating point/);
		await expectRefusal(file, /ends before/);
	});

	it('refuses signed integer samples', async () => {
		const file = makeTiff({
			width: 1,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0, 0),
			extra: [{ tag: 339, type: SHORT, values: [2] }],
		});

		await expectFloatRefusal(file, /integers rather than IEEE floating point/);
	});

	it('refuses a float TIFF whose samples never pass 1', async () => {
		await expectFloatRefusal(floatFile(4, 1, 1, [0, 0.25, 0.5, 1]), /never pass 1/);
	});

	it('converts a bounded float TIFF to PNG with its pixels unchanged', async () => {
		// The regression the refusal above exists for, through the whole
		// pipeline. `convert` runs the light ladder first and unconditionally,
		// so the decoder registered here is the shape `defaults.ts` gets once a
		// float TIFF reader is wired into it, and the refusal is the only thing
		// that keeps this file on the byte ladder. `toneMap` meters log average
		// luminance against 0.18 with no shortcut for a bounded image, so a
		// `FloatImage` reaching the encoder would arrive several stops bright.
		//
		// The four values are what ImageMagick reads back out of its own
		// `-depth 32 -define quantum:format=floating-point` file, and they are
		// what this package produced before there was a light ladder at all.
		let askedForLight = false;
		installDefaultCodecs();
		registerDecoder({
			id: 'tiff-pure-light',
			formats: ['tiff'],
			path: 'pure',
			// Ahead of the reader `defaults.ts` already registers, so that both
			// ladders reach this one and the assertions below are about it.
			priority: 39,
			async available() {
				return true;
			},
			async decode(input) {
				return { image: await decodeTiff(input), orientation: UPRIGHT };
			},
			async decodeFloat(input) {
				askedForLight = true;
				return { image: await decodeTiffFloat(input), orientation: UPRIGHT };
			},
		});
		try {
			const file = floatFile(4, 1, 1, [0, 0.25, 0.5, 1]);
			const result = await convert(file, { to: 'png' }, PURE_ONLY);
			const png = await decodePng(result.bytes);

			// Asked for light, refused, and read again as bytes. Nothing metered
			// anything, which is the whole point.
			expect(askedForLight).toBe(true);
			expect(result.report.decoderId).toBe('tiff-pure-light');
			expect(result.report.toneMapped).toBeUndefined();
			expect(Array.from(png.data)).toEqual([
				0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
			]);
		} finally {
			clearRegistry();
			resetDefaultCodecs();
		}
	});

	it('refuses WhiteIsZero light, which has no ceiling to invert against', async () => {
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 0,
			data: float32([0.5, 3]),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});

		await expectFloatRefusal(file, /WhiteIsZero/);
	});

	it('reads thirty-two bit float colour as the light it stores', async () => {
		const image = await decodeTiffFloat(floatFile(2, 1, 3, [0.25, 0.5, 2, 4, 0.125, 1.5]));

		expect([image.width, image.height]).toEqual([2, 1]);
		expect(image.colourSpace).toBe('srgb');
		expect(image.hasAlpha).toBe(false);
		// Every one of these is exact in binary32, so an approximate match here
		// would be hiding a conversion that should not have happened.
		expect(Array.from(image.data)).toEqual([0.25, 0.5, 2, 1, 4, 0.125, 1.5, 1]);
	});

	it('spreads a single float channel across three', async () => {
		const image = await decodeTiffFloat(floatFile(2, 1, 1, [0.5, 3]));

		expect(Array.from(image.data)).toEqual([0.5, 0.5, 0.5, 1, 3, 3, 3, 1]);
	});

	it('reads sixteen bit half floats as light', async () => {
		// 0x3800 is 0.5 and 0x4000 is 2 in IEEE 754 binary16, little endian here
		// because the file's header said so.
		const file = makeTiff({
			width: 2,
			height: 1,
			bits: 16,
			samples: 1,
			photometric: 1,
			data: bytes(0x00, 0x38, 0x00, 0x40),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});

		expect(Array.from((await decodeTiffFloat(file)).data)).toEqual([0.5, 0.5, 0.5, 1, 2, 2, 2, 1]);
	});

	it('carries unassociated alpha through as coverage', async () => {
		const file = floatFile(
			2,
			1,
			4,
			[0.25, 0.5, 0.75, 0.5, 2, 2, 2, 1],
			[{ tag: 338, type: SHORT, values: [2] }],
		);
		const image = await decodeTiffFloat(file);

		expect(image.hasAlpha).toBe(true);
		expect(Array.from(image.data)).toEqual([0.25, 0.5, 0.75, 0.5, 2, 2, 2, 1]);
	});

	it('divides associated alpha back out of the light', async () => {
		const file = floatFile(
			2,
			1,
			4,
			[0.5, 0.5, 0.5, 0.5, 2, 2, 2, 1],
			[{ tag: 338, type: SHORT, values: [1] }],
		);

		expect(Array.from((await decodeTiffFloat(file)).data)).toEqual([1, 1, 1, 0.5, 2, 2, 2, 1]);
	});

	it('reports no alpha where a fourth channel is present and fully covered', async () => {
		const file = floatFile(
			2,
			1,
			4,
			[0.25, 0.5, 0.75, 1, 2, 2, 2, 1],
			[{ tag: 338, type: SHORT, values: [2] }],
		);

		expect((await decodeTiffFloat(file)).hasAlpha).toBe(false);
	});

	it('reads a Deflate compressed float TIFF, which is what GDAL writes', async () => {
		const file = makeTiff({
			width: 4,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			compression: 8,
			data: await deflate(float32([0.5, 3, 0.25, 4])),
			extra: [{ tag: 339, type: SHORT, values: [3] }],
		});

		expect(reds(await decodeTiffFloat(file))).toEqual([0.5, 3, 0.25, 4]);
	});

	it.each([
		[1, [2, 3, 4, 5]],
		[2, [3, 2, 5, 4]],
		[3, [5, 4, 3, 2]],
		[4, [4, 5, 2, 3]],
		[5, [2, 4, 3, 5]],
		[6, [4, 2, 5, 3]],
		[7, [5, 3, 4, 2]],
		[8, [3, 5, 2, 4]],
	])('turns the light the way orientation %i asks for', async (tag, expected) => {
		const file = makeTiff({
			width: 2,
			height: 2,
			bits: 32,
			samples: 1,
			photometric: 1,
			data: float32([2, 3, 4, 5]),
			extra: [
				{ tag: 274, type: SHORT, values: [tag] },
				{ tag: 339, type: SHORT, values: [3] },
			],
		});
		const image = await decodeTiffFloat(file);

		expect(reds(image)).toEqual(expected);
		// The byte path turns the same file through `applyOrientation`, and the
		// tone map in front of it is monotonic in luminance, so the two have to
		// arrange the picture identically. That is the assertion that does not
		// depend on the table above having been worked out correctly, and it is
		// the one that catches a mirror and a rotation applied in the wrong
		// order, which only shows on orientations 5 and 7.
		expect(ranks(reds(await decodeTiff(file)))).toEqual(ranks(expected));
	});

	it('swaps the dimensions of a picture the orientation turns', async () => {
		const file = makeTiff({
			width: 3,
			height: 1,
			bits: 32,
			samples: 1,
			photometric: 1,
			data: float32([2, 3, 4]),
			extra: [
				{ tag: 274, type: SHORT, values: [6] },
				{ tag: 339, type: SHORT, values: [3] },
			],
		});
		const image = await decodeTiffFloat(file);

		expect([image.width, image.height]).toEqual([1, 3]);
		expect(reds(image)).toEqual([2, 3, 4]);
	});

	it('refuses something that is not a TIFF at all', async () => {
		await expectFloatRefusal(bytes(1, 2, 3, 4, 5, 6, 7, 8), /II or MM/);
	});
});

/* ── EXIF, on the way out ─────────────────────────────────────────────── */

/** Bytes per value, by field type, for the twelve TIFF 6.0 defines. */
const TYPE_BYTES: Record<number, number> = {
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

interface OutEntry {
	readonly tag: number;
	readonly type: number;
	readonly count: number;
	/** Where the twelve byte entry starts, which is where a short value sits too. */
	readonly entryAt: number;
	/** Where the value is, inline or at the offset the entry names. */
	readonly valueAt: number;
}

/**
 * Read one little endian directory, the way the specification lays it out.
 *
 * Written here rather than borrowed from the decoder so that the encoder is
 * checked against the format rather than against its own reader.
 */
function readIfd(file: Uint8Array, at: number): OutEntry[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const count = view.getUint16(at, true);
	const out: OutEntry[] = [];
	for (let i = 0; i < count; i += 1) {
		const entryAt = at + 2 + i * 12;
		const type = view.getUint16(entryAt + 2, true);
		const values = view.getUint32(entryAt + 4, true);
		const size = (TYPE_BYTES[type] ?? 0) * values;
		out.push({
			tag: view.getUint16(entryAt, true),
			type,
			count: values,
			entryAt,
			valueAt: size <= 4 ? entryAt + 8 : view.getUint32(entryAt + 8, true),
		});
	}
	return out;
}

function ifd0Of(file: Uint8Array): OutEntry[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	return readIfd(file, view.getUint32(4, true));
}

function tagged(entries: readonly OutEntry[], tag: number): OutEntry | undefined {
	return entries.find((entry) => entry.tag === tag);
}

function longAt(file: Uint8Array, at: number): number {
	return new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(at, true);
}

function textOf(file: Uint8Array, entry: OutEntry): string {
	let out = '';
	for (let i = 0; i < entry.count; i += 1) {
		const byte = file[entry.valueAt + i] as number;
		if (byte === 0) break;
		out += String.fromCharCode(byte);
	}
	return out;
}

/** The sub-directory a pointer tag names, or nothing where the tag is absent. */
function subIfdOf(file: Uint8Array, tag: number): OutEntry[] | undefined {
	const pointer = tagged(ifd0Of(file), tag);
	if (!pointer) return undefined;
	return readIfd(file, longAt(file, pointer.valueAt));
}

function ascii(text: string): number[] {
	return [...text].map((character) => character.charCodeAt(0));
}

function patch16(file: Uint8Array, at: number, value: number): Uint8Array {
	const out = file.slice();
	new DataView(out.buffer).setUint16(at, value, true);
	return out;
}

function patch32(file: Uint8Array, at: number, value: number): Uint8Array {
	const out = file.slice();
	new DataView(out.buffer).setUint32(at, value, true);
	return out;
}

interface ExifSpec {
	readonly ifd0: readonly FieldSpec[];
	readonly exif?: readonly FieldSpec[];
	readonly gps?: readonly FieldSpec[];
	readonly little?: boolean;
}

/**
 * An EXIF payload, laid out from the TIFF 6.0 and Exif 2.3 rules by hand.
 *
 * This is the shape that makes carrying EXIF into another TIFF awkward, so the
 * fixture has to have it honestly: a byte order mark, the number 42, IFD0, and
 * sub-directories at offsets counted from byte zero of this block rather than
 * from byte zero of whatever it is eventually put inside.
 */
function buildExif(spec: ExifSpec): Uint8Array {
	const little = spec.little ?? true;
	const subs: { tag: number; fields: readonly FieldSpec[] }[] = [];
	if (spec.exif) subs.push({ tag: 34665, fields: spec.exif });
	if (spec.gps) subs.push({ tag: 34853, fields: spec.gps });

	const ifd0: FieldSpec[] = [
		...spec.ifd0,
		...subs.map((sub) => ({ tag: sub.tag, type: LONG, values: [0] })),
	].sort((a, b) => a.tag - b.tag);
	const directories: FieldSpec[][] = [
		ifd0,
		...subs.map((sub) => [...sub.fields].sort((a, b) => a.tag - b.tag)),
	];

	// Where each directory and each long value goes, in one pass. A pointer is
	// four bytes whatever it holds, so the layout does not depend on the offsets
	// that are still unknown at this point.
	const directoryAt: number[] = [];
	const valueAt: number[][] = [];
	let at = 8;
	for (const fields of directories) {
		directoryAt.push(at);
		at += 2 + fields.length * 12 + 4;
		const offsets: number[] = [];
		for (const field of fields) {
			const size = valueBytes(field, little).length;
			if (size <= 4) {
				offsets.push(-1);
				continue;
			}
			at += at & 1;
			offsets.push(at);
			at += size;
		}
		valueAt.push(offsets);
	}

	const out = new Uint8Array(at);
	const view = new DataView(out.buffer);
	out[0] = little ? 0x49 : 0x4d;
	out[1] = little ? 0x49 : 0x4d;
	view.setUint16(2, 42, little);
	view.setUint32(4, directoryAt[0] as number, little);

	directories.forEach((fields, d) => {
		const start = directoryAt[d] as number;
		view.setUint16(start, fields.length, little);
		fields.forEach((field, i) => {
			// Only IFD0 names sub-directories. A pointer tag inside one of them is
			// whatever the fixture said it was, which is how a nested pointer can
			// be tested at all.
			const sub = d === 0 ? subs.findIndex((entry) => entry.tag === field.tag) : -1;
			const resolved = sub < 0 ? field : { ...field, values: [directoryAt[sub + 1] as number] };
			const to = start + 2 + i * 12;
			view.setUint16(to, resolved.tag, little);
			view.setUint16(to + 2, resolved.type, little);
			view.setUint32(to + 4, valueCount(resolved), little);
			const value = valueBytes(resolved, little);
			const where = (valueAt[d] as number[])[i] as number;
			if (where < 0) {
				out.set(value, to + 8);
			} else {
				view.setUint32(to + 8, where, little);
				out.set(value, where);
			}
		});
		view.setUint32(start + 2 + fields.length * 12, 0, little);
	});
	return out;
}

/** A payload with a camera, a capture time, an exposure and a location in it. */
function cameraExif(little = true): Uint8Array {
	return buildExif({
		little,
		ifd0: [
			{ tag: 271, type: ASCII, values: ascii('Canon\0') },
			{ tag: 272, type: ASCII, values: ascii('Canon EOS 5D\0') },
			{ tag: 305, type: ASCII, values: ascii('Digital Photo Professional\0') },
			{ tag: 306, type: ASCII, values: ascii('2019:07:04 11:22:33\0') },
			// Carried nowhere. The pixels an encoder is handed are upright, so a
			// tag saying they are not would turn every portrait photograph.
			{ tag: 274, type: SHORT, values: [6] },
			// Structure of the picture the payload came off, not of this one.
			{ tag: 256, type: LONG, values: [5616] },
			{ tag: 259, type: SHORT, values: [6] },
		],
		exif: [
			{ tag: 0x829a, type: RATIONAL, values: [1, 200] },
			{ tag: 0x8827, type: SHORT, values: [400] },
			{ tag: 0x9003, type: ASCII, values: ascii('2019:07:04 11:22:33\0') },
		],
		gps: [
			{ tag: 1, type: ASCII, values: ascii('S\0') },
			{ tag: 2, type: RATIONAL, values: [33, 1, 52, 1, 0, 1] },
		],
	});
}

const PIXEL = () => raster(1, 1, [10, 20, 30, 255]);

describe('encodeTiff with EXIF', () => {
	it('reads back through this package own EXIF reader', async () => {
		const out = await encodeTiff(PIXEL(), { exif: cameraExif() });
		const summary = readExif(out);

		expect(summary?.cameraMake).toBe('Canon');
		expect(summary?.cameraModel).toBe('Canon EOS 5D');
		expect(summary?.software).toBe('Digital Photo Professional');
		expect(summary?.capturedAt).toBe('2019:07:04 11:22:33');
		expect(summary?.hasLocation).toBe(true);
		// The payload said 6. Nothing carried it, so a reader is told the picture
		// is upright, which it is.
		expect(summary?.orientation).toBe(1);
		// And the picture itself still reads.
		expect(pixelsOf(await decodeTiff(out))).toEqual([10, 20, 30, 255]);
	});

	it('leaves the structure of the picture the payload came off behind', async () => {
		const out = await encodeTiff(PIXEL(), { exif: cameraExif() });
		const ifd0 = ifd0Of(out);

		// 256 and 259 are in the payload with the source's values. Carrying
		// either would either describe this file wrongly or put two entries with
		// the same tag in one directory.
		expect(tagged(ifd0, 256)?.count).toBe(1);
		expect(longAt(out, tagged(ifd0, 256)?.valueAt as number)).toBe(1);
		expect(tagged(ifd0, 274)).toBeUndefined();
		const tags = ifd0.map((entry) => entry.tag);
		expect(new Set(tags).size).toBe(tags.length);
		expect(tags).toEqual([...tags].sort((a, b) => a - b));
	});

	it('places both sub-directories where TIFF 6.0 says a directory may go', async () => {
		const out = await encodeTiff(PIXEL(), { exif: cameraExif() });

		for (const tag of [34665, 34853]) {
			const pointer = tagged(ifd0Of(out), tag) as OutEntry;
			// A pointer is one LONG, which is what makes it four bytes and puts it
			// inside the entry.
			expect(pointer.type).toBe(LONG);
			expect(pointer.count).toBe(1);

			const at = longAt(out, pointer.valueAt);
			expect(at % 2).toBe(0);
			expect(at).toBeGreaterThan(8);
			expect(at).toBeLessThan(out.length);

			const sub = readIfd(out, at);
			const tags = sub.map((entry) => entry.tag);
			expect(tags).toEqual([...tags].sort((a, b) => a - b));
			expect(new Set(tags).size).toBe(tags.length);
			// A sub-directory has no successor, so the chain ends inside it.
			expect(longAt(out, at + 2 + sub.length * 12)).toBe(0);

			for (const entry of sub) {
				const size = (TYPE_BYTES[entry.type] as number) * entry.count;
				if (size <= 4) continue;
				expect(entry.valueAt % 2).toBe(0);
				expect(entry.valueAt + size).toBeLessThanOrEqual(out.length);
			}
		}
		expect(out.length % 2).toBe(0);
	});

	it('rebases the values inside a sub-directory rather than pointing at a copy', async () => {
		const out = await encodeTiff(PIXEL(), { exif: cameraExif() });
		const sub = subIfdOf(out, 34665) as OutEntry[];

		// 1/200 as two longs, read out of this file at the offset this file's own
		// entry names. A spliced payload would resolve this offset somewhere in
		// the strip data instead.
		const exposure = tagged(sub, 0x829a) as OutEntry;
		expect(exposure.type).toBe(RATIONAL);
		expect([longAt(out, exposure.valueAt), longAt(out, exposure.valueAt + 4)]).toEqual([1, 200]);
		// A short fits in the entry, so it is not rebased at all.
		const iso = tagged(sub, 0x8827) as OutEntry;
		expect(iso.valueAt).toBe(iso.entryAt + 8);
		expect(
			new DataView(out.buffer, out.byteOffset, out.byteLength).getUint16(iso.valueAt, true),
		).toBe(400);
		expect(textOf(out, tagged(sub, 0x9003) as OutEntry)).toBe('2019:07:04 11:22:33');

		const gps = subIfdOf(out, 34853) as OutEntry[];
		const latitude = tagged(gps, 2) as OutEntry;
		expect(latitude.count).toBe(3);
		expect(longAt(out, latitude.valueAt)).toBe(33);
		expect(longAt(out, latitude.valueAt + 8)).toBe(52);
	});

	it('swaps the numbers of a big endian payload rather than copying its bytes', async () => {
		// The payload is MM and this encoder writes II. A rational copied byte for
		// byte comes back as 16777216/3355443200, which is a number rather than
		// visible damage, and a shutter speed of 1/200 reading as its own reverse
		// is exactly the sort of thing nobody notices for a year.
		const out = await encodeTiff(PIXEL(), { exif: cameraExif(false) });
		const sub = subIfdOf(out, 34665) as OutEntry[];
		const exposure = tagged(sub, 0x829a) as OutEntry;

		expect([longAt(out, exposure.valueAt), longAt(out, exposure.valueAt + 4)]).toEqual([1, 200]);
		expect(
			new DataView(out.buffer, out.byteOffset, out.byteLength).getUint16(
				(tagged(sub, 0x8827) as OutEntry).valueAt,
				true,
			),
		).toBe(400);
		expect(readExif(out)?.cameraMake).toBe('Canon');
		expect(textOf(out, tagged(sub, 0x9003) as OutEntry)).toBe('2019:07:04 11:22:33');
	});

	it('drops the maker note by name and keeps everything beside it', async () => {
		const payload = buildExif({
			ifd0: [{ tag: 271, type: ASCII, values: ascii('NIKON CORPORATION\0') }],
			exif: [
				{ tag: 0x9003, type: ASCII, values: ascii('2020:01:01 00:00:00\0') },
				// A real one holds offsets counted from the original file's header,
				// which nothing outside the camera maker can rebase.
				{ tag: 37500, type: UNDEFINED, values: Array.from({ length: 64 }, (_, i) => i) },
				{ tag: 40965, type: LONG, values: [8] },
			],
		});
		const out = await encodeTiff(PIXEL(), { exif: payload });
		const sub = subIfdOf(out, 34665) as OutEntry[];

		expect(sub.map((entry) => entry.tag)).toEqual([0x9003]);
		expect(readExif(out)?.cameraMake).toBe('NIKON CORPORATION');
	});

	it('writes no pointer for a sub-directory whose every entry was dropped', async () => {
		const payload = buildExif({
			ifd0: [{ tag: 271, type: ASCII, values: ascii('Sony\0') }],
			exif: [{ tag: 37500, type: UNDEFINED, values: [1, 2, 3, 4, 5, 6, 7, 8] }],
		});
		const out = await encodeTiff(PIXEL(), { exif: payload });

		expect(tagged(ifd0Of(out), 34665)).toBeUndefined();
		expect(readExif(out)?.cameraMake).toBe('Sony');
	});

	it('writes an ICC profile and EXIF into the same directory', async () => {
		const profile = Uint8Array.from({ length: 301 }, (_, i) => (i * 7) & 0xff);
		const out = await encodeTiff(PIXEL(), { exif: cameraExif(), iccProfile: profile });

		expect(Array.from(readTiffIccProfile(out) as Uint8Array)).toEqual(Array.from(profile));
		expect(readExif(out)?.cameraMake).toBe('Canon');
		expect(out.length % 2).toBe(0);
	});

	it('keeps a multi-strip picture readable with metadata after it', async () => {
		const image = noise(64, 600, false);
		const out = await encodeTiff(image, { exif: cameraExif() });

		expect(pixelsOf(await decodeTiff(out))).toEqual(pixelsOf(image));
		expect(readExif(out)?.cameraModel).toBe('Canon EOS 5D');
	});

	it('writes nothing for a payload that is empty or is not a TIFF', async () => {
		for (const exif of [
			new Uint8Array(0),
			bytes(1, 2, 3),
			bytes(1, 2, 3, 4, 5, 6, 7, 8),
			// The right byte order mark and the wrong version, which is what a
			// BigTIFF block would look like here.
			bytes(0x49, 0x49, 43, 0, 8, 0, 0, 0),
		]) {
			const out = await encodeTiff(PIXEL(), { exif });
			expect(tagged(ifd0Of(out), 34665)).toBeUndefined();
			expect(tagged(ifd0Of(out), 271)).toBeUndefined();
		}
	});

	it('writes nothing for a payload whose first directory is not where it says', async () => {
		const payload = buildExif({ ifd0: [{ tag: 271, type: ASCII, values: ascii('Canon\0') }] });

		for (const offset of [0, 4, payload.length - 1]) {
			const out = await encodeTiff(PIXEL(), { exif: patch32(payload, 4, offset) });
			expect(tagged(ifd0Of(out), 271)).toBeUndefined();
		}
	});

	it('stops at the end of a directory that claims more entries than it has', async () => {
		const payload = buildExif({ ifd0: [{ tag: 271, type: ASCII, values: ascii('Canon\0') }] });
		// Forty entries in a directory that holds one. Reading past the end would
		// throw out of the encoder rather than produce a file.
		const out = await encodeTiff(PIXEL(), { exif: patch16(payload, 8, 40) });

		expect(textOf(out, tagged(ifd0Of(out), 271) as OutEntry)).toBe('Canon');
	});

	it.each([
		['an offset before the header', 8, 4],
		['an offset past the end', 8, 0xfffe],
		['a count nothing that size could hold', 4, 0xffffff],
	])('skips a payload entry with %s', async (_name, field, value) => {
		const payload = buildExif({
			ifd0: [{ tag: 271, type: ASCII, values: ascii('Nikon Corporation\0') }],
		});
		const entry = tagged(readIfd(payload, 8), 271) as OutEntry;
		const broken = patch32(payload, entry.entryAt + field, value);

		expect(tagged(ifd0Of(await encodeTiff(PIXEL(), { exif: broken })), 271)).toBeUndefined();
	});

	it('skips a payload entry whose type TIFF does not define', async () => {
		const payload = buildExif({ ifd0: [{ tag: 271, type: 99, values: [1, 2, 3] }] });

		expect(tagged(ifd0Of(await encodeTiff(PIXEL(), { exif: payload })), 271)).toBeUndefined();
	});

	it.each([
		['is not a long', { tag: 34665, type: SHORT, values: [8] }],
		['names more than one directory', { tag: 34665, type: LONG, values: [8, 8] }],
		['points outside the payload', { tag: 34665, type: LONG, values: [0xfffe] }],
	])('does not follow an EXIF pointer that %s', async (_name, pointer) => {
		const payload = buildExif({
			ifd0: [{ tag: 271, type: ASCII, values: ascii('Fujifilm\0') }, pointer],
		});
		const out = await encodeTiff(PIXEL(), { exif: payload });

		expect(tagged(ifd0Of(out), 34665)).toBeUndefined();
		expect(textOf(out, tagged(ifd0Of(out), 271) as OutEntry)).toBe('Fujifilm');
	});

	it('carries a tag the payload repeats exactly once', async () => {
		const payload = buildExif({
			ifd0: [
				{ tag: 271, type: ASCII, values: ascii('First\0') },
				{ tag: 271, type: ASCII, values: ascii('Second\0') },
			],
		});
		const out = await encodeTiff(PIXEL(), { exif: payload });
		const makes = ifd0Of(out).filter((entry) => entry.tag === 271);

		expect(makes.length).toBe(1);
		expect(textOf(out, makes[0] as OutEntry)).toBe('First');
	});

	it('stops copying when the payload describes more bytes than it holds', async () => {
		// Two entries pointing at one value, which nothing forbids and which lets
		// a payload claim far more metadata than its own length. The copy is
		// bounded by the size of the original, so the second one is left behind.
		const text = ascii('x'.repeat(119) + '\0');
		const payload = buildExif({
			ifd0: [
				{ tag: 270, type: ASCII, values: text },
				{ tag: 305, type: ASCII, values: text },
			],
		});
		const first = tagged(readIfd(payload, 8), 270) as OutEntry;
		const second = tagged(readIfd(payload, 8), 305) as OutEntry;
		const shared = patch32(payload, second.entryAt + 8, first.valueAt);
		const out = await encodeTiff(PIXEL(), { exif: shared.slice(0, first.valueAt + 120) });

		expect(tagged(ifd0Of(out), 270)).toBeDefined();
		expect(tagged(ifd0Of(out), 305)).toBeUndefined();
	});

	it('stops copying part way through a sub-directory for the same reason', async () => {
		const text = ascii('x'.repeat(119) + '\0');
		const payload = buildExif({
			ifd0: [],
			exif: [
				{ tag: 0x9003, type: ASCII, values: text },
				{ tag: 0x9286, type: UNDEFINED, values: text },
			],
		});
		const pointer = tagged(readIfd(payload, 8), 34665) as OutEntry;
		const sub = readIfd(payload, longAt(payload, pointer.valueAt));
		const first = tagged(sub, 0x9003) as OutEntry;
		const second = tagged(sub, 0x9286) as OutEntry;
		const shared = patch32(payload, second.entryAt + 8, first.valueAt);
		const out = await encodeTiff(PIXEL(), { exif: shared.slice(0, first.valueAt + 120) });

		expect((subIfdOf(out, 34665) as OutEntry[]).map((entry) => entry.tag)).toEqual([0x9003]);
	});
});
