import { describe, expect, it } from 'vitest';

import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { decodePnm } from '../../src/codecs/pnm/decode.js';
import { encodePnm } from '../../src/codecs/pnm/encode.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

function ascii(text: string): Uint8Array {
	return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** Build a file out of literal header text and literal data bytes. */
function file(...parts: (string | number[] | Uint8Array)[]): Uint8Array {
	const pieces = parts.map((part) =>
		typeof part === 'string'
			? ascii(part)
			: part instanceof Uint8Array
				? part
				: Uint8Array.from(part),
	);
	let total = 0;
	for (const piece of pieces) total += piece.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const piece of pieces) {
		out.set(piece, at);
		at += piece.length;
	}
	return out;
}

/** A deterministic pattern that differs in all three channels and per row. */
function pattern(width: number, height: number, hasAlpha = false): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			image.data[at] = (x * 37 + y * 11) & 0xff;
			image.data[at + 1] = (x * 5 + y * 91) & 0xff;
			image.data[at + 2] = (x * 211 + y * 3) & 0xff;
			image.data[at + 3] = 255;
		}
	}
	return image;
}

function pixel(image: RasterImage, x: number, y: number): number[] {
	const at = (y * image.width + x) * 4;
	return Array.from(image.data.subarray(at, at + 4));
}

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodePnm', () => {
	it('writes the exact P6 header the specification describes', () => {
		const image = createRaster(2, 1);
		image.data.set([255, 0, 0, 255, 1, 2, 3, 255]);

		expect(Array.from(encodePnm(image))).toEqual([
			0x50, // 'P'
			0x36, // '6'
			0x0a,
			0x32, // '2', the width
			0x20,
			0x31, // '1', the height
			0x0a,
			0x32, // '2'
			0x35, // '5'
			0x35, // '5', the maximum sample value
			0x0a, // the single whitespace byte that ends the header
			255,
			0,
			0,
			1,
			2,
			3,
		]);
	});

	it('writes a 1 by 1 image', () => {
		const image = createRaster(1, 1);
		image.data.set([9, 8, 7, 255]);
		const encoded = encodePnm(image);
		expect(Array.from(encoded.subarray(0, 11))).toEqual(Array.from(ascii('P6\n1 1\n255\n')));
		expect(Array.from(encoded.subarray(11))).toEqual([9, 8, 7]);
		expect(encoded.length).toBe(14);
	});

	it('writes three bytes per pixel and no padding for an odd width', () => {
		const encoded = encodePnm(pattern(3, 5));
		expect(encoded.length).toBe(ascii('P6\n3 5\n255\n').length + 3 * 5 * 3);
	});

	it('refuses an image with no pixels', () => {
		expect(() => encodePnm(createRaster(0, 4))).toThrow(EncodeFailedError);
		expect(() => encodePnm(createRaster(4, 0))).toThrow(EncodeFailedError);
	});

	it('refuses a raster whose buffer is shorter than its dimensions', () => {
		// The header is written from the width and the height. Writing this one
		// anyway produces a file whose last two rows are black, which reads as a
		// damaged photograph rather than as a caller's bug.
		const short: RasterImage = {
			data: new Uint8ClampedArray(4 * 4),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodePnm(short)).toThrow(EncodeFailedError);
	});

	it('composites translucent pixels onto white by default', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([0, 0, 255, 128]);
		const decoded = decodePnm(encodePnm(image));
		expect(pixel(decoded, 0, 0)).toEqual([127, 127, 255, 255]);
	});

	it('composites onto the background it is given', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([0, 0, 255, 128]);
		const decoded = decodePnm(encodePnm(image, { background: [0, 0, 0] }));
		expect(pixel(decoded, 0, 0)).toEqual([0, 0, 128, 255]);
	});

	it('drops a fully transparent pixel to the background', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([12, 34, 56, 0]);
		const decoded = decodePnm(encodePnm(image, { background: [10, 20, 30] }));
		expect(pixel(decoded, 0, 0)).toEqual([10, 20, 30, 255]);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('P6 round trip', () => {
	// Odd sizes on both axes, and both single row and single column, because a
	// stride bug is invisible when every dimension is a multiple of anything.
	for (const [width, height] of [
		[1, 1],
		[3, 5],
		[7, 1],
		[1, 7],
		[9, 9],
		[13, 2],
	] as const) {
		it(`preserves every pixel of a ${width} by ${height} image`, () => {
			const source = pattern(width, height);
			const decoded = decodePnm(encodePnm(source));
			expect(decoded.width).toBe(width);
			expect(decoded.height).toBe(height);
			expect(decoded.hasAlpha).toBe(false);
			expect(decoded.colourSpace).toBe('srgb');
			expect(Array.from(decoded.data)).toEqual(Array.from(source.data));
		});
	}
});

/* ── Decoding, one test per member of the family ──────────────────────── */

describe('decodePnm P1', () => {
	it('reads a set bit as black, which is the reverse of the rest of the family', () => {
		const image = decodePnm(file('P1\n3 2\n', '101\n010\n'));
		expect(pixel(image, 0, 0)).toEqual(BLACK);
		expect(pixel(image, 1, 0)).toEqual(WHITE);
		expect(pixel(image, 2, 0)).toEqual(BLACK);
		expect(pixel(image, 0, 1)).toEqual(WHITE);
		expect(pixel(image, 1, 1)).toEqual(BLACK);
		expect(pixel(image, 2, 1)).toEqual(WHITE);
	});

	it('reads samples with no whitespace between them', () => {
		const image = decodePnm(file('P1\n2 2\n1100'));
		expect(pixel(image, 0, 0)).toEqual(BLACK);
		expect(pixel(image, 1, 0)).toEqual(BLACK);
		expect(pixel(image, 0, 1)).toEqual(WHITE);
		expect(pixel(image, 1, 1)).toEqual(WHITE);
	});

	it('rejects a character that is neither 0 nor 1', () => {
		expect(() => decodePnm(file('P1\n2 1\n1 2'))).toThrow(DecodeFailedError);
	});
});

describe('decodePnm P2', () => {
	it('scales samples from the maximum the header gives', () => {
		const image = decodePnm(file('P2\n3 1\n15\n0 5 15\n'));
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([85, 85, 85, 255]);
		expect(pixel(image, 2, 0)).toEqual([255, 255, 255, 255]);
	});

	it('spreads a grey sample across all three channels', () => {
		const image = decodePnm(file('P2\n1 1\n255\n200'));
		expect(pixel(image, 0, 0)).toEqual([200, 200, 200, 255]);
	});
});

describe('decodePnm P3', () => {
	it('reads RGB triples', () => {
		const image = decodePnm(file('P3\n2 1\n255\n255 0 0  0 128 255\n'));
		expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([0, 128, 255, 255]);
	});

	it('scales a 16 bit maximum down to 8 bits', () => {
		const image = decodePnm(file('P3\n1 1\n65535\n65535 32768 0'));
		expect(pixel(image, 0, 0)).toEqual([255, 128, 0, 255]);
	});
});

describe('decodePnm P4', () => {
	it('packs eight pixels to a byte, most significant bit leftmost', () => {
		const image = decodePnm(file('P4\n8 1\n', [0b10000001]));
		expect(pixel(image, 0, 0)).toEqual(BLACK);
		expect(pixel(image, 1, 0)).toEqual(WHITE);
		expect(pixel(image, 6, 0)).toEqual(WHITE);
		expect(pixel(image, 7, 0)).toEqual(BLACK);
	});

	it('ignores the padding bits at the end of a row of odd width', () => {
		// Every padding bit is set, and a reader that counts pixels rather than
		// bits would report five extra black pixels per row.
		const image = decodePnm(file('P4\n3 2\n', [0b10111111, 0b01011111]));
		expect(pixel(image, 0, 0)).toEqual(BLACK);
		expect(pixel(image, 1, 0)).toEqual(WHITE);
		expect(pixel(image, 2, 0)).toEqual(BLACK);
		expect(pixel(image, 0, 1)).toEqual(WHITE);
		expect(pixel(image, 1, 1)).toEqual(BLACK);
		expect(pixel(image, 2, 1)).toEqual(WHITE);
	});

	it('starts each row on a byte boundary when the width crosses one', () => {
		// Nine pixels wide, so two bytes a row and the ninth pixel is the top bit
		// of the second byte.
		const image = decodePnm(file('P4\n9 2\n', [0b00000000, 0b10000000, 0b11111111, 0b00000000]));
		expect(pixel(image, 0, 0)).toEqual(WHITE);
		expect(pixel(image, 8, 0)).toEqual(BLACK);
		expect(pixel(image, 0, 1)).toEqual(BLACK);
		expect(pixel(image, 8, 1)).toEqual(WHITE);
	});

	it('reports a truncated final row rather than reading past the end', () => {
		expect(() => decodePnm(file('P4\n9 2\n', [0x00, 0x80, 0xff]))).toThrow(DecodeFailedError);
	});

	it('refuses a width in the range where a shifted row length would go negative', () => {
		// A row of this many pixels is 268435456 bytes. Computed with `>>` the
		// arithmetic wraps through a signed 32 bit integer and comes out
		// negative, the room check then passes, and this twelve byte file gets an
		// eight gigabyte buffer and a two billion pixel image made of nothing.
		for (const width of [2147483647, 2147483644, 2147483641]) {
			expect(() => decodePnm(file(`P4\n${width} 1\n`, [0x00]))).toThrow(DecodeFailedError);
		}
	});
});

describe('decodePnm P5', () => {
	it('reads one byte per pixel', () => {
		const image = decodePnm(file('P5\n2 1\n255\n', [0, 200]));
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([200, 200, 200, 255]);
	});

	it('reads two big endian bytes per pixel when the maximum is above 255', () => {
		const image = decodePnm(file('P5\n2 1\n65535\n', [0xff, 0xff, 0x80, 0x00]));
		expect(pixel(image, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(pixel(image, 1, 0)).toEqual([128, 128, 128, 255]);
	});

	it('treats a second whitespace byte after the header as pixel data', () => {
		// The header ends after exactly one whitespace byte, so the newline that
		// follows is a sample worth 10 and not part of the header.
		const image = decodePnm(file('P5\n1 1\n255\n\n'));
		expect(pixel(image, 0, 0)).toEqual([10, 10, 10, 255]);
	});
});

describe('decodePnm P6', () => {
	it('reads RGB triples straight out of the file', () => {
		const image = decodePnm(file('P6\n2 1\n255\n', [1, 2, 3, 250, 251, 252]));
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([250, 251, 252, 255]);
	});

	it('scales samples when the maximum is not 255', () => {
		const image = decodePnm(file('P6\n1 1\n15\n', [0, 5, 15]));
		expect(pixel(image, 0, 0)).toEqual([0, 85, 255, 255]);
	});

	it('reads 16 bit samples as big endian pairs', () => {
		const image = decodePnm(file('P6\n1 1\n65535\n', [0xff, 0xff, 0x80, 0x00, 0x00, 0x00]));
		expect(pixel(image, 0, 0)).toEqual([255, 128, 0, 255]);
	});

	it('does not treat a hash in the pixel data as a comment', () => {
		// 0x23 is '#'. In the data it is a perfectly ordinary sample, and a
		// reader that keeps looking for comments here eats the rest of the row.
		const image = decodePnm(file('P6\n1 1\n255\n', [0x23, 0x23, 0x23]));
		expect(pixel(image, 0, 0)).toEqual([35, 35, 35, 255]);
	});

	it('ignores bytes after the end of the image', () => {
		const image = decodePnm(file('P6\n1 1\n255\n', [1, 2, 3], 'P6\n1 1\n255\n', [4, 5, 6]));
		expect(image.width).toBe(1);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
	});
});

/* ── Header grammar ───────────────────────────────────────────────────── */

describe('PNM header parsing', () => {
	it('accepts a comment between the width and the height', () => {
		const image = decodePnm(file('P6\n2 # two across, said here\n1\n255\n', [1, 2, 3, 4, 5, 6]));
		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(pixel(image, 1, 0)).toEqual([4, 5, 6, 255]);
	});

	it('accepts a comment immediately after the magic number', () => {
		const image = decodePnm(file('P6# written by hand\n1 1\n255\n', [7, 8, 9]));
		expect(pixel(image, 0, 0)).toEqual([7, 8, 9, 255]);
	});

	it('ignores digits inside a comment', () => {
		const image = decodePnm(file('P6\n# 99 88 77\n1 1\n# 66\n255\n', [7, 8, 9]));
		expect(image.width).toBe(1);
		expect(pixel(image, 0, 0)).toEqual([7, 8, 9, 255]);
	});

	it('accepts tabs and carriage returns as whitespace', () => {
		const image = decodePnm(file('P6\r\n\t1\t1\r\n255\n', [7, 8, 9]));
		expect(pixel(image, 0, 0)).toEqual([7, 8, 9, 255]);
	});

	it('stops at a comment that runs off the end of the file', () => {
		// The comment never reaches a newline, so the scan has to end at the end
		// of the buffer rather than spinning there.
		expect(() => decodePnm(file('P6\n1 # never ends'))).toThrow(DecodeFailedError);
	});

	it('allows a comment to end the ASCII pixel data', () => {
		const image = decodePnm(file('P2\n1 1\n255\n7 # trailing note'));
		expect(pixel(image, 0, 0)).toEqual([7, 7, 7, 255]);
	});

	it('starts the pixel data one byte after the header, comment or not', () => {
		// A '#' here is a sample worth 35, because a binary header ends after
		// exactly one whitespace byte.
		const image = decodePnm(file('P6\n1 1\n255 # not a comment'));
		expect(pixel(image, 0, 0)).toEqual([35, 32, 110, 255]);
	});

	it('reads a comment that starts where the last header field ends', () => {
		// No whitespace between the maximum sample value and the '#', so the
		// comment is still inside the header and the newline that closes it is
		// the byte that ends the header. Netpbm and ImageMagick both read this
		// file as the single pixel 7, 8, 9.
		const image = decodePnm(file('P6\n1 1\n255# a note\n', [7, 8, 9]));
		expect(pixel(image, 0, 0)).toEqual([7, 8, 9, 255]);
	});

	it('reads a comment that starts where a P4 height ends', () => {
		const image = decodePnm(file('P4\n8 1# a note\n', [0b10000000]));
		expect(pixel(image, 0, 0)).toEqual(BLACK);
		expect(pixel(image, 1, 0)).toEqual(WHITE);
	});

	it('ends that comment at a carriage return, leaving the line feed as data', () => {
		const image = decodePnm(file('P6\n1 1\n255# a note\r\n', [1, 2]));
		expect(pixel(image, 0, 0)).toEqual([10, 1, 2, 255]);
	});

	it('refuses a comment at the end of the header that never closes', () => {
		expect(() => decodePnm(file('P6\n1 1\n255# a note that never ends'))).toThrow(
			DecodeFailedError,
		);
	});
});

/* ── Malformed input ──────────────────────────────────────────────────── */

describe('malformed PNM input', () => {
	function expectRefusal(input: Uint8Array): DecodeFailedError {
		let thrown: unknown;
		try {
			decodePnm(input);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const failure = thrown as DecodeFailedError;
		expect(failure.code).toBe('decode/failed');
		expect(failure.format).toBe('pnm');
		// The message has to be a sentence somebody can read, not "undefined".
		expect(failure.message).toMatch(/[a-z]{4}/);
		expect(failure.message).not.toMatch(/undefined|NaN/);
		return failure;
	}

	it('refuses an empty file', () => {
		expectRefusal(new Uint8Array(0));
	});

	it('refuses a file that is only the magic number', () => {
		expectRefusal(ascii('P6'));
	});

	it('refuses a magic number that is not P1 to P6', () => {
		expectRefusal(file('Q6\n1 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P0\n1 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P9\n1 1\n255\n', [1, 2, 3]));
	});

	it('refuses P7, which is PAM and a different grammar', () => {
		const failure = expectRefusal(file('P7\nWIDTH 1\nHEIGHT 1\nENDHDR\n', [1]));
		expect(failure.message).toContain('PAM');
	});

	it('refuses a magic number not followed by whitespace', () => {
		expectRefusal(file('P61 1\n255\n', [1, 2, 3]));
	});

	it('refuses a header that stops before the height', () => {
		expectRefusal(ascii('P6\n1'));
		expectRefusal(ascii('P6\n1 '));
	});

	it('refuses a dimension that is not a number', () => {
		expectRefusal(file('P6\nwide 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P6\n1x 1\n255\n', [1, 2, 3]));
	});

	it('refuses a zero dimension', () => {
		expectRefusal(ascii('P6\n0 1\n255\n'));
		expectRefusal(ascii('P6\n1 0\n255\n'));
	});

	it('refuses a maximum sample value of zero or above 65535', () => {
		expectRefusal(file('P6\n1 1\n0\n', [1, 2, 3]));
		expectRefusal(file('P6\n1 1\n70000\n', [1, 2, 3]));
	});

	it('refuses a header with no whitespace before the pixel data', () => {
		expectRefusal(ascii('P6\n1 1\n255'));
	});

	it('refuses pixel data that stops short', () => {
		expectRefusal(file('P6\n2 2\n255\n', [1, 2, 3, 4, 5, 6]));
		expectRefusal(file('P5\n4 4\n255\n', [1, 2, 3]));
		expectRefusal(file('P6\n1 1\n65535\n', [0xff, 0xff, 0x00]));
	});

	it('refuses a header claiming more pixels than the file could hold', () => {
		// The allocation for this would be four gigabytes, so it has to be
		// refused from the header rather than part way through the read.
		expectRefusal(file('P3\n40000 40000\n255\n1 2 3'));
		expectRefusal(file('P1\n40000 40000\n1 0 1'));
		expectRefusal(file('P6\n40000 40000\n255\n', [1, 2, 3]));
	});

	it('refuses an implausibly large dimension', () => {
		expectRefusal(file('P6\n99999999999 1\n255\n', [1, 2, 3]));
	});

	it('refuses a pixel count past the ceiling before it looks at the file at all', () => {
		// A P4 row is a bit a pixel, so a 50 megabyte file honestly describes 400
		// million of them and the check against what is left of the file lets it
		// through. The raster is still four bytes a pixel, so there has to be an
		// absolute ceiling as well, and it has to be the thing that refuses this.
		const failure = expectRefusal(file('P4\n40000 40000\n', [0]));
		expect(failure.message).toContain('far larger than anything this tool will allocate for');
	});

	it('refuses ASCII data that runs out early', () => {
		expectRefusal(file('P2\n2 2\n255\n1 2 3'));
		expectRefusal(file('P3\n2 1\n255\n1 2 3 4 5'));
		expectRefusal(file('P1\n3 3\n101 010'));
	});

	it('refuses ASCII data that is not a number', () => {
		expectRefusal(file('P2\n2 1\n255\n1 x'));
	});
});

/* ── Bytes from another implementation ────────────────────────────────── */

/**
 * The files in this block are literal transcriptions of what ImageMagick 7
 * wrote for one three by two image, one member of the family at a time, and the
 * pixel values are ImageMagick's own reading of them back. A round trip through
 * this package's own writer and reader would agree with itself no matter what
 * either of them believed about the format, so the only assertions that say
 * anything about Netpbm are the ones against bytes somebody else produced.
 *
 * Reproduce with:
 *   magick src.png -depth 8 ppm:src.ppm          (and pgm:, -compress none, -depth 16)
 *   magick -size 9x2 pattern:gray50 -monochrome pbm:p4.pbm
 */
describe('files written by ImageMagick', () => {
	/** The three by two source, as ImageMagick's P6 records it. */
	const RGB = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[1, 2, 3],
		[127, 128, 129],
		[254, 253, 252],
	];
	/** The same image after ImageMagick's own conversion to greyscale. */
	const GREY = [54, 182, 18, 2, 128, 253];

	/** ImageMagick's src.ppm, byte for byte. */
	const P6_FILE = file('P6\n3 2\n255\n', RGB.flat());

	function pixels(image: RasterImage): number[][] {
		const out: number[][] = [];
		for (let i = 0; i < image.width * image.height; i += 1) {
			out.push(Array.from(image.data.subarray(i * 4, i * 4 + 3)));
		}
		return out;
	}

	it('writes the same bytes ImageMagick writes for the same pixels', () => {
		const source = createRaster(3, 2);
		RGB.forEach(([r, g, b], i) => {
			source.data.set([r as number, g as number, b as number, 255], i * 4);
		});
		expect(Array.from(encodePnm(source))).toEqual(Array.from(P6_FILE));
	});

	it('reads ImageMagick P6', () => {
		expect(pixels(decodePnm(P6_FILE))).toEqual(RGB);
	});

	it('reads ImageMagick P3', () => {
		const bytes = file('P3\n3 2\n255\n255 0 0 0 255 0 0 0 255\n1 2 3 127 128 129 254 253 252\n');
		expect(pixels(decodePnm(bytes))).toEqual(RGB);
	});

	it('reads ImageMagick 16 bit P6', () => {
		const bytes = file(
			'P6\n3 2\n65535\n',
			[
				0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
				0x00, 0xff, 0xff, 0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x7f, 0x7f, 0x80, 0x80, 0x81, 0x81,
				0xfe, 0xfe, 0xfd, 0xfd, 0xfc, 0xfc,
			],
		);
		expect(pixels(decodePnm(bytes))).toEqual(RGB);
	});

	it('reads ImageMagick P5', () => {
		const bytes = file('P5\n3 2\n255\n', [0x36, 0xb6, 0x12, 0x02, 0x80, 0xfd]);
		expect(pixels(decodePnm(bytes))).toEqual(GREY.map((v) => [v, v, v]));
	});

	it('reads ImageMagick 16 bit P5', () => {
		// The samples are 13936, 46868, 4731, 478, 32860 and 65057, which scale
		// back to the same eight bit greys to within nothing at all.
		const bytes = file(
			'P5\n3 2\n65535\n',
			[0x36, 0x70, 0xb7, 0x14, 0x12, 0x7b, 0x01, 0xde, 0x80, 0x5c, 0xfe, 0x21],
		);
		expect(pixels(decodePnm(bytes))).toEqual(GREY.map((v) => [v, v, v]));
	});

	it('reads ImageMagick P2', () => {
		const bytes = file('P2\n3 2\n255\n54 182 18\n2 128 253\n');
		expect(pixels(decodePnm(bytes))).toEqual(GREY.map((v) => [v, v, v]));
	});

	/**
	 * A nine by two checkerboard, so both the row padding and the polarity are
	 * load bearing. ImageMagick renders both of these to the same P6, in which
	 * the first pixel is black: a set bit is black.
	 */
	const CHECKER = [
		[0, 255, 0, 255, 0, 255, 0, 255, 0],
		[255, 0, 255, 0, 255, 0, 255, 0, 255],
	].flat();

	it('reads ImageMagick P4, padding and polarity together', () => {
		const bytes = file('P4\n9 2\n', [0xaa, 0x80, 0x55, 0x00]);
		expect(pixels(decodePnm(bytes)).map((p) => p[0])).toEqual(CHECKER);
	});

	it('reads ImageMagick P1, padding and polarity together', () => {
		const bytes = file('P1\n9 2\n1 0 1 0 1 0 1 0 1\n0 1 0 1 0 1 0 1 0\n');
		expect(pixels(decodePnm(bytes)).map((p) => p[0])).toEqual(CHECKER);
	});
});
