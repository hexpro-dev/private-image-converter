/**
 * QOI codec tests.
 *
 * The chunk expectations here are worked out from the specification by hand and
 * written as literal bytes, not captured from a run of the encoder. A test that
 * records whatever the code produced only proves the code is deterministic.
 */

import { describe, expect, it } from 'vitest';
import { decodeQoi } from '../../src/codecs/qoi/decode.js';
import { encodeQoi } from '../../src/codecs/qoi/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

const MAGIC = [0x71, 0x6f, 0x69, 0x66];
const END_MARKER = [0, 0, 0, 0, 0, 0, 0, 1];

/** Build a raster from a flat list of RGBA quadruples. */
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

/** A deterministic pattern with enough variety to hit every chunk type. */
function noise(width: number, height: number, hasAlpha: boolean): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	let state = 0x2545f491;
	for (let i = 0; i < width * height; i += 1) {
		// A small xorshift, so the same pixels appear on every machine.
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		const at = i * 4;
		// Run every value through a small range as well as a wide one, so runs,
		// index hits and full colour chunks all occur.
		image.data[at] = state & 0xff;
		image.data[at + 1] = (state >>> 8) & 0x0f;
		image.data[at + 2] = (state >>> 16) & 0xff;
		image.data[at + 3] = hasAlpha ? ((state >>> 24) & 0x03) * 85 : 255;
	}
	return image;
}

function header(bytes: Uint8Array): number[] {
	return [...bytes.subarray(0, 14)];
}

function chunks(bytes: Uint8Array): number[] {
	return [...bytes.subarray(14, bytes.length - 8)];
}

function file(parts: {
	width: number;
	height: number;
	channels: number;
	colourSpace: number;
	body: readonly number[];
	marker?: readonly number[];
}): Uint8Array {
	const { width, height, channels, colourSpace, body, marker = END_MARKER } = parts;
	return Uint8Array.from([
		...MAGIC,
		(width >>> 24) & 0xff,
		(width >>> 16) & 0xff,
		(width >>> 8) & 0xff,
		width & 0xff,
		(height >>> 24) & 0xff,
		(height >>> 16) & 0xff,
		(height >>> 8) & 0xff,
		height & 0xff,
		channels,
		colourSpace,
		...body,
		...marker,
	]);
}

describe('the QOI header', () => {
	it('writes the magic, the dimensions big endian, three channels and sRGB', () => {
		const encoded = encodeQoi(raster(3, 5, []));
		expect(header(encoded)).toEqual([...MAGIC, 0, 0, 0, 3, 0, 0, 0, 5, 3, 0]);
	});

	it('writes four channels when the raster carries alpha', () => {
		const image = raster(1, 1, [1, 2, 3, 4], true);
		expect(header(encodeQoi(image))[12]).toBe(4);
	});

	it('writes a dimension above 65535 across all four bytes', () => {
		const encoded = encodeQoi(createRaster(66000, 3));
		expect(header(encoded).slice(4, 12)).toEqual([0, 1, 0x01, 0xd0, 0, 0, 0, 3]);
	});

	it('tags a Display P3 raster sRGB, because QOI cannot say Display P3', () => {
		const image = createRaster(2, 2, 'display-p3');
		expect(header(encodeQoi(image))[13]).toBe(0);
		expect(decodeQoi(encodeQoi(image)).colourSpace).toBe('srgb');
	});

	it('ends the stream with seven zero bytes and a one', () => {
		const encoded = encodeQoi(raster(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]));
		expect([...encoded.subarray(encoded.length - 8)]).toEqual(END_MARKER);
	});
});

describe('the QOI chunk stream', () => {
	it('writes a difference chunk, a run and a wrapped difference', () => {
		// Red, red, red, blue. Red is one below black on the red channel once the
		// difference wraps, which is a two bit chunk rather than four bytes.
		const image = raster(2, 2, [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
		expect(chunks(encodeQoi(image))).toEqual([0x5a, 0xc1, 0x79]);
	});

	it('writes luma, full colour, index, alpha and run chunks', () => {
		const image = raster(
			6,
			1,
			[
				10, 10, 10, 255, 200, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 128, 10, 10, 10, 128, 10,
				10, 10, 128,
			],
			true,
		);
		expect(chunks(encodeQoi(image))).toEqual([
			0xaa, 0x88, 0xfe, 0xc8, 0x0a, 0x0a, 0x0b, 0xff, 0x0a, 0x0a, 0x0a, 0x80, 0xc1,
		]);
	});

	it('splits a long run at 62 and never writes the two forbidden run counts', () => {
		// Black at full alpha is the pixel the stream starts from, so all 130 are
		// a run: 62, 62, then 6.
		const image = createRaster(130, 1);
		for (let i = 0; i < 130; i += 1) image.data[i * 4 + 3] = 255;
		const body = chunks(encodeQoi(image));
		expect(body).toEqual([0xfd, 0xfd, 0xc5]);
		expect(body).not.toContain(0xfe);
		expect(body).not.toContain(0xff);
	});

	it('decodes a hand written stream to the pixels the specification implies', () => {
		const decoded = decodeQoi(
			file({ width: 2, height: 2, channels: 3, colourSpace: 0, body: [0x5a, 0xc1, 0x79] }),
		);
		expect([...decoded.data]).toEqual([
			255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
		]);
	});
});

/**
 * Files produced by ffmpeg's QOI encoder, which shares no code with this one.
 *
 * A round trip through this package's own encoder and decoder would pass even
 * if both agreed on the wrong format, so these two files are the ones that
 * decide whether what is written here is QOI. Both were captured from
 * `ffmpeg -c:v qoi` over known pixels and pasted in as literal bytes.
 */
describe('QOI against files written by ffmpeg', () => {
	/** 11 by 4, four channels, 77 bytes. Every one of the six chunk kinds appears. */
	const RGBA_FILE = Uint8Array.from([
		0x71, 0x6f, 0x69, 0x66, 0x00, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x04, 0x04, 0x00, 0xfe, 0x1e,
		0x3c, 0x5a, 0xc5, 0x6b, 0xc2, 0x56, 0xa2, 0x77, 0x75, 0x47, 0xa2, 0x75, 0x77, 0x30, 0x04, 0x3b,
		0x37, 0x3d, 0xa9, 0x98, 0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88,
		0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88, 0xa9, 0x88, 0xfe, 0x1e, 0x3c, 0x5a, 0xc2, 0xff, 0x28, 0x46,
		0x64, 0x80, 0xc1, 0x31, 0xc2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
	]);

	/** The 44 pixels ffmpeg was handed, straight RGBA. */
	const RGBA_PIXELS = [
		0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff,
		0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5b, 0xff,
		0x1e, 0x3c, 0x5b, 0xff, 0x1e, 0x3c, 0x5b, 0xff, 0x1e, 0x3c, 0x5b, 0xff, 0x1d, 0x3b, 0x5b, 0xff,
		0x1e, 0x3d, 0x5c, 0xff, 0x1f, 0x3c, 0x5b, 0xff, 0x1d, 0x3b, 0x5c, 0xff, 0x1e, 0x3d, 0x5b, 0xff,
		0x1f, 0x3c, 0x5c, 0xff, 0x1d, 0x3b, 0x5b, 0xff, 0x1e, 0x3d, 0x5c, 0xff, 0x1f, 0x3c, 0x5b, 0xff,
		0x1d, 0x3b, 0x5c, 0xff, 0x1e, 0x3d, 0x5b, 0xff, 0x28, 0x46, 0x64, 0xff, 0x31, 0x4f, 0x6d, 0xff,
		0x3a, 0x58, 0x76, 0xff, 0x43, 0x61, 0x7f, 0xff, 0x4c, 0x6a, 0x88, 0xff, 0x55, 0x73, 0x91, 0xff,
		0x5e, 0x7c, 0x9a, 0xff, 0x67, 0x85, 0xa3, 0xff, 0x70, 0x8e, 0xac, 0xff, 0x79, 0x97, 0xb5, 0xff,
		0x82, 0xa0, 0xbe, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff,
		0x1e, 0x3c, 0x5a, 0xff, 0x28, 0x46, 0x64, 0x80, 0x28, 0x46, 0x64, 0x80, 0x28, 0x46, 0x64, 0x80,
		0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff, 0x1e, 0x3c, 0x5a, 0xff,
	];

	/** 9 by 3, three channels, 48 bytes. Its red channel runs past 255 and wraps. */
	const RGB_FILE = Uint8Array.from([
		0x71, 0x6f, 0x69, 0x66, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00, 0xfe, 0xc8,
		0x0a, 0x0a, 0xc3, 0x7f, 0xc2, 0x05, 0xa7, 0x88, 0xa7, 0x88, 0xa7, 0x88, 0xa7, 0x88, 0xa7, 0x88,
		0xa7, 0x88, 0xa7, 0x88, 0xa7, 0x88, 0x05, 0xc7, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
	]);

	/** The 27 pixels ffmpeg was handed, three bytes each. */
	const RGB_PIXELS = [
		0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc9,
		0x0b, 0x0b, 0xc9, 0x0b, 0x0b, 0xc9, 0x0b, 0x0b, 0xc9, 0x0b, 0x0b, 0xc8, 0x0a, 0x0a, 0xcf, 0x11,
		0x11, 0xd6, 0x18, 0x18, 0xdd, 0x1f, 0x1f, 0xe4, 0x26, 0x26, 0xeb, 0x2d, 0x2d, 0xf2, 0x34, 0x34,
		0xf9, 0x3b, 0x3b, 0x00, 0x42, 0x42, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8,
		0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a, 0x0a, 0xc8, 0x0a,
		0x0a,
	];

	/** Count each chunk kind, so a fixture cannot quietly stop covering them. */
	function chunkKinds(bytes: Uint8Array): Record<string, number> {
		const counts: Record<string, number> = {};
		let at = 14;
		const end = bytes.length - 8;
		while (at < end) {
			const op = bytes[at] as number;
			let kind: string;
			let length: number;
			if (op === 0xfe) [kind, length] = ['rgb', 4];
			else if (op === 0xff) [kind, length] = ['rgba', 5];
			else if ((op & 0xc0) === 0x00) [kind, length] = ['index', 1];
			else if ((op & 0xc0) === 0x40) [kind, length] = ['diff', 1];
			else if ((op & 0xc0) === 0x80) [kind, length] = ['luma', 2];
			else [kind, length] = ['run', 1];
			counts[kind] = (counts[kind] ?? 0) + 1;
			at += length;
		}
		return counts;
	}

	it('covers every chunk kind between the two fixtures', () => {
		const rgba = chunkKinds(RGBA_FILE);
		for (const kind of ['rgb', 'rgba', 'index', 'diff', 'luma', 'run']) {
			expect(rgba[kind], `${kind} chunks in the four channel fixture`).toBeGreaterThan(0);
		}
		// A three channel file must never carry an alpha chunk.
		expect(chunkKinds(RGB_FILE).rgba).toBeUndefined();
	});

	it('decodes a four channel ffmpeg file to the exact pixels ffmpeg was given', () => {
		const decoded = decodeQoi(RGBA_FILE);
		expect(decoded.width).toBe(11);
		expect(decoded.height).toBe(4);
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual(RGBA_PIXELS);
	});

	it('re-encodes those pixels to the same bytes ffmpeg wrote', () => {
		const image = raster(11, 4, RGBA_PIXELS, true);
		expect([...encodeQoi(image)]).toEqual([...RGBA_FILE]);
	});

	it('decodes a three channel ffmpeg file to opaque pixels', () => {
		const decoded = decodeQoi(RGB_FILE);
		expect(decoded.width).toBe(9);
		expect(decoded.height).toBe(3);
		expect(decoded.hasAlpha).toBe(false);
		const expected: number[] = [];
		for (let i = 0; i < 27; i += 1) {
			expected.push(
				RGB_PIXELS[i * 3] as number,
				RGB_PIXELS[i * 3 + 1] as number,
				RGB_PIXELS[i * 3 + 2] as number,
				255,
			);
		}
		expect([...decoded.data]).toEqual(expected);
	});

	it('re-encodes those pixels to the same bytes ffmpeg wrote', () => {
		const image = createRaster(9, 3, 'srgb', false);
		for (let i = 0; i < 27; i += 1) {
			image.data[i * 4] = RGB_PIXELS[i * 3] as number;
			image.data[i * 4 + 1] = RGB_PIXELS[i * 3 + 1] as number;
			image.data[i * 4 + 2] = RGB_PIXELS[i * 3 + 2] as number;
			image.data[i * 4 + 3] = 255;
		}
		expect([...encodeQoi(image)]).toEqual([...RGB_FILE]);
	});
});

/**
 * Three channels means opaque, and nothing in the chunk stream can change that.
 *
 * The running alpha still has to be tracked, because an RGBA chunk and the
 * index table have to stay in step with whatever wrote the file, but it never
 * reaches the raster. Both expectations below were confirmed against ffmpeg.
 */
describe('QOI three channel alpha', () => {
	it('hands back opaque pixels for a colour chunk that carries alpha', () => {
		const decoded = decodeQoi(
			file({
				width: 2,
				height: 1,
				channels: 3,
				colourSpace: 0,
				body: [0xff, 10, 20, 30, 40, 0xfe, 1, 2, 3],
			}),
		);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([10, 20, 30, 255, 1, 2, 3, 255]);
	});

	it('still tracks that alpha through the index table', () => {
		// hash(10, 20, 30, 40) is 12, and hash(10, 20, 30, 255) is 9. An index
		// chunk for slot 12 therefore only finds that colour if the alpha of 40
		// was carried into the table, which is what the reference decoder does.
		const decoded = decodeQoi(
			file({
				width: 3,
				height: 1,
				channels: 3,
				colourSpace: 0,
				body: [0xff, 10, 20, 30, 40, 0xfe, 1, 2, 3, 0x0c],
			}),
		);
		expect([...decoded.data]).toEqual([10, 20, 30, 255, 1, 2, 3, 255, 10, 20, 30, 255]);
	});

	it('hands back opaque pixels for an index into a slot nothing has written', () => {
		// The table starts as 64 entries of rgba(0, 0, 0, 0). Reading one of them
		// out into a three channel image must not produce a transparent pixel in
		// a file whose header says it has no alpha channel at all.
		const decoded = decodeQoi(
			file({ width: 2, height: 1, channels: 3, colourSpace: 0, body: [0x01, 0x01] }),
		);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
	});

	it('keeps a cold index translucent in a four channel file, as the reference does', () => {
		const decoded = decodeQoi(
			file({ width: 2, height: 1, channels: 4, colourSpace: 0, body: [0x01, 0x01] }),
		);
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

describe('QOI round trips', () => {
	const sizes: readonly [number, number][] = [
		[1, 1],
		[1, 7],
		[7, 1],
		[3, 5],
		[5, 3],
		[17, 13],
		[64, 65],
	];

	for (const [width, height] of sizes) {
		it(`is lossless at ${width} by ${height} without alpha`, () => {
			const image = noise(width, height, false);
			const decoded = decodeQoi(encodeQoi(image));
			expect(decoded.width).toBe(width);
			expect(decoded.height).toBe(height);
			expect(decoded.hasAlpha).toBe(false);
			expect([...decoded.data]).toEqual([...image.data]);
		});

		it(`is lossless at ${width} by ${height} with alpha`, () => {
			const image = noise(width, height, true);
			const decoded = decodeQoi(encodeQoi(image));
			expect(decoded.hasAlpha).toBe(true);
			expect([...decoded.data]).toEqual([...image.data]);
		});
	}

	it('keeps a single pixel exactly', () => {
		const image = raster(1, 1, [12, 34, 56, 78], true);
		expect([...decodeQoi(encodeQoi(image)).data]).toEqual([12, 34, 56, 78]);
	});

	it('keeps every colour of a full 256 step gradient', () => {
		const image = createRaster(256, 3);
		for (let y = 0; y < 3; y += 1) {
			for (let x = 0; x < 256; x += 1) {
				const at = (y * 256 + x) * 4;
				image.data[at] = x;
				image.data[at + 1] = (x * 3) & 0xff;
				image.data[at + 2] = 255 - x;
				image.data[at + 3] = 255;
			}
		}
		expect([...decodeQoi(encodeQoi(image)).data]).toEqual([...image.data]);
	});

	it('reports no alpha for a four channel file that turns out to be opaque', () => {
		const image = createRaster(4, 3, 'srgb', true);
		for (let i = 0; i < 12; i += 1) {
			image.data[i * 4] = i * 7;
			image.data[i * 4 + 3] = 255;
		}
		const encoded = encodeQoi(image);
		expect(header(encoded)[12]).toBe(4);
		const decoded = decodeQoi(encoded);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([...image.data]);
	});

	it('treats a raster that declares itself opaque as opaque, whatever its alpha bytes say', () => {
		// Straight from createRaster: every byte is zero, including alpha, and the
		// raster says it has none. Honouring those zeroes would write an entirely
		// transparent image instead of a black one.
		const image = createRaster(3, 2);
		const decoded = decodeQoi(encodeQoi(image));
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data.slice(0, 8)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
	});

	it('carries fully transparent and partly transparent pixels', () => {
		const image = raster(2, 2, [1, 2, 3, 0, 1, 2, 3, 0, 9, 9, 9, 1, 4, 5, 6, 254], true);
		const decoded = decodeQoi(encodeQoi(image));
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual([1, 2, 3, 0, 1, 2, 3, 0, 9, 9, 9, 1, 4, 5, 6, 254]);
	});
});

describe('QOI decoding of damaged files', () => {
	function expectRefusal(bytes: Uint8Array): DecodeFailedError {
		let thrown: unknown;
		try {
			decodeQoi(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('qoi');
		expect(error.decoderId).toBe('qoi-pure');
		expect(error.message.length).toBeGreaterThan(20);
		return error;
	}

	const valid = encodeQoi(noise(9, 7, true));

	it('refuses an empty file', () => {
		expectRefusal(new Uint8Array(0));
	});

	it('refuses a file shorter than a header and an end marker', () => {
		expectRefusal(valid.subarray(0, 21));
	});

	it('refuses a file that does not begin with the signature', () => {
		const bytes = Uint8Array.from(valid);
		bytes[1] = 0x6e;
		expectRefusal(bytes);
	});

	it('refuses a channel count that is not 3 or 4', () => {
		for (const channels of [0, 1, 2, 5, 255]) {
			expectRefusal(file({ width: 1, height: 1, channels, colourSpace: 0, body: [0xfe, 1, 2, 3] }));
		}
	});

	it('refuses an unknown colour space value', () => {
		expectRefusal(
			file({ width: 1, height: 1, channels: 3, colourSpace: 2, body: [0xfe, 1, 2, 3] }),
		);
	});

	it('refuses a zero width or a zero height', () => {
		expectRefusal(file({ width: 0, height: 4, channels: 3, colourSpace: 0, body: [0xff] }));
		expectRefusal(file({ width: 4, height: 0, channels: 3, colourSpace: 0, body: [0xff] }));
	});

	it('refuses a file whose end marker is missing', () => {
		const bytes = Uint8Array.from(valid);
		bytes[bytes.length - 1] = 0;
		expectRefusal(bytes);
	});

	it('refuses a file with bytes appended after the end marker', () => {
		expectRefusal(Uint8Array.from([...valid, 0]));
	});

	it('refuses a file truncated in the middle of the chunk stream', () => {
		const cut = 14 + Math.floor((valid.length - 22) / 2);
		expectRefusal(Uint8Array.from([...valid.subarray(0, cut), ...END_MARKER]));
	});

	it('refuses a colour chunk that runs off the end', () => {
		expectRefusal(file({ width: 1, height: 1, channels: 3, colourSpace: 0, body: [0xfe, 1] }));
		expectRefusal(
			file({ width: 1, height: 1, channels: 4, colourSpace: 0, body: [0xff, 1, 2, 3] }),
		);
	});

	it('refuses a luma chunk missing its second byte', () => {
		expectRefusal(file({ width: 1, height: 1, channels: 3, colourSpace: 0, body: [0xaa] }));
	});

	it('refuses a run that claims more pixels than the image holds', () => {
		expectRefusal(file({ width: 1, height: 1, channels: 3, colourSpace: 0, body: [0xc5] }));
	});

	it('refuses chunks left over after the last pixel', () => {
		expectRefusal(file({ width: 1, height: 1, channels: 3, colourSpace: 0, body: [0x5a, 0x5a] }));
	});

	it('refuses a header that describes more pixels than the stream could hold', () => {
		expectRefusal(file({ width: 1000, height: 1000, channels: 3, colourSpace: 0, body: [0x5a] }));
	});

	it('refuses a header describing an image too large to allocate for', () => {
		expectRefusal(
			file({ width: 0xffff, height: 0xffff, channels: 4, colourSpace: 0, body: [0x5a] }),
		);
	});

	it('reads a file that sits inside a larger buffer', () => {
		const padded = new Uint8Array(valid.length + 32);
		padded.set(valid, 16);
		const decoded = decodeQoi(padded.subarray(16, 16 + valid.length));
		expect(decoded.width).toBe(9);
		expect(decoded.height).toBe(7);
	});
});

describe('QOI encoding refusals', () => {
	it('refuses a raster with no pixels', () => {
		expect(() => encodeQoi(createRaster(0, 4))).toThrow(EncodeFailedError);
		expect(() => encodeQoi(createRaster(4, 0))).toThrow(EncodeFailedError);
	});

	it('refuses a buffer smaller than the dimensions claim', () => {
		const broken: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		let thrown: unknown;
		try {
			encodeQoi(broken);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EncodeFailedError);
		expect((thrown as EncodeFailedError).code).toBe('encode/failed');
		expect((thrown as EncodeFailedError).encoderId).toBe('qoi-pure');
	});

	it('returns a buffer sized to the file, not to the worst case', () => {
		const encoded = encodeQoi(createRaster(200, 200));
		expect(encoded.byteLength).toBe(encoded.buffer.byteLength);
		expect(encoded.byteLength).toBeLessThan(200 * 200);
	});
});
