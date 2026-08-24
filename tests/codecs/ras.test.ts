import { describe, expect, it } from 'vitest';

import { decodeRas } from '../../src/codecs/ras/decode.js';
import { encodeRas } from '../../src/codecs/ras/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

interface RasSpec {
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	/** 0 old, 1 standard, 2 byte encoded, 3 RGB. Defaults to standard. */
	readonly type?: number;
	/** 0 none, 1 equal RGB, 2 raw. Defaults to none. */
	readonly mapType?: number;
	/** Written as given, so a fixture can lie about the length on purpose. */
	readonly mapLength?: number;
	readonly map?: readonly number[];
	/** Overrides the computed length field, which is what a truncated file lies about. */
	readonly length?: number;
	readonly data: readonly number[];
}

/**
 * Hand build a Sun raster from field values rather than from the encoder.
 *
 * The decoder tests have to read files this package did not write, so the
 * fixtures are assembled from the numbers in the specification directly. A
 * fixture built by calling the encoder would only prove the two agree.
 */
function buildRas(spec: RasSpec): Uint8Array {
	const map = spec.map ?? [];
	const out = new Uint8Array(32 + map.length + spec.data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x59a66a95);
	view.setUint32(4, spec.width);
	view.setUint32(8, spec.height);
	view.setUint32(12, spec.depth);
	view.setUint32(16, spec.length ?? spec.data.length);
	view.setUint32(20, spec.type ?? 1);
	view.setUint32(24, spec.mapType ?? 0);
	view.setUint32(28, spec.mapLength ?? map.length);
	out.set(map, 32);
	out.set(spec.data, 32 + map.length);
	return out;
}

/** An equal-RGB map: every red, then every green, then every blue. */
function equalRgbMap(entries: readonly (readonly [number, number, number])[]): number[] {
	return [
		...entries.map((entry) => entry[0]),
		...entries.map((entry) => entry[1]),
		...entries.map((entry) => entry[2]),
	];
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/** One `[r, g, b, a]` per pixel, which reads better than a flat list. */
function coloursOf(image: RasterImage): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < image.width * image.height; i += 1) {
		out.push(Array.from(image.data.subarray(i * 4, i * 4 + 4)));
	}
	return out;
}

function raster(
	width: number,
	height: number,
	pixels: readonly number[],
	hasAlpha = false,
): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
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

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodeRas', () => {
	it('reads a 24 bit type 1 file with its channels stored blue first', () => {
		// The whole trap of the format. Reading these bytes in the order they are
		// written turns a photograph of a sunset into a photograph of the sea.
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 24, data: [0, 0, 255, 30, 20, 10] }),
		);

		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(image.hasAlpha).toBe(false);
		expect(image.colourSpace).toBe('srgb');
		expect(coloursOf(image)).toEqual([RED, [10, 20, 30, 255]]);
	});

	it('reads a 24 bit type 3 file with its channels stored red first', () => {
		// Type 3 exists only to say the order is the other way round.
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 24, type: 3, data: [255, 0, 0, 10, 20, 30] }),
		);

		expect(coloursOf(image)).toEqual([RED, [10, 20, 30, 255]]);
	});

	it('reads type 0, the old form, as a standard uncompressed file', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 24, type: 0, data: [0, 255, 0, 0] }),
		);

		expect(coloursOf(image)).toEqual([GREEN]);
	});

	it('ignores a length field that an old writer left at zero', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 24, type: 0, length: 0, data: [0, 255, 0, 0] }),
		);

		expect(coloursOf(image)).toEqual([GREEN]);
	});

	it('pads a 24 bit row out to a 16 bit boundary', () => {
		// Three bytes a row rounds up to four, and a reader that missed it would
		// slide every row after the first one pixel to the left.
		const image = decodeRas(
			buildRas({
				width: 1,
				height: 2,
				depth: 24,
				data: [30, 20, 10, 0x99, 60, 50, 40, 0x99],
			}),
		);

		expect(coloursOf(image)).toEqual([
			[10, 20, 30, 255],
			[40, 50, 60, 255],
		]);
	});

	it('pads an 8 bit row out to a 16 bit boundary', () => {
		const image = decodeRas(
			buildRas({ width: 3, height: 2, depth: 8, data: [0, 128, 255, 0x99, 255, 128, 0, 0x99] }),
		);

		expect(coloursOf(image)).toEqual([
			[0, 0, 0, 255],
			[128, 128, 128, 255],
			[255, 255, 255, 255],
			[255, 255, 255, 255],
			[128, 128, 128, 255],
			[0, 0, 0, 255],
		]);
	});

	it('pads a 1 bit row out to a 16 bit boundary', () => {
		const image = decodeRas(
			buildRas({ width: 5, height: 2, depth: 1, data: [0b10000000, 0x99, 0b00001000, 0x99] }),
		);

		expect(coloursOf(image).map((colour) => colour[0])).toEqual([
			0, 255, 255, 255, 255, 255, 255, 255, 255, 0,
		]);
	});

	it('reads 8 bit with no colour map as a grey ramp', () => {
		const image = decodeRas(buildRas({ width: 2, height: 1, depth: 8, data: [0, 255] }));

		expect(coloursOf(image)).toEqual([
			[0, 0, 0, 255],
			[255, 255, 255, 255],
		]);
	});

	it('reads an equal-RGB colour map, which is not a list of triples', () => {
		// Every red, then every green, then every blue. A reader stepping through
		// it three bytes at a time builds a palette out of three entries' reds and
		// returns a picture rather than an error.
		const image = decodeRas(
			buildRas({
				width: 3,
				height: 1,
				depth: 8,
				mapType: 1,
				map: equalRgbMap([
					[255, 0, 0],
					[0, 255, 0],
					[0, 0, 255],
				]),
				data: [0, 1, 2, 0],
			}),
		);

		expect(coloursOf(image)).toEqual([RED, GREEN, BLUE]);
	});

	it('reads a 1 bit file through a colour map', () => {
		const image = decodeRas(
			buildRas({
				width: 4,
				height: 1,
				depth: 1,
				mapType: 1,
				map: equalRgbMap([
					[255, 0, 0],
					[0, 255, 0],
				]),
				data: [0b01010000, 0],
			}),
		);

		expect(coloursOf(image)).toEqual([RED, GREEN, RED, GREEN]);
	});

	it('reads a set bit as black when there is no colour map', () => {
		// The reverse of the grey ramp above it, and the convention every writer
		// of a one bit Sun raster follows.
		const image = decodeRas(buildRas({ width: 2, height: 1, depth: 1, data: [0b10000000, 0] }));

		expect(coloursOf(image)).toEqual([
			[0, 0, 0, 255],
			[255, 255, 255, 255],
		]);
	});

	it('steps over a raw colour map and reads the image without it', () => {
		// A raw map is a device dependent blob the file does not describe, so the
		// pixels are read as if it were not there rather than the file refused.
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 8, mapType: 2, map: [1, 2, 3, 4], data: [0, 255] }),
		);

		expect(coloursOf(image)).toEqual([
			[0, 0, 0, 255],
			[255, 255, 255, 255],
		]);
	});

	it('ignores a colour map on a 24 bit file, whose pixels carry their own colour', () => {
		const image = decodeRas(
			buildRas({
				width: 1,
				height: 1,
				depth: 24,
				mapType: 1,
				map: equalRgbMap([[9, 9, 9]]),
				data: [0, 0, 255, 0],
			}),
		);

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('reads a 32 bit file, whose first byte comes before the colour rather than after', () => {
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 32, data: [128, 30, 20, 10, 255, 60, 50, 40] }),
		);

		expect(coloursOf(image)).toEqual([
			[10, 20, 30, 128],
			[40, 50, 60, 255],
		]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads a 32 bit type 3 file, where the three colour bytes are the other way round', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 32, type: 3, data: [64, 10, 20, 30] }),
		);

		expect(coloursOf(image)).toEqual([[10, 20, 30, 64]]);
	});

	it('treats a 32 bit file whose padding byte is never set as opaque', () => {
		// The specification calls that byte padding, so a writer that zero filled
		// it did not mean an image nobody can see.
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 32, data: [0, 30, 20, 10, 0, 60, 50, 40] }),
		);

		expect(coloursOf(image)).toEqual([
			[10, 20, 30, 255],
			[40, 50, 60, 255],
		]);
		expect(image.hasAlpha).toBe(false);
	});

	it('honours the padding byte of a 32 bit file when any pixel sets it', () => {
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 32, data: [0, 30, 20, 10, 255, 60, 50, 40] }),
		);

		expect(coloursOf(image)).toEqual([
			[10, 20, 30, 0],
			[40, 50, 60, 255],
		]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = buildRas({ width: 1, height: 1, depth: 24, data: [0, 0, 255, 0] });
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(coloursOf(decodeRas(padded.subarray(8, 8 + file.length)))).toEqual([RED]);
	});

	it('ignores bytes past the end of the pixel data', () => {
		const file = buildRas({ width: 1, height: 1, depth: 24, data: [0, 0, 255, 0, 9, 9, 9] });

		expect(coloursOf(decodeRas(file))).toEqual([RED]);
	});
});

/* ── The byte encoding ────────────────────────────────────────────────── */

describe('decodeRas with the byte encoding', () => {
	it('reads a literal byte that is not the escape', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 24, type: 2, data: [0, 0, 255, 0] }),
		);

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('expands a run, whose count is one less than the number of bytes', () => {
		// 0x80 0x03 0x11 stands for four copies of 0x11, not three.
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 24, type: 2, data: [0x80, 0x03, 0x11, 0x22, 0x33] }),
		);

		expect(coloursOf(image)).toEqual([
			[0x11, 0x11, 0x11, 255],
			[0x33, 0x22, 0x11, 255],
		]);
	});

	it('reads the escape standing for itself, in two bytes rather than three', () => {
		// 0x80 0x00 is a literal 0x80. A reader that took every escape as the
		// start of a three byte run walks one byte out of step for the rest of the
		// file, and the picture that comes out looks like static rather than like
		// an error.
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 24, type: 2, data: [0x80, 0x00, 0x01, 0x02, 0x03] }),
		);

		expect(coloursOf(image)).toEqual([[0x02, 0x01, 0x80, 255]]);
	});

	it('lets a run carry on across a row boundary', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 2, depth: 8, type: 2, data: [0x80, 0x03, 0x40] }),
		);

		// Four bytes of 0x40: two rows of one pixel, each padded out to two bytes.
		expect(coloursOf(image)).toEqual([
			[0x40, 0x40, 0x40, 255],
			[0x40, 0x40, 0x40, 255],
		]);
	});

	it('stops at the size the header describes rather than at the end of the run', () => {
		const image = decodeRas(
			buildRas({ width: 2, height: 1, depth: 8, type: 2, data: [0x80, 0xff, 0x40] }),
		);

		expect(coloursOf(image)).toEqual([
			[0x40, 0x40, 0x40, 255],
			[0x40, 0x40, 0x40, 255],
		]);
	});

	it('reads a compressed file whose length field is zero', () => {
		const image = decodeRas(
			buildRas({ width: 1, height: 1, depth: 24, type: 2, length: 0, data: [0, 0, 255, 0] }),
		);

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('stops at the length field when the file carries more than it claims', () => {
		const file = buildRas({
			width: 1,
			height: 1,
			depth: 24,
			type: 2,
			length: 4,
			data: [0, 0, 255, 0, 9, 9, 9],
		});

		expect(coloursOf(decodeRas(file))).toEqual([RED]);
	});
});

/* ── A file this package did not write ────────────────────────────────── */

describe('decodeRas against a file from another writer', () => {
	/**
	 * A four by three Sun raster written by ImageMagick 7, byte for byte.
	 *
	 * Every other decoder fixture here is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. This one is not: it came out
	 * of an implementation with no connection to this one, and it is the shape
	 * the hand built fixtures never produce, an 8 bit indexed file with a five
	 * entry equal-RGB map where only four entries are ever used.
	 *
	 * The pixels below are what ImageMagick itself reads back out of it.
	 */
	const magick = Uint8Array.from([
		0x59, 0xa6, 0x6a, 0x95, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x08,
		0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0f,
		0xff, 0x00, 0x00, 0x0a, 0xff, 0x00, 0xff, 0x00, 0x14, 0xff, 0x00, 0x00, 0xff, 0x1e, 0xff, 0x00,
		0x01, 0x02, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	]);

	it('reads a colour mapped file written by ImageMagick', () => {
		const image = decodeRas(magick);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(image.hasAlpha).toBe(false);
		expect(coloursOf(image).slice(0, 4)).toEqual([RED, GREEN, BLUE, [10, 20, 30, 255]]);
		expect(coloursOf(image).slice(4)).toEqual(new Array<number[]>(8).fill([10, 20, 30, 255]));
	});

	it('re-encodes that file to something with the same pixels in it', () => {
		const again = decodeRas(encodeRas(decodeRas(magick)));

		expect(pixelsOf(again)).toEqual(pixelsOf(decodeRas(magick)));
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeRas', () => {
	it('writes the whole of a one pixel 24 bit file byte for byte', () => {
		const out = encodeRas(raster(1, 1, [10, 20, 30, 255]));

		expect(Array.from(out)).toEqual([
			// The magic, then 1 by 1, 24 bits deep, 4 bytes of pixel data.
			0x59, 0xa6, 0x6a, 0x95, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 24, 0, 0, 0, 4,
			// Type 1, no colour map, a colour map of no length.
			0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
			// One pixel as blue, green, red, then the row's padding byte.
			30, 20, 10, 0,
		]);
	});

	it('writes the whole of a one pixel 32 bit file byte for byte', () => {
		const out = encodeRas(raster(1, 1, [10, 20, 30, 40], true));

		expect(Array.from(out)).toEqual([
			0x59, 0xa6, 0x6a, 0x95, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 32, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0,
			0, 0, 0, 0, 0,
			// The alpha byte comes first, then blue, green, red.
			40, 30, 20, 10,
		]);
	});

	it('pads an odd 24 bit row out to a 16 bit boundary', () => {
		const out = encodeRas(raster(3, 1, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]));

		// Nine bytes of pixel rounds up to ten.
		expect(out.length).toBe(32 + 10);
		expect(Array.from(out.subarray(32))).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7, 0]);
	});

	it('stores rows top down, which is the only order this format has', () => {
		const out = encodeRas(raster(1, 2, [1, 1, 1, 255, 9, 9, 9, 255]));

		expect(Array.from(out.subarray(32, 36))).toEqual([1, 1, 1, 0]);
		expect(Array.from(out.subarray(36, 40))).toEqual([9, 9, 9, 0]);
	});

	it('writes 32 bit when asked to, even for an opaque raster', () => {
		const out = encodeRas(raster(1, 1, [10, 20, 30, 255]), { alpha: true });

		expect(out.length).toBe(36);
		expect(Array.from(out.subarray(32))).toEqual([255, 30, 20, 10]);
	});

	it('flattens onto white when alpha is turned off', () => {
		const out = encodeRas(raster(1, 1, [0, 0, 0, 128], true), { alpha: false });

		expect(out.length).toBe(36);
		expect(Array.from(out.subarray(32, 35))).toEqual([127, 127, 127]);
	});

	it('flattens onto the background it was given', () => {
		const out = encodeRas(raster(1, 1, [0, 0, 0, 128], true), {
			alpha: false,
			background: [255, 0, 0],
		});

		// Blue, green, red: half of red over black is a dark red.
		expect(Array.from(out.subarray(32, 35))).toEqual([0, 0, 127]);
	});

	it('refuses an image with no pixels', () => {
		const empty = createRaster(0, 0);

		expect(() => encodeRas(empty)).toThrow(EncodeFailedError);
		expect(() => encodeRas(empty)).toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};

		expect(() => encodeRas(short)).toThrow(EncodeFailedError);
		expect(() => encodeRas(short)).toThrow(/shorter than/);
	});

	it('refuses an image wider than the header can record', () => {
		const wide: RasterImage = {
			data: new Uint8ClampedArray(4),
			width: 0x100000000,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};

		expect(() => encodeRas(wide)).toThrow(/header can record/);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('Sun raster round trips', () => {
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
		const back = decodeRas(encodeRas(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it.each([
		[1, 1],
		[3, 5],
		[9, 4],
	])('carries a %i by %i image with alpha through unchanged', (width, height) => {
		const source = noise(width, height, true);
		// The generator can produce an opaque run by chance; pin one pixel so the
		// alpha assertion below is about the codec rather than about the noise.
		source.data[3] = 64;
		const back = decodeRas(encodeRas(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('keeps a fully transparent pixel next to an opaque one', () => {
		const source = raster(2, 1, [10, 20, 30, 0, 40, 50, 60, 255], true);
		const back = decodeRas(encodeRas(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it('loses an image that is transparent everywhere, which is the price of the salvage', () => {
		// The format has no field that says whether the first byte is alpha, so a
		// file whose every pixel reads as transparent is far more likely to be one
		// whose writer zero filled the padding than an image nobody can see. The
		// alternative, honouring it, means every 32 bit file from a writer that
		// obeyed the specification comes back invisible.
		const source = createRaster(2, 2, 'srgb', true);
		for (let i = 0; i < 16; i += 4) source.data.set([10, 20, 30, 0], i);
		const back = decodeRas(encodeRas(source));

		expect(back.hasAlpha).toBe(false);
		expect(coloursOf(back)).toEqual(new Array<number[]>(4).fill([10, 20, 30, 255]));
	});

	it('reports no alpha after a translucent image is flattened', () => {
		const source = raster(2, 1, [0, 0, 0, 0, 255, 255, 255, 128], true);
		const back = decodeRas(encodeRas(source, { alpha: false }));

		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeRas refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeRas(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('ras');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('rejects a file that does not start with the signature', () => {
		const file = buildRas({ width: 1, height: 1, depth: 24, data: [1, 2, 3] });
		file[3] = 0x00;
		expectRefusal(file, /four byte signature/);
	});

	it.each([0, 1, 16, 31])('rejects a file cut off at %i bytes', (length) => {
		const file = buildRas({ width: 1, height: 1, depth: 24, data: [1, 2, 3] });
		expectRefusal(file.subarray(0, length), /end of its header/);
	});

	it('names type 4, a TIFF wearing a Sun header', () => {
		expectRefusal(buildRas({ width: 1, height: 1, depth: 24, type: 4, data: [1, 2, 3] }), /TIFF/);
	});

	it('names type 5, an IFF wearing a Sun header', () => {
		expectRefusal(buildRas({ width: 1, height: 1, depth: 24, type: 5, data: [1, 2, 3] }), /IFF/);
	});

	it('names the experimental type', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 24, type: 0xffff, data: [1, 2, 3] }),
			/experimental type 65535/,
		);
	});

	it('reports an unknown type by number', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 24, type: 42, data: [1, 2, 3] }),
			/image type 42/,
		);
	});

	it.each([2, 4, 16, 48])('rejects a depth of %i bits', (depth) => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth, data: [1, 2, 3, 4, 5, 6] }),
			new RegExp(`${depth} bits per pixel`),
		);
	});

	it('rejects a width of zero', () => {
		expectRefusal(buildRas({ width: 0, height: 1, depth: 24, data: [] }), /0 pixels wide/);
	});

	it('rejects a height of zero', () => {
		expectRefusal(buildRas({ width: 1, height: 0, depth: 24, data: [] }), /0 pixels tall/);
	});

	it('rejects dimensions far larger than anything it will allocate for', () => {
		expectRefusal(buildRas({ width: 60000, height: 60000, depth: 24, data: [] }), /far larger/);
	});

	it('rejects a colour map type the format does not define', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 8, mapType: 3, map: [1, 2, 3], data: [0, 0] }),
			/colour map type 3/,
		);
	});

	it('rejects a file that says it has no map and then gives one a length', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 8, mapType: 0, mapLength: 6, data: [0, 0] }),
			/no colour map and then gives one a length/,
		);
	});

	it('rejects a colour map that is not three equal runs', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 8, mapType: 1, map: [1, 2, 3, 4], data: [0, 0] }),
			/not three equal runs/,
		);
	});

	it('rejects an equal-RGB map with no entries', () => {
		expectRefusal(
			buildRas({ width: 1, height: 1, depth: 8, mapType: 1, map: [], data: [0, 0] }),
			/no entries/,
		);
	});

	it('rejects a colour map larger than the depth can index', () => {
		expectRefusal(
			buildRas({
				width: 1,
				height: 1,
				depth: 1,
				mapType: 1,
				map: equalRgbMap([
					[1, 1, 1],
					[2, 2, 2],
					[3, 3, 3],
				]),
				data: [0, 0],
			}),
			/3 entries, more than the 2/,
		);
	});

	it('rejects a file cut off inside its colour map', () => {
		const file = buildRas({
			width: 1,
			height: 1,
			depth: 8,
			mapType: 1,
			map: equalRgbMap([[1, 2, 3]]),
			data: [0, 0],
		});
		expectRefusal(file.subarray(0, 34), /end of its colour map/);
	});

	it('rejects a file cut off before the end of its pixel data', () => {
		const file = buildRas({ width: 4, height: 4, depth: 24, data: new Array<number>(48).fill(1) });
		expectRefusal(file.subarray(0, file.length - 1), /end of its pixel data/);
	});

	it('rejects a header claiming far more pixels than the file holds', () => {
		expectRefusal(
			buildRas({ width: 4000, height: 4000, depth: 24, data: [1, 2, 3] }),
			/pixel data/,
		);
	});

	it('rejects an index the colour map does not contain', () => {
		expectRefusal(
			buildRas({
				width: 1,
				height: 1,
				depth: 8,
				mapType: 1,
				map: equalRgbMap([[1, 2, 3]]),
				data: [7, 0],
			}),
			/does not contain/,
		);
	});

	it('rejects a compressed stream too short to hold what the header describes', () => {
		expectRefusal(
			buildRas({ width: 4000, height: 4000, depth: 24, type: 2, data: [1, 2, 3] }),
			/too short to hold/,
		);
	});

	it('rejects a compressed stream that runs out partway through', () => {
		expectRefusal(
			buildRas({ width: 4, height: 4, depth: 8, type: 2, data: [0x80, 0x03, 0x40, 1, 2, 3] }),
			/ends after 7 of the 16 bytes/,
		);
	});

	it('rejects a compressed stream that ends on an escape', () => {
		expectRefusal(
			buildRas({ width: 4, height: 1, depth: 8, type: 2, data: [1, 2, 3, 0x80] }),
			/ends inside a run/,
		);
	});

	it('rejects a compressed stream that ends on a run count', () => {
		expectRefusal(
			buildRas({ width: 4, height: 1, depth: 8, type: 2, data: [1, 2, 0x80, 0x05] }),
			/ends inside a run/,
		);
	});
});
