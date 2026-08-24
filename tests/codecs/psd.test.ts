import { describe, expect, it, vi } from 'vitest';

import { decodePsd } from '../../src/codecs/psd/decode.js';
import { deflate } from '../../src/codecs/png/deflate.js';
import { CodecUnavailableError, DecodeFailedError } from '../../src/errors.js';
import type { RasterImage } from '../../src/types.js';

/* ── Building files ───────────────────────────────────────────────────── */

const MODE_BITMAP = 0;
const MODE_GREYSCALE = 1;
const MODE_INDEXED = 2;
const MODE_RGB = 3;
const MODE_CMYK = 4;
const MODE_MULTICHANNEL = 7;
const MODE_DUOTONE = 8;
const MODE_LAB = 9;

interface PsdSpec {
	/** 1 for a PSD, 2 for a PSB. */
	readonly version?: number;
	/** The six bytes after the version, which the format says must be zero. */
	readonly reserved?: readonly number[];
	readonly channels?: number;
	readonly width: number;
	readonly height: number;
	readonly depth?: number;
	readonly mode: number;
	readonly colourModeData?: readonly number[];
	readonly resources?: readonly number[];
	readonly layerAndMask?: readonly number[];
	readonly compression?: number;
	/** Everything after the two byte compression word. */
	readonly body?: readonly number[];
	/** Stop after the layer and mask section, leaving no image data at all. */
	readonly omitImageData?: boolean;
}

function u16(out: number[], value: number): void {
	out.push((value >>> 8) & 0xff, value & 0xff);
}

function u32(out: number[], value: number): void {
	out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u64(out: number[], value: number): void {
	u32(out, Math.floor(value / 0x100000000));
	u32(out, value >>> 0);
}

/**
 * Hand build a Photoshop file from field values rather than from a writer.
 *
 * Nothing in this package writes a PSD, so every fixture here is assembled from
 * the numbers in the specification directly. The three files at the bottom that
 * came out of ImageMagick are the check on whether that reading is right.
 */
function buildPsd(spec: PsdSpec): Uint8Array {
	const version = spec.version ?? 1;
	const out: number[] = [0x38, 0x42, 0x50, 0x53];
	u16(out, version);
	out.push(...(spec.reserved ?? [0, 0, 0, 0, 0, 0]));
	u16(out, spec.channels ?? 3);
	// Height before width, which is the field order the format actually uses.
	u32(out, spec.height);
	u32(out, spec.width);
	u16(out, spec.depth ?? 8);
	u16(out, spec.mode);

	const colourModeData = spec.colourModeData ?? [];
	u32(out, colourModeData.length);
	out.push(...colourModeData);

	const resources = spec.resources ?? [];
	u32(out, resources.length);
	out.push(...resources);

	const layerAndMask = spec.layerAndMask ?? [];
	// A PSB widens this one length to 64 bits and leaves the other two alone.
	if (version === 2) u64(out, layerAndMask.length);
	else u32(out, layerAndMask.length);
	out.push(...layerAndMask);

	if (!spec.omitImageData) {
		u16(out, spec.compression ?? 0);
		out.push(...(spec.body ?? []));
	}
	return Uint8Array.from(out);
}

/** Split channel planes into the rows a row length table describes. */
function rowsOf(planes: readonly (readonly number[])[], rowBytes: number): number[][] {
	const rows: number[][] = [];
	for (const plane of planes) {
		for (let at = 0; at < plane.length; at += rowBytes) rows.push(plane.slice(at, at + rowBytes));
	}
	return rows;
}

/** PackBits using literal packets only, which is the simplest legal encoding. */
function packLiterals(row: readonly number[]): number[] {
	const out: number[] = [];
	for (let at = 0; at < row.length; at += 128) {
		const chunk = row.slice(at, at + 128);
		out.push(chunk.length - 1, ...chunk);
	}
	return out;
}

/** A run length encoded image data body: the row length table, then the rows. */
function rleBody(rows: readonly (readonly number[])[], wide = false): number[] {
	const packed = rows.map((row) => packLiterals(row));
	const out: number[] = [];
	for (const row of packed) {
		if (wide) u32(out, row.length);
		else u16(out, row.length);
	}
	for (const row of packed) out.push(...row);
	return out;
}

/** The horizontal delta a ZIP with prediction stores at 8 bits, per row. */
function predictBytes(plane: readonly number[], rowBytes: number): number[] {
	const out: number[] = [];
	for (let at = 0; at < plane.length; at += rowBytes) {
		let previous = 0;
		for (let i = 0; i < rowBytes; i += 1) {
			const value = plane[at + i] as number;
			out.push((value - previous) & 0xff);
			previous = value;
		}
	}
	return out;
}

/** The same delta at 16 bits, where it runs over samples rather than bytes. */
function predictShorts(samples: readonly number[], width: number): number[] {
	const out: number[] = [];
	for (let at = 0; at < samples.length; at += width) {
		let previous = 0;
		for (let i = 0; i < width; i += 1) {
			const value = samples[at + i] as number;
			const delta = (value - previous) & 0xffff;
			out.push((delta >>> 8) & 0xff, delta & 0xff);
			previous = value;
		}
	}
	return out;
}

/**
 * The same delta at 32 bits, where the row's bytes are separated first.
 *
 * Every pixel's first byte, then every pixel's second, and so on, and the delta
 * then runs over that rearranged row. It is TIFF's floating point predictor.
 */
function predictFloats(plane: readonly number[], width: number): number[] {
	const rowBytes = width * 4;
	const out: number[] = [];
	for (let at = 0; at < plane.length; at += rowBytes) {
		const separated: number[] = [];
		for (let b = 0; b < 4; b += 1) {
			for (let x = 0; x < width; x += 1) separated.push(plane[at + x * 4 + b] as number);
		}
		let previous = 0;
		for (const value of separated) {
			out.push((value - previous) & 0xff);
			previous = value;
		}
	}
	return out;
}

async function zipBody(plane: readonly number[]): Promise<number[]> {
	return Array.from(await deflate(Uint8Array.from(plane)));
}

/**
 * Somewhere to write deflate's two kinds of bit field.
 *
 * Its fixed width fields go in low bit first and its Huffman codes go in high
 * bit first, which is the one detail that makes hand writing a stream harder
 * than it looks and is why there are two methods here rather than one.
 */
interface BitSink {
	/** A fixed width field: block type, a code length, a repeat count. */
	field(value: number, count: number): void;
	/** A Huffman code, whose bits are written from the top down. */
	code(value: number, count: number): void;
}

/**
 * A zlib stream written bit by bit.
 *
 * No compressor emits the streams below. They are legal up to the point being
 * tested and wrong immediately after it, which is what a file damaged in
 * transit looks like to a reader walking over its blocks, and the only way to
 * reach the refusals that walk exists to produce.
 */
function craftedZip(build: (bits: BitSink) => void): number[] {
	const bytes: number[] = [];
	let partial = 0;
	let used = 0;
	const put = (bit: number): void => {
		partial |= bit << used;
		used += 1;
		if (used === 8) {
			bytes.push(partial);
			partial = 0;
			used = 0;
		}
	};
	build({
		field(value, count) {
			for (let i = 0; i < count; i += 1) put((value >> i) & 1);
		},
		code(value, count) {
			for (let i = count - 1; i >= 0; i -= 1) put((value >> i) & 1);
		},
	});
	if (used > 0) bytes.push(partial);
	return [0x78, 0x9c, ...bytes];
}

/** Big endian floats, which is how a 32 bit Photoshop sample is stored. */
function floatBytes(values: readonly number[]): number[] {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => view.setFloat32(i * 4, value, false));
	return Array.from(out);
}

/**
 * 16 bit samples whose low byte is deliberately not the high one.
 *
 * The reader takes the high byte, so a low byte of 0x7f proves it is taking the
 * one it means to rather than reading the pair the wrong way round.
 */
function shortBytes(values: readonly number[]): number[] {
	return values.flatMap((value) => [value, 0x7f]);
}

/**
 * A colour blended onto white at a coverage, which is how a composite is stored.
 *
 * Photoshop does not write the straight colour an alpha channel belongs to. It
 * writes that colour already blended onto white and leaves the alpha beside it,
 * so a fixture that means to stand in for a real file has to be built the same
 * way round. The throw is not defensive: every value below is chosen so the
 * blend lands on a whole byte, which is what makes the decoded colour exactly
 * the one asked for rather than within a rounding step of it.
 */
function matte(level: number, alpha: number): number {
	const scaled = level * alpha + 255 * (255 - alpha);
	if (scaled % 255 !== 0) {
		throw new Error(`${level} at an alpha of ${alpha} does not blend onto a whole byte`);
	}
	return scaled / 255;
}

/** An indexed colour table: 256 reds, then 256 greens, then 256 blues. */
function colourTable(entries: readonly (readonly [number, number, number])[]): number[] {
	const table = new Array<number>(768).fill(0);
	entries.forEach(([red, green, blue], i) => {
		table[i] = red;
		table[256 + i] = green;
		table[512 + i] = blue;
	});
	return table;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/**
 * A real deflate stream with its checksum broken.
 *
 * The blocks still walk, so this gets past the measurement that finds where one
 * stream ends and is refused by the platform's decompressor rather than by this
 * package, which is the path a damaged file actually takes. A stand-in that
 * errors on cue cannot stand in for it: the failure worth asserting is that the
 * write side of a real stream rejects too, and a rejection nobody is watching
 * takes the whole process down a tick after the decode has already failed
 * correctly.
 */
async function corruptZipBody(plane: readonly number[]): Promise<number[]> {
	const body = await zipBody(plane);
	const last = body.length - 1;
	return body.slice(0, last).concat([(body[last] as number) ^ 0xff]);
}

/* ── The picture every RGB fixture carries ────────────────────────────── */

/**
 * A 4 by 3 image whose rows are red, purple and blue.
 *
 * The same picture ImageMagick was asked to write, so the hand built fixtures
 * and the three foreign files at the bottom assert the same pixels.
 */
const RED_ROW = [255, 0, 0, 255];
const PURPLE_ROW = [128, 0, 128, 255];
const BLUE_ROW = [0, 0, 255, 255];
const RAMP_PIXELS = [
	...RED_ROW,
	...RED_ROW,
	...RED_ROW,
	...RED_ROW,
	...PURPLE_ROW,
	...PURPLE_ROW,
	...PURPLE_ROW,
	...PURPLE_ROW,
	...BLUE_ROW,
	...BLUE_ROW,
	...BLUE_ROW,
	...BLUE_ROW,
];

const RAMP_RED = [255, 255, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0];
const RAMP_GREEN = new Array<number>(12).fill(0);
const RAMP_BLUE = [0, 0, 0, 0, 128, 128, 128, 128, 255, 255, 255, 255];
const RAMP_PLANES = [RAMP_RED, RAMP_GREEN, RAMP_BLUE];

/* ── RGB ──────────────────────────────────────────────────────────────── */

describe('decodePsd in RGB mode', () => {
	it('reads an 8 bit composite stored raw', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			body: RAMP_PLANES.flat(),
		});
		const image = await decodePsd(file);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(image.colourSpace).toBe('srgb');
		expect(pixelsOf(image)).toEqual(RAMP_PIXELS);
	});

	it('reads an 8 bit composite stored with run length encoding', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 1,
			body: rleBody(rowsOf(RAMP_PLANES, 4)),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads channels as whole planes rather than interleaved per pixel', async () => {
		// Every pixel differs from its neighbours here, so a reader that took the
		// three channels three bytes at a time would produce something other than
		// this rather than the same picture with a colour cast.
		const file = buildPsd({
			width: 2,
			height: 1,
			mode: MODE_RGB,
			body: [10, 20, 30, 40, 50, 60],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 30, 50, 255, 20, 40, 60, 255]);
	});

	it('takes the high byte of every sample in a 16 bit composite', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			depth: 16,
			mode: MODE_RGB,
			body: RAMP_PLANES.flatMap((plane) => shortBytes(plane)),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads the channel past the colour channels as alpha', async () => {
		const file = buildPsd({
			channels: 4,
			width: 2,
			height: 1,
			mode: MODE_RGB,
			body: [10, matte(40, 51), 20, matte(50, 51), 30, matte(60, 51), 255, 51],
		});
		const image = await decodePsd(file);

		expect(pixelsOf(image)).toEqual([10, 20, 30, 255, 40, 50, 60, 51]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reports no alpha when the file carries only its colour channels', async () => {
		const file = buildPsd({ width: 2, height: 1, mode: MODE_RGB, body: [1, 2, 3, 4, 5, 6] });

		expect((await decodePsd(file)).hasAlpha).toBe(false);
	});

	it('reports no alpha when the alpha channel is opaque everywhere', async () => {
		const file = buildPsd({
			channels: 4,
			width: 2,
			height: 1,
			mode: MODE_RGB,
			body: [1, 2, 3, 4, 5, 6, 255, 255],
		});

		expect((await decodePsd(file)).hasAlpha).toBe(false);
	});

	it('reads past the spot channels a file carries after its alpha', async () => {
		// Five channels: red, green, blue, alpha and one spot plate. The spot
		// plate is a separation rather than part of the composite, so it is read
		// past rather than blended in.
		const file = buildPsd({
			channels: 5,
			width: 1,
			height: 1,
			mode: MODE_RGB,
			body: [matte(10, 51), matte(20, 51), matte(30, 51), 51, 99],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 20, 30, 51]);
	});

	it('takes the high byte of a 16 bit alpha channel as well', async () => {
		const file = buildPsd({
			channels: 4,
			width: 1,
			height: 1,
			depth: 16,
			mode: MODE_RGB,
			body: shortBytes([matte(10, 51)]).concat(
				shortBytes([matte(20, 51)]),
				shortBytes([matte(30, 51)]),
				shortBytes([51]),
			),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 20, 30, 51]);
	});
});

/* ── Greyscale and duotone ────────────────────────────────────────────── */

describe('decodePsd in greyscale mode', () => {
	it('reads an 8 bit composite', async () => {
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 1,
			mode: MODE_GREYSCALE,
			body: [0, 64, 128, 255],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([
			0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
		]);
	});

	it('reads a 16 bit composite', async () => {
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			depth: 16,
			mode: MODE_GREYSCALE,
			body: shortBytes([40, 200]),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([40, 40, 40, 255, 200, 200, 200, 255]);
	});

	it('reads a composite with an alpha channel', async () => {
		const file = buildPsd({
			channels: 2,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			body: [10, matte(20, 51), 0, 51],
		});

		// The first pixel has no coverage at all, so the level stored under it is
		// the matte rather than a colour, and it is left where the file left it.
		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 0, 20, 20, 20, 51]);
	});

	it('reads a duotone file as greyscale, which is how it is stored', async () => {
		// The ink specification sits in the colour mode data and is skipped: the
		// format's own advice to a reader that does not reproduce duotone inks is
		// to treat the image as greyscale, and the stored channel already is one.
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_DUOTONE,
			colourModeData: [0, 1, 2, 3, 4, 5, 6, 7],
			body: [30, 60],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([30, 30, 30, 255, 60, 60, 60, 255]);
	});
});

/* ── Indexed ──────────────────────────────────────────────────────────── */

describe('decodePsd in indexed mode', () => {
	it('reads a composite through its colour table', async () => {
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 3,
			mode: MODE_INDEXED,
			colourModeData: colourTable([
				[255, 0, 0],
				[0, 0, 255],
				[128, 0, 128],
			]),
			body: [0, 0, 0, 0, 2, 2, 2, 2, 1, 1, 1, 1],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads the table as three runs of 256 rather than as 256 triples', async () => {
		// Read interleaved, index 1 would come out black and index 0 would pick up
		// index 1's red as its own green. Both are plausible enough looking
		// pictures to survive a glance, which is why this is asserted directly.
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_INDEXED,
			colourModeData: colourTable([
				[10, 20, 30],
				[200, 100, 50],
			]),
			body: [0, 1],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 20, 30, 255, 200, 100, 50, 255]);
	});

	it('reads a composite with an alpha channel', async () => {
		const file = buildPsd({
			channels: 2,
			width: 2,
			height: 1,
			mode: MODE_INDEXED,
			// The table holds what was stored, and what a composite stores under
			// a partial coverage is the colour already blended onto white.
			colourModeData: colourTable([
				[10, 20, 30],
				[matte(200, 51), matte(100, 51), matte(50, 51)],
			]),
			body: [1, 0, 51, 255],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([200, 100, 50, 51, 10, 20, 30, 255]);
	});

	it('reads every index a byte can hold without running off the table', async () => {
		const entries: [number, number, number][] = [];
		for (let i = 0; i < 256; i += 1) entries.push([i, 255 - i, 0]);
		const file = buildPsd({
			channels: 1,
			width: 256,
			height: 1,
			mode: MODE_INDEXED,
			colourModeData: colourTable(entries),
			body: Array.from({ length: 256 }, (_unused, i) => i),
		});
		const image = await decodePsd(file);

		expect(pixelsOf(image).slice(0, 4)).toEqual([0, 255, 0, 255]);
		expect(pixelsOf(image).slice(-4)).toEqual([255, 0, 0, 255]);
	});
});

/* ── Bitmap ───────────────────────────────────────────────────────────── */

describe('decodePsd in bitmap mode', () => {
	it('reads a set bit as black, which is the reverse of the obvious reading', async () => {
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 3,
			depth: 1,
			mode: MODE_BITMAP,
			body: [0b10100000, 0b01000000, 0b11110000],
		});
		const image = await decodePsd(file);

		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual([
			0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0,
			0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0,
			0, 0, 255,
		]);
	});

	it('pads a row out to a whole byte', async () => {
		// Nine pixels take two bytes and the last seven bits carry no pixel. A
		// reader that packed rows end to end would take the second row's first
		// pixel from the first row's padding.
		const file = buildPsd({
			channels: 1,
			width: 9,
			height: 2,
			depth: 1,
			mode: MODE_BITMAP,
			body: [0b11111111, 0b00000000, 0b00000000, 0b10000000],
		});
		const image = await decodePsd(file);

		expect(pixelsOf(image).slice(0, 4)).toEqual([0, 0, 0, 255]);
		expect(pixelsOf(image).slice(32, 36)).toEqual([255, 255, 255, 255]);
		expect(pixelsOf(image).slice(36, 40)).toEqual([255, 255, 255, 255]);
		expect(pixelsOf(image).slice(68, 72)).toEqual([0, 0, 0, 255]);
	});

	it('reads a bitmap stored with run length encoding', async () => {
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 2,
			depth: 1,
			mode: MODE_BITMAP,
			compression: 1,
			body: rleBody([[0b10000000], [0b01000000]]),
		});

		expect(pixelsOf(await decodePsd(file)).slice(0, 8)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	});
});

/* ── CMYK ─────────────────────────────────────────────────────────────── */

describe('decodePsd in CMYK mode', () => {
	it('reads an 8 bit composite', async () => {
		const cyan = [255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0];
		const magenta = new Array<number>(12).fill(0);
		const yellow = [0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255];
		const black = [255, 255, 255, 255, 128, 128, 128, 128, 255, 255, 255, 255];
		const file = buildPsd({
			channels: 4,
			width: 4,
			height: 3,
			mode: MODE_CMYK,
			body: [...cyan, ...magenta, ...yellow, ...black],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('treats a stored zero as full ink and a stored 255 as none', async () => {
		// The inversion is the whole trap. Written the obvious way round, this
		// file comes back as its own negative.
		const file = buildPsd({
			channels: 4,
			width: 3,
			height: 1,
			mode: MODE_CMYK,
			body: [0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([
			0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255,
		]);
	});

	it('paints black where the key plate is fully inked', async () => {
		const file = buildPsd({
			channels: 4,
			width: 1,
			height: 1,
			mode: MODE_CMYK,
			body: [255, 255, 255, 0],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([0, 0, 0, 255]);
	});

	it('reads a 16 bit composite', async () => {
		const file = buildPsd({
			channels: 4,
			width: 1,
			height: 1,
			depth: 16,
			mode: MODE_CMYK,
			body: shortBytes([255]).concat(shortBytes([0]), shortBytes([0]), shortBytes([255])),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([255, 0, 0, 255]);
	});

	it('reads a composite with an alpha channel', async () => {
		const file = buildPsd({
			channels: 5,
			width: 1,
			height: 1,
			mode: MODE_CMYK,
			body: [255, 255, 255, 255, 96],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([255, 255, 255, 96]);
	});
});

/* ── The white the composite is stored blended onto ───────────────────── */

describe('decodePsd taking the white back out of a composite', () => {
	it('divides a soft edge out of the white it was stored blended onto', async () => {
		// One colour at four coverages, which is what an antialiased edge is.
		// Read as straight alpha, each of these is a lighter colour than the one
		// beside it at full coverage, and lighter the less of it there is, which
		// is the white halo a Photoshop file grows around everything in it.
		const coverages = [255, 204, 153, 51];
		const file = buildPsd({
			channels: 4,
			width: 4,
			height: 1,
			mode: MODE_RGB,
			body: [
				...coverages.map((alpha) => matte(20, alpha)),
				...coverages.map((alpha) => matte(40, alpha)),
				...coverages.map((alpha) => matte(60, alpha)),
				...coverages,
			],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(
			coverages.flatMap((alpha) => [20, 40, 60, alpha]),
		);
	});

	it('leaves the matte alone where the composite has no coverage', async () => {
		// Nothing was blended in, so there is nothing to divide by and nothing
		// to take back out. Every fully transparent pixel of a real Photoshop
		// file is this exact white, and that is the evidence the rest is a blend.
		const file = buildPsd({
			channels: 4,
			width: 1,
			height: 1,
			mode: MODE_RGB,
			body: [255, 255, 255, 0],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([255, 255, 255, 0]);
	});

	it('stops at black rather than carrying on past it', async () => {
		// A composite further from white than its own coverage allows is not a
		// blend of anything, and the division sends it below zero. ImageMagick's
		// writer produces exactly this, because it stores the straight colour
		// where Photoshop stores the blend.
		const file = buildPsd({
			channels: 4,
			width: 1,
			height: 1,
			mode: MODE_RGB,
			body: [100, 100, 100, 51],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([0, 0, 0, 51]);
	});

	it('divides the plates of a CMYK composite before they multiply together', async () => {
		// Paper white is a stored 255 on every plate, so a CMYK composite is
		// blended onto the same white the others are, plate by plate. Dividing
		// after the plates have multiplied into a colour reads this pixel as
		// something else entirely, and it is the one case where where the
		// division happens is visible.
		const file = buildPsd({
			channels: 5,
			width: 1,
			height: 1,
			mode: MODE_CMYK,
			body: [matte(100, 51), matte(150, 51), matte(200, 51), matte(100, 51), 51],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([39, 59, 78, 51]);
	});

	it('divides a 32 bit composite against a ceiling of one instead of 255', async () => {
		// The same colour twice, stored straight at full coverage and blended at
		// half. Both values are exact in binary, so the two pixels are the same
		// colour to the bit once the blend is out, and the tone mapper cannot
		// separate them. Left in, the second is the brighter of the two.
		const file = buildPsd({
			channels: 2,
			width: 2,
			height: 1,
			depth: 32,
			mode: MODE_GREYSCALE,
			body: floatBytes([0.25, 0.25 * 0.5 + 0.5]).concat(floatBytes([1, 0.5])),
		});
		const image = await decodePsd(file);

		expect(image.data[4]).toBe(image.data[0]);
		expect(image.data[3]).toBe(255);
		expect(image.data[7]).toBe(128);
	});

	it('leaves a composite with no alpha channel exactly as it is stored', async () => {
		const file = buildPsd({ width: 4, height: 3, mode: MODE_RGB, body: RAMP_PLANES.flat() });

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});
});

/* ── 32 bit floating point ────────────────────────────────────────────── */

describe('decodePsd at 32 bits', () => {
	it('puts a middle grey scene back at middle grey', async () => {
		// 0.18 is the reflectance a camera's average metering aims at, and the
		// tone mapper meters the same way, so a flat 0.18 field comes out as the
		// sRGB encoding of 0.18 rather than clipped or crushed.
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 2,
			depth: 32,
			mode: MODE_GREYSCALE,
			body: floatBytes([0.18, 0.18, 0.18, 0.18]),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([
			118, 118, 118, 255, 118, 118, 118, 255, 118, 118, 118, 255, 118, 118, 118, 255,
		]);
	});

	it('keeps a linear ramp in order once it is tone mapped', async () => {
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 1,
			depth: 32,
			mode: MODE_GREYSCALE,
			body: floatBytes([0.05, 0.2, 0.6, 4]),
		});
		const image = await decodePsd(file);
		const levels = [0, 1, 2, 3].map((i) => image.data[i * 4] as number);

		expect(levels[0]).toBeLessThan(levels[1] as number);
		expect(levels[1]).toBeLessThan(levels[2] as number);
		expect(levels[2]).toBeLessThan(levels[3] as number);
	});

	it('reads a 32 bit RGB composite one plane at a time', async () => {
		const file = buildPsd({
			width: 2,
			height: 1,
			depth: 32,
			mode: MODE_RGB,
			body: floatBytes([1, 0]).concat(floatBytes([0, 1]), floatBytes([0, 0])),
		});
		const image = await decodePsd(file);

		// Exact levels are the tone mapper's business; which channel is lit is
		// this reader's.
		expect(image.data[0]).toBeGreaterThan(image.data[1] as number);
		expect(image.data[5]).toBeGreaterThan(image.data[4] as number);
	});

	it('carries a 32 bit alpha channel through as coverage', async () => {
		const file = buildPsd({
			channels: 2,
			width: 2,
			height: 1,
			depth: 32,
			mode: MODE_GREYSCALE,
			body: floatBytes([0.18, 0.18]).concat(floatBytes([1, 0.5])),
		});
		const image = await decodePsd(file);

		expect(image.hasAlpha).toBe(true);
		expect(image.data[3]).toBe(255);
		expect(image.data[7]).toBe(128);
	});
});

/* ── Compression ──────────────────────────────────────────────────────── */

describe('decodePsd compression methods', () => {
	it('reads a repeated run packet', async () => {
		// 0xfd is -3 in a signed byte, so the next byte is repeated four times.
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 1,
			body: [0, 2, 0xfd, 77],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([
			77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255,
		]);
	});

	it('treats the control byte 128 as writing nothing at all', async () => {
		// Taken as a run of one it would write a byte that is not in the picture
		// and push the rest of the row along by one, which is a plausible looking
		// image rather than an error.
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 1,
			body: [0, 4, 128, 1, 10, 20],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
	});

	it('reads a ZIP compressed composite', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 2,
			body: await zipBody(RAMP_PLANES.flat()),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads every channel out of one ZIP stream when that is what the section holds', async () => {
		// One deflate stream covering all three planes. Nothing in the section
		// says which of the two layouts it is, so both have to read.
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 2,
			body: await zipBody(RAMP_PLANES.flat()),
		});
		const image = await decodePsd(file);

		expect(image.data[2]).toBe(0);
		expect(image.data[34]).toBe(255);
	});

	it('reads a section holding one ZIP stream per channel plane', async () => {
		// Which is what every writer that puts ZIP here actually emits, with
		// nothing in front of any stream saying how long it is. Handing the
		// whole section to one decompressor stops at the end of the first plane
		// and rejects everything after it as junk, so a file like this decoded
		// to nothing at all rather than to a wrong picture.
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 2,
			body: (await zipBody(RAMP_RED)).concat(await zipBody(RAMP_GREEN), await zipBody(RAMP_BLUE)),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads one ZIP stream per plane with the delta on top of it', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 3,
			body: (await zipBody(predictBytes(RAMP_RED, 4))).concat(
				await zipBody(predictBytes(RAMP_GREEN, 4)),
				await zipBody(predictBytes(RAMP_BLUE, 4)),
			),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('stops at the last plane it needs rather than at the end of the file', async () => {
		// Four streams where three cover the picture. The fourth is whatever a
		// writer left after the composite, and reading it is not this reader's
		// business.
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 2,
			body: (await zipBody(RAMP_RED)).concat(
				await zipBody(RAMP_GREEN),
				await zipBody(RAMP_BLUE),
				await zipBody([0xde, 0xad, 0xbe, 0xef]),
			),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('ignores bytes sitting after a ZIP compressed image data section', async () => {
		// The raw and run length paths have always read their own length and
		// left whatever followed alone. Handing everything to the end of the
		// file to a decompressor instead made a single byte of padding fatal.
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 2,
			body: (await zipBody([10, 20])).concat([0x00, 0xde, 0xad]),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
	});

	it('undoes the horizontal delta of a ZIP with prediction at 8 bits', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 3,
			body: await zipBody(RAMP_PLANES.flatMap((plane) => predictBytes(plane, 4))),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('restarts the delta at the beginning of every row', async () => {
		// A delta that ran on across the row boundary would leave every row after
		// the first offset by the last value of the one before it.
		const plane = [10, 20, 30, 40, 200, 210, 220, 230];
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 2,
			mode: MODE_GREYSCALE,
			compression: 3,
			body: await zipBody(predictBytes(plane, 4)),
		});
		const image = await decodePsd(file);

		expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => image.data[i * 4])).toEqual(plane);
	});

	it('restarts the delta at the beginning of every channel', async () => {
		// A delta that carried on into the alpha plane would read its first
		// sample as 20 plus 204 rather than as 204.
		const file = buildPsd({
			channels: 2,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 3,
			body: await zipBody(
				predictBytes([matte(10, 204), 20], 2).concat(predictBytes([204, 255], 2)),
			),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 204, 20, 20, 20, 255]);
	});

	it('undoes the horizontal delta of a ZIP with prediction at 16 bits', async () => {
		const samples = [0x0102, 0x2030, 0x4050, 0xf0f0];
		const file = buildPsd({
			channels: 1,
			width: 4,
			height: 1,
			depth: 16,
			mode: MODE_GREYSCALE,
			compression: 3,
			body: await zipBody(predictShorts(samples, 4)),
		});
		const image = await decodePsd(file);

		expect([0, 1, 2, 3].map((i) => image.data[i * 4])).toEqual([0x01, 0x20, 0x40, 0xf0]);
	});

	it('separates the bytes of a 32 bit row when it undoes the prediction', async () => {
		const plane = floatBytes([0.18, 0.18, 0.18, 0.18]);
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 2,
			depth: 32,
			mode: MODE_GREYSCALE,
			compression: 3,
			body: await zipBody(predictFloats(plane, 2)),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([
			118, 118, 118, 255, 118, 118, 118, 255, 118, 118, 118, 255, 118, 118, 118, 255,
		]);
	});

	it('ignores whatever the compressed stream holds past the image', async () => {
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 2,
			body: await zipBody([10, 20, 99, 99, 99]),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
	});

	it('reads a ZIP stream that builds Huffman tables of its own', async () => {
		// A short stream is written with the fixed tables of RFC 1951 or not
		// compressed at all. A plane this size makes the compressor build tables
		// and write them into the stream ahead of the data, which is the long way
		// through measuring one, and it also comes back out of the decompressor
		// in more than one piece.
		const width = 200;
		const height = 200;
		const plane = Array.from(
			{ length: width * height },
			(_, i) => (i * 7 + ((i >> 5) % 13) * 31) & 0xff,
		);
		const file = buildPsd({
			channels: 1,
			width,
			height,
			mode: MODE_GREYSCALE,
			compression: 2,
			body: await zipBody(plane),
		});
		const image = await decodePsd(file);

		expect(Array.from({ length: plane.length }, (_, i) => image.data[i * 4])).toEqual(plane);
	});

	it('reads a ZIP stream holding a block that was stored rather than coded', async () => {
		// Deflate gives up on data it cannot compress and writes it out as it
		// stands, in a block that states its own length instead of holding any
		// codes at all. Measuring one means stepping over it.
		let seed = 12345;
		const plane = Array.from({ length: 3000 }, () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return (seed >>> 16) & 0xff;
		});
		const file = buildPsd({
			channels: 1,
			width: 100,
			height: 30,
			mode: MODE_GREYSCALE,
			compression: 2,
			body: await zipBody(plane),
		});
		const image = await decodePsd(file);

		expect(Array.from({ length: plane.length }, (_, i) => image.data[i * 4])).toEqual(plane);
	});
});

/* ── PSB ──────────────────────────────────────────────────────────────── */

describe('decodePsd on a PSB', () => {
	it('reads the eight byte layer and mask length a PSB writes', async () => {
		// Read as four bytes, the image data offset lands in the middle of the
		// layer stack and the compression word is whatever is sitting there.
		const file = buildPsd({
			version: 2,
			width: 4,
			height: 3,
			mode: MODE_RGB,
			layerAndMask: [1, 2, 3, 4, 5, 6, 7, 8],
			body: RAMP_PLANES.flat(),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('reads a four byte row length table', async () => {
		const file = buildPsd({
			version: 2,
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 1,
			body: rleBody(rowsOf(RAMP_PLANES, 4), true),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('allows a side a PSD may not', async () => {
		const file = buildPsd({
			version: 2,
			channels: 1,
			width: 40000,
			height: 1,
			mode: MODE_GREYSCALE,
			body: new Array<number>(40000).fill(7),
		});
		const image = await decodePsd(file);

		expect(image.width).toBe(40000);
		expect(image.data[0]).toBe(7);
	});
});

/* ── Whatever else is in the file ─────────────────────────────────────── */

describe('decodePsd reading past the sections it does not use', () => {
	it('skips the colour mode data, image resources and layer stack', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			colourModeData: [9, 9, 9],
			resources: [0x38, 0x42, 0x49, 0x4d, 1, 2, 3, 4],
			layerAndMask: new Array<number>(64).fill(0xaa),
			body: RAMP_PLANES.flat(),
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('ignores bytes sitting after the image data', async () => {
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			body: [10, 20, 0xde, 0xad, 0xbe, 0xef],
		});

		expect(pixelsOf(await decodePsd(file))).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', async () => {
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			body: [10, 20],
		});
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(pixelsOf(await decodePsd(padded.subarray(8, 8 + file.length)))).toEqual([
			10, 10, 10, 255, 20, 20, 20, 255,
		]);
	});
});

/* ── Files this package did not write ─────────────────────────────────── */

describe('decodePsd against files from another writer', () => {
	/**
	 * A 4 by 3 PSD written by ImageMagick 7, byte for byte.
	 *
	 * Every other fixture here is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. The files in this block are
	 * not: they came out of implementations with no connection to this one, and
	 * they carry the shape the hand built fixtures never produce, a real layer
	 * and mask section with a deflated layer inside it and a run length encoded
	 * composite after it.
	 *
	 * The pixels asserted below are what ImageMagick itself reads back out.
	 */
	const magickRgb = Uint8Array.from([
		0x38, 0x42, 0x50, 0x53, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x00, 0x76, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x13, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x02, 0x00, 0x00, 0x00, 0x13,
		0x38, 0x42, 0x49, 0x4d, 0x6e, 0x6f, 0x72, 0x6d, 0xff, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0c,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x4c, 0x31, 0x00, 0x00, 0x02, 0x78, 0x9c,
		0xfb, 0xff, 0xff, 0xff, 0xff, 0x06, 0x20, 0x60, 0x00, 0x02, 0x00, 0x36, 0xe2, 0x05, 0xfd, 0x00,
		0x02, 0x78, 0x9c, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x01, 0x00, 0x02, 0x78, 0x9c,
		0x63, 0x60, 0x60, 0x60, 0x68, 0x00, 0x82, 0xff, 0x40, 0x00, 0x00, 0x17, 0x02, 0x05, 0xfd, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00,
		0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0xfd, 0xff, 0x80, 0xfd, 0x80, 0x80, 0xfd, 0x00, 0x80,
		0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x80, 0x80, 0xfd,
		0xff, 0x80,
	]);

	/** The same picture, written as CMYK. Its four plates are stored inverted. */
	const magickCmyk = Uint8Array.from([
		0x38, 0x42, 0x50, 0x53, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00,
		0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x88, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x02, 0x00, 0x00, 0x00, 0x10,
		0x00, 0x03, 0x00, 0x00, 0x00, 0x13, 0x38, 0x42, 0x49, 0x4d, 0x6e, 0x6f, 0x72, 0x6d, 0xff, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x4c,
		0x31, 0x00, 0x00, 0x02, 0x78, 0x9c, 0xfb, 0xff, 0x1f, 0x02, 0x18, 0x80, 0x00, 0x00, 0x43, 0xc8,
		0x07, 0xf9, 0x00, 0x02, 0x78, 0x9c, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x01, 0x00,
		0x02, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x05, 0x00, 0x23, 0xe8, 0x07, 0xf9, 0x00,
		0x02, 0x78, 0x9c, 0xfb, 0xff, 0xff, 0xff, 0xff, 0x06, 0x20, 0x00, 0x52, 0xff, 0x01, 0x40, 0xd8,
		0x09, 0xf9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03,
		0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03, 0x00, 0x03,
		0xfd, 0xff, 0x80, 0xfd, 0xff, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd,
		0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0xff, 0x80, 0xfd, 0xff, 0x80, 0xfd, 0xff, 0x80, 0xfd, 0x80,
		0x80, 0xfd, 0xff, 0x80,
	]);

	/** The same picture again as a PSB, with the wide fields a PSB uses. */
	const magickPsb = Uint8Array.from([
		0x38, 0x42, 0x50, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x82, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
		0x00, 0x00, 0x00, 0x04, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13,
		0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x13, 0x38, 0x42, 0x49, 0x4d, 0x6e, 0x6f, 0x72, 0x6d, 0xff, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x4c, 0x31, 0x00,
		0x00, 0x02, 0x78, 0x9c, 0xfb, 0xff, 0xff, 0xff, 0xff, 0x06, 0x20, 0x60, 0x00, 0x02, 0x00, 0x36,
		0xe2, 0x05, 0xfd, 0x00, 0x02, 0x78, 0x9c, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x01,
		0x00, 0x02, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x68, 0x00, 0x82, 0xff, 0x40, 0x00, 0x00, 0x17,
		0x02, 0x05, 0xfd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
		0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
		0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0xfd, 0xff, 0x80,
		0xfd, 0x80, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd, 0x00, 0x80, 0xfd,
		0x00, 0x80, 0xfd, 0x80, 0x80, 0xfd, 0xff, 0x80,
	]);

	it('reads a run length encoded PSD written by ImageMagick', async () => {
		const image = await decodePsd(magickRgb);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual(RAMP_PIXELS);
	});

	it('reads a CMYK PSD written by ImageMagick back to the same colours', async () => {
		expect(pixelsOf(await decodePsd(magickCmyk))).toEqual(RAMP_PIXELS);
	});

	it('reads a PSB written by ImageMagick', async () => {
		const image = await decodePsd(magickPsb);

		expect(image.width).toBe(4);
		expect(pixelsOf(image)).toEqual(RAMP_PIXELS);
	});

	/**
	 * The same picture again, ZIP compressed, from `magick -compress Zip`.
	 *
	 * Its image data section is three separate zlib streams, one per channel
	 * plane, and that is the layout this reader was written against the wrong
	 * reading of. Nothing hand built here would have caught it: assembling a
	 * fixture from the specification means assembling it the way the reader
	 * expects, and both halves were wrong together.
	 */
	const magickZip = Uint8Array.from([
		0x38, 0x42, 0x50, 0x53, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x00, 0x76, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x13, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x02, 0x00, 0x00, 0x00, 0x13,
		0x38, 0x42, 0x49, 0x4d, 0x6e, 0x6f, 0x72, 0x6d, 0xff, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0c,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x4c, 0x31, 0x00, 0x00, 0x02, 0x78, 0x9c,
		0xfb, 0xff, 0xff, 0xff, 0xff, 0x06, 0x20, 0x60, 0x00, 0x02, 0x00, 0x36, 0xe2, 0x05, 0xfd, 0x00,
		0x02, 0x78, 0x9c, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x01, 0x00, 0x02, 0x78, 0x9c,
		0x63, 0x60, 0x60, 0x60, 0x68, 0x00, 0x82, 0xff, 0x40, 0x00, 0x00, 0x17, 0x02, 0x05, 0xfd, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x02, 0x78, 0x9c, 0xfb, 0xff, 0xff, 0xff, 0xff, 0x06, 0x20, 0x60, 0x00,
		0x02, 0x00, 0x36, 0xe2, 0x05, 0xfd, 0x78, 0x9c, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00,
		0x01, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x68, 0x00, 0x82, 0xff, 0x40, 0x00, 0x00, 0x17, 0x02,
		0x05, 0xfd,
	]);

	it('reads a ZIP compressed PSD written by ImageMagick', async () => {
		expect(pixelsOf(await decodePsd(magickZip))).toEqual(RAMP_PIXELS);
	});

	/**
	 * The same picture's channel planes, predicted and deflated by libtiff.
	 *
	 * Nothing available here writes a PSD with prediction, and nothing writes a
	 * 32 bit one at all: asking ImageMagick for `-depth 32 PSD:` gets a 16 bit
	 * file back. So the delta and the 32 bit sample layout were checked only
	 * against this file's own inverses of them, which is the same reading of the
	 * specification on both sides of the assertion.
	 *
	 * TIFF is the way round that. Its predictor 2 is the same horizontal delta a
	 * ZIP compressed PSD applies, per row and per plane, and its predictor 3 is
	 * the same byte separated one for floating point; a TIFF written with
	 * `-interlace plane -endian MSB` stores each plane as one deflate stream of
	 * exactly those bytes. Lifting the strips out of one and dropping them into
	 * a PSD's image data section produces a file no part of this package has
	 * touched, encoded by libtiff, that this reader must agree with.
	 */
	const libtiffPredicted8 = [
		0x78, 0xda, 0xfb, 0xcf, 0xc0, 0xc0, 0xd0, 0xc0, 0x00, 0x01, 0x00, 0x10, 0x00, 0x01, 0x80, 0x78,
		0xda, 0x63, 0x60, 0x40, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x01, 0x78, 0xda, 0x63, 0x60, 0x60, 0x60,
		0x68, 0x00, 0xe2, 0xff, 0x40, 0x0c, 0x00, 0x08, 0x08, 0x01, 0x80,
	];
	const libtiffPredicted16 = [
		0x78, 0xda, 0xfb, 0xff, 0x9f, 0x01, 0x0c, 0x1a, 0x1a, 0x18, 0x50, 0x00, 0x00, 0x3e, 0x69, 0x02,
		0xff, 0x78, 0xda, 0x63, 0x60, 0xc0, 0x0e, 0x00, 0x00, 0x18, 0x00, 0x01, 0x78, 0xda, 0x63, 0x60,
		0x80, 0x80, 0x86, 0x06, 0x08, 0xfd, 0xff, 0x3f, 0x84, 0x06, 0x00, 0x1e, 0x89, 0x02, 0xff,
	];
	const libtiffPredicted32 = [
		0x78, 0xda, 0xb3, 0x67, 0x60, 0x60, 0x70, 0x04, 0xe2, 0x06, 0x06, 0x08, 0xb0, 0x07, 0xe2, 0x83,
		0x50, 0x3e, 0x23, 0x03, 0x26, 0x00, 0x00, 0x54, 0x3c, 0x02, 0x82, 0x78, 0xda, 0x63, 0x60, 0x20,
		0x0d, 0x00, 0x00, 0x00, 0x30, 0x00, 0x01, 0x78, 0xda, 0x63, 0x60, 0x40, 0x05, 0xf6, 0x40, 0x7c,
		0x10, 0x88, 0x1b, 0x80, 0x98, 0x11, 0xca, 0x77, 0x84, 0xf2, 0x41, 0x00, 0x00, 0x34, 0x3c, 0x02,
		0x82,
	];

	it('undoes an 8 bit delta another encoder wrote', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			mode: MODE_RGB,
			compression: 3,
			body: libtiffPredicted8,
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('undoes a 16 bit delta another encoder wrote', async () => {
		const file = buildPsd({
			width: 4,
			height: 3,
			depth: 16,
			mode: MODE_RGB,
			compression: 3,
			body: libtiffPredicted16,
		});

		expect(pixelsOf(await decodePsd(file))).toEqual(RAMP_PIXELS);
	});

	it('undoes the byte separated 32 bit delta another encoder wrote', async () => {
		// The 32 bit path meters the picture before it quantises it, so the
		// pixels this lands on are the tone mapper's business rather than the
		// predictor's. What is asserted is that the predicted planes and the
		// same planes stored raw arrive at the same place, which is the
		// predictor on its own with the tone mapping cancelled out of it.
		const predicted = buildPsd({
			width: 4,
			height: 3,
			depth: 32,
			mode: MODE_RGB,
			compression: 3,
			body: libtiffPredicted32,
		});
		// The samples libtiff was handed, which are the quantum values divided
		// by the range: 255 lands on 1, 128 on 128/255, and 0 on 0.
		const half = 128 / 255;
		const plain = buildPsd({
			width: 4,
			height: 3,
			depth: 32,
			mode: MODE_RGB,
			body: floatBytes([1, 1, 1, 1, half, half, half, half, 0, 0, 0, 0]).concat(
				floatBytes(new Array<number>(12).fill(0)),
				floatBytes([0, 0, 0, 0, half, half, half, half, 1, 1, 1, 1]),
			),
		});

		expect(pixelsOf(await decodePsd(predicted))).toEqual(pixelsOf(await decodePsd(plain)));
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodePsd refusals', () => {
	async function expectRefusal(bytes: Uint8Array, pattern: RegExp): Promise<void> {
		let thrown: unknown;
		try {
			await decodePsd(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('psd');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	/** The smallest ZIP compressed file a given image data section can sit in. */
	function zipRefusal(body: readonly number[]): Uint8Array {
		return buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 2,
			body,
		});
	}

	const plain: PsdSpec = { channels: 1, width: 2, height: 1, mode: MODE_GREYSCALE, body: [10, 20] };

	it('rejects a file that does not start with 8BPS', async () => {
		const file = buildPsd(plain);
		file[3] = 0x54;
		await expectRefusal(file, /8BPS/);
	});

	it.each([0, 4, 13, 25])('rejects a file cut off at %i bytes', async (length) => {
		await expectRefusal(buildPsd(plain).subarray(0, length), /26 byte header/);
	});

	it.each([0, 3, 65535])('rejects format version %i', async (version) => {
		await expectRefusal(buildPsd({ ...plain, version }), /format version/);
	});

	it('rejects a file whose reserved bytes are not zero', async () => {
		await expectRefusal(buildPsd({ ...plain, reserved: [0, 0, 1, 0, 0, 0] }), /reserved bytes/);
	});

	it('rejects a channel count of zero', async () => {
		await expectRefusal(buildPsd({ ...plain, channels: 0 }), /0 channels/);
	});

	it('rejects a channel count past the 56 the format allows', async () => {
		await expectRefusal(buildPsd({ ...plain, channels: 57 }), /57 channels/);
	});

	it('rejects a width of zero', async () => {
		await expectRefusal(buildPsd({ ...plain, width: 0 }), /width or a height of zero/);
	});

	it('rejects a height of zero', async () => {
		await expectRefusal(buildPsd({ ...plain, height: 0 }), /width or a height of zero/);
	});

	it('rejects a PSD wider than the 30000 Photoshop allows', async () => {
		await expectRefusal(buildPsd({ ...plain, width: 30001 }), /past the 30000 a PSD is allowed/);
	});

	it('rejects a PSD taller than the 30000 Photoshop allows', async () => {
		await expectRefusal(buildPsd({ ...plain, height: 30001 }), /past the 30000 a PSD is allowed/);
	});

	it('rejects a PSB wider than the 300000 Photoshop allows', async () => {
		await expectRefusal(
			buildPsd({ ...plain, version: 2, width: 300001 }),
			/past the 300000 a PSB is allowed/,
		);
	});

	it('rejects a pixel count larger than it will allocate for, without allocating', async () => {
		// Both sides are legal for a PSB on their own. Ninety billion pixels is
		// not, and the refusal has to come from the header rather than from the
		// allocator.
		await expectRefusal(
			buildPsd({ ...plain, version: 2, width: 300000, height: 300000 }),
			/far larger than anything this tool will allocate for/,
		);
	});

	it.each([2, 4, 24, 64])('rejects a depth of %i bits', async (depth) => {
		await expectRefusal(buildPsd({ ...plain, depth }), /bits per channel/);
	});

	it('names multichannel rather than guessing what its plates mean', async () => {
		await expectRefusal(buildPsd({ ...plain, mode: MODE_MULTICHANNEL }), /multichannel/);
	});

	it('names Lab rather than reading it as RGB', async () => {
		await expectRefusal(buildPsd({ ...plain, channels: 3, mode: MODE_LAB }), /Lab colour/);
	});

	it.each([5, 6, 10, 65535])('rejects colour mode %i, which does not exist', async (mode) => {
		await expectRefusal(buildPsd({ ...plain, mode }), /colour mode/);
	});

	it('rejects a bitmap mode file that is not one bit per channel', async () => {
		await expectRefusal(buildPsd({ ...plain, mode: MODE_BITMAP }), /bitmap mode image at 8 bits/);
	});

	it('rejects a bitmap mode file with more than one channel', async () => {
		await expectRefusal(
			buildPsd({ ...plain, channels: 2, depth: 1, mode: MODE_BITMAP }),
			/bitmap mode image with 2 channels/,
		);
	});

	it('rejects one bit per channel outside bitmap mode', async () => {
		await expectRefusal(buildPsd({ ...plain, depth: 1 }), /one bit per channel outside bitmap/);
	});

	it('rejects an indexed file that is not eight bits per channel', async () => {
		await expectRefusal(
			buildPsd({ ...plain, depth: 16, mode: MODE_INDEXED }),
			/indexed image at 16 bits/,
		);
	});

	it('names 32 bit CMYK rather than inventing a conversion for it', async () => {
		await expectRefusal(
			buildPsd({ ...plain, channels: 4, depth: 32, mode: MODE_CMYK }),
			/32 bit floating point CMYK/,
		);
	});

	it('rejects a file with fewer channels than its colour mode needs', async () => {
		await expectRefusal(
			buildPsd({ ...plain, channels: 2, mode: MODE_RGB }),
			/2 channels, where its colour mode needs 3/,
		);
	});

	it('rejects a file cut off before its colour mode data length', async () => {
		await expectRefusal(buildPsd(plain).subarray(0, 28), /length of its colour mode data/);
	});

	it('rejects a file cut off inside its colour mode data', async () => {
		const file = buildPsd({ ...plain, colourModeData: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
		await expectRefusal(file.subarray(0, 35), /end of its colour mode data/);
	});

	it('rejects a file cut off before its image resources length', async () => {
		await expectRefusal(buildPsd(plain).subarray(0, 32), /length of its image resources/);
	});

	it('rejects a file cut off inside its image resources', async () => {
		const file = buildPsd({ ...plain, resources: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
		await expectRefusal(file.subarray(0, 40), /end of its image resources/);
	});

	it('rejects a file cut off before its layer and mask length', async () => {
		await expectRefusal(buildPsd(plain).subarray(0, 36), /length of its layer and mask/);
	});

	it('rejects a PSB cut off inside the eight bytes of that same length', async () => {
		await expectRefusal(
			buildPsd({ ...plain, version: 2 }).subarray(0, 38),
			/length of its layer and mask/,
		);
	});

	it('rejects a file cut off inside its layer and mask information', async () => {
		const file = buildPsd({
			...plain,
			layerAndMask: new Array<number>(20).fill(0),
			omitImageData: true,
		});
		await expectRefusal(file.subarray(0, file.length - 5), /end of its layer and mask/);
	});

	it('names the image data section when the file stops before it', async () => {
		await expectRefusal(
			buildPsd({ ...plain, omitImageData: true }),
			/image data section, which is where the flattened picture lives/,
		);
	});

	it('rejects an indexed file whose colour table is the wrong length', async () => {
		await expectRefusal(
			buildPsd({ ...plain, mode: MODE_INDEXED, colourModeData: new Array<number>(700).fill(0) }),
			/colour mode data is 700 bytes/,
		);
	});

	it('rejects an indexed file with no colour table at all', async () => {
		await expectRefusal(buildPsd({ ...plain, mode: MODE_INDEXED }), /colour mode data is 0 bytes/);
	});

	it.each([4, 5, 65535])('rejects compression method %i', async (compression) => {
		await expectRefusal(buildPsd({ ...plain, compression }), /compression method/);
	});

	it('rejects a file cut off inside its uncompressed image data', async () => {
		await expectRefusal(
			buildPsd({ channels: 1, width: 8, height: 4, mode: MODE_GREYSCALE, body: [1, 2, 3] }),
			/end of its uncompressed image data/,
		);
	});

	it('rejects a file cut off inside its row length table', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 4,
				height: 4,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0],
			}),
			/table of row lengths/,
		);
	});

	it('rejects a row whose encoded bytes run off the end of the file', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 4,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 40, 3],
			}),
			/end of row 0 of its image data/,
		);
	});

	it('rejects a row that decodes to fewer bytes than its width', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 4,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 2, 0, 10],
			}),
			/fewer bytes than its width needs/,
		);
	});

	it('rejects a row that decodes to more bytes than its width', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 2,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 5, 3, 10, 20, 30, 40],
			}),
			/more bytes than its width holds/,
		);
	});

	it('rejects a repeated run that would overrun the row', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 2,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 2, 0xfd, 7],
			}),
			/more bytes than its width holds/,
		);
	});

	it('rejects a row that ends inside a literal run', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 4,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 3, 3, 10, 20],
			}),
			/ends inside a literal run/,
		);
	});

	it('rejects a row that ends inside a repeated run', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 4,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: [0, 1, 0xfd],
			}),
			/ends inside a repeated run/,
		);
	});

	it('rejects a run length claim larger than the rest of the file could produce', async () => {
		// The row length table is present and honest about its own size; what it
		// promises to unpack to is not. The refusal has to come before the buffer
		// for it is asked for.
		const table: number[] = [];
		for (let row = 0; row < 100; row += 1) u16(table, 1);
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 1000,
				height: 100,
				mode: MODE_GREYSCALE,
				compression: 1,
				body: table.concat(new Array<number>(100).fill(0)),
			}),
			/more than the .* bytes left in the file could produce/,
		);
	});

	it('rejects a ZIP claim larger than the rest of the file could produce', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 1000,
				height: 1000,
				mode: MODE_GREYSCALE,
				compression: 2,
				body: new Array<number>(10).fill(0),
			}),
			/more than the 10 bytes left in the file could produce/,
		);
	});

	it('rejects a ZIP stream the platform will not inflate', async () => {
		// On the real decompressor rather than a stand-in for it, because the
		// failure that matters is not the sentence: it is that a damaged stream
		// rejects on the write side as well as the read side, and the write side
		// is the one nothing is awaiting. Left unwatched, that rejection ends
		// the process a tick after this assertion has already passed, and the
		// runner reports it against whatever test happens to be running then.
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 2,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 2,
				body: await corruptZipBody([10, 20]),
			}),
			/could not be unpacked/,
		);
	});

	it('survives a ZIP stream the platform will not inflate more than once', async () => {
		// A stray rejection lands a tick late, so the one above can pass while
		// the run dies during the test after it. Failing the same way several
		// times over gives that a place to happen inside this test instead.
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await expectRefusal(
				buildPsd({
					channels: 1,
					width: 4,
					height: 1,
					mode: MODE_GREYSCALE,
					compression: 2,
					body: await corruptZipBody([10, 20, 30, 40]),
				}),
				/could not be unpacked/,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it('names a ZIP stream that does not start with a zlib header', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 2,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 2,
				body: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
			}),
			/does not start with a zlib header/,
		);
	});

	it('names a ZIP stream holding a deflate block of the reserved type', async () => {
		// A zlib header followed by a set bit, which reads as a final block of
		// type 3. Left to the platform this is the same 'could not be unpacked'
		// as every other damaged stream, and it is also the shape a decoder that
		// walks off the end of a stream and into the next one lands on.
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 2,
				height: 1,
				mode: MODE_GREYSCALE,
				compression: 2,
				body: [0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
			}),
			/deflate block of the type RFC 1951 reserves/,
		);
	});

	it('names a ZIP stream that stops inside a deflate block', async () => {
		const body = await zipBody([10, 20]);
		await expectRefusal(zipRefusal(body.slice(0, 3)), /ends inside a deflate block/);
	});

	it('names a ZIP stream that stops before the checksum closing it', async () => {
		const body = await zipBody([10, 20]);
		await expectRefusal(zipRefusal(body.slice(0, -4)), /ends before the checksum/);
	});

	it('names a ZIP stream cut off inside its zlib header', async () => {
		await expectRefusal(zipRefusal([0x78]), /ends before the two byte zlib header/);
	});

	it('names a ZIP stream that asks for a preset dictionary', async () => {
		// 0x78 0x20 passes the check digit and sets the bit that says a
		// dictionary the file does not contain was used to compress it.
		await expectRefusal(zipRefusal([0x78, 0x20, 0, 0, 0, 0, 0, 0]), /names a preset dictionary/);
	});

	it('names a ZIP stream that stops inside the header of a stored block', async () => {
		await expectRefusal(
			zipRefusal(craftedZip((bits) => bits.field(0b001, 3))),
			/ends inside the header of a stored block/,
		);
	});

	it('names a ZIP stream whose stored block runs off the end of the file', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					bits.field(0b001, 3);
					// Aligned to a byte, then a length of 255 with nothing after it.
					bits.field(0, 5);
					bits.field(255, 16);
					bits.field(0, 16);
				}),
			),
			/ends inside a stored block/,
		);
	});

	it('names a ZIP stream holding a Huffman code its own tables do not define', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					// A dynamic block whose table of code lengths describes one
					// symbol, so a set bit is a code with nothing behind it.
					bits.field(1, 1);
					bits.field(2, 2);
					bits.field(0, 5);
					bits.field(0, 5);
					bits.field(0, 4);
					bits.field(1, 3);
					bits.field(0, 3);
					bits.field(0, 3);
					bits.field(0, 3);
					bits.field(0xffff, 16);
					bits.field(0xff, 8);
				}),
			),
			/Huffman code no table in it describes/,
		);
	});

	it('names a ZIP stream that repeats a code length before stating one', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					bits.field(1, 1);
					bits.field(2, 2);
					bits.field(0, 5);
					bits.field(0, 5);
					bits.field(0, 4);
					// Symbol 16 is the only code, and symbol 16 means repeat what
					// came before it, which at the front of the table is nothing.
					bits.field(1, 3);
					bits.field(0, 3);
					bits.field(0, 3);
					bits.field(0, 3);
					bits.code(0, 1);
					bits.field(0, 8);
				}),
			),
			/repeats a code length before it has stated one/,
		);
	});

	it('names a ZIP stream that repeats more code lengths than its table holds', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					bits.field(1, 1);
					bits.field(2, 2);
					bits.field(0, 5);
					bits.field(0, 5);
					bits.field(0, 4);
					// Symbol 18 is the only code, and it writes up to 138 zeros at
					// a time. Two of them overrun a table of 258 lengths.
					bits.field(0, 3);
					bits.field(0, 3);
					bits.field(1, 3);
					bits.field(0, 3);
					for (let run = 0; run < 2; run += 1) {
						bits.code(0, 1);
						bits.field(127, 7);
					}
				}),
			),
			/repeats more code lengths than its table holds/,
		);
	});

	it('names a ZIP stream holding a length symbol the format does not define', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					// A fixed block, then the eight bit code for symbol 286, which
					// has a code and no meaning.
					bits.field(1, 1);
					bits.field(1, 2);
					bits.code(0b11000110, 8);
				}),
			),
			/length symbol RFC 1951 does not define/,
		);
	});

	it('names a ZIP stream holding a distance symbol the format does not define', async () => {
		await expectRefusal(
			zipRefusal(
				craftedZip((bits) => {
					bits.field(1, 1);
					bits.field(1, 2);
					// Symbol 257, a length of three, and then distance symbol 30.
					bits.code(0b0000001, 7);
					bits.code(30, 5);
				}),
			),
			/distance symbol RFC 1951 does not define/,
		);
	});

	it('rejects a ZIP stream that unpacks to fewer bytes than the dimensions need', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 8,
				height: 4,
				mode: MODE_GREYSCALE,
				compression: 2,
				body: await zipBody([1, 2, 3]),
			}),
			/unpacked to 3 bytes, where its dimensions need 32/,
		);
	});

	it('names ZIP with prediction on a one bit image rather than inventing a delta', async () => {
		await expectRefusal(
			buildPsd({
				channels: 1,
				width: 8,
				height: 1,
				depth: 1,
				mode: MODE_BITMAP,
				compression: 3,
				body: await zipBody([0b10101010]),
			}),
			/ZIP compression with prediction on a one bit image/,
		);
	});

	it('rejects an image data section larger than it will hold at once', async () => {
		// 390 million pixels is under the pixel ceiling and both sides are legal
		// for a PSD, but three 16 bit channels of it is two and a third gigabytes
		// of samples, and that buffer is asked for before a single byte is read.
		await expectRefusal(
			buildPsd({ width: 30000, height: 13000, depth: 16, mode: MODE_RGB }),
			/more than this reader will hold at once/,
		);
	});

	it('says so when the browser has no decompression to offer', async () => {
		const file = buildPsd({
			channels: 1,
			width: 2,
			height: 1,
			mode: MODE_GREYSCALE,
			compression: 2,
			body: await zipBody([10, 20]),
		});
		vi.stubGlobal('DecompressionStream', undefined);
		try {
			await expect(decodePsd(file)).rejects.toBeInstanceOf(CodecUnavailableError);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
