import { describe, expect, it } from 'vitest';

import { decodePcx } from '../../src/codecs/pcx/decode.js';
import { encodePcx } from '../../src/codecs/pcx/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { ColourSpace, RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

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

/** An image with `count` colours nothing repeats, laid out one to a column. */
function manyColours(count: number): RasterImage {
	const image = createRaster(count, 1, 'srgb', false);
	for (let i = 0; i < count; i += 1) {
		image.data.set([i & 0xff, (i >> 8) & 0xff, 7, 255], i * 4);
	}
	return image;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/** Sixteen header entries a failing assertion can be read back from. */
const RAMP16: readonly (readonly [number, number, number])[] = Array.from(
	{ length: 16 },
	(_, i) => [i * 16, i, 255 - i * 16] as const,
);

/** What RAMP16 index `i` should come out as, with alpha. */
function ramp(i: number): number[] {
	return [i * 16, i, 255 - i * 16, 255];
}

/** The smallest even number of bytes one plane of a row can occupy. */
function evenStride(width: number, bitsPerPixel: number): number {
	const needed = Math.ceil((width * bitsPerPixel) / 8);
	return needed + (needed % 2);
}

interface PcxSpec {
	readonly width: number;
	readonly height: number;
	readonly bitsPerPixel: number;
	readonly planes: number;
	readonly version?: number;
	/** 0 for raw, 1 for run length. Defaults to 0, so most fixtures read plainly. */
	readonly encoding?: number;
	readonly bytesPerLine?: number;
	readonly paletteInfo?: number;
	/** The 16 entry header table, as RGB triples. Absent entries stay zero. */
	readonly egaPalette?: readonly (readonly [number, number, number])[];
	/** Where the window starts. Only its size reaches the picture. */
	readonly origin?: readonly [number, number];
	/** The bytes between the header and anything trailing, exactly as written. */
	readonly data: readonly number[];
	/** 256 entries behind a 0x0C marker, at the very end. Short lists pad with black. */
	readonly vgaPalette?: readonly (readonly [number, number, number])[];
	/** Bytes between the pixel data and any colour table. */
	readonly trailer?: readonly number[];
}

/**
 * Hand build a PCX from field values rather than from the encoder.
 *
 * The decoder tests have to read files this package did not write, so the
 * fixtures are assembled from the numbers in the specification directly. A
 * fixture built by calling the encoder would only prove the two agree with each
 * other.
 */
function buildPcx(spec: PcxSpec): Uint8Array {
	const [xMin, yMin] = spec.origin ?? [0, 0];
	const stride = spec.bytesPerLine ?? evenStride(spec.width, spec.bitsPerPixel);

	const head = new Uint8Array(128);
	const view = new DataView(head.buffer);
	head[0] = 0x0a;
	head[1] = spec.version ?? 5;
	head[2] = spec.encoding ?? 0;
	head[3] = spec.bitsPerPixel;
	// The window is inclusive at both ends, which is why every corner is one
	// short of the size.
	view.setUint16(4, xMin, true);
	view.setUint16(6, yMin, true);
	view.setUint16(8, xMin + spec.width - 1, true);
	view.setUint16(10, yMin + spec.height - 1, true);
	view.setUint16(12, 72, true);
	view.setUint16(14, 72, true);
	(spec.egaPalette ?? []).forEach((entry, i) => head.set(entry, 16 + i * 3));
	head[65] = spec.planes;
	view.setUint16(66, stride, true);
	view.setUint16(68, spec.paletteInfo ?? 1, true);
	view.setUint16(70, spec.width, true);
	view.setUint16(72, spec.height, true);

	const table: number[] = [];
	if (spec.vgaPalette) {
		table.push(0x0c);
		for (let i = 0; i < 256; i += 1) {
			const entry = spec.vgaPalette[i] ?? [0, 0, 0];
			table.push(entry[0], entry[1], entry[2]);
		}
	}

	const trailer = spec.trailer ?? [];
	const out = new Uint8Array(128 + spec.data.length + trailer.length + table.length);
	out.set(head, 0);
	out.set(spec.data, 128);
	out.set(trailer, 128 + spec.data.length);
	out.set(table, 128 + spec.data.length + trailer.length);
	return out;
}

/**
 * A minimal run length encoder, for fixtures that need encoding 1.
 *
 * Written from the specification rather than reused from `encode.ts`, so a
 * decoder test that passes says something about the format rather than about
 * this package agreeing with itself. Runs stop at the end of each plane.
 */
function rleOf(raw: readonly number[], stride: number): number[] {
	const out: number[] = [];
	for (let start = 0; start < raw.length; start += stride) {
		const line = raw.slice(start, start + stride);
		let at = 0;
		while (at < line.length) {
			const value = line[at] as number;
			let run = 1;
			while (run < 63 && at + run < line.length && line[at + run] === value) run += 1;
			if (run > 1 || (value & 0xc0) === 0xc0) out.push(0xc0 | run, value);
			else out.push(value);
			at += run;
		}
	}
	return out;
}

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodePcx', () => {
	it('writes the whole of a one pixel file byte for byte', () => {
		const out = encodePcx(raster(1, 1, [10, 20, 30, 255]));

		// 128 byte header, two bytes of pixel data, 769 bytes of colour table.
		expect(out.length).toBe(899);
		expect(Array.from(out.subarray(0, 16))).toEqual([
			// ZSoft, version 5, run length encoded, 8 bits a plane.
			0x0a, 0x05, 0x01, 0x08,
			// The window: 0,0 to 0,0, which is one pixel because it is inclusive.
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			// 72 dots per inch both ways.
			0x48, 0x00, 0x48, 0x00,
		]);
		// The 16 colour header table, deliberately left blank at this depth.
		expect(Array.from(out.subarray(16, 64))).toEqual(new Array<number>(48).fill(0));
		expect(Array.from(out.subarray(64, 74))).toEqual([
			// Reserved, one plane, two bytes a row, palette info 1 (colour).
			0x00, 0x01, 0x02, 0x00, 0x01, 0x00,
			// Screen size, which we fill in with the image's own size.
			0x01, 0x00, 0x01, 0x00,
		]);
		expect(Array.from(out.subarray(74, 128))).toEqual(new Array<number>(54).fill(0));
		// One run of two: the pixel, and the padding byte that repeats it.
		expect(Array.from(out.subarray(128, 130))).toEqual([0xc2, 0x00]);
		// The colour table: a marker, the one colour, and 255 unused entries.
		expect(Array.from(out.subarray(130, 134))).toEqual([0x0c, 10, 20, 30]);
		expect(out.subarray(134).every((byte) => byte === 0)).toBe(true);
	});

	it('rounds an odd width up to an even stride and repeats the last pixel into it', () => {
		const out = encodePcx(raster(3, 1, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]));

		expect(out[66]).toBe(4);
		expect(out[67]).toBe(0);
		// Two literals, then a run of two: the last pixel and its padding byte.
		expect(Array.from(out.subarray(128, 132))).toEqual([0, 1, 0xc2, 2]);
	});

	it('writes one plane and a trailing colour table for 256 colours or fewer', () => {
		const out = encodePcx(manyColours(256));

		expect(out[3]).toBe(8);
		expect(out[65]).toBe(1);
		expect(out[out.length - 769]).toBe(0x0c);
	});

	it('writes three planes once there are more colours than a table can hold', () => {
		const out = encodePcx(manyColours(257));

		expect(out[3]).toBe(8);
		expect(out[65]).toBe(3);
	});

	it('escapes a literal byte whose top two bits are set', () => {
		// Index 192 is 0xC0, which a reader would take as a run tag. Written
		// plainly it would desynchronise the stream for the rest of the image.
		const out = encodePcx(manyColours(256));

		expect(Array.from(out.subarray(128 + 192, 128 + 196))).toEqual([0xc1, 0xc0, 0xc1, 0xc1]);
	});

	it('splits a run longer than the six bit count can hold', () => {
		const flat = createRaster(100, 1, 'srgb', false);
		for (let i = 0; i < 100; i += 1) flat.data.set([9, 9, 9, 255], i * 4);
		const out = encodePcx(flat);

		// 63, then the remaining 37 of the hundred.
		expect(Array.from(out.subarray(128, 132))).toEqual([0xff, 0x00, 0xc0 | 37, 0x00]);
	});

	it('writes the trailing table at full length even for a two colour image', () => {
		const out = encodePcx(raster(2, 1, [1, 1, 1, 255, 2, 2, 2, 255]));

		// The table is found by measuring back from the end of the file, so a
		// short one would be looked for in the middle of the pixel data.
		expect(out[out.length - 769]).toBe(0x0c);
		expect(Array.from(out.subarray(out.length - 768, out.length - 762))).toEqual([
			1, 1, 1, 2, 2, 2,
		]);
		expect(out.subarray(out.length - 762).every((byte) => byte === 0)).toBe(true);
	});

	it('quantises to the palette size it was asked for', () => {
		const out = encodePcx(noise(16, 16, false), { palette: 4 });
		const back = decodePcx(out);
		const seen = new Set<string>();
		for (let i = 0; i < back.data.length; i += 4) {
			seen.add(`${back.data[i]},${back.data[i + 1]},${back.data[i + 2]}`);
		}

		expect(out[65]).toBe(1);
		expect(seen.size).toBeLessThanOrEqual(4);
	});

	it('flattens onto white when the raster carries alpha', () => {
		const out = encodePcx(raster(1, 1, [0, 0, 0, 128], true));

		expect(pixelsOf(decodePcx(out))).toEqual([127, 127, 127, 255]);
	});

	it('flattens onto the background it was given', () => {
		const out = encodePcx(raster(1, 1, [0, 0, 0, 128], true), { background: [255, 0, 0] });

		expect(pixelsOf(decodePcx(out))).toEqual([127, 0, 0, 255]);
	});

	it('leaves the alpha bytes of an opaque raster alone', () => {
		// A raster straight out of `createRaster` has every byte at zero including
		// alpha, and says so with `hasAlpha`. Reading those bytes as coverage would
		// make the whole image one transparent colour.
		const image = createRaster(2, 1, 'srgb', false);
		image.data.set([10, 20, 30, 0, 40, 50, 60, 0]);

		expect(pixelsOf(decodePcx(encodePcx(image)))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
	});

	it('ignores a quality setting, because nothing in PCX is lossy', () => {
		const image = noise(8, 8, false);

		expect(Array.from(encodePcx(image, { quality: 0.1 }))).toEqual(
			Array.from(encodePcx(image, { quality: 1 })),
		);
	});

	it('refuses an image with no pixels', () => {
		expect(() => encodePcx(createRaster(0, 0))).toThrow(EncodeFailedError);
		expect(() => encodePcx(createRaster(0, 0))).toThrow(/no pixels/);
	});

	it('refuses a fractional width', () => {
		const odd: RasterImage = {
			data: new Uint8ClampedArray(16),
			width: 1.5,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePcx(odd)).toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePcx(short)).toThrow(EncodeFailedError);
		expect(() => encodePcx(short)).toThrow(/shorter than the width and height/);
	});

	it('refuses a width the two byte window field cannot describe', () => {
		const wide: RasterImage = {
			data: new Uint8ClampedArray(0x10000 * 4),
			width: 0x10000,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePcx(wide)).toThrow(/window fields/);
	});

	it('refuses a height the two byte window field cannot describe', () => {
		const tall: RasterImage = {
			data: new Uint8ClampedArray(0x10000 * 4),
			width: 1,
			height: 0x10000,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePcx(tall)).toThrow(/window fields/);
	});

	it('refuses a width whose even stride would overflow the stride field', () => {
		// 65535 fits the window fields and 65536 does not fit the stride field, so
		// this is the one width that passes the check above and fails here.
		const wide: RasterImage = {
			data: new Uint8ClampedArray(0xffff * 4),
			width: 0xffff,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePcx(wide)).toThrow(/stride field/);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('PCX round trips', () => {
	it('carries a single pixel through unchanged', () => {
		const back = decodePcx(encodePcx(raster(1, 1, [200, 100, 50, 255])));

		expect(back.width).toBe(1);
		expect(back.height).toBe(1);
		expect(back.hasAlpha).toBe(false);
		expect(back.colourSpace).toBe('srgb');
		expect(pixelsOf(back)).toEqual([200, 100, 50, 255]);
	});

	it.each([
		[1, 1],
		[1, 7],
		[7, 1],
		[3, 3],
		[7, 5],
		[5, 8],
		[16, 16],
		[17, 2],
		[64, 3],
	])('carries a %i by %i image through unchanged', (width, height) => {
		const source = noise(width, height, false);
		const back = decodePcx(encodePcx(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('carries an image of exactly 256 colours through the indexed path unchanged', () => {
		const source = manyColours(256);
		const file = encodePcx(source);

		expect(file[65]).toBe(1);
		expect(pixelsOf(decodePcx(file))).toEqual(pixelsOf(source));
	});

	it('carries an image of 257 colours through the three plane path unchanged', () => {
		const source = manyColours(257);
		const file = encodePcx(source);

		expect(file[65]).toBe(3);
		expect(pixelsOf(decodePcx(file))).toEqual(pixelsOf(source));
	});

	it('carries an odd width three plane image through unchanged', () => {
		const source = manyColours(257);
		const wide = createRaster(257, 3, 'srgb', false);
		for (let y = 0; y < 3; y += 1) {
			wide.data.set(source.data.subarray(0, 257 * 4), y * 257 * 4);
		}
		wide.data[4] = 199;

		expect(pixelsOf(decodePcx(encodePcx(wide)))).toEqual(pixelsOf(wide));
	});

	it('reports no alpha after a translucent image has been flattened', () => {
		const source = raster(2, 1, [0, 0, 0, 0, 255, 255, 255, 128], true);
		const back = decodePcx(encodePcx(source));

		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
	});

	it('carries a flat image through, where every row is one long run', () => {
		const flat = createRaster(9, 4, 'srgb', false);
		for (let i = 0; i < 36; i += 1) flat.data.set([3, 4, 5, 255], i * 4);

		expect(pixelsOf(decodePcx(encodePcx(flat)))).toEqual(pixelsOf(flat));
	});
});

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodePcx', () => {
	it('reads an 8 bit image against the colour table at the tail of the file', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			data: [1, 2, 3, 0, 3, 2, 1, 0],
			vgaPalette: [
				[0, 0, 0],
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			],
		});
		const image = decodePcx(file);

		expect(image.width).toBe(3);
		expect(image.height).toBe(2);
		expect(image.hasAlpha).toBe(false);
		expect(image.colourSpace).toBe('srgb');
		expect(pixelsOf(image)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0,
			255,
		]);
	});

	it('discards the padding a longer bytesPerLine leaves at the end of a row', () => {
		// The classic PCX bug. Reading the two extra bytes as pixels shears the
		// picture diagonally by two more pixels on every row.
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			bytesPerLine: 6,
			data: [1, 2, 3, 99, 99, 99, 3, 2, 1, 99, 99, 99],
			vgaPalette: [
				[0, 0, 0],
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0,
			255,
		]);
	});

	it('honours an odd bytesPerLine rather than rounding it up', () => {
		// The specification says the field is always even. ImageMagick writes an
		// odd one anyway, and it is the stride, so it has to be taken as given.
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			bytesPerLine: 3,
			data: [1, 2, 3, 3, 2, 1],
			vgaPalette: [
				[0, 0, 0],
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0,
			255,
		]);
	});

	it('reads a 24 bit image as three planes inside each row', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 3,
			data: [
				// Row 0: reds, greens, blues, each with one padding byte.
				10, 20, 30, 99, 40, 50, 60, 99, 70, 80, 90, 99,
				// Row 1.
				11, 21, 31, 99, 41, 51, 61, 99, 71, 81, 91, 99,
			],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			10, 40, 70, 255, 20, 50, 80, 255, 30, 60, 90, 255, 11, 41, 71, 255, 21, 51, 81, 255, 31, 61,
			91, 255,
		]);
	});

	it('reads a 4 bit image, high nibble first', () => {
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 4,
			planes: 1,
			egaPalette: RAMP16,
			data: [0x12, 0x30],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([...ramp(1), ...ramp(2), ...ramp(3)]);
	});

	it('reads a 1 bit image against the two colours in its header', () => {
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 1,
			planes: 1,
			egaPalette: [
				[0, 0, 0],
				[255, 255, 255],
			],
			data: [0b10100000, 0xff],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
		]);
	});

	it('honours a 1 bit header table written the other way round', () => {
		// ImageMagick ignores this table and hardcodes a set bit to black. The
		// file says otherwise, and following the file is the position that can be
		// defended from the specification.
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 1,
			planes: 1,
			egaPalette: [
				[255, 255, 255],
				[0, 0, 0],
			],
			data: [0b10100000, 0xff],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
	});

	it('falls back to black and white when a 1 bit file left both entries the same', () => {
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 1,
			planes: 1,
			data: [0b10100000, 0xff],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
		]);
	});

	it('reads a four plane EGA image, plane 0 carrying the lowest bit', () => {
		// Eight pixels holding the indexes 0 to 7, spread a bit to a plane. The
		// second byte of every plane is padding and must not reach a pixel.
		const file = buildPcx({
			width: 8,
			height: 1,
			bitsPerPixel: 1,
			planes: 4,
			egaPalette: RAMP16,
			data: [0b01010101, 0xff, 0b00110011, 0xff, 0b00001111, 0xff, 0b00000000, 0xff],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			...ramp(0),
			...ramp(1),
			...ramp(2),
			...ramp(3),
			...ramp(4),
			...ramp(5),
			...ramp(6),
			...ramp(7),
		]);
	});

	it('falls back to the IBM EGA table when a 16 colour file left its own blank', () => {
		const file = buildPcx({
			width: 4,
			height: 1,
			bitsPerPixel: 4,
			planes: 1,
			data: [0x01, 0x6f],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			0, 0, 0, 255, 0, 0, 170, 255, 170, 85, 0, 255, 255, 255, 255, 255,
		]);
	});

	it('reads run length encoded data, escaped tag bytes included', () => {
		const rows = [1, 2, 0xc5, 0, 0xc5, 0xc5, 0xc5, 0];
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: rleOf(rows, 4),
			vgaPalette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as const),
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			1, 0, 0, 255, 2, 0, 0, 255, 0xc5, 0, 0, 255, 0xc5, 0, 0, 255, 0xc5, 0, 0, 255, 0xc5, 0, 0,
			255,
		]);
	});

	it('reads a run of the full 63 bytes', () => {
		const file = buildPcx({
			width: 63,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			bytesPerLine: 63,
			encoding: 1,
			data: [0xff, 5],
			vgaPalette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as const),
		});
		const image = decodePcx(file);

		expect(image.width).toBe(63);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([5, 0, 0, 255]);
		expect(Array.from(image.data.subarray(248, 252))).toEqual([5, 0, 0, 255]);
	});

	it('treats a run of zero as the empty run it is', () => {
		// Legal to write and pointless. It has to consume its two bytes and fill
		// nothing, or a file made of them either loops or reads past its own end.
		const file = buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xc0, 0x77, 3, 4],
			vgaPalette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as const),
		});

		expect(pixelsOf(decodePcx(file))).toEqual([3, 0, 0, 255, 4, 0, 0, 255]);
	});

	it('reads a run that carries on across a row boundary', () => {
		// The specification says a run stops at the end of a scan line. Files that
		// cross exist, and every other reader displays them, so refusing them
		// would be refusing an image rather than catching a fault.
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xc8, 7],
			vgaPalette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as const),
		});
		const image = decodePcx(file);

		expect(Array.from(image.data.subarray(0, 4))).toEqual([7, 0, 0, 255]);
		expect(Array.from(image.data.subarray(20, 24))).toEqual([7, 0, 0, 255]);
	});

	it('reads uncompressed pixel data when the header says encoding 0', () => {
		const file = buildPcx({
			width: 2,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 0,
			data: [1, 2, 2, 1],
			vgaPalette: Array.from({ length: 256 }, (_, i) => [i, 0, 0] as const),
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			1, 0, 0, 255, 2, 0, 0, 255, 2, 0, 0, 255, 1, 0, 0, 255,
		]);
	});

	it('reads an 8 bit version 2 file against the sixteen colours in its header', () => {
		// There is no table at the tail before version 5, so the header's is all
		// there is, and indexes past its sixteenth entry fall on the grey ramp.
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			version: 2,
			egaPalette: RAMP16,
			data: [0, 15, 200, 0],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([...ramp(0), ...ramp(15), 200, 200, 200, 255]);
	});

	it('ignores a table at the tail of a version 2 file, which cannot have one', () => {
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			version: 2,
			egaPalette: RAMP16,
			data: [0, 1, 2, 0],
			vgaPalette: [
				[9, 9, 9],
				[8, 8, 8],
				[7, 7, 7],
			],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([...ramp(0), ...ramp(1), ...ramp(2)]);
	});

	it('falls back to a grey ramp when a version 5 file has no table at its tail', () => {
		const file = buildPcx({
			width: 3,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			data: [0, 128, 255, 0],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([
			0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255,
		]);
	});

	it('uses the grey ramp alone when the header says the file is greyscale', () => {
		// PaletteInfo 2 means the colours are a ramp, so the sixteen entries in
		// the header are not describing the picture and are left out of it.
		const file = buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			paletteInfo: 2,
			egaPalette: RAMP16,
			data: [1, 2],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([1, 1, 1, 255, 2, 2, 2, 255]);
	});

	it('ignores a trailing block whose marker byte is not 0x0C', () => {
		const file = buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			data: [4, 5],
			trailer: new Array<number>(769).fill(0x42),
		});

		expect(pixelsOf(decodePcx(file))).toEqual([4, 4, 4, 255, 5, 5, 5, 255]);
	});

	it('reads a window that does not start at the origin as its own size', () => {
		const file = buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			origin: [100, 40],
			data: [4, 5],
		});
		const image = decodePcx(file);

		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
	});

	it('reads a one pixel file', () => {
		const file = buildPcx({
			width: 1,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			data: [77, 0],
		});

		expect(pixelsOf(decodePcx(file))).toEqual([77, 77, 77, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = encodePcx(raster(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]));
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(pixelsOf(decodePcx(padded.subarray(8, 8 + file.length)))).toEqual([
			1, 2, 3, 255, 4, 5, 6, 255,
		]);
	});

	it.each([0, 2, 3, 4, 5])('accepts version %i', (version) => {
		const file = buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			version,
			data: [1, 2],
		});

		expect(decodePcx(file).width).toBe(2);
	});
});

/* ── Files this package did not write ─────────────────────────────────── */

describe('decodePcx against files from another writer', () => {
	/**
	 * The twelve pixels the two fixtures below both hold, as ImageMagick reads
	 * them out of its own files.
	 */
	const expected = [
		255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0,
		255, 0, 255, 255, 255, 255, 0, 255, 255, 128, 128, 128, 255, 170, 85, 0, 255, 85, 85, 255, 255,
		85, 255, 85, 255,
	];

	/**
	 * A four by three PCX written by ImageMagick 7, byte for byte.
	 *
	 * Every other decoder fixture here is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. This one is not: it came out
	 * of an implementation with no connection to this one, and it is the shape
	 * the hand built fixtures never produce, with an odd bytesPerLine and runs
	 * that ImageMagick chose rather than we did.
	 *
	 * ImageMagick appends a 769 byte colour table even at this depth, where the
	 * format gives it no meaning. Those bytes are not reproduced: this reader
	 * never looks at them for a three plane image, and the 142 bytes below are a
	 * complete file that ImageMagick itself still reads back correctly.
	 */
	const magickTruecolour = Uint8Array.from([
		0x0a, 0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
		0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff,
		0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x80, 0x80, 0x80, 0xaa, 0x55, 0x00, 0x55, 0x55,
		0xff, 0x55, 0xff, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x04, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x50, 0x30, 0x00, 0x00, 0x50, 0x30, 0xc1, 0xf0, 0x00, 0x50, 0x30, 0x00, 0xc1, 0xf0,
	]);

	/**
	 * The same twelve pixels, written by ImageMagick as a sixteen colour file.
	 *
	 * One bit across four planes, which is the shape where the plane order
	 * matters and where getting it backwards produces a picture that still looks
	 * like a picture in the wrong sixteen colours.
	 */
	const magickEga = Uint8Array.from([
		0x0a, 0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0xaa, 0x55, 0x00, 0x00, 0xff, 0x00, 0x55, 0xff, 0x55, 0xff,
		0xff, 0x00, 0x00, 0x00, 0xff, 0x55, 0x55, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0x80, 0x80,
		0x80, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x04, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0xc1, 0xd0, 0x70, 0x20, 0x10, 0x60, 0x00, 0x40, 0x30, 0x20, 0xc1, 0xe0, 0x30, 0x80,
	]);

	it('reads a three plane file written by ImageMagick', () => {
		const image = decodePcx(magickTruecolour);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(pixelsOf(image)).toEqual(expected);
	});

	it('reads a four plane EGA file written by ImageMagick', () => {
		const image = decodePcx(magickEga);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(pixelsOf(image)).toEqual(expected);
	});

	it('re-encodes one of those files to something with the same pixels in it', () => {
		const again = decodePcx(encodePcx(decodePcx(magickEga)));

		expect(pixelsOf(again)).toEqual(expected);
	});
});

describe('the fourth plane some writers add', () => {
	/**
	 * ImageMagick writes 8 bits across four planes whenever the source has an
	 * alpha channel, so `magick logo.png logo.pcx` produces one. ZSoft's
	 * specification stopped at three planes and says nothing about it, which is
	 * why this is worth pinning: the layout is the same, with a fourth run of
	 * `bytesPerLine` holding the coverage.
	 */
	function rgbaPcx(alpha: readonly number[]): Uint8Array {
		return buildPcx({
			width: 2,
			height: 1,
			bitsPerPixel: 8,
			planes: 4,
			bytesPerLine: 2,
			data: [10, 20, 30, 40, 50, 60, ...alpha],
		});
	}

	it('reads the fourth plane as alpha', () => {
		const image = decodePcx(rgbaPcx([255, 0]));
		expect(Array.from(image.data)).toEqual([10, 30, 50, 255, 20, 40, 60, 0]);
	});

	it('reports that it has alpha only when a pixel is actually translucent', () => {
		expect(decodePcx(rgbaPcx([255, 0])).hasAlpha).toBe(true);
		// A writer that added the plane and then filled it with opacity is
		// common, and calling that image translucent would make every encoder
		// downstream carry a channel that holds nothing.
		expect(decodePcx(rgbaPcx([255, 255])).hasAlpha).toBe(false);
	});

	it('leaves a three plane file opaque', () => {
		const image = decodePcx(
			buildPcx({
				width: 2,
				height: 1,
				bitsPerPixel: 8,
				planes: 3,
				bytesPerLine: 2,
				data: [10, 20, 30, 40, 50, 60],
			}),
		);
		expect(Array.from(image.data)).toEqual([10, 30, 50, 255, 20, 40, 60, 255]);
		expect(image.hasAlpha).toBe(false);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodePcx refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodePcx(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('pcx');
		expect(error.decoderId).toBe('pcx-pure');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	function plain(): Uint8Array {
		return buildPcx({ width: 2, height: 1, bitsPerPixel: 8, planes: 1, data: [1, 2] });
	}

	it.each([0, 1, 4, 64, 127])('rejects a file cut off at %i bytes', (length) => {
		expectRefusal(plain().subarray(0, length), /128 byte header/);
	});

	it('rejects a file that does not start with the ZSoft byte', () => {
		const file = plain();
		file[0] = 0x0b;
		expectRefusal(file, /manufacturer byte/);
	});

	it.each([1, 6, 255])('rejects version %i, which ZSoft never shipped', (version) => {
		const file = plain();
		file[1] = version;
		expectRefusal(file, new RegExp(`version ${version}`));
	});

	it('rejects an encoding the format does not define', () => {
		const file = plain();
		file[2] = 2;
		expectRefusal(file, /encoding 2/);
	});

	it.each([0, 3, 5, 16])('rejects a depth of %i bits per pixel', (bits) => {
		const file = plain();
		file[3] = bits;
		expectRefusal(file, new RegExp(`${bits} bits per pixel, which the format does not define`));
	});

	it.each([0, 5, 255])('rejects a plane count of %i', (planes) => {
		const file = plain();
		file[65] = planes;
		expectRefusal(file, new RegExp(`${planes} colour planes`));
	});

	it('rejects a window whose far corner is left of its near one', () => {
		const file = plain();
		new DataView(file.buffer).setUint16(4, 10, true);
		expectRefusal(file, /inside out/);
	});

	it('rejects a window whose far corner is above its near one', () => {
		const file = plain();
		new DataView(file.buffer).setUint16(6, 10, true);
		expectRefusal(file, /inside out/);
	});

	it('names the four colour CGA form', () => {
		const file = plain();
		file[3] = 2;
		expectRefusal(file, /four colour CGA/);
	});

	it.each([2, 3])('names the reduced EGA form of one bit across %i planes', (planes) => {
		const file = plain();
		file[3] = 1;
		file[65] = planes;
		expectRefusal(file, new RegExp(`one bit across ${planes} planes`));
	});

	it.each([
		[4, 2],
		[4, 3],
		[4, 4],
		[8, 2],
		[2, 4],
	])('reports %i bits across %i planes as a combination it does not implement', (bits, planes) => {
		const file = plain();
		file[3] = bits;
		file[65] = planes;
		expectRefusal(file, new RegExp(`${bits} bits per pixel across ${planes} planes`));
	});

	it('rejects a bytesPerLine too small to hold a row', () => {
		const file = buildPcx({
			width: 8,
			height: 1,
			bitsPerPixel: 8,
			planes: 1,
			bytesPerLine: 4,
			data: [1, 2, 3, 4],
		});
		expectRefusal(file, /4 bytes per plane for a row 8 pixels wide/);
	});

	it('rejects a bytesPerLine of zero', () => {
		const file = buildPcx({
			width: 8,
			height: 1,
			bitsPerPixel: 1,
			planes: 1,
			bytesPerLine: 0,
			data: [],
		});
		expectRefusal(file, /0 bytes per plane/);
	});

	it('rejects a window larger than anything this reader will allocate for', () => {
		const file = buildPcx({
			width: 0xffff,
			height: 0xffff,
			bitsPerPixel: 8,
			planes: 1,
			bytesPerLine: 2,
			data: [],
		});
		expectRefusal(file, /far larger than anything/);
	});

	it('rejects compressed data far too short for the size the header claims', () => {
		const file = buildPcx({
			width: 200,
			height: 200,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [1, 2],
		});
		expectRefusal(file, /too short to describe an image of that size/);
	});

	it('rejects compressed data that runs out before the last row', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xc4, 5, 0xc3, 7],
		});
		expectRefusal(file, /ends before every row/);
	});

	it('rejects a run at the end of the file with no byte to repeat', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xc4, 5, 0xc3],
		});
		expectRefusal(file, /missing the byte it repeats/);
	});

	it('rejects a run that reaches past the end of the last row', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xff, 5],
		});
		expectRefusal(file, /past the end of its last row/);
	});

	it('will not let a run read into the colour table at the tail of the file', () => {
		// One byte short of a full image, with 769 bytes of table behind it. A
		// reader that took the whole rest of the file as pixels would finish the
		// picture out of the palette and report nothing wrong.
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 1,
			data: [0xc4, 5, 0xc3, 7],
			vgaPalette: [[1, 2, 3]],
		});
		expectRefusal(file, /ends before every row/);
	});

	it('rejects uncompressed data that runs out before the last row', () => {
		const file = buildPcx({
			width: 3,
			height: 2,
			bitsPerPixel: 8,
			planes: 1,
			encoding: 0,
			data: [1, 2, 3, 4, 5],
		});
		expectRefusal(file, /uncompressed pixel data ends before/);
	});
});
