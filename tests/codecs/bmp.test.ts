import { describe, expect, it } from 'vitest';

import { decodeBmp } from '../../src/codecs/bmp/decode.js';
import { encodeBmp } from '../../src/codecs/bmp/encode.js';
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

interface BmpSpec {
	readonly width: number;
	readonly height: number;
	readonly bitCount: number;
	readonly headerSize?: number;
	readonly compression?: number;
	readonly planes?: number;
	readonly coloursUsed?: number;
	/** Colour table entries as [red, green, blue]. */
	readonly palette?: readonly (readonly [number, number, number])[];
	/** Channel masks, red first. Three entries, or four to include alpha. */
	readonly masks?: readonly number[];
	/** One entry per stored row, in file order. Short rows are zero padded. */
	readonly rows: readonly (readonly number[])[];
}

/**
 * Hand build a BMP from field values rather than from the encoder.
 *
 * The decoder tests have to read files this package did not write, so the
 * fixtures are assembled from the numbers in the specification directly. A
 * fixture built by calling the encoder would only prove the two agree.
 */
function buildBmp(spec: BmpSpec): Uint8Array {
	const headerSize = spec.headerSize ?? 40;
	const core = headerSize === 12;
	const entryBytes = core ? 3 : 4;
	const paletteBytes = (spec.palette?.length ?? 0) * entryBytes;
	// From BITMAPV2INFOHEADER on the masks are part of the header itself, so
	// they only take extra room after a plain 40 byte one.
	const maskBytes = headerSize === 40 && spec.masks ? spec.masks.length * 4 : 0;
	const pixelOffset = 14 + headerSize + maskBytes + paletteBytes;

	const stride = Math.ceil((spec.width * spec.bitCount) / 32) * 4;
	const out = new Uint8Array(pixelOffset + stride * spec.rows.length);
	const view = new DataView(out.buffer);

	out[0] = 0x42;
	out[1] = 0x4d;
	view.setUint32(2, out.length, true);
	view.setUint32(10, pixelOffset, true);
	view.setUint32(14, headerSize, true);

	if (core) {
		view.setUint16(18, spec.width, true);
		view.setUint16(20, spec.height, true);
		view.setUint16(22, spec.planes ?? 1, true);
		view.setUint16(24, spec.bitCount, true);
	} else {
		view.setInt32(18, spec.width, true);
		view.setInt32(22, spec.height, true);
		view.setUint16(26, spec.planes ?? 1, true);
		view.setUint16(28, spec.bitCount, true);
		view.setUint32(30, spec.compression ?? 0, true);
		view.setUint32(34, stride * spec.rows.length, true);
		view.setUint32(46, spec.coloursUsed ?? spec.palette?.length ?? 0, true);
	}

	// Both placements start at the same absolute offset, which is why a 40 byte
	// header with masks appended and a V4 header read identically.
	if (spec.masks) {
		spec.masks.forEach((mask, i) => view.setUint32(54 + i * 4, mask, true));
	}

	if (spec.palette) {
		const at = 14 + headerSize + maskBytes;
		spec.palette.forEach((entry, i) => {
			const to = at + i * entryBytes;
			out[to] = entry[2];
			out[to + 1] = entry[1];
			out[to + 2] = entry[0];
		});
	}

	spec.rows.forEach((row, i) => out.set(row, pixelOffset + i * stride));
	return out;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeBmp', () => {
	it('writes the whole of a one pixel 24 bit file byte for byte', () => {
		const out = encodeBmp(raster(1, 1, [10, 20, 30, 255]));

		expect(Array.from(out)).toEqual([
			// BITMAPFILEHEADER: 'BM', 58 byte file, two reserved words, pixels at 54.
			0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
			// BITMAPINFOHEADER: 40 bytes, 1 by 1, one plane, 24 bit, BI_RGB.
			0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x18,
			0x00, 0x00, 0x00, 0x00, 0x00,
			// Four bytes of pixel data, 2835 pixels per metre both ways, no palette.
			0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00,
			// One pixel as blue, green, red, then the row's padding byte.
			30, 20, 10, 0x00,
		]);
	});

	it('writes the whole of a one pixel 32 bit file byte for byte', () => {
		const out = encodeBmp(raster(1, 1, [10, 20, 30, 40], true));

		expect(out.length).toBe(126);
		expect(Array.from(out.subarray(0, 74))).toEqual([
			// BITMAPFILEHEADER: 'BM', 126 byte file, two reserved words, pixels at 122.
			0x42, 0x4d, 0x7e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7a, 0x00, 0x00, 0x00,
			// BITMAPV4HEADER: 108 bytes, 1 by 1, one plane, 32 bit, BI_BITFIELDS.
			0x6c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x20,
			0x00, 0x03, 0x00, 0x00, 0x00,
			// Four bytes of pixel data, 2835 pixels per metre both ways, no palette.
			0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00,
			// Masks for red, green, blue and alpha in a little endian word.
			0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0xff,
			// LCS_sRGB, which is 'sRGB' stored the other way round.
			0x42, 0x47, 0x52, 0x73,
		]);
		// Nine endpoint words and three gamma words, none of which we fill in.
		expect(Array.from(out.subarray(74, 122))).toEqual(new Array<number>(48).fill(0));
		// One pixel as blue, green, red, alpha.
		expect(Array.from(out.subarray(122))).toEqual([30, 20, 10, 40]);
	});

	it('pads every row of an odd width image to a multiple of four bytes', () => {
		const out = encodeBmp(raster(3, 1, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]));

		// Three pixels at three bytes is nine, which rounds up to twelve.
		expect(out.length).toBe(54 + 12);
		expect(Array.from(out.subarray(54))).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7, 0, 0, 0]);
	});

	it('stores rows bottom up', () => {
		const top = [1, 1, 1, 255];
		const bottom = [9, 9, 9, 255];
		const out = encodeBmp(raster(1, 2, [...top, ...bottom]));

		// The first row in the file is the last row of the picture.
		expect(Array.from(out.subarray(54, 58))).toEqual([9, 9, 9, 0]);
		expect(Array.from(out.subarray(58, 62))).toEqual([1, 1, 1, 0]);
	});

	it('refuses to claim sRGB for a Display P3 raster', () => {
		const out = encodeBmp(raster(1, 1, [10, 20, 30, 40], true, 'display-p3'));

		// LCS_CALIBRATED_RGB with no endpoints: no claim, rather than a false one.
		expect(Array.from(out.subarray(70, 74))).toEqual([0, 0, 0, 0]);
	});

	it('flattens onto white when alpha is turned off', () => {
		const half = raster(1, 1, [0, 0, 0, 128], true);
		const out = encodeBmp(half, { alpha: false });

		expect(out.length).toBe(58);
		expect(Array.from(out.subarray(54, 57))).toEqual([127, 127, 127]);
	});

	it('flattens onto the background it was given', () => {
		const half = raster(1, 1, [0, 0, 0, 128], true);
		const out = encodeBmp(half, { alpha: false, background: [255, 0, 0] });

		// Blue, green, red: half of red over black is a dark red.
		expect(Array.from(out.subarray(54, 57))).toEqual([0, 0, 127]);
	});

	it('writes 32 bit when asked to, even for an opaque raster', () => {
		const out = encodeBmp(raster(1, 1, [10, 20, 30, 255]), { alpha: true });

		expect(out.length).toBe(126);
		expect(Array.from(out.subarray(122))).toEqual([30, 20, 10, 255]);
	});

	it('refuses an image with no pixels', () => {
		const empty = createRaster(0, 0);
		expect(() => encodeBmp(empty)).toThrow(EncodeFailedError);
		expect(() => encodeBmp(empty)).toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodeBmp(short)).toThrow(EncodeFailedError);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('BMP round trips', () => {
	it('carries a single pixel through unchanged', () => {
		const source = raster(1, 1, [200, 100, 50, 255]);
		const back = decodeBmp(encodeBmp(source));

		expect(back.width).toBe(1);
		expect(back.height).toBe(1);
		expect(back.hasAlpha).toBe(false);
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
	])('carries a %i by %i opaque image through unchanged', (width, height) => {
		const source = noise(width, height, false);
		const back = decodeBmp(encodeBmp(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it.each([
		[1, 1],
		[3, 5],
		[7, 5],
		[9, 4],
	])('carries a %i by %i image with alpha through unchanged', (width, height) => {
		const source = noise(width, height, true);
		// The generator can produce an opaque run by chance; pin one pixel so the
		// alpha assertion below is about the codec rather than about the noise.
		source.data[3] = 64;
		const back = decodeBmp(encodeBmp(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('reports no alpha after a translucent image is flattened', () => {
		const source = raster(2, 1, [0, 0, 0, 0, 255, 255, 255, 128], true);
		const back = decodeBmp(encodeBmp(source, { alpha: false }));

		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
	});

	it('keeps a fully transparent pixel next to an opaque one', () => {
		const source = raster(2, 1, [10, 20, 30, 0, 40, 50, 60, 255], true);
		const back = decodeBmp(encodeBmp(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual([10, 20, 30, 0, 40, 50, 60, 255]);
	});

	it('carries an image that is transparent everywhere through unchanged', () => {
		// The hard case for the reader's alpha salvage. The file our writer emits
		// names an alpha mask, so a decoder that took every zero as a mistake
		// would hand back an opaque rectangle and the round trip would silently
		// lose the whole alpha channel.
		const source = raster(2, 2, new Array<number>(16).fill(0), true);
		for (let i = 0; i < 16; i += 4) source.data.set([10, 20, 30, 0], i);
		const back = decodeBmp(encodeBmp(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});
});

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodeBmp', () => {
	it('reads 24 bit rows stored bottom up', () => {
		const file = buildBmp({
			width: 2,
			height: 2,
			bitCount: 24,
			rows: [
				[0, 0, 255, 0, 255, 0], // bottom row: red then green
				[255, 0, 0, 255, 255, 255], // top row: blue then white
			],
		});
		const image = decodeBmp(file);

		expect(pixelsOf(image)).toEqual([
			0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
		]);
		expect(image.hasAlpha).toBe(false);
		expect(image.colourSpace).toBe('srgb');
	});

	it('reads 24 bit rows stored top down when the height is negative', () => {
		const file = buildBmp({
			width: 2,
			height: -2,
			bitCount: 24,
			rows: [
				[255, 0, 0, 255, 255, 255], // top row first this time
				[0, 0, 255, 0, 255, 0],
			],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([
			0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
		]);
	});

	it('reads an 8 bit palettised image with a padded odd width', () => {
		const file = buildBmp({
			width: 3,
			height: 2,
			bitCount: 8,
			palette: [
				[0, 0, 0],
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			],
			rows: [
				[1, 2, 3],
				[3, 2, 1],
			],
		});
		const image = decodeBmp(file);

		expect(image.width).toBe(3);
		expect(image.height).toBe(2);
		expect(pixelsOf(image)).toEqual([
			0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255,
			255,
		]);
	});

	it('reads a 4 bit palettised image, high nibble first', () => {
		const file = buildBmp({
			width: 3,
			height: 1,
			bitCount: 4,
			palette: [
				[0, 0, 0],
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
			],
			rows: [[0x12, 0x30]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
	});

	it('reads a 1 bit palettised image, high bit first', () => {
		const file = buildBmp({
			width: 3,
			height: 1,
			bitCount: 1,
			palette: [
				[0, 0, 0],
				[255, 255, 255],
			],
			rows: [[0b10100000]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([
			255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
		]);
	});

	it('reads 16 bit BI_RGB as X1R5G5B5 and scales the channels to full range', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 16,
			rows: [[0xff, 0x7f, 0x1f, 0x00]],
		});

		// Five bits of one have to land on 255, not on 248.
		expect(pixelsOf(decodeBmp(file))).toEqual([255, 255, 255, 255, 0, 0, 255, 255]);
	});

	it('reads 16 bit BI_BITFIELDS with 565 masks', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 16,
			compression: 3,
			masks: [0xf800, 0x07e0, 0x001f],
			rows: [[0xff, 0xff, 0xe0, 0x07]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([255, 255, 255, 255, 0, 255, 0, 255]);
	});

	it('reads a 32 bit BI_BITFIELDS alpha mask out of a V4 header', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			headerSize: 108,
			compression: 3,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
			rows: [[30, 20, 10, 128]],
		});
		const image = decodeBmp(file);

		expect(pixelsOf(image)).toEqual([10, 20, 30, 128]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads a 32 bit BI_ALPHABITFIELDS file, whose fourth mask follows the header', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			compression: 6,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
			rows: [[30, 20, 10, 64]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([10, 20, 30, 64]);
	});

	it('reads masks that do not sit on byte boundaries', () => {
		// 2:10:10:10, which is legal and rare. Green occupies bits 10 to 19 and
		// alpha the top two, so neither starts or ends on a byte.
		//
		// The alpha bits are set rather than left clear on purpose. A V4 header
		// names an alpha mask, so its zeroes are real: a pixel whose alpha bits
		// are clear is transparent, and expecting 255 there would be asserting
		// that the decoder ignores a mask the file went out of its way to
		// declare.
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			headerSize: 108,
			compression: 3,
			masks: [0x3ff00000, 0x000ffc00, 0x000003ff, 0xc0000000],
			rows: [[0x00, 0xfc, 0x0f, 0xc0]],
		});

		// Green and alpha are all ones, red and blue are zero.
		expect(pixelsOf(decodeBmp(file))).toEqual([0, 255, 0, 255]);
	});

	it('honours a declared alpha mask whose bits are clear', () => {
		// The same file with the alpha bits cleared. This is the other half of
		// the rule above and the reason the decoder tracks whether a mask was
		// declared at all: a guessed alpha of zero is taken back, a declared one
		// is not, or a fully transparent image could not survive a round trip.
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			headerSize: 108,
			compression: 3,
			masks: [0x3ff00000, 0x000ffc00, 0x000003ff, 0xc0000000],
			rows: [[0x00, 0xfc, 0x0f, 0x00]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([0, 255, 0, 0]);
	});

	it('reads only the lowest contiguous run of a mask that is not contiguous', () => {
		// Red claims bits 4 to 7 and, dishonestly, bits 12 to 15 as well. The run
		// this reader uses is the low one, so the first pixel, which sets only the
		// high group, is not red at all. Extracting through the mask as declared
		// would produce a number far larger than four bits can hold, which scales
		// past 255 and clamps, and both pixels would come out fully lit.
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 32,
			headerSize: 108,
			compression: 3,
			masks: [0x0000f0f0, 0x000f0000, 0x00f00000, 0],
			rows: [
				// 0x0000f000, then 0x000000f0.
				[0x00, 0xf0, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x00],
			],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([0, 0, 0, 255, 255, 0, 0, 255]);
	});

	it('treats a 32 bit BI_RGB file with no alpha byte set as opaque', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 32,
			rows: [[30, 20, 10, 0, 60, 50, 40, 0]],
		});
		const image = decodeBmp(file);

		// Reading the reserved byte literally would make the whole image invisible.
		expect(pixelsOf(image)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('honours the alpha byte of a 32 bit BI_RGB file when any pixel sets it', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 32,
			rows: [[30, 20, 10, 0, 60, 50, 40, 255]],
		});
		const image = decodeBmp(file);

		expect(pixelsOf(image)).toEqual([10, 20, 30, 0, 40, 50, 60, 255]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads a BITMAPCOREHEADER file with its three byte colour table', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 24,
			headerSize: 12,
			rows: [[0, 0, 255, 0, 255, 0]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('reads a palettised BITMAPCOREHEADER file', () => {
		const file = buildBmp({
			width: 2,
			height: 1,
			bitCount: 8,
			headerSize: 12,
			palette: [
				[0, 0, 0],
				[10, 20, 30],
			],
			rows: [[1, 0]],
		});

		expect(pixelsOf(decodeBmp(file))).toEqual([10, 20, 30, 255, 0, 0, 0, 255]);
	});

	it('reads an OS/2 2.x header that is otherwise a plain BI_RGB file', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, headerSize: 64, rows: [[1, 2, 3]] });

		expect(pixelsOf(decodeBmp(file))).toEqual([3, 2, 1, 255]);
	});

	it('ignores a file size field that disagrees with the buffer', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		new DataView(file.buffer).setUint32(2, 999999, true);

		expect(pixelsOf(decodeBmp(file))).toEqual([3, 2, 1, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = encodeBmp(raster(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]));
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(pixelsOf(decodeBmp(padded.subarray(8, 8 + file.length)))).toEqual([
			1, 2, 3, 255, 4, 5, 6, 255,
		]);
	});

	it('skips over a pixel offset that leaves a gap after the header', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		const spaced = new Uint8Array(file.length + 8);
		spaced.set(file.subarray(0, 54), 0);
		spaced.set(file.subarray(54), 62);
		new DataView(spaced.buffer).setUint32(10, 62, true);

		expect(pixelsOf(decodeBmp(spaced))).toEqual([3, 2, 1, 255]);
	});
});

/* ── A file this package did not write ────────────────────────────────── */

describe('decodeBmp against a file from another writer', () => {
	/**
	 * A two by two BMP written by ImageMagick 7, byte for byte.
	 *
	 * Every other decoder fixture here is assembled from the field values in
	 * the specification, which is a better test than a round trip but is still
	 * this package's reading of the format on both sides. This one is not: it
	 * is a real file from an implementation with no connection to this one, and
	 * it is the shape the hand built fixtures never produce, a 124 byte
	 * BITMAPV5HEADER with the colour space, intent and profile fields filled
	 * in, BI_BITFIELDS masks inside the header and a real alpha channel.
	 *
	 * The pixels below are what ImageMagick itself reads back out of it.
	 */
	const magickV5 = Uint8Array.from([
		0x42, 0x4d, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8a, 0x00, 0x00, 0x00, 0x7c, 0x00,
		0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x03, 0x00,
		0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x42, 0x47, 0x52, 0x73, 0x8f, 0xc2, 0xf5, 0x28, 0x51, 0xb8,
		0x1e, 0x15, 0x1e, 0x85, 0xeb, 0x01, 0x33, 0x33, 0x33, 0x13, 0x66, 0x66, 0x66, 0x26, 0x66, 0x66,
		0x66, 0x06, 0x99, 0x99, 0x99, 0x09, 0x3d, 0x0a, 0xd7, 0x03, 0x28, 0x5c, 0x8f, 0x32, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
		0xff, 0x40, 0x32, 0x64, 0xc8, 0xff, 0x1e, 0x14, 0x0a, 0x80,
	]);

	it('reads a BITMAPV5HEADER file written by ImageMagick', () => {
		const image = decodeBmp(magickV5);

		expect(image.width).toBe(2);
		expect(image.height).toBe(2);
		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual([
			200, 100, 50, 255, 10, 20, 30, 128, 0, 0, 0, 0, 255, 255, 255, 64,
		]);
	});

	it('re-encodes that file to something with the same pixels in it', () => {
		const again = decodeBmp(encodeBmp(decodeBmp(magickV5)));

		expect(pixelsOf(again)).toEqual(pixelsOf(decodeBmp(magickV5)));
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeBmp refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeBmp(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('bmp');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('names BI_RLE8 rather than half implementing it', () => {
		const file = buildBmp({ width: 2, height: 1, bitCount: 8, compression: 1, rows: [[0, 0]] });
		expectRefusal(file, /BI_RLE8/);
	});

	it('names BI_RLE4 rather than half implementing it', () => {
		const file = buildBmp({ width: 2, height: 1, bitCount: 4, compression: 2, rows: [[0]] });
		expectRefusal(file, /BI_RLE4/);
	});

	it('names BI_JPEG', () => {
		const file = buildBmp({ width: 2, height: 1, bitCount: 24, compression: 4, rows: [[0]] });
		expectRefusal(file, /BI_JPEG/);
	});

	it('names BI_PNG', () => {
		const file = buildBmp({ width: 2, height: 1, bitCount: 24, compression: 5, rows: [[0]] });
		expectRefusal(file, /BI_PNG/);
	});

	it('reports an unknown compression method by number', () => {
		const file = buildBmp({ width: 2, height: 1, bitCount: 24, compression: 42, rows: [[0]] });
		expectRefusal(file, /compression method 42/);
	});

	it('refuses an OS/2 2.x header whose compression field means something else', () => {
		// A 64 byte header reading 3 means Huffman 1D, not BI_BITFIELDS.
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 24,
			headerSize: 64,
			compression: 3,
			rows: [[1, 2, 3]],
		});
		expectRefusal(file, /OS\/2 bitmap using compression method 3/);
	});

	it('rejects a file that does not start with BM', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		file[1] = 0x4e;
		expectRefusal(file, /BM/);
	});

	it.each([0, 1, 2, 8, 13])('rejects a file cut off at %i bytes', (length) => {
		const file = encodeBmp(raster(1, 1, [1, 2, 3, 255]));
		expectRefusal(file.subarray(0, length), /file header/);
	});

	it('rejects a file cut off inside its information header', () => {
		const file = encodeBmp(raster(1, 1, [1, 2, 3, 255]));
		expectRefusal(file.subarray(0, 30), /information header/);
	});

	it('rejects a file cut off before its pixel data', () => {
		const file = encodeBmp(raster(4, 4, new Array<number>(64).fill(255)));
		expectRefusal(file.subarray(0, file.length - 1), /pixel data/);
	});

	it('rejects a palettised file with no colour table at all', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 8, rows: [[0]] });
		expectRefusal(file, /no colour table/);
	});

	it('rejects a colour table that would run into the pixel data', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 4,
			coloursUsed: 8,
			palette: [
				[0, 0, 0],
				[1, 1, 1],
			],
			rows: [[0]],
		});
		expectRefusal(file, /run past the start/);
	});

	it('rejects a file cut off inside its channel masks', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			compression: 3,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff],
			rows: [[1, 2, 3, 4]],
		});
		expectRefusal(file.subarray(0, 60), /channel masks/);
	});

	it('rejects an information header size it does not know', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		new DataView(file.buffer).setUint32(14, 20, true);
		expectRefusal(file, /20 bytes/);
	});

	it('rejects a plane count other than one', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, planes: 3, rows: [[1, 2, 3]] });
		expectRefusal(file, /3 colour planes/);
	});

	it('rejects a depth it does not know', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 2, rows: [[0]] });
		expectRefusal(file, /2 bits per pixel/);
	});

	it('rejects BI_BITFIELDS at a depth where masks mean nothing', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 24,
			compression: 3,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff],
			rows: [[1, 2, 3]],
		});
		expectRefusal(file, /24 bits per pixel/);
	});

	it('rejects BI_BITFIELDS with every mask empty', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 32,
			compression: 3,
			masks: [0, 0, 0],
			rows: [[1, 2, 3, 4]],
		});
		expectRefusal(file, /every colour mask empty/);
	});

	it('rejects a width of zero', () => {
		const file = buildBmp({ width: 0, height: 1, bitCount: 24, rows: [[]] });
		expectRefusal(file, /width of zero/);
	});

	it('rejects a height of zero', () => {
		const file = buildBmp({ width: 1, height: 0, bitCount: 24, rows: [] });
		expectRefusal(file, /height no image can have/);
	});

	it('rejects the most negative height, which has no positive counterpart', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		new DataView(file.buffer).setInt32(22, -0x80000000, true);
		expectRefusal(file, /height no image can have/);
	});

	it('rejects a pixel offset pointing back into the header', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		new DataView(file.buffer).setUint32(10, 40, true);
		expectRefusal(file, /points back inside/);
	});

	it('rejects a colour table larger than the depth can index', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 4,
			coloursUsed: 32,
			palette: [
				[0, 0, 0],
				[1, 1, 1],
			],
			rows: [[0]],
		});
		expectRefusal(file, /32 entries/);
	});

	it('rejects an index the colour table does not contain', () => {
		const file = buildBmp({
			width: 1,
			height: 1,
			bitCount: 8,
			palette: [[0, 0, 0]],
			rows: [[7]],
		});
		expectRefusal(file, /does not contain/);
	});

	it('rejects a claimed size larger than the file, without allocating it', () => {
		const file = buildBmp({ width: 1, height: 1, bitCount: 24, rows: [[1, 2, 3]] });
		new DataView(file.buffer).setInt32(18, 0x10000, true);
		new DataView(file.buffer).setInt32(22, 0x10000, true);
		expectRefusal(file, /pixel data/);
	});
});
