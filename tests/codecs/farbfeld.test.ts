/**
 * farbfeld, both directions.
 *
 * The format is small enough that the interesting failures are all at the
 * edges: the widening of an 8 bit sample to 16, a header read with the wrong
 * endianness, an odd width where a stride bug hides, and a file that promises
 * more pixels than it carries. Those are what most of this file is about.
 */

import { describe, expect, it } from 'vitest';
import { decodeFarbfeld } from '../../src/codecs/farbfeld/decode.js';
import { encodeFarbfeld } from '../../src/codecs/farbfeld/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { ColourSpace, RasterImage } from '../../src/types.js';

/** 'farbfeld' in ASCII, written out rather than computed, so a typo shows. */
const MAGIC = [0x66, 0x61, 0x72, 0x62, 0x66, 0x65, 0x6c, 0x64];

/**
 * A deterministic fill.
 *
 * A linear congruential generator rather than `Math.random`, so a failing run
 * fails the same way the next time somebody looks at it.
 */
function pattern(
	width: number,
	height: number,
	hasAlpha: boolean,
	colourSpace: ColourSpace = 'srgb',
): RasterImage {
	const image = createRaster(width, height, colourSpace, hasAlpha);
	let seed = 0x2f6e2b1;
	for (let i = 0; i < width * height; i += 1) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		image.data[i * 4] = seed & 0xff;
		image.data[i * 4 + 1] = (seed >> 8) & 0xff;
		image.data[i * 4 + 2] = (seed >> 16) & 0xff;
		image.data[i * 4 + 3] = hasAlpha ? (seed >> 4) & 0xff : 255;
	}
	if (hasAlpha) {
		// Pinned so the translucency of the fixture never depends on the
		// generator happening to produce a value other than 255.
		image.data[3] = 0;
		if (width * height > 1) image.data[7] = 128;
	}
	return image;
}

/** Build a file by hand, so the decoder is read against the specification. */
function file(width: number, height: number, samples: readonly number[]): Uint8Array {
	const out = new Uint8Array(16 + samples.length);
	out.set(MAGIC, 0);
	const view = new DataView(out.buffer);
	view.setUint32(8, width);
	view.setUint32(12, height);
	out.set(samples, 16);
	return out;
}

function decodeError(bytes: Uint8Array): DecodeFailedError {
	try {
		decodeFarbfeld(bytes);
	} catch (error) {
		if (error instanceof DecodeFailedError) return error;
		throw error;
	}
	throw new Error('that input was expected to be refused and was not.');
}

function encodeError(image: RasterImage): EncodeFailedError {
	try {
		encodeFarbfeld(image);
	} catch (error) {
		if (error instanceof EncodeFailedError) return error;
		throw error;
	}
	throw new Error('that raster was expected to be refused and was not.');
}

/** A raster the type system would accept from a caller but the encoder must not. */
function raster(width: number, height: number, bytes: number): RasterImage {
	return {
		data: new Uint8ClampedArray(bytes),
		width,
		height,
		colourSpace: 'srgb',
		hasAlpha: false,
	};
}

describe('farbfeld header', () => {
	it('opens with the eight magic bytes, spelling farbfeld', () => {
		const out = encodeFarbfeld(pattern(3, 2, false));
		expect([...out.subarray(0, 8)]).toEqual(MAGIC);
		expect(String.fromCharCode(...out.subarray(0, 8))).toBe('farbfeld');
	});

	it('writes a 1x1 file byte for byte as the specification describes it', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([0x12, 0x34, 0x56, 0x78]);

		// Row by row: the magic, width 1, height 1, then the four channels with
		// each byte in both halves of its sample. Laid out to be read against
		// the specification, which is why the formatter is told to leave it be.
		// prettier-ignore
		expect([...encodeFarbfeld(image)]).toEqual([
			0x66, 0x61, 0x72, 0x62, 0x66, 0x65, 0x6c, 0x64,
			0x00, 0x00, 0x00, 0x01,
			0x00, 0x00, 0x00, 0x01,
			0x12, 0x12, 0x34, 0x34, 0x56, 0x56, 0x78, 0x78,
		]);
	});

	it('writes width then height as big endian, not little endian', () => {
		const out = encodeFarbfeld(pattern(258, 1, false));
		// 258 is 0x0102, which reads as 0x0201 the wrong way round and would
		// still be a plausible width, so the wrong endianness would not crash.
		expect([...out.subarray(8, 16)]).toEqual([0, 0, 1, 2, 0, 0, 0, 1]);
	});

	it('writes sixteen bytes of header and eight bytes for every pixel', () => {
		expect(encodeFarbfeld(pattern(1, 1, false)).length).toBe(16 + 8);
		expect(encodeFarbfeld(pattern(7, 5, true)).length).toBe(16 + 7 * 5 * 8);
		expect(encodeFarbfeld(pattern(17, 13, false)).length).toBe(16 + 17 * 13 * 8);
	});

	it('returns a plain Uint8Array', () => {
		expect(encodeFarbfeld(pattern(2, 2, false))).toBeInstanceOf(Uint8Array);
	});
});

describe('farbfeld sample widening', () => {
	it('puts each byte in both halves of its sixteen bit sample', () => {
		const image = createRaster(256, 1, 'srgb', false);
		for (let value = 0; value < 256; value += 1) {
			image.data.set([value, value, value, 255], value * 4);
		}
		const out = encodeFarbfeld(image);
		const view = new DataView(out.buffer);

		for (let value = 0; value < 256; value += 1) {
			const at = 16 + value * 8;
			expect(out[at]).toBe(value);
			expect(out[at + 1]).toBe(value);
			// The reason for the replication: it is a multiply by 257 exactly.
			expect(view.getUint16(at)).toBe(value * 257);
		}
	});

	it('sends full white to 0xffff rather than the 0xff00 a left shift gives', () => {
		const image = createRaster(1, 1, 'srgb', false);
		image.data.set([255, 255, 255, 255]);
		const out = encodeFarbfeld(image);
		const view = new DataView(out.buffer);

		expect(view.getUint16(16)).toBe(0xffff);
		expect(view.getUint16(16)).not.toBe(0xff00);
		expect(view.getUint16(22)).toBe(0xffff);
	});

	it('sends black to zero', () => {
		const out = encodeFarbfeld(createRaster(1, 1, 'srgb', false));
		expect([...out.subarray(16, 22)]).toEqual([0, 0, 0, 0, 0, 0]);
	});
});

describe('farbfeld alpha', () => {
	it('writes the alpha channel through when the raster carries one', () => {
		const image = createRaster(2, 1, 'srgb', true);
		image.data.set([10, 20, 30, 0, 40, 50, 60, 128]);
		const out = encodeFarbfeld(image);

		expect([...out.subarray(22, 24)]).toEqual([0, 0]);
		expect([...out.subarray(30, 32)]).toEqual([128, 128]);
	});

	it('writes an opaque file when the raster declares no alpha, whatever its alpha bytes hold', () => {
		// `createRaster` zero fills, so an opaque raster arrives here with an
		// alpha channel of zero. Honouring it would write a fully transparent
		// image out of a picture that had nothing wrong with it.
		const image = createRaster(2, 1, 'srgb', false);
		image.data[0] = 200;
		image.data[4] = 100;
		expect(image.data[3]).toBe(0);

		const out = encodeFarbfeld(image);
		expect([...out.subarray(22, 24)]).toEqual([255, 255]);
		expect([...out.subarray(30, 32)]).toEqual([255, 255]);
		expect(decodeFarbfeld(out).hasAlpha).toBe(false);
	});

	it('reports alpha on decode only when a pixel is really translucent', () => {
		const opaque = file(2, 1, [1, 1, 2, 2, 3, 3, 255, 255, 4, 4, 5, 5, 6, 6, 255, 255]);
		const translucent = file(2, 1, [1, 1, 2, 2, 3, 3, 255, 255, 4, 4, 5, 5, 6, 6, 254, 254]);

		expect(decodeFarbfeld(opaque).hasAlpha).toBe(false);
		expect(decodeFarbfeld(translucent).hasAlpha).toBe(true);
	});
});

describe('farbfeld decoding', () => {
	it('narrows every sample by rounding a divide by 257', () => {
		const decoded = decodeFarbfeld(file(1, 1, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]));
		expect([...decoded.data]).toEqual([0x12, 0x56, 0x9a, 0xde]);
	});

	it('rounds the samples where the three plausible narrowings disagree', () => {
		// Each of these is a value where taking the high byte, truncating a
		// divide by 257 and rounding one give different answers, so this pins
		// which the reader uses rather than assuming. 0x00ff and 0x0081 are real
		// if faint greys that the high byte sends to nothing, and 0xff7e is a
		// level short of full that the high byte reads as full.
		// prettier-ignore
		const bytes = file(2, 1, [
			0x00, 0xff, 0x01, 0x00, 0x00, 0x81, 0xff, 0xff,
			0xff, 0x7e, 0x81, 0x7f, 0x80, 0x80, 0x80, 0x00,
		]);
		const decoded = decodeFarbfeld(bytes);

		expect([...decoded.data]).toEqual([1, 1, 1, 255, 254, 129, 128, 128]);
		// Written out so the difference is visible rather than something a
		// reader has to work out: this is what the high byte would have said.
		expect([...decoded.data]).not.toEqual([0, 1, 0, 255, 255, 129, 128, 128]);
	});

	it('keeps every narrowed sample inside 0 to 255', () => {
		const decoded = decodeFarbfeld(file(1, 1, [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]));
		expect([...decoded.data]).toEqual([255, 255, 0, 0]);
	});

	it('reads the dimensions from the header, big endian', () => {
		const decoded = decodeFarbfeld(file(2, 3, new Array(2 * 3 * 8).fill(255)));
		expect(decoded.width).toBe(2);
		expect(decoded.height).toBe(3);
		expect(decoded.data.length).toBe(2 * 3 * 4);
	});

	it('reads a file that is a view into the middle of a larger buffer', () => {
		// A DataView built over `bytes.buffer` without the offset would read the
		// padding as the header and report the wrong size.
		const source = file(1, 1, [0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44]);
		const padded = new Uint8Array(source.length + 9);
		padded.set(source, 5);

		const decoded = decodeFarbfeld(padded.subarray(5, 5 + source.length));
		expect(decoded.width).toBe(1);
		expect(decoded.height).toBe(1);
		expect([...decoded.data]).toEqual([0x11, 0x22, 0x33, 0x44]);
	});

	it('ignores bytes after the last pixel, as the reference tools do', () => {
		const complete = file(1, 1, [1, 1, 2, 2, 3, 3, 255, 255]);
		const withTail = new Uint8Array(complete.length + 4);
		withTail.set(complete, 0);
		withTail.set([0x0a, 0x0a, 0x0a, 0x0a], complete.length);

		expect([...decodeFarbfeld(withTail).data]).toEqual([1, 2, 3, 255]);
	});

	it('reports sRGB, because the format has nowhere to record a colour space', () => {
		expect(decodeFarbfeld(file(1, 1, new Array(8).fill(0))).colourSpace).toBe('srgb');
	});
});

describe('farbfeld decoding refuses damaged input', () => {
	it('refuses an empty file', () => {
		const error = decodeError(new Uint8Array(0));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('farbfeld');
		expect(error.decoderId).toBe('farbfeld-pure');
		expect(error.message).toContain('0 bytes');
	});

	it.each([1, 8, 12, 15])('refuses a file of only %i bytes', (length) => {
		const bytes = file(1, 1, new Array(8).fill(0)).subarray(0, length);
		expect(decodeError(bytes).message).toContain('the header alone is 16');
	});

	it('refuses a file whose magic bytes are wrong', () => {
		const bytes = file(1, 1, new Array(8).fill(0));
		bytes[7] = 0x44; // 'D' rather than 'd', which is the whole difference
		expect(decodeError(bytes).message).toContain('magic bytes');
	});

	it('refuses a PNG handed to it by mistake', () => {
		const png = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
		]);
		expect(decodeError(png).message).toContain('magic bytes');
	});

	it('refuses a file truncated by a single byte', () => {
		const complete = file(3, 2, new Array(3 * 2 * 8).fill(7));
		const error = decodeError(complete.subarray(0, complete.length - 1));
		expect(error.message).toContain('needs 48 bytes');
		expect(error.message).toContain('47');
	});

	it('refuses a header with no pixel data at all behind it', () => {
		expect(decodeError(file(4, 4, [])).message).toContain('4 by 4');
	});

	it.each([
		[0, 4],
		[4, 0],
		[0, 0],
	])('refuses a declared size of %i by %i', (width, height) => {
		const error = decodeError(file(width, height, new Array(64).fill(0)));
		expect(error.message).toContain('no width or no height');
	});

	it('refuses four billion pixels a side without trying to allocate them', () => {
		// The whole point of checking the length before the allocation: this file
		// is sixteen bytes and claims about 148 exabytes of pixel data.
		const bytes = file(0xffffffff, 0xffffffff, []);
		const started = performance.now();
		const error = decodeError(bytes);

		expect(error.message).toContain('4294967295 by 4294967295');
		// Refused rather than attempted. An allocation of that size does not
		// merely fail, it fails after the runtime has spent a while trying, so
		// the time is part of the assertion.
		expect(performance.now() - started).toBeLessThan(100);
	});

	it('writes a sentence rather than leaking undefined into the message', () => {
		for (const bytes of [new Uint8Array(0), new Uint8Array(20), file(9, 9, [])]) {
			const { message } = decodeError(bytes);
			expect(message).not.toContain('undefined');
			expect(message).not.toContain('NaN');
			expect(message.startsWith('That FARBFELD file could not be read: ')).toBe(true);
			expect(message.endsWith('.')).toBe(true);
		}
	});
});

const refusals: readonly [string, RasterImage][] = [
	['no width', raster(0, 4, 0)],
	['no height', raster(4, 0, 0)],
	['a negative width', raster(-4, 4, 64)],
	['a negative height', raster(4, -4, 64)],
	['a fractional width', raster(1.5, 4, 64)],
	['a fractional height', raster(4, 1.5, 64)],
	// NaN loses every comparison, so a guard written as `width < 1` would let
	// these through and reach `new Uint8Array(NaN)`, which is a zero length
	// buffer and a header of four zero bytes rather than an error.
	['a NaN width', raster(NaN, 4, 64)],
	['a NaN height', raster(4, NaN, 64)],
	['an infinite width', raster(Infinity, 4, 64)],
];

describe('farbfeld encoding refuses rasters it cannot write', () => {
	it.each(refusals)('refuses %s', (_label, image) => {
		const error = encodeError(image);
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.code).toBe('encode/failed');
		expect(error.format).toBe('farbfeld');
		expect(error.encoderId).toBe('farbfeld-pure');
		expect(error.message).toContain('no width or no height');
	});

	it('refuses a buffer shorter than the width and height claim', () => {
		// One pixel short: the encoder would otherwise read past the end and
		// write four undefined channels as zeroes.
		const error = encodeError(raster(4, 4, 4 * 4 * 4 - 1));
		expect(error.message).toContain('smaller than the width and height');
	});

	it('refuses a dimension the u32 header field cannot hold', () => {
		const error = encodeError(raster(0x100000000, 1, 0));
		expect(error.message).toContain('4294967295');
	});

	it('says which file could not be written, in a sentence', () => {
		const { message } = encodeError(raster(0, 0, 0));
		expect(message.startsWith('The FARBFELD could not be written: ')).toBe(true);
		expect(message.endsWith('.')).toBe(true);
		expect(message).not.toContain('undefined');
	});
});

describe('farbfeld round trips', () => {
	it.each([
		[1, 1],
		[1, 7],
		[7, 1],
		[3, 3],
		[7, 5],
		[5, 7],
		[17, 13],
		[33, 2],
	])('returns the same pixels for %i by %i with alpha', (width, height) => {
		const image = pattern(width, height, true);
		const decoded = decodeFarbfeld(encodeFarbfeld(image));

		expect(decoded.width).toBe(width);
		expect(decoded.height).toBe(height);
		expect(decoded.hasAlpha).toBe(true);
		expect(decoded.data).toEqual(image.data);
	});

	it.each([
		[1, 1],
		[1, 9],
		[9, 1],
		[7, 5],
		[13, 17],
	])('returns the same pixels for %i by %i without alpha', (width, height) => {
		const image = pattern(width, height, false);
		const decoded = decodeFarbfeld(encodeFarbfeld(image));

		expect(decoded.width).toBe(width);
		expect(decoded.height).toBe(height);
		expect(decoded.hasAlpha).toBe(false);
		expect(decoded.data).toEqual(image.data);
	});

	it('keeps every one of the 256 byte values in every channel', () => {
		const image = createRaster(256, 1, 'srgb', true);
		for (let value = 0; value < 256; value += 1) {
			image.data.set([value, 255 - value, (value * 7) & 0xff, value], value * 4);
		}
		expect(decodeFarbfeld(encodeFarbfeld(image)).data).toEqual(image.data);
	});

	it('keeps a fully transparent pixel next to an opaque one', () => {
		const image = createRaster(2, 1, 'srgb', true);
		image.data.set([200, 100, 50, 0, 200, 100, 50, 255]);
		const decoded = decodeFarbfeld(encodeFarbfeld(image));

		expect([...decoded.data]).toEqual([200, 100, 50, 0, 200, 100, 50, 255]);
		expect(decoded.hasAlpha).toBe(true);
	});

	it('survives a second trip through the format unchanged', () => {
		const image = pattern(9, 4, true);
		const once = encodeFarbfeld(image);
		const twice = encodeFarbfeld(decodeFarbfeld(once));
		expect(twice).toEqual(once);
	});

	it('keeps the numbers of a Display P3 raster but returns them as sRGB', () => {
		// Documented loss, not an oversight: farbfeld has no colour space tag, so
		// a wide gamut image survives as numbers and loses what they meant.
		const image = pattern(4, 3, true, 'display-p3');
		const decoded = decodeFarbfeld(encodeFarbfeld(image));

		expect(decoded.data).toEqual(image.data);
		expect(decoded.colourSpace).toBe('srgb');
	});
});

describe('farbfeld encode options', () => {
	it('writes the same bytes whatever quality, background or profile it is given', () => {
		const image = pattern(5, 3, true);
		const plain = encodeFarbfeld(image);

		expect(encodeFarbfeld(image, {})).toEqual(plain);
		expect(encodeFarbfeld(image, { quality: 0.1 })).toEqual(plain);
		expect(encodeFarbfeld(image, { background: [0, 0, 0] })).toEqual(plain);
		expect(encodeFarbfeld(image, { iccProfile: new Uint8Array([1, 2, 3]) })).toEqual(plain);
	});

	it('does not composite a translucent pixel onto the background', () => {
		// The rule about flattening is for formats with no alpha channel.
		// farbfeld has one in every file, so a background here would destroy
		// information the format can carry.
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([10, 20, 30, 0]);
		const decoded = decodeFarbfeld(encodeFarbfeld(image, { background: [255, 255, 255] }));

		expect([...decoded.data]).toEqual([10, 20, 30, 0]);
	});
});

/**
 * A round trip through this package's own encoder and decoder proves only that
 * the two agree with each other, which they would even if both had the width
 * and height the wrong way round. These two fixtures come from somewhere else:
 * ImageMagick 7 wrote `REFERENCE_FILE` from the raw RGBA in
 * `REFERENCE_PIXELS`, and read the same eight bit values back out of it.
 *
 *     magick -size 3x2 -depth 8 rgba:in.raw ff:out.ff
 */
// prettier-ignore
const REFERENCE_PIXELS = [
	0x12, 0x34, 0x56, 0xff,
	0x00, 0x80, 0xff, 0x80,
	0xff, 0xff, 0xff, 0x00,
	0x01, 0x02, 0x03, 0x04,
	0xfe, 0x00, 0x7f, 0xc0,
	0x00, 0x00, 0x00, 0xff,
];

// prettier-ignore
const REFERENCE_FILE = [
	0x66, 0x61, 0x72, 0x62, 0x66, 0x65, 0x6c, 0x64,
	0x00, 0x00, 0x00, 0x03,
	0x00, 0x00, 0x00, 0x02,
	0x12, 0x12, 0x34, 0x34, 0x56, 0x56, 0xff, 0xff,
	0x00, 0x00, 0x80, 0x80, 0xff, 0xff, 0x80, 0x80,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00,
	0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x04, 0x04,
	0xfe, 0xfe, 0x00, 0x00, 0x7f, 0x7f, 0xc0, 0xc0,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
];

describe('farbfeld against a file another implementation wrote', () => {
	it('writes the same bytes ImageMagick writes for the same pixels', () => {
		const image = createRaster(3, 2, 'srgb', true);
		image.data.set(REFERENCE_PIXELS);

		expect([...encodeFarbfeld(image)]).toEqual(REFERENCE_FILE);
	});

	it('reads the same pixels ImageMagick reads out of that file', () => {
		const decoded = decodeFarbfeld(Uint8Array.from(REFERENCE_FILE));

		expect(decoded.width).toBe(3);
		expect(decoded.height).toBe(2);
		expect([...decoded.data]).toEqual(REFERENCE_PIXELS);
		expect(decoded.hasAlpha).toBe(true);
	});
});
