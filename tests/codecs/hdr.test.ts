import { describe, expect, it } from 'vitest';

import { decodeHdr, decodeHdrFloat } from '../../src/codecs/hdr/decode.js';
import { encodeHdr } from '../../src/codecs/hdr/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { ColourSpace, RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** One pixel as the four bytes a file stores: three mantissas and an exponent. */
type Rgbe = readonly [number, number, number, number];

function asciiBytes(text: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
	return out;
}

/** Bytes back to text, one byte to one character, so offsets in both agree. */
function textOf(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return text;
}

interface HdrSpec {
	readonly width: number;
	readonly height: number;
	/** Defaults to `#?RADIANCE`. */
	readonly signature?: string;
	/** Header lines between the signature and the blank line. */
	readonly lines?: readonly string[];
	/** Replaces the whole resolution line, for testing the ones that are wrong. */
	readonly resolution?: string;
	/** What follows the resolution line. */
	readonly payload?: readonly number[];
	/** Written between the header lines and the resolution line. Defaults to one blank line. */
	readonly separator?: string;
}

/**
 * Hand build a Radiance picture from field values rather than from the encoder.
 *
 * The decoder has to read files this package did not write, so the fixtures are
 * assembled from what the specification says the bytes mean. A fixture built by
 * calling the encoder would only prove the two halves agree with each other.
 */
function buildHdr(spec: HdrSpec): Uint8Array {
	const lines = spec.lines ?? ['FORMAT=32-bit_rle_rgbe'];
	const resolution = spec.resolution ?? `-Y ${spec.height} +X ${spec.width}`;
	const text =
		`${spec.signature ?? '#?RADIANCE'}\n` +
		lines.map((line) => `${line}\n`).join('') +
		(spec.separator ?? '\n') +
		`${resolution}\n`;
	return Uint8Array.from([...asciiBytes(text), ...(spec.payload ?? [])]);
}

/** A scanline with no compression: four bytes a pixel and nothing else. */
function flatRow(pixels: readonly Rgbe[]): number[] {
	return pixels.flatMap((pixel) => [...pixel]);
}

/**
 * A new-style scanline written entirely as literals.
 *
 * Runs are built by hand in the tests that are about runs, because a helper
 * clever enough to find them would be the encoder again.
 */
function literalRow(pixels: readonly Rgbe[]): number[] {
	const width = pixels.length;
	const out = [2, 2, (width >> 8) & 0xff, width & 0xff];
	for (let channel = 0; channel < 4; channel += 1) {
		let x = 0;
		while (x < width) {
			const count = Math.min(128, width - x);
			out.push(count);
			for (let i = 0; i < count; i += 1) out.push((pixels[x + i] as Rgbe)[channel]);
			x += count;
		}
	}
	return out;
}

/** What one stored byte pair means, as the Radiance sources define it. */
function sampleOf(mantissa: number, exponent: number): number {
	if (exponent === 0) return 0;
	return ((mantissa + 0.5) / 256) * 2 ** (exponent - 128);
}

/**
 * Compare against an expected sample relatively, not absolutely.
 *
 * The values here span thirty orders of magnitude, so a fixed tolerance is
 * either meaningless at the top of the range or unreachable at the bottom.
 * Exact zero is compared exactly, because black is exact in this format.
 */
function expectClose(actual: number, expected: number, tolerance = 1e-6): void {
	if (expected === 0) {
		expect(actual).toBe(0);
		return;
	}
	expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(tolerance);
}

function expectPixel(
	image: { data: Float32Array; width: number },
	x: number,
	y: number,
	rgb: readonly number[],
): void {
	const at = (y * image.width + x) * 3;
	expectClose(image.data[at] as number, rgb[0] as number);
	expectClose(image.data[at + 1] as number, rgb[1] as number);
	expectClose(image.data[at + 2] as number, rgb[2] as number);
}

/** The sRGB transfer function, undone. The encoder's contract, written out again. */
function toLinear(byte: number): number {
	const level = byte / 255;
	return level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4;
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
function noise(width: number, height: number): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	let state = 0x2545f491;
	for (let i = 0; i < image.data.length; i += 4) {
		for (let channel = 0; channel < 3; channel += 1) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			image.data[i + channel] = (state >> 16) & 0xff;
		}
		image.data[i + 3] = 255;
	}
	return image;
}

/** An encoded file split where its header ends, so both halves can be asserted. */
function splitHdr(bytes: Uint8Array): { header: string; payload: number[] } {
	const text = textOf(bytes);
	const blank = text.indexOf('\n\n');
	const end = text.indexOf('\n', blank + 2) + 1;
	return { header: text.slice(0, end), payload: Array.from(bytes.subarray(end)) };
}

/* ── Header ───────────────────────────────────────────────────────────── */

describe('decodeHdrFloat headers', () => {
	const onePixel = flatRow([[128, 64, 32, 129]]);

	it('reads the smallest picture there is', () => {
		const image = decodeHdrFloat(buildHdr({ width: 1, height: 1, payload: onePixel }));

		expect(image.width).toBe(1);
		expect(image.height).toBe(1);
		expect(image.exposure).toBe(1);
		expect(image.colourSpace).toBe('srgb');
		expectPixel(image, 0, 0, [sampleOf(128, 129), sampleOf(64, 129), sampleOf(32, 129)]);
	});

	it('accepts the older #?RGBE signature', () => {
		const file = buildHdr({ width: 1, height: 1, signature: '#?RGBE', payload: onePixel });

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('accepts a signature with a version after it', () => {
		const file = buildHdr({ width: 1, height: 1, signature: '#?RADIANCE 5.4', payload: onePixel });

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('accepts a file with no FORMAT line, which the specification allows', () => {
		const file = buildHdr({ width: 1, height: 1, lines: [], payload: onePixel });

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('skips comments and lines it has no use for', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: [
				'# made earlier',
				'#FORMAT=32-bit_rle_xyze',
				'SOFTWARE=something',
				'VIEW= -vtv -vp 0 0 0',
				'FORMAT=32-bit_rle_rgbe',
			],
			payload: onePixel,
		});

		// The commented out FORMAT line is the point: a comment can say anything,
		// including something that would be refused if it were read as a key.
		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('reads a header whose lines end with a carriage return as well', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['FORMAT=32-bit_rle_rgbe\r'],
			separator: '\r\n',
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('ignores a header line carrying bytes that are not text', () => {
		const file = buildHdr({ width: 1, height: 1, payload: onePixel });
		const dirty = Uint8Array.from([...asciiBytes('#?RADIANCE\n\x01\x02\x03\n'), ...file.slice(11)]);

		expect(decodeHdrFloat(dirty).width).toBe(1);
	});

	it('divides the samples by the exposure the header declares', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['FORMAT=32-bit_rle_rgbe', 'EXPOSURE=4'],
			payload: onePixel,
		});
		const image = decodeHdrFloat(file);

		expect(image.exposure).toBe(4);
		expectPixel(image, 0, 0, [
			sampleOf(128, 129) / 4,
			sampleOf(64, 129) / 4,
			sampleOf(32, 129) / 4,
		]);
	});

	it('multiplies repeated exposure lines together', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['EXPOSURE=2', 'EXPOSURE=0.5e1', 'EXPOSURE=+1'],
			payload: onePixel,
		});

		// Each tool that changed the exposure appended its own line, so the
		// picture was multiplied by all of them and recovering it divides by all
		// of them. Taking only the last would be out by a factor of two here.
		expect(decodeHdrFloat(file).exposure).toBe(10);
	});

	it('accepts the corrections that say nothing was corrected', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['GAMMA=1', 'COLORCORR=1 1 1', 'PIXASPECT=1.0000', 'FORMAT=32-bit_rle_rgbe'],
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('reads Display P3 out of a PRIMARIES line', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PRIMARIES=0.680 0.320 0.265 0.690 0.150 0.060 0.3127 0.3290'],
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).colourSpace).toBe('display-p3');
	});

	it('treats sRGB primaries as sRGB', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PRIMARIES=0.640 0.330 0.300 0.600 0.150 0.060 0.3127 0.3290'],
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).colourSpace).toBe('srgb');
	});

	it('treats a PRIMARIES line that names nothing as sRGB', () => {
		// ImageMagick writes eight zeroes here for every picture it converts,
		// which is not a colour space and must not be read as one.
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PRIMARIES=0 0 0 0 0 0 0 0'],
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).colourSpace).toBe('srgb');
	});

	it('ignores a PRIMARIES line that is not eight numbers', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PRIMARIES=0.680 0.320 rubbish'],
			payload: onePixel,
		});

		expect(decodeHdrFloat(file).colourSpace).toBe('srgb');
	});
});

/* ── Samples ──────────────────────────────────────────────────────────── */

describe('decodeHdrFloat samples', () => {
	it('reads a zero exponent as exactly black', () => {
		const file = buildHdr({ width: 1, height: 1, payload: flatRow([[200, 100, 50, 0]]) });
		const image = decodeHdrFloat(file);

		// Reserved, not merely small. Running the arithmetic on it would light
		// every unlit pixel in the picture.
		expect(Array.from(image.data)).toEqual([0, 0, 0]);
	});

	it('adds the half a mantissa stands for, so a zero mantissa is not zero', () => {
		const file = buildHdr({ width: 1, height: 1, payload: flatRow([[0, 0, 0, 128]]) });
		const image = decodeHdrFloat(file);

		expectPixel(image, 0, 0, [0.5 / 256, 0.5 / 256, 0.5 / 256]);
	});

	it('reads white as a shade over one, which is what the format stores', () => {
		const file = buildHdr({ width: 1, height: 1, payload: flatRow([[128, 128, 128, 129]]) });

		expectPixel(decodeHdrFloat(file), 0, 0, [1.00390625, 1.00390625, 1.00390625]);
	});

	it('reads the whole exponent range without overflowing', () => {
		// Compressed rather than flat, because three mantissas of 255 are the
		// repeat marker in an uncompressed scanline and cannot be written there.
		const pixels: Rgbe[] = [
			[255, 255, 255, 255],
			[1, 1, 1, 1],
			...Array.from({ length: 6 }, () => [0, 0, 0, 0] as Rgbe),
		];
		const image = decodeHdrFloat(buildHdr({ width: 8, height: 1, payload: literalRow(pixels) }));

		expectPixel(image, 0, 0, [sampleOf(255, 255), sampleOf(255, 255), sampleOf(255, 255)]);
		// The dimmest exponent lands below the smallest normal 32 bit float, so
		// what comes back is a subnormal and carries about ten bits rather than
		// twenty four. It is still the right number to a part in a thousand, and
		// it is nine orders of magnitude below anything a screen can show.
		expectClose(image.data[3] as number, sampleOf(1, 1), 1e-3);
		expect(image.data.every((value) => Number.isFinite(value))).toBe(true);
	});
});

/* ── Scanline encodings ───────────────────────────────────────────────── */

describe('decodeHdrFloat scanlines', () => {
	it('reads an uncompressed picture, which is what a narrow one always is', () => {
		const pixels: Rgbe[] = [
			[10, 20, 30, 128],
			[40, 50, 60, 129],
			[70, 80, 90, 130],
			[100, 110, 120, 131],
		];
		const file = buildHdr({ width: 4, height: 1, payload: flatRow(pixels) });
		const image = decodeHdrFloat(file);

		pixels.forEach((pixel, x) => {
			expectPixel(image, x, 0, [
				sampleOf(pixel[0], pixel[3]),
				sampleOf(pixel[1], pixel[3]),
				sampleOf(pixel[2], pixel[3]),
			]);
		});
	});

	it('reads several uncompressed rows in order', () => {
		const file = buildHdr({
			width: 2,
			height: 2,
			payload: [
				...flatRow([
					[10, 0, 0, 128],
					[20, 0, 0, 128],
				]),
				...flatRow([
					[30, 0, 0, 128],
					[40, 0, 0, 128],
				]),
			],
		});
		const image = decodeHdrFloat(file);

		expectClose(image.data[0] as number, sampleOf(10, 128));
		expectClose(image.data[3] as number, sampleOf(20, 128));
		expectClose(image.data[6] as number, sampleOf(30, 128));
		expectClose(image.data[9] as number, sampleOf(40, 128));
	});

	it('reads a compressed scanline made of literals', () => {
		const pixels: Rgbe[] = Array.from({ length: 8 }, (_unused, x) => [x * 8, x * 4, x * 2, 130]);
		const file = buildHdr({ width: 8, height: 1, payload: literalRow(pixels) });
		const image = decodeHdrFloat(file);

		pixels.forEach((pixel, x) => {
			expectPixel(image, x, 0, [
				sampleOf(pixel[0], 130),
				sampleOf(pixel[1], 130),
				sampleOf(pixel[2], 130),
			]);
		});
	});

	it('reads a compressed scanline made of runs', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [
				2,
				2,
				0,
				8,
				// Each channel is one run of eight, which is how a flat colour row
				// comes out and why the encoding stores the channels apart.
				...[136, 11],
				...[136, 22],
				...[136, 33],
				...[136, 128],
			],
		});
		const image = decodeHdrFloat(file);

		for (let x = 0; x < 8; x += 1) {
			expectPixel(image, x, 0, [sampleOf(11, 128), sampleOf(22, 128), sampleOf(33, 128)]);
		}
	});

	it('reads a compressed scanline that mixes runs and literals', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [
				2, 2, 0, 8,
				// Red: a run of five, then three literals.
				133, 7, 3, 1, 2, 3,
				// The other three channels are one run each.
				136, 0, 136, 0, 136, 128,
			],
		});
		const image = decodeHdrFloat(file);

		expectClose(image.data[0] as number, sampleOf(7, 128));
		expectClose(image.data[12] as number, sampleOf(7, 128));
		expectClose(image.data[15] as number, sampleOf(1, 128));
		expectClose(image.data[18] as number, sampleOf(2, 128));
		expectClose(image.data[21] as number, sampleOf(3, 128));
	});

	it('reads a literal of exactly 128, which is not a run of nothing', () => {
		// The one off by one in the encoding: over 128 is a run, and 128 itself is
		// the longest literal. Reading it as a run of zero stalls on a file
		// Radiance itself writes.
		const width = 128;
		const payload = [2, 2, 0, 128];
		for (let channel = 0; channel < 4; channel += 1) {
			payload.push(128);
			for (let x = 0; x < width; x += 1) payload.push(channel === 3 ? 128 : x);
		}
		const image = decodeHdrFloat(buildHdr({ width, height: 1, payload }));

		expectClose(image.data[0] as number, sampleOf(0, 128));
		expectClose(image.data[(width - 1) * 3] as number, sampleOf(127, 128));
	});

	it('reads the longest run there is, which is 127 rather than 128', () => {
		const width = 130;
		const payload = [2, 2, 0, 130];
		for (let channel = 0; channel < 4; channel += 1) {
			// A run of 127, the longest the code can carry, then the three left
			// over as literals.
			payload.push(255, channel === 3 ? 128 : 9);
			payload.push(3, ...(channel === 3 ? [128, 128, 128] : [1, 2, 3]));
		}
		const image = decodeHdrFloat(buildHdr({ width, height: 1, payload }));

		expectClose(image.data[0] as number, sampleOf(9, 128));
		expectClose(image.data[126 * 3] as number, sampleOf(9, 128));
		expectClose(image.data[127 * 3] as number, sampleOf(1, 128));
		expectClose(image.data[129 * 3] as number, sampleOf(3, 128));
	});

	it('reads a wide picture as several compressed scanlines', () => {
		const row = (value: number): number[] => [2, 2, 0, 8, 136, value, 136, 0, 136, 0, 136, 128];
		const image = decodeHdrFloat(
			buildHdr({ width: 8, height: 3, payload: [...row(10), ...row(20), ...row(30)] }),
		);

		expectClose(image.data[0] as number, sampleOf(10, 128));
		expectClose(image.data[8 * 3] as number, sampleOf(20, 128));
		expectClose(image.data[16 * 3] as number, sampleOf(30, 128));
	});

	it('reads a repeat marker as the pixel before it, over again', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [...flatRow([[10, 20, 30, 128]]), 255, 255, 255, 6, ...flatRow([[40, 50, 60, 129]])],
		});
		const image = decodeHdrFloat(file);

		for (let x = 0; x < 7; x += 1) {
			expectPixel(image, x, 0, [sampleOf(10, 128), sampleOf(20, 128), sampleOf(30, 128)]);
		}
		expectPixel(image, 7, 0, [sampleOf(40, 129), sampleOf(50, 129), sampleOf(60, 129)]);
	});

	it('shifts the count of a repeat marker that follows another one', () => {
		// The part of the original encoding nobody implements. A second marker in
		// a row is the same count eight bits further up, so this row is one pixel,
		// then 43 of it, then 256 more, which is 300 exactly. Read as two plain
		// counts it would be 44 pixels and the rest of the picture would shear.
		const width = 300;
		const file = buildHdr({
			width,
			height: 1,
			payload: [...flatRow([[10, 20, 30, 128]]), 255, 255, 255, 43, 255, 255, 255, 1],
		});
		const image = decodeHdrFloat(file);

		expect(image.width).toBe(width);
		for (const x of [0, 1, 43, 44, 299]) {
			expectPixel(image, x, 0, [sampleOf(10, 128), sampleOf(20, 128), sampleOf(30, 128)]);
		}
	});

	it('accepts a repeat marker whose count is zero and carries on', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [
				...flatRow([[10, 20, 30, 128]]),
				255,
				255,
				255,
				0,
				...flatRow(Array.from({ length: 7 }, () => [40, 50, 60, 129] as Rgbe)),
			],
		});
		const image = decodeHdrFloat(file);

		expectPixel(image, 0, 0, [sampleOf(10, 128), sampleOf(20, 128), sampleOf(30, 128)]);
		expectPixel(image, 7, 0, [sampleOf(40, 129), sampleOf(50, 129), sampleOf(60, 129)]);
	});

	it('reads a wide scanline that begins with a pixel looking like a header', () => {
		// 2, 2 with the top bit of the third byte set is an ordinary pixel whose
		// red and green mantissas are both 2, not a compressed scanline header.
		const pixels: Rgbe[] = [
			[2, 2, 200, 129],
			...Array.from({ length: 7 }, () => [10, 20, 30, 128] as Rgbe),
		];
		const image = decodeHdrFloat(buildHdr({ width: 8, height: 1, payload: flatRow(pixels) }));

		expectPixel(image, 0, 0, [sampleOf(2, 129), sampleOf(2, 129), sampleOf(200, 129)]);
		expectPixel(image, 7, 0, [sampleOf(10, 128), sampleOf(20, 128), sampleOf(30, 128)]);
	});

	it('reads a narrow scanline that begins with the bytes 2 and 2', () => {
		// Below eight pixels the compressed encoding is not legal, so these four
		// bytes are a pixel however much they look like a header.
		const pixels: Rgbe[] = [
			[2, 2, 0, 4],
			[10, 20, 30, 128],
			[40, 50, 60, 129],
			[70, 80, 90, 130],
		];
		const image = decodeHdrFloat(buildHdr({ width: 4, height: 1, payload: flatRow(pixels) }));

		expectPixel(image, 0, 0, [sampleOf(2, 4), sampleOf(2, 4), sampleOf(0, 4)]);
		expectPixel(image, 3, 0, [sampleOf(70, 130), sampleOf(80, 130), sampleOf(90, 130)]);
	});

	it('reads a file whose scanlines are not all encoded the same way', () => {
		// The encoding is chosen per scanline, not per file, so a writer that
		// changed its mind halfway down produces something every reader has to
		// handle. The second row here is the older encoding inside a picture wide
		// enough for the newer one.
		const file = buildHdr({
			width: 8,
			height: 2,
			payload: [
				2,
				2,
				0,
				8,
				136,
				11,
				136,
				0,
				136,
				0,
				136,
				128,
				...flatRow([[22, 0, 0, 128]]),
				255,
				255,
				255,
				7,
			],
		});
		const image = decodeHdrFloat(file);

		expectClose(image.data[0] as number, sampleOf(11, 128));
		expectClose(image.data[8 * 3] as number, sampleOf(22, 128));
		expectClose(image.data[15 * 3] as number, sampleOf(22, 128));
	});

	it('ignores bytes after the last scanline', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			payload: [...flatRow([[10, 20, 30, 128]]), 0xff, 0xff, 0xff, 0xff],
		});

		expect(decodeHdrFloat(file).width).toBe(1);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = buildHdr({ width: 1, height: 1, payload: flatRow([[10, 20, 30, 128]]) });
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);
		const image = decodeHdrFloat(padded.subarray(8, 8 + file.length));

		expectPixel(image, 0, 0, [sampleOf(10, 128), sampleOf(20, 128), sampleOf(30, 128)]);
	});
});

/* ── Orientation ──────────────────────────────────────────────────────── */

describe('decodeHdrFloat orientation', () => {
	/** Four pixels, one per corner, each identifiable by its red mantissa. */
	const corners: Rgbe[] = [
		[1, 0, 0, 128],
		[2, 0, 0, 128],
		[3, 0, 0, 128],
		[4, 0, 0, 128],
	];

	function redsOf(resolution: string): number[] {
		const file = buildHdr({
			width: 2,
			height: 2,
			resolution,
			payload: [...flatRow(corners.slice(0, 2)), ...flatRow(corners.slice(2))],
		});
		const image = decodeHdrFloat(file);
		const out: number[] = [];
		for (let i = 0; i < 4; i += 1) {
			// Undo the sample arithmetic to get the mantissa back, which is what
			// says where each pixel landed.
			out.push(Math.round((image.data[i * 3] as number) / 2 ** (128 - 136) - 0.5));
		}
		return out;
	}

	it('reads -Y +X, which is the order everything writes, without moving anything', () => {
		expect(redsOf('-Y 2 +X 2')).toEqual([1, 2, 3, 4]);
	});

	it('reads +Y as a picture stored bottom row first', () => {
		expect(redsOf('+Y 2 +X 2')).toEqual([3, 4, 1, 2]);
	});

	it('reads -X as a scanline stored right to left', () => {
		expect(redsOf('-Y 2 -X 2')).toEqual([2, 1, 4, 3]);
	});

	it('reads +Y with -X as a picture turned through half a turn', () => {
		expect(redsOf('+Y 2 -X 2')).toEqual([4, 3, 2, 1]);
	});

	it('accepts extra spacing around the numbers', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			resolution: '  -Y  1   +X  1  ',
			payload: flatRow([[10, 20, 30, 128]]),
		});

		expect(decodeHdrFloat(file).width).toBe(1);
	});
});

/* ── The tone mapped picture ──────────────────────────────────────────── */

describe('decodeHdr', () => {
	it('meters the picture, so a single white pixel comes back middle grey', () => {
		const file = buildHdr({ width: 1, height: 1, payload: flatRow([[128, 128, 128, 129]]) });
		const image = decodeHdr(file);

		// There is no absolute white in a scene referred file, so the exposure has
		// to come from the picture. One pixel of any brightness is its own average
		// and lands on middle grey by definition.
		expect(Array.from(image.data)).toEqual([118, 118, 118, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('leaves a picture with no light in it black', () => {
		const file = buildHdr({
			width: 2,
			height: 1,
			payload: flatRow([
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			]),
		});

		expect(Array.from(decodeHdr(file).data)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
	});

	it('keeps the brighter of two pixels brighter', () => {
		const file = buildHdr({
			width: 2,
			height: 1,
			payload: flatRow([
				[128, 128, 128, 120],
				[128, 128, 128, 140],
			]),
		});
		const image = decodeHdr(file);

		// Twenty stops apart in the file. The roll-off compresses that, and it
		// must not reorder it.
		expect(image.data[0] as number).toBeLessThan(image.data[4] as number);
	});

	it('gives back the dimensions of the file and no alpha channel', () => {
		const file = buildHdr({
			width: 3,
			height: 2,
			payload: flatRow(Array.from({ length: 6 }, () => [128, 128, 128, 128] as Rgbe)),
		});
		const image = decodeHdr(file);

		expect(image.width).toBe(3);
		expect(image.height).toBe(2);
		expect(image.data.length).toBe(24);
		expect(image.hasAlpha).toBe(false);
		for (let i = 3; i < image.data.length; i += 4) expect(image.data[i]).toBe(255);
	});

	it('carries a Display P3 header through to the raster', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PRIMARIES=0.680 0.320 0.265 0.690 0.150 0.060 0.3127 0.3290'],
			payload: flatRow([[128, 128, 128, 129]]),
		});

		expect(decodeHdr(file).colourSpace).toBe('display-p3');
	});
});

/* ── A file this package did not write ────────────────────────────────── */

describe('decodeHdrFloat against a file from another writer', () => {
	/**
	 * An eight by four red to blue gradient written by ImageMagick 7, byte for
	 * byte.
	 *
	 * Every other decoder fixture here is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. This one is not: it came out
	 * of an implementation with no connection to this one, and it carries the two
	 * header lines ImageMagick always writes, one of which names a colour space
	 * made entirely of zeroes.
	 */
	const magick = Uint8Array.from([
		0x23, 0x3f, 0x52, 0x41, 0x44, 0x49, 0x41, 0x4e, 0x43, 0x45, 0x0a, 0x47, 0x41, 0x4d, 0x4d, 0x41,
		0x3d, 0x31, 0x0a, 0x50, 0x52, 0x49, 0x4d, 0x41, 0x52, 0x49, 0x45, 0x53, 0x3d, 0x30, 0x20, 0x30,
		0x20, 0x30, 0x20, 0x30, 0x20, 0x30, 0x20, 0x30, 0x20, 0x30, 0x20, 0x30, 0x0a, 0x46, 0x4f, 0x52,
		0x4d, 0x41, 0x54, 0x3d, 0x33, 0x32, 0x2d, 0x62, 0x69, 0x74, 0x5f, 0x72, 0x6c, 0x65, 0x5f, 0x72,
		0x67, 0x62, 0x65, 0x0a, 0x0a, 0x2d, 0x59, 0x20, 0x34, 0x20, 0x2b, 0x58, 0x20, 0x38, 0x0a, 0x02,
		0x02, 0x00, 0x08, 0x88, 0x80, 0x88, 0x00, 0x88, 0x00, 0x88, 0x81, 0x02, 0x02, 0x00, 0x08, 0x88,
		0xcd, 0x88, 0x00, 0x88, 0x2e, 0x88, 0x7f, 0x02, 0x02, 0x00, 0x08, 0x88, 0x2e, 0x88, 0x00, 0x88,
		0xcd, 0x88, 0x7f, 0x02, 0x02, 0x00, 0x08, 0x88, 0x00, 0x88, 0x00, 0x88, 0x80, 0x88, 0x81,
	]);

	it('reads its size and its four rows of flat colour', () => {
		const image = decodeHdrFloat(magick);

		expect(image.width).toBe(8);
		expect(image.height).toBe(4);
		expect(image.colourSpace).toBe('srgb');

		expectPixel(image, 0, 0, [sampleOf(128, 129), sampleOf(0, 129), sampleOf(0, 129)]);
		expectPixel(image, 7, 0, [sampleOf(128, 129), sampleOf(0, 129), sampleOf(0, 129)]);
		expectPixel(image, 0, 1, [sampleOf(205, 127), sampleOf(0, 127), sampleOf(46, 127)]);
		expectPixel(image, 0, 2, [sampleOf(46, 127), sampleOf(0, 127), sampleOf(205, 127)]);
		expectPixel(image, 0, 3, [sampleOf(0, 129), sampleOf(0, 129), sampleOf(128, 129)]);
	});

	it('reads its top row as red and its bottom row as blue', () => {
		const image = decodeHdr(magick);

		const top = Array.from(image.data.subarray(0, 4));
		const bottom = Array.from(image.data.subarray(3 * 8 * 4, 3 * 8 * 4 + 4));
		expect(top[0] as number).toBeGreaterThan(200);
		expect(top[2] as number).toBeLessThan(60);
		expect(bottom[2] as number).toBeGreaterThan(200);
		expect(bottom[0] as number).toBeLessThan(60);
	});

	it('writes a file with the same pixel bytes in it', () => {
		// ImageMagick's writer and this one make the same choices: the same
		// exponent per pixel, the same truncated mantissas, and the same runs.
		const again = encodeHdr(decodeHdr(magick));

		expect(splitHdr(again).payload.length).toBe(48);
		expect(splitHdr(again).payload.slice(0, 4)).toEqual([2, 2, 0, 8]);
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeHdr', () => {
	it('writes the whole of a one pixel file byte for byte', () => {
		const out = encodeHdr(raster(1, 1, [255, 255, 255, 255]));

		expect(textOf(out)).toBe('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\x80\x80\x80\x81');
	});

	it('writes linear light rather than the bytes it was given', () => {
		// Middle grey is 128 on screen and a fifth of the light, not half of it.
		// Writing the byte straight through is the mistake this format invites,
		// and the file it produces opens and looks merely wrong.
		const { payload } = splitHdr(encodeHdr(raster(1, 1, [128, 128, 128, 255])));

		expect(payload).toEqual([221, 221, 221, 126]);
		expectClose(sampleOf(221, 126), toLinear(128), 0.005);
	});

	it('writes black as four zero bytes', () => {
		expect(splitHdr(encodeHdr(raster(1, 1, [0, 0, 0, 255]))).payload).toEqual([0, 0, 0, 0]);
	});

	it('shares one exponent across the three channels', () => {
		const { payload } = splitHdr(encodeHdr(raster(1, 1, [255, 0, 0, 255])));

		// Red is at the top of its range, so it takes the exponent and the other
		// two are measured against it. A channel that is off cannot be spelled
		// exactly, which is the format's one real limitation.
		expect(payload).toEqual([128, 0, 0, 129]);
	});

	it('writes a scanline of eight or more as runs', () => {
		const pixels: number[] = [];
		for (let x = 0; x < 8; x += 1) pixels.push(255, 0, 0, 255);
		const { payload } = splitHdr(encodeHdr(raster(8, 1, pixels)));

		// Byte for byte what ImageMagick writes for the same picture: the four
		// byte header, then each channel as one run of eight.
		expect(payload).toEqual([2, 2, 0, 8, 136, 128, 136, 0, 136, 0, 136, 129]);
	});

	it('writes samples that do not repeat as literals', () => {
		const pixels: number[] = [];
		for (let x = 0; x < 8; x += 1) pixels.push(255, 40 + x * 20, 0, 255);
		const { payload } = splitHdr(encodeHdr(raster(8, 1, pixels)));

		expect(payload.slice(0, 4)).toEqual([2, 2, 0, 8]);
		expect(payload[4]).toBe(136); // red, one run of eight
		expect(payload[6]).toBe(8); // green, eight literals
	});

	it('breaks a run longer than 127 rather than writing a code it cannot', () => {
		const pixels: number[] = [];
		for (let x = 0; x < 130; x += 1) pixels.push(255, 0, 0, 255);
		const { payload } = splitHdr(encodeHdr(raster(130, 1, pixels)));

		// A run of 127, then the remaining three as a literal, because a run of
		// three costs more than it saves.
		expect(payload.slice(0, 4)).toEqual([2, 2, 0, 130]);
		expect(payload.slice(4, 6)).toEqual([255, 128]);
		expect(payload.slice(6, 10)).toEqual([3, 128, 128, 128]);
	});

	it('writes literals, then a run, then the literals after it', () => {
		const levels = [10, 20, 30, 44, 44, 44, 44, 44, 40, 50, 60, 70, 80, 90, 100, 110];
		const pixels = levels.flatMap((level) => [level, level, level, 255]);
		const { payload } = splitHdr(encodeHdr(raster(16, 1, pixels)));

		// Three literals, a run of five, then the eight left over. The run has to
		// interrupt the literal rather than the literal swallowing it, or a flat
		// area of any size would cost a byte a pixel.
		expect(payload.slice(0, 4)).toEqual([2, 2, 0, 16]);
		expect(payload[4]).toBe(3);
		expect(payload[8]).toBe(128 + 5);
		expect(payload[10]).toBe(8);
	});

	it('writes one scanline for every row', () => {
		const row = (level: number): number[] =>
			Array.from({ length: 8 }, () => [level, level, level, 255]).flat();
		const out = encodeHdr(raster(8, 3, [...row(10), ...row(200), ...row(90)]));
		const { payload } = splitHdr(out);

		// Each row is a flat colour, so each is four runs behind a four byte
		// header, and the three of them are the same length.
		expect(payload.length).toBe(3 * 12);
		expect(payload.slice(12, 16)).toEqual([2, 2, 0, 8]);
		expect(payload.slice(24, 28)).toEqual([2, 2, 0, 8]);
	});

	it('writes a narrow picture flat, because the compressed form is not legal there', () => {
		const pixels: number[] = [];
		for (let x = 0; x < 7; x += 1) pixels.push(255, 0, 0, 255);
		const { payload } = splitHdr(encodeHdr(raster(7, 1, pixels)));

		expect(payload.length).toBe(28);
		expect(payload.slice(0, 8)).toEqual([128, 0, 0, 129, 128, 0, 0, 129]);
	});

	it('never writes the three mantissas that mean "repeat" into a flat scanline', () => {
		// A grey of 99 is the one eight bit level whose light sits just under a
		// power of two in all three channels, so it encodes to 255, 255, 255,
		// which in an uncompressed scanline is not a pixel at all but the marker
		// that repeats the pixel before it.
		const pixels: number[] = [];
		for (let x = 0; x < 4; x += 1) pixels.push(99, 99, 99, 255);
		const { payload } = splitHdr(encodeHdr(raster(4, 1, pixels)));

		expect(payload.slice(0, 4)).toEqual([254, 254, 254, 125]);
		expect(decodeHdrFloat(encodeHdr(raster(4, 1, pixels))).width).toBe(4);
	});

	it('writes rows from the top down', () => {
		const out = encodeHdr(raster(1, 2, [255, 255, 255, 255, 0, 0, 0, 255]));

		expect(splitHdr(out).payload).toEqual([128, 128, 128, 129, 0, 0, 0, 0]);
	});

	it('flattens a translucent pixel onto white by default', () => {
		const out = encodeHdr(raster(1, 1, [0, 0, 0, 0], true));

		expect(splitHdr(out).payload).toEqual([128, 128, 128, 129]);
	});

	it('flattens onto the background it was given', () => {
		const out = encodeHdr(raster(1, 1, [0, 0, 0, 0], true), { background: [255, 0, 0] });

		expect(splitHdr(out).payload).toEqual([128, 0, 0, 129]);
	});

	it('ignores the alpha bytes of a raster that says it has none', () => {
		// A raster fresh from `createRaster` has zero in every alpha byte and says
		// it is opaque. Compositing those would write a picture of the background.
		const image = raster(1, 1, [255, 255, 255, 0], false);

		expect(splitHdr(encodeHdr(image)).payload).toEqual([128, 128, 128, 129]);
	});

	it('says so in the header when the numbers are Display P3', () => {
		const out = encodeHdr(raster(1, 1, [255, 255, 255, 255], false, 'display-p3'));

		expect(splitHdr(out).header).toContain('PRIMARIES=0.680 0.320 0.265 0.690 0.150 0.060');
		expect(decodeHdrFloat(out).colourSpace).toBe('display-p3');
	});

	it('writes no primaries line for an ordinary sRGB picture', () => {
		expect(splitHdr(encodeHdr(raster(1, 1, [1, 2, 3, 255]))).header).not.toContain('PRIMARIES');
	});

	it('ignores the quality setting, there being nothing lossy to steer', () => {
		const low = encodeHdr(raster(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]), { quality: 0.1 });
		const high = encodeHdr(raster(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]), { quality: 1 });

		expect(Array.from(low)).toEqual(Array.from(high));
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('HDR round trips', () => {
	/**
	 * How far a sample may move through the codec.
	 *
	 * A pixel's three channels share one exponent, so the step between one
	 * mantissa and the next is a 256th of the brightest channel in that pixel.
	 * The reader lands in the middle of the step, so the error is at most half of
	 * it, and the storage is 32 bit float, which adds nothing at this scale. That
	 * is the whole loss: a channel far darker than its neighbours in the same
	 * pixel keeps that absolute accuracy rather than a relative one, which is why
	 * pure blue comes back with a trace of red in it.
	 */
	function expectRoundTrip(image: RasterImage): void {
		const back = decodeHdrFloat(encodeHdr(image));

		expect(back.width).toBe(image.width);
		expect(back.height).toBe(image.height);

		for (let i = 0; i < image.width * image.height; i += 1) {
			const source = [
				toLinear(image.data[i * 4] as number),
				toLinear(image.data[i * 4 + 1] as number),
				toLinear(image.data[i * 4 + 2] as number),
			];
			const brightest = Math.max(...source);
			for (let channel = 0; channel < 3; channel += 1) {
				const difference = Math.abs(
					(back.data[i * 3 + channel] as number) - (source[channel] as number),
				);
				expect(difference).toBeLessThanOrEqual(brightest / 256 + 1e-9);
			}
		}
	}

	it.each([
		[1, 1],
		[2, 1],
		[7, 1],
		[8, 1],
		[9, 3],
		[16, 16],
		[127, 2],
		[128, 2],
		[129, 2],
		[3, 17],
	])('carries a %i by %i picture through within half a mantissa step', (width, height) => {
		expectRoundTrip(noise(width, height));
	});

	it('carries every grey level through', () => {
		const image = createRaster(256, 1, 'srgb', false);
		for (let x = 0; x < 256; x += 1) image.data.set([x, x, x, 255], x * 4);

		expectRoundTrip(image);
	});

	it('carries a flat colour through, which is the case runs are for', () => {
		const pixels: number[] = [];
		for (let i = 0; i < 64; i += 1) pixels.push(12, 200, 90, 255);
		expectRoundTrip(raster(32, 2, pixels));
	});

	it('keeps black exactly black', () => {
		const back = decodeHdrFloat(encodeHdr(raster(8, 1, new Array<number>(32).fill(0))));

		expect(Array.from(back.data)).toEqual(new Array<number>(24).fill(0));
	});

	it('writes a picture wider than the compressed encoding allows, and reads it back', () => {
		// Above 32767 the length field of a compressed scanline cannot hold the
		// width, so the row goes out flat. It is in the specification and it is
		// easy to miss, because nothing anybody has to hand is that wide.
		const width = 32768;
		const image = createRaster(width, 1, 'srgb', false);
		for (let x = 0; x < width; x += 1) image.data.set([x & 0xff, 0, 128, 255], x * 4);
		const file = encodeHdr(image);

		expect(splitHdr(file).payload.length).toBe(width * 4);
		const back = decodeHdrFloat(file);
		expect(back.width).toBe(width);
		expectClose(back.data[3 * 100] as number, toLinear(100), 0.02);
	});

	it('settles after one pass, because the tone map has metered it by then', () => {
		// The first trip through cannot come back byte for byte: the file holds
		// light with no ceiling and the reader has to choose an exposure for it.
		// Once that choice has been made the picture meters at middle grey, so
		// every trip after the first is the identity, give or take the mantissa.
		const once = decodeHdr(encodeHdr(noise(16, 16)));
		const twice = decodeHdr(encodeHdr(once));
		const thrice = decodeHdr(encodeHdr(twice));

		for (let i = 0; i < once.data.length; i += 1) {
			expect(Math.abs((twice.data[i] as number) - (once.data[i] as number))).toBeLessThanOrEqual(6);
		}
		// And by then it is a fixed point rather than merely close to one: the
		// exposure the picture meters at is the one it already has.
		expect(Array.from(thrice.data)).toEqual(Array.from(twice.data));
	});

	it('carries a Display P3 picture through as Display P3', () => {
		const image = raster(8, 1, new Array<number>(32).fill(128), false, 'display-p3');
		image.data.forEach((_unused, i) => {
			if (i % 4 === 3) image.data[i] = 255;
		});

		expect(decodeHdr(encodeHdr(image)).colourSpace).toBe('display-p3');
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeHdr refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeHdrFloat(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('hdr');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('rejects an empty file', () => {
		expectRefusal(new Uint8Array(0), /"#\?"/);
	});

	it('rejects a file that does not open with the two signature bytes', () => {
		expectRefusal(Uint8Array.from(asciiBytes('RADIANCE\n\n-Y 1 +X 1\n')), /"#\?"/);
	});

	it('rejects a first line naming neither RADIANCE nor RGBE', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			signature: '#?SOMETHINGELSE',
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /names neither RADIANCE nor RGBE/);
	});

	it('rejects a file that stops inside its header', () => {
		expectRefusal(
			Uint8Array.from(asciiBytes('#?RADIANCE\nFORMAT=32-bit')),
			/ends inside its header/,
		);
	});

	it('rejects a header with no blank line in it at all', () => {
		const long = `#?RADIANCE\n${'# padding\n'.repeat(7000)}`;
		expectRefusal(Uint8Array.from(asciiBytes(long)), /65536 bytes/);
	});

	it('rejects a file that ends where its size should be', () => {
		expectRefusal(
			Uint8Array.from(asciiBytes('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')),
			/ends inside its header/,
		);
	});

	it('names the XYZE format rather than reading it as red, green and blue', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['FORMAT=32-bit_rle_xyze'],
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /FORMAT=32-bit_rle_xyze/);
	});

	it('rejects a FORMAT it does not know', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['FORMAT=16-bit_something'],
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /other than 32-bit_rle_rgbe/);
	});

	it.each(['EXPOSURE=0', 'EXPOSURE=-2', 'EXPOSURE=nonsense', 'EXPOSURE=1 2'])(
		'rejects %s, which nothing can be divided by',
		(line) => {
			const file = buildHdr({ width: 1, height: 1, lines: [line], payload: [1, 2, 3, 4] });
			expectRefusal(file, /EXPOSURE that is not a positive number/);
		},
	);

	it('rejects exposures that multiply out past what a number can hold', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['EXPOSURE=1e200', 'EXPOSURE=1e200'],
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /multiply out/);
	});

	it('names GAMMA rather than handing back a picture already corrected', () => {
		const file = buildHdr({ width: 1, height: 1, lines: ['GAMMA=2.2'], payload: [1, 2, 3, 4] });
		expectRefusal(file, /GAMMA other than 1/);
	});

	it('names COLORCORR rather than leaving a colour cast in', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['COLORCORR=1 1 1.6'],
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /COLORCORR/);
	});

	it('names COLORCORR when it does not carry three numbers either', () => {
		const file = buildHdr({ width: 1, height: 1, lines: ['COLORCORR=1'], payload: [1, 2, 3, 4] });
		expectRefusal(file, /COLORCORR/);
	});

	it('names PIXASPECT rather than handing back a stretched picture', () => {
		const file = buildHdr({
			width: 1,
			height: 1,
			lines: ['PIXASPECT=1.5'],
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /PIXASPECT other than 1/);
	});

	it('names the transposed layouts rather than treating them as the common one', () => {
		const file = buildHdr({
			width: 2,
			height: 2,
			resolution: '+X 2 -Y 2',
			payload: flatRow(Array.from({ length: 4 }, () => [1, 2, 3, 128] as Rgbe)),
		});
		expectRefusal(file, /down columns/);
	});

	it('rejects a size line naming the same axis twice', () => {
		const file = buildHdr({ width: 1, height: 1, resolution: '-Y 1 +Y 1', payload: [1, 2, 3, 4] });
		expectRefusal(file, /same axis twice/);
	});

	it.each(['-Y 1 X 1', 'nonsense', '-Y 1', '-Y one +X one', '-Q 1 +X 1'])(
		'rejects %s as a size line',
		(resolution) => {
			const file = buildHdr({ width: 1, height: 1, resolution, payload: [1, 2, 3, 4] });
			expectRefusal(file, /is not a size such as/);
		},
	);

	it('rejects a picture with no pixels in it', () => {
		const file = buildHdr({ width: 0, height: 1, resolution: '-Y 1 +X 0', payload: [] });
		expectRefusal(file, /0 pixels wide/);
	});

	it('rejects a picture claiming more pixels than this tool will allocate for', () => {
		const file = buildHdr({
			width: 60000,
			height: 60000,
			resolution: '-Y 60000 +X 60000',
			payload: [1, 2, 3, 4],
		});
		expectRefusal(file, /far larger than anything/);
	});

	it('rejects a height there is not enough file left for', () => {
		const file = buildHdr({ width: 1000, height: 1000, payload: [1, 2, 3, 4] });
		expectRefusal(file, /less pixel data than the 1000 scanlines/);
	});

	it('rejects a compressed scanline whose declared length is not the width', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [2, 2, 0, 9, ...new Array<number>(32).fill(0)],
		});
		expectRefusal(file, /declares a length that is not the width/);
	});

	it('rejects a compressed scanline that stops in the middle', () => {
		// Red and green are complete, and the file stops where blue's first code
		// should be.
		const file = buildHdr({ width: 8, height: 1, payload: [2, 2, 0, 8, 136, 1, 136, 2] });
		expectRefusal(file, /ends inside a compressed scanline/);
	});

	it('rejects a run that reaches past the end of its row', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [2, 2, 0, 8, 128 + 9, 1, ...new Array<number>(32).fill(0)],
		});
		expectRefusal(file, /run in a compressed scanline reaches past/);
	});

	it('rejects a run with nothing after it to repeat', () => {
		const file = buildHdr({ width: 8, height: 1, payload: [2, 2, 0, 8, 136] });
		expectRefusal(file, /missing the value it repeats/);
	});

	it('rejects a literal run of no bytes, which would never end', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [2, 2, 0, 8, 0, ...new Array<number>(32).fill(1)],
		});
		expectRefusal(file, /literal run of no bytes/);
	});

	it('rejects a literal run that reaches past the end of its row', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [2, 2, 0, 8, 9, ...new Array<number>(32).fill(1)],
		});
		expectRefusal(file, /literal run in a compressed scanline reaches past/);
	});

	it('rejects a literal run that runs off the end of the file', () => {
		const file = buildHdr({ width: 8, height: 1, payload: [2, 2, 0, 8, 8, 1, 2, 3] });
		expectRefusal(file, /ends inside a literal run/);
	});

	it('rejects an uncompressed scanline that stops in the middle', () => {
		const file = buildHdr({ width: 4, height: 1, payload: [1, 2, 3, 128, 4, 5] });
		expectRefusal(file, /ends inside a scanline/);
	});

	it('rejects a repeat marker with no pixel in front of it', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [255, 255, 255, 4, ...new Array<number>(28).fill(0)],
		});
		expectRefusal(file, /begins with a repeat marker/);
	});

	it('rejects a repeat marker that reaches past the end of its row', () => {
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [1, 2, 3, 128, 255, 255, 255, 200, ...new Array<number>(24).fill(0)],
		});
		expectRefusal(file, /repeat marker in a scanline reaches past/);
	});

	it('rejects a shifted repeat marker that reaches past the end of its row', () => {
		// The second marker's count is eight bits higher up, so a count of one
		// here means 256 pixels rather than one.
		const file = buildHdr({
			width: 8,
			height: 1,
			payload: [1, 2, 3, 128, 255, 255, 255, 2, 255, 255, 255, 1, ...new Array<number>(20).fill(0)],
		});
		expectRefusal(file, /repeat marker in a scanline reaches past/);
	});

	it('rejects a truncated file whose header alone is intact', () => {
		const file = buildHdr({ width: 8, height: 8, payload: new Array<number>(16).fill(0) });
		expectRefusal(file, /less pixel data than the 8 scanlines/);
	});
});

describe('encodeHdr refusals', () => {
	function expectRefusal(image: RasterImage, pattern: RegExp): void {
		let thrown: unknown;
		try {
			encodeHdr(image);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EncodeFailedError);
		const error = thrown as EncodeFailedError;
		expect(error.code).toBe('encode/failed');
		expect(error.format).toBe('hdr');
		expect(error.message).toMatch(pattern);
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('refuses an image with no pixels', () => {
		expectRefusal(createRaster(0, 0), /no width or no height/);
	});

	it('refuses a fractional size', () => {
		const odd: RasterImage = {
			data: new Uint8ClampedArray(16),
			width: 1.5,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expectRefusal(odd, /no width or no height/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expectRefusal(short, /smaller than the width and height/);
	});
});
