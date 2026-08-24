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

/** The same pattern with an opacity that varies per pixel and starts at zero. */
function translucent(width: number, height: number): RasterImage {
	const image = pattern(width, height, true);
	for (let i = 0; i < width * height; i += 1) {
		image.data[i * 4 + 3] = (i * 29) & 0xff;
	}
	return image;
}

/** The PAM header this package's writer produces for a translucent image. */
function writtenPamHeader(width: number, height: number): string {
	return `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
}

/** A PAM header, with its fields in the order every writer puts them. */
function pamHeader(
	width: number | string,
	height: number | string,
	depth: number | string,
	maxval: number | string,
	tupleType?: string,
): string {
	const tuple = tupleType === undefined ? '' : `TUPLTYPE ${tupleType}\n`;
	return `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${depth}\nMAXVAL ${maxval}\n${tuple}ENDHDR\n`;
}

/** Decode `input`, assert it was refused, and hand back the refusal to inspect. */
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

	it('refuses fractional dimensions', () => {
		// The header would say 2 and the loop would write two and a half rows, so
		// the file and its own header would disagree about where a row ends.
		const fractional: RasterImage = { ...pattern(4, 4), width: 2.5 };
		expect(() => encodePnm(fractional)).toThrow(EncodeFailedError);
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

	it('keeps a translucent pixel rather than compositing it away', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([0, 0, 255, 128]);
		const decoded = decodePnm(encodePnm(image));
		expect(pixel(decoded, 0, 0)).toEqual([0, 0, 255, 128]);
		expect(decoded.hasAlpha).toBe(true);
	});

	it('ignores a background, because the alpha is written rather than flattened', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([0, 0, 255, 128]);
		expect(Array.from(encodePnm(image, { background: [0, 0, 0] }))).toEqual(
			Array.from(encodePnm(image)),
		);
	});

	it('keeps the colour underneath a fully transparent pixel', () => {
		// PAM's fourth sample is straight opacity rather than premultiplied, so
		// the colour under a transparent pixel is still there afterwards.
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([12, 34, 56, 0]);
		const decoded = decodePnm(encodePnm(image, { background: [10, 20, 30] }));
		expect(pixel(decoded, 0, 0)).toEqual([12, 34, 56, 0]);
	});

	it('refuses a translucent raster whose buffer is shorter than its dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(4 * 4),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: true,
		};
		expect(() => encodePnm(short)).toThrow(EncodeFailedError);
	});
});

/* ── Encoding a translucent image, which is where PAM comes in ────────── */

describe('encodePnm to PAM', () => {
	it('writes the exact P7 header the specification describes', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([9, 8, 7, 6]);
		const encoded = encodePnm(image);
		const header = writtenPamHeader(1, 1);

		expect(Array.from(encoded.subarray(0, header.length))).toEqual(Array.from(ascii(header)));
		expect(Array.from(encoded.subarray(header.length))).toEqual([9, 8, 7, 6]);
		expect(encoded.length).toBe(header.length + 4);
	});

	it('writes four bytes per pixel and no padding for an odd width', () => {
		expect(encodePnm(translucent(3, 5)).length).toBe(writtenPamHeader(3, 5).length + 3 * 5 * 4);
	});

	it('writes P6 for an image that declares no alpha and P7 for one that does', () => {
		expect(encodePnm(pattern(2, 2))[1]).toBe(0x36);
		expect(encodePnm(pattern(2, 2, true))[1]).toBe(0x37);
	});

	it('writes P7 for a raster that declares alpha but happens to be opaque', () => {
		// The flag decides, not the buffer. That is the same choice the PNG
		// writer makes between colour types 2 and 6, and `convert` has already
		// resolved the flag with `detectAlpha` before an encoder sees the image.
		// The alpha channel then reads back as solid, so what comes out the far
		// end declares itself opaque again.
		const image = pattern(2, 2, true);
		const encoded = encodePnm(image);
		expect(encoded[1]).toBe(0x37);

		const decoded = decodePnm(encoded);
		expect(decoded.hasAlpha).toBe(false);
		expect(Array.from(decoded.data)).toEqual(Array.from(image.data));
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('PAM round trip', () => {
	for (const [width, height] of [
		[1, 1],
		[3, 5],
		[7, 1],
		[1, 7],
		[9, 9],
		[13, 2],
	] as const) {
		it(`preserves every pixel of a translucent ${width} by ${height} image`, () => {
			const source = translucent(width, height);
			const decoded = decodePnm(encodePnm(source));
			expect(decoded.width).toBe(width);
			expect(decoded.height).toBe(height);
			expect(decoded.hasAlpha).toBe(true);
			expect(decoded.colourSpace).toBe('srgb');
			expect(Array.from(decoded.data)).toEqual(Array.from(source.data));
		});
	}
});

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

describe('decodePnm P7', () => {
	it('reads DEPTH 4 as straight RGBA', () => {
		const bytes = file(pamHeader(2, 1, 4, 255, 'RGB_ALPHA'), [1, 2, 3, 255, 250, 251, 252, 64]);
		const image = decodePnm(bytes);
		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(image.hasAlpha).toBe(true);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([250, 251, 252, 64]);
	});

	it('reads DEPTH 3 as an opaque pixmap', () => {
		const bytes = file(pamHeader(2, 1, 3, 255, 'RGB'), [1, 2, 3, 250, 251, 252]);
		const image = decodePnm(bytes);
		expect(image.hasAlpha).toBe(false);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(pixel(image, 1, 0)).toEqual([250, 251, 252, 255]);
	});

	it('reads DEPTH 2 as a grey with an opacity beside it', () => {
		const bytes = file(pamHeader(2, 1, 2, 255, 'GRAYSCALE_ALPHA'), [200, 255, 10, 128]);
		const image = decodePnm(bytes);
		expect(image.hasAlpha).toBe(true);
		// The one luminance sample fills all three colour channels, so a grey
		// image arrives grey rather than red.
		expect(pixel(image, 0, 0)).toEqual([200, 200, 200, 255]);
		expect(pixel(image, 1, 0)).toEqual([10, 10, 10, 128]);
	});

	it('reads DEPTH 1 as an opaque greymap', () => {
		const bytes = file(pamHeader(2, 1, 1, 255, 'GRAYSCALE'), [0, 200]);
		const image = decodePnm(bytes);
		expect(image.hasAlpha).toBe(false);
		expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(image, 1, 0)).toEqual([200, 200, 200, 255]);
	});

	it('reports no alpha when every opacity sample turned out to be solid', () => {
		// A file can spend a whole channel saying every pixel is opaque. The flag
		// is a promise about the pixels rather than a record of what the file
		// spent bytes on, so it comes back false and no later encoder writes an
		// alpha channel nothing needs.
		const rgba = file(pamHeader(2, 1, 4, 255, 'RGB_ALPHA'), [1, 2, 3, 255, 4, 5, 6, 255]);
		expect(decodePnm(rgba).hasAlpha).toBe(false);
		const greyAlpha = file(pamHeader(2, 1, 2, 255, 'GRAYSCALE_ALPHA'), [1, 255, 2, 255]);
		expect(decodePnm(greyAlpha).hasAlpha).toBe(false);
	});

	it('keeps the colour underneath a fully transparent pixel', () => {
		// PAM opacity is straight rather than premultiplied, so a transparent
		// pixel still carries its colour. ImageMagick writes exactly these four
		// bytes for a transparent blue.
		const bytes = file(pamHeader(1, 1, 4, 255, 'RGB_ALPHA'), [0, 0, 255, 0]);
		expect(pixel(decodePnm(bytes), 0, 0)).toEqual([0, 0, 255, 0]);
	});

	it('scales samples from the maximum the header gives', () => {
		const bytes = file(pamHeader(2, 1, 4, 15, 'RGB_ALPHA'), [0, 5, 15, 15, 15, 0, 0, 8]);
		const image = decodePnm(bytes);
		expect(pixel(image, 0, 0)).toEqual([0, 85, 255, 255]);
		expect(pixel(image, 1, 0)).toEqual([255, 0, 0, 136]);
	});

	it('reads two big endian bytes per sample when the maximum is above 255', () => {
		const bytes = file(
			pamHeader(1, 1, 4, 65535, 'RGB_ALPHA'),
			[0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x40, 0x00],
		);
		expect(pixel(decodePnm(bytes), 0, 0)).toEqual([255, 128, 0, 64]);
	});

	it('reads 16 bit greyscale with alpha', () => {
		const bytes = file(
			pamHeader(2, 1, 2, 65535, 'GRAYSCALE_ALPHA'),
			[0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0xff, 0xff],
		);
		const image = decodePnm(bytes);
		expect(pixel(image, 0, 0)).toEqual([255, 255, 255, 128]);
		expect(pixel(image, 1, 0)).toEqual([0, 0, 0, 255]);
	});

	it('reads BLACKANDWHITE the opposite way round from P1 and P4', () => {
		// This is the trap. In a PBM a set bit is black; in a PAM the sample is
		// an intensity, so 1 is white. Both of these files are ImageMagick's own
		// output for one four pixel picture, one as a PAM and one as a PBM, and
		// their sample bits are the inverse of each other.
		const pam = decodePnm(file(pamHeader(4, 1, 1, 1, 'BLACKANDWHITE'), [1, 1, 0, 0]));
		const pbm = decodePnm(file('P4\n4 1\n', [0b00110000]));
		for (const image of [pam, pbm]) {
			expect(pixel(image, 0, 0)).toEqual(WHITE);
			expect(pixel(image, 1, 0)).toEqual(WHITE);
			expect(pixel(image, 2, 0)).toEqual(BLACK);
			expect(pixel(image, 3, 0)).toEqual(BLACK);
		}
	});

	it('reads a file with no TUPLTYPE line at all', () => {
		// TUPLTYPE is optional, and DEPTH is what decides where one pixel ends.
		const bytes = file(pamHeader(2, 1, 3, 255), [1, 2, 3, 250, 251, 252]);
		expect(pixel(decodePnm(bytes), 1, 0)).toEqual([250, 251, 252, 255]);
	});

	it('ignores bytes after the end of the image', () => {
		const bytes = file(
			pamHeader(1, 1, 3, 255, 'RGB'),
			[1, 2, 3],
			pamHeader(1, 1, 3, 255),
			[4, 5, 6],
		);
		const image = decodePnm(bytes);
		expect(image.width).toBe(1);
		expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
	});

	it('treats a second newline after ENDHDR as pixel data', () => {
		// The newline that closes ENDHDR is the last byte of the header, and
		// there is no separator after it the way P4 to P6 have one. So the next
		// byte is a sample worth 10, not spare whitespace.
		const bytes = file(pamHeader(2, 1, 1, 255, 'GRAYSCALE'), '\n', [20]);
		const image = decodePnm(bytes);
		expect(pixel(image, 0, 0)).toEqual([10, 10, 10, 255]);
		expect(pixel(image, 1, 0)).toEqual([20, 20, 20, 255]);
	});

	it('does not treat a hash in the pixel data as a comment', () => {
		const bytes = file(pamHeader(1, 1, 3, 255, 'RGB'), [0x23, 0x23, 0x23]);
		expect(pixel(decodePnm(bytes), 0, 0)).toEqual([35, 35, 35, 255]);
	});
});

/* ── PAM header grammar, which is lines rather than tokens ────────────── */

describe('PAM header parsing', () => {
	const DATA = [1, 2, 3, 250, 251, 252];

	it('accepts the fields in any order', () => {
		const bytes = file('P7\nMAXVAL 255\nDEPTH 3\nHEIGHT 1\nWIDTH 2\nENDHDR\n', DATA);
		const image = decodePnm(bytes);
		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(pixel(image, 1, 0)).toEqual([250, 251, 252, 255]);
	});

	it('accepts comment lines between the fields', () => {
		const bytes = file(
			'P7\n# written by hand\nWIDTH 2\nHEIGHT 1\n#  99 88 77\nDEPTH 3\nMAXVAL 255\nENDHDR\n',
			DATA,
		);
		expect(decodePnm(bytes).width).toBe(2);
	});

	it('accepts a comment on the magic number line', () => {
		const bytes = file(
			'P7# written by hand\nWIDTH 2\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nENDHDR\n',
			DATA,
		);
		expect(pixel(decodePnm(bytes), 0, 0)).toEqual([1, 2, 3, 255]);
	});

	it('accepts blank lines', () => {
		const bytes = file('P7\n\nWIDTH 2\n\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\n   \nENDHDR\n', DATA);
		expect(decodePnm(bytes).width).toBe(2);
	});

	it('ignores a keyword it does not know', () => {
		// A key this reader has never heard of cannot change where one pixel ends
		// and the next begins, so skipping it is safer than refusing a file whose
		// raster is perfectly readable.
		const bytes = file(
			'P7\nWIDTH 2\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nCOMMENT written by hand\nENDHDR\n',
			DATA,
		);
		expect(decodePnm(bytes).width).toBe(2);
	});

	it('accepts a header written with carriage returns', () => {
		const bytes = file(
			'P7\r\nWIDTH 2\r\nHEIGHT 1\r\nDEPTH 3\r\nMAXVAL 255\r\nTUPLTYPE RGB\r\nENDHDR\r\n',
			DATA,
		);
		// A stray carriage return glued to ENDHDR would leave the header looking
		// like it never ended, and one glued to a value would make every number
		// unreadable.
		expect(pixel(decodePnm(bytes), 1, 0)).toEqual([250, 251, 252, 255]);
	});

	it('accepts tabs and extra spaces around a field', () => {
		const bytes = file('P7\n  WIDTH\t2  \nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nENDHDR\n', DATA);
		expect(decodePnm(bytes).width).toBe(2);
	});

	it('joins repeated TUPLTYPE lines rather than taking the last', () => {
		// The format lets a long tuple type be split across lines and means the
		// concatenation. So these two lines are the single type "RGB ALPHA",
		// which is not one this reader knows, rather than a file that quietly
		// reads as RGB.
		const bytes = file(
			'P7\nWIDTH 2\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nTUPLTYPE ALPHA\nENDHDR\n',
			DATA,
		);
		expect(() => decodePnm(bytes)).toThrow(DecodeFailedError);
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
	it('refuses an empty file', () => {
		expectRefusal(new Uint8Array(0));
	});

	it('refuses a file that is only the magic number', () => {
		expectRefusal(ascii('P6'));
	});

	it('refuses a magic number that is not P1 to P7', () => {
		expectRefusal(file('Q6\n1 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P0\n1 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P8\n1 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P9\n1 1\n255\n', [1, 2, 3]));
	});

	it('refuses a magic number not followed by whitespace', () => {
		expectRefusal(file('P61 1\n255\n', [1, 2, 3]));
		expectRefusal(file('P7WIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nENDHDR\n', [1]));
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

	it('refuses ASCII data that is all separator and no sample', () => {
		// There are bytes enough here for two samples, so the room check lets it
		// through, and then the whitespace between them runs to the end of the
		// file. That is a different failure from a file that is simply too short.
		const failure = expectRefusal(file('P2\n2 1\n255\n1      '));
		expect(failure.message).toContain('1 of 2 samples');
	});
});

/* ── Malformed PAM ────────────────────────────────────────────────────── */

describe('malformed PAM input', () => {
	it('refuses a header with no ENDHDR line', () => {
		const failure = expectRefusal(ascii('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\n'));
		expect(failure.message).toContain('ENDHDR');
	});

	it('names the field that is missing', () => {
		const fields = ['WIDTH 1', 'HEIGHT 1', 'DEPTH 1', 'MAXVAL 1'];
		for (const missing of fields) {
			const header = `P7\n${fields.filter((field) => field !== missing).join('\n')}\nENDHDR\n`;
			const failure = expectRefusal(file(header, [1]));
			expect(failure.message).toContain(missing.split(' ')[0] as string);
		}
	});

	it('refuses a field given twice', () => {
		expectRefusal(file('P7\nWIDTH 1\nWIDTH 2\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nENDHDR\n', [1, 1]));
		expectRefusal(file('P7\nWIDTH 1\nHEIGHT 1\nHEIGHT 2\nDEPTH 1\nMAXVAL 1\nENDHDR\n', [1, 1]));
		expectRefusal(file('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nDEPTH 3\nMAXVAL 1\nENDHDR\n', [1, 1, 1]));
		expectRefusal(file('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nMAXVAL 255\nENDHDR\n', [1]));
	});

	it('refuses a keyword with no value after it', () => {
		expectRefusal(file('P7\nWIDTH\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nENDHDR\n', [1]));
		expectRefusal(file('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nTUPLTYPE\nENDHDR\n', [1]));
	});

	it('refuses a field that is not a number', () => {
		expectRefusal(file(pamHeader('wide', 1, 1, 1), [1]));
		expectRefusal(file(pamHeader(1, '1x', 1, 1), [1]));
		expectRefusal(file(pamHeader(1, 1, 'three', 255), [1]));
		expectRefusal(file(pamHeader(1, 1, 1, '2 5 5'), [1]));
	});

	it('refuses an implausibly large dimension', () => {
		expectRefusal(file(pamHeader('99999999999', 1, 1, 255), [1]));
	});

	it('refuses a zero dimension', () => {
		expectRefusal(file(pamHeader(0, 1, 1, 255), [1]));
		expectRefusal(file(pamHeader(1, 0, 1, 255), [1]));
	});

	it('refuses a header claiming more pixels than anything will be allocated for', () => {
		const failure = expectRefusal(file(pamHeader(40000, 40000, 1, 255), [1]));
		expect(failure.message).toContain('far larger than anything this tool will allocate for');
	});

	it('refuses a DEPTH of zero', () => {
		const failure = expectRefusal(file(pamHeader(1, 1, 0, 255), [1]));
		expect(failure.message).toContain('DEPTH');
	});

	it('refuses a DEPTH above four by name', () => {
		// Five samples a pixel is a tuple of measurements rather than a picture,
		// and there is no honest way to render one as RGBA.
		const failure = expectRefusal(file(pamHeader(1, 1, 5, 255), [1, 2, 3, 4, 5]));
		expect(failure.message).toContain('DEPTH of 5');
		expect(failure.message).toContain('this reader only reads');
	});

	it('refuses a maximum sample value of zero or above 65535', () => {
		expectRefusal(file(pamHeader(1, 1, 1, 0), [1]));
		expectRefusal(file(pamHeader(1, 1, 1, 70000), [1, 2]));
	});

	it('refuses a TUPLTYPE it does not recognise, rather than guessing', () => {
		// ImageMagick writes and reads TUPLTYPE CMYK at DEPTH 4. Reading those
		// four samples as red, green, blue and opacity produces a picture rather
		// than an error, which is the worst of the two outcomes.
		const failure = expectRefusal(file(pamHeader(1, 1, 4, 255, 'CMYK'), [1, 2, 3, 4]));
		expect(failure.message).toContain('TUPLTYPE');
		expect(failure.message).toContain('RGB');
	});

	it('refuses a TUPLTYPE that contradicts the DEPTH', () => {
		const failure = expectRefusal(file(pamHeader(1, 1, 3, 255, 'RGB_ALPHA'), [1, 2, 3]));
		expect(failure.message).toContain('contradict');
		expectRefusal(file(pamHeader(1, 1, 4, 255, 'RGB'), [1, 2, 3, 4]));
		expectRefusal(file(pamHeader(1, 1, 1, 1, 'GRAYSCALE_ALPHA'), [1]));
	});

	it('refuses pixel data that stops short', () => {
		expectRefusal(file(pamHeader(2, 2, 4, 255, 'RGB_ALPHA'), [1, 2, 3, 4, 5, 6, 7, 8]));
		expectRefusal(file(pamHeader(1, 1, 4, 65535, 'RGB_ALPHA'), [0, 1, 0, 2, 0, 3, 0]));
		expectRefusal(file(pamHeader(4, 4, 1, 255, 'GRAYSCALE'), [1, 2, 3]));
	});

	it('refuses a file that ends where the pixel data should begin', () => {
		expectRefusal(ascii(pamHeader(1, 1, 3, 255, 'RGB')));
	});

	it('refuses a header line longer than any header line has cause to be', () => {
		// Without this the line is assembled as a string, so a megabyte with no
		// newline in it would be copied into one before anything noticed that the
		// file is not a PAM.
		const failure = expectRefusal(file('P7\n', `WIDTH ${'1'.repeat(2000)}\n`, 'ENDHDR\n'));
		expect(failure.message).toContain('header');
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
 *   magick src.png -depth 8 src.pam              (and -colorspace gray, -alpha off)
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
	/** The opacity of each of the six, for the PAM files below. */
	const ALPHA = [255, 128, 0, 255, 64, 255];

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

	/** ImageMagick's src.pam for the same six pixels with an alpha channel. */
	const RGBA_PAM = file(
		'P7\nWIDTH 3\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n',
		RGB.map((colour, i) => [...colour, ALPHA[i] as number]).flat(),
	);

	it('writes the same PAM bytes ImageMagick writes for the same pixels', () => {
		// Field order included. ImageMagick puts WIDTH, HEIGHT, DEPTH, MAXVAL and
		// TUPLTYPE in that order, and so does this writer, so the two files are
		// the same bytes rather than merely the same picture.
		const source = createRaster(3, 2, 'srgb', true);
		RGB.forEach(([r, g, b], i) => {
			source.data.set([r as number, g as number, b as number, ALPHA[i] as number], i * 4);
		});
		expect(Array.from(encodePnm(source))).toEqual(Array.from(RGBA_PAM));
	});

	it('reads ImageMagick RGB_ALPHA', () => {
		const image = decodePnm(RGBA_PAM);
		expect(image.hasAlpha).toBe(true);
		expect(pixels(image)).toEqual(RGB);
		// The third pixel is fully transparent and still blue, which is what
		// straight rather than premultiplied opacity means.
		expect(pixel(image, 2, 0)).toEqual([0, 0, 255, 0]);
		expect(pixel(image, 1, 1)).toEqual([127, 128, 129, 64]);
	});

	it('reads ImageMagick GRAYSCALE_ALPHA', () => {
		const bytes = file(
			'P7\nWIDTH 3\nHEIGHT 2\nDEPTH 2\nMAXVAL 255\nTUPLTYPE GRAYSCALE_ALPHA\nENDHDR\n',
			GREY.map((grey, i) => [grey, ALPHA[i] as number]).flat(),
		);
		const image = decodePnm(bytes);
		expect(pixels(image)).toEqual(GREY.map((v) => [v, v, v]));
		expect(pixel(image, 2, 0)).toEqual([18, 18, 18, 0]);
	});

	it('reads ImageMagick GRAYSCALE', () => {
		const bytes = file(
			'P7\nWIDTH 3\nHEIGHT 2\nDEPTH 1\nMAXVAL 255\nTUPLTYPE GRAYSCALE\nENDHDR\n',
			GREY,
		);
		const image = decodePnm(bytes);
		expect(image.hasAlpha).toBe(false);
		expect(pixels(image)).toEqual(GREY.map((v) => [v, v, v]));
	});

	it('reads a PAM ImageMagick wrote with a two bit maximum', () => {
		// ImageMagick narrows MAXVAL to whatever the samples need, so a
		// black and white picture arrives as GRAYSCALE with a MAXVAL of 3 rather
		// than as BLACKANDWHITE with a MAXVAL of 1. Both have to scale to the
		// same picture.
		const bytes = file(
			'P7\nWIDTH 4\nHEIGHT 1\nDEPTH 1\nMAXVAL 3\nTUPLTYPE GRAYSCALE\nENDHDR\n',
			[3, 3, 0, 0],
		);
		const image = decodePnm(bytes);
		expect(pixel(image, 0, 0)).toEqual(WHITE);
		expect(pixel(image, 3, 0)).toEqual(BLACK);
	});
});
