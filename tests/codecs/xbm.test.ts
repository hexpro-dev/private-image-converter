import { describe, expect, it } from 'vitest';

import { decodeXbm } from '../../src/codecs/xbm/decode.js';
import { encodeXbm } from '../../src/codecs/xbm/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * An XBM is C source, so a fixture is the source itself.
 *
 * Every decoder fixture below is written out as the text a compiler would see
 * rather than produced by the encoder, which is the same discipline the BMP
 * tests apply to a binary header: a fixture built by calling the encoder would
 * only prove that the two halves of this package agree with each other.
 */
function xbm(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
	return out;
}

function textOf(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

/** A set pixel as `#`, a clear one as `.`, one string per row. */
function shape(image: RasterImage): string[] {
	const rows: string[] = [];
	for (let y = 0; y < image.height; y += 1) {
		let row = '';
		for (let x = 0; x < image.width; x += 1) {
			row += image.data[(y * image.width + x) * 4 + 3] === 255 ? '#' : '.';
		}
		rows.push(row);
	}
	return rows;
}

/** Turn a `#` and `.` drawing into an opaque-black-on-transparent raster. */
function raster(rows: readonly string[]): RasterImage {
	const width = (rows[0] as string).length;
	const image = createRaster(width, rows.length, 'srgb', true);
	rows.forEach((row, y) => {
		for (let x = 0; x < width; x += 1) {
			if (row[x] === '#') image.data[(y * width + x) * 4 + 3] = 255;
		}
	});
	return image;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodeXbm', () => {
	it('reads a small bitmap least significant bit first', () => {
		// 0x0e is 0b00001110, and the low bit is the leftmost pixel, so the row
		// reads clear then three set. A reader filling from the top bit down would
		// return the mirror image of this and nothing would look broken.
		const image = decodeXbm(
			xbm(
				'#define tiny_width 4\n' +
					'#define tiny_height 3\n' +
					'static char tiny_bits[] = {\n' +
					'   0x0e, 0x0f, 0x07 };\n',
			),
		);

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(shape(image)).toEqual(['.###', '####', '###.']);
	});

	it('draws a set bit as opaque black and a clear bit as fully transparent', () => {
		const image = decodeXbm(
			xbm('#define a_width 2\n#define a_height 1\nstatic char a_bits[] = { 0x01 };\n'),
		);

		expect(pixelsOf(image)).toEqual([0, 0, 0, 255, 0, 0, 0, 0]);
		expect(image.hasAlpha).toBe(true);
		expect(image.colourSpace).toBe('srgb');
	});

	it('reports no alpha for a bitmap with every bit set', () => {
		const image = decodeXbm(
			xbm('#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { 0xff };\n'),
		);

		expect(image.hasAlpha).toBe(false);
	});

	it('pads each row out to a whole byte', () => {
		// Nine pixels take two bytes a row, and the top seven bits of the second
		// carry no pixel at all.
		const image = decodeXbm(
			xbm(
				'#define wide_width 9\n' +
					'#define wide_height 2\n' +
					'static char wide_bits[] = { 0xff, 0x01, 0x00, 0x00 };\n',
			),
		);

		expect(shape(image)).toEqual(['#########', '.........']);
	});

	it('ignores whatever the padding bits of the last byte hold', () => {
		const image = decodeXbm(
			xbm('#define w_width 3\n#define w_height 1\nstatic char w_bits[] = { 0xff };\n'),
		);

		expect(shape(image)).toEqual(['###']);
	});

	it('reads a 16 bit array when the declaration says short', () => {
		// X10 files pack sixteen pixels into each unit, so a nine pixel row costs
		// one short rather than two bytes and the padding is seven bits wider.
		const image = decodeXbm(
			xbm(
				'#define x10_width 9\n' +
					'#define x10_height 2\n' +
					'static unsigned short x10_bits[] = { 0x01ff, 0x0000 };\n',
			),
		);

		expect(shape(image)).toEqual(['#########', '.........']);
	});

	it('reads a 16 bit array declared as a plain short', () => {
		const image = decodeXbm(
			xbm('#define s_width 16\n#define s_height 1\nstatic short s_bits[] = { 0x8001 };\n'),
		);

		expect(shape(image)).toEqual(['#..............#']);
	});

	it('does not mistake a name containing "short" for a short array', () => {
		// `shortcut_bits` is a name, not a type. Reading it as shorts would take
		// two bytes for every one pixel column and return a stretched picture.
		const image = decodeXbm(
			xbm(
				'#define shortcut_width 8\n' +
					'#define shortcut_height 2\n' +
					'static char shortcut_bits[] = { 0x0f, 0xf0 };\n',
			),
		);

		expect(shape(image)).toEqual(['####....', '....####']);
	});

	it('does not mistake a name ending in short for a short array', () => {
		const image = decodeXbm(
			xbm(
				'#define is_short_width 8\n' +
					'#define is_short_height 1\n' +
					'static char is_short_bits[] = { 0x0f };\n',
			),
		);

		expect(shape(image)).toEqual(['####....']);
	});

	it('reads octal values, where a leading zero changes what the digits mean', () => {
		// 0377 is 255 and 015 is 13. Reading them as decimal would give 377 and 15,
		// and 15 draws a different row from 13.
		const image = decodeXbm(
			xbm('#define o_width 8\n#define o_height 2\nstatic char o_bits[] = { 0377, 015 };\n'),
		);

		expect(shape(image)).toEqual(['########', '#.##....']);
	});

	it('reads plain decimal values', () => {
		const image = decodeXbm(
			xbm('#define d_width 8\n#define d_height 1\nstatic char d_bits[] = { 129 };\n'),
		);

		expect(shape(image)).toEqual(['#......#']);
	});

	it('reads a bare zero, which is octal with no digits after it', () => {
		const image = decodeXbm(
			xbm('#define z_width 4\n#define z_height 1\nstatic char z_bits[] = { 0 };\n'),
		);

		expect(shape(image)).toEqual(['....']);
	});

	it('reads negative values as the signed char a compiler would have written', () => {
		// A writer that dumped a signed array put -1 where the file means 0xff.
		const image = decodeXbm(
			xbm('#define n_width 8\n#define n_height 2\nstatic char n_bits[] = { -1, -128 };\n'),
		);

		expect(shape(image)).toEqual(['########', '.......#']);
	});

	it('accepts uppercase hexadecimal and an uppercase X', () => {
		const image = decodeXbm(
			xbm('#define h_width 8\n#define h_height 2\nstatic char h_bits[] = { 0XAB, 0xCD };\n'),
		);

		expect(shape(image)).toEqual(['##.#.#.#', '#.##..##']);
	});

	it('reads an array split across many lines with a trailing comma', () => {
		const image = decodeXbm(
			xbm(
				'#define m_width 4\n#define m_height 4\n' +
					'static unsigned char m_bits[] = {\n' +
					'  0x01,\n  0x02,\n\t0x04,\n  0x08,\n};\n',
			),
		);

		expect(shape(image)).toEqual(['#...', '.#..', '..#.', '...#']);
	});

	it('skips a hotspot pair rather than refusing the file', () => {
		// Every X cursor carries one, and it means nothing once the bitmap is a
		// picture.
		const image = decodeXbm(
			xbm(
				'#define c_width 4\n#define c_height 1\n' +
					'#define c_x_hot 2\n#define c_y_hot 0\n' +
					'static char c_bits[] = { 0x05 };\n',
			),
		);

		expect(shape(image)).toEqual(['#.#.']);
	});

	it('accepts a const declaration', () => {
		const image = decodeXbm(
			xbm(
				'#define k_width 4\n#define k_height 1\nstatic const unsigned char k_bits[] = { 0x09 };\n',
			),
		);

		expect(shape(image)).toEqual(['#..#']);
	});

	it('reads a file wrapped in an include guard', () => {
		// The other directives are stepped over rather than parsed: only a
		// `#define` whose name ends the right way and whose value is a number
		// counts for anything.
		const image = decodeXbm(
			xbm(
				'#ifndef ARROW_XBM\n#define ARROW_XBM\n' +
					'#define arrow_width 4\n#define arrow_height 1\n' +
					'static char arrow_bits[] = { 0x05 };\n#endif\n',
			),
		);

		expect(shape(image)).toEqual(['#.#.']);
	});

	it('accepts a leading comment, which is what several writers put there', () => {
		const image = decodeXbm(
			xbm(
				'/* Created by a tool that is not this one */\n' +
					'#define g_width 4\n#define g_height 1\nstatic char g_bits[] = { 0x0f };\n',
			),
		);

		expect(shape(image)).toEqual(['####']);
	});

	it('takes the dimensions from a define that carries no name at all', () => {
		// The identifier is derived from whatever the file was called when
		// somebody ran the X11 bitmap editor on it, so it is matched by suffix. A
		// file that used the bare words still says how big it is.
		const image = decodeXbm(
			xbm('#define width 4\n#define height 1\nstatic char b[] = { 0x03 };\n'),
		);

		expect(shape(image)).toEqual(['##..']);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = xbm('#define v_width 4\n#define v_height 1\nstatic char v_bits[] = { 0x06 };\n');
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(shape(decodeXbm(padded.subarray(8, 8 + file.length)))).toEqual(['.##.']);
	});

	it('ignores values past the ones the dimensions need', () => {
		// A writer that padded the last line out is more common than a file that
		// means something by the extra bytes.
		const image = decodeXbm(
			xbm('#define e_width 4\n#define e_height 1\nstatic char e_bits[] = { 0x0f, 0x00, 0x00 };\n'),
		);

		expect(shape(image)).toEqual(['####']);
	});
});

/* ── A file this package did not write ────────────────────────────────── */

describe('decodeXbm against a file from another writer', () => {
	/**
	 * The XBM ImageMagick 7 writes for a four by three picture with two white
	 * pixels in opposite corners, byte for byte.
	 *
	 * Worth having because it is the shape a hand written fixture never quite
	 * produces: two spaces of indent, uppercase hexadecimal, a trailing comma
	 * before the brace and `static char` rather than `static unsigned char`.
	 */
	const magick =
		'#define tiny_width 4\n' +
		'#define tiny_height 3\n' +
		'static char tiny_bits[] = {\n' +
		'  0x0E, 0x0F, 0x07, };\n';

	it('reads it, with the corners ImageMagick left clear', () => {
		expect(shape(decodeXbm(xbm(magick)))).toEqual(['.###', '####', '###.']);
	});

	it('re-encodes it to something with the same bits in it', () => {
		const once = decodeXbm(xbm(magick));
		const twice = decodeXbm(encodeXbm(once));

		expect(shape(twice)).toEqual(shape(once));
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeXbm', () => {
	it('writes the whole of a small file, character for character', () => {
		const out = encodeXbm(raster(['#..#', '.##.']));

		expect(textOf(out)).toBe(
			'#define image_width 4\n' +
				'#define image_height 2\n' +
				'static unsigned char image_bits[] = {\n' +
				'   0x09, 0x06 };\n',
		);
	});

	it('names the array after the name it is given', () => {
		const out = encodeXbm(raster(['#']), { name: 'cursor' });

		expect(textOf(out)).toContain('#define cursor_width 1');
		expect(textOf(out)).toContain('static unsigned char cursor_bits[] = {');
	});

	it('replaces anything C cannot use in an identifier', () => {
		const out = encodeXbm(raster(['#']), { name: 'my logo-2' });

		expect(textOf(out)).toContain('#define my_logo_2_width 1');
	});

	it('puts an underscore in front of a name that starts with a digit', () => {
		const out = encodeXbm(raster(['#']), { name: '2019' });

		expect(textOf(out)).toContain('#define _2019_width 1');
	});

	it('falls back to a usable name when the one it is given is empty', () => {
		const out = encodeXbm(raster(['#']), { name: '' });

		expect(textOf(out)).toContain('#define image_width 1');
	});

	it('sets a bit for a dark opaque pixel and clears it for a light one', () => {
		const image = createRaster(2, 1, 'srgb', false);
		image.data.set([0, 0, 0, 255, 255, 255, 255, 255]);

		expect(textOf(encodeXbm(image))).toContain('0x01');
	});

	it('leaves a translucent pixel clear however dark it is', () => {
		// A transparent logo is usually stored as black with nothing behind it.
		// Without the alpha test the whole rectangle would come out as ink.
		const image = createRaster(2, 1, 'srgb', true);
		image.data.set([0, 0, 0, 127, 0, 0, 0, 255]);

		expect(textOf(encodeXbm(image))).toContain('0x02');
	});

	it('puts the threshold on luminance rather than on any one channel', () => {
		// Full blue is dark, full green is light, and a reader that averaged the
		// three would put both on the same side of the line.
		const image = createRaster(2, 1, 'srgb', false);
		image.data.set([0, 0, 255, 255, 0, 255, 0, 255]);

		expect(textOf(encodeXbm(image))).toContain('0x01');
	});

	it('pads each row out to a whole byte', () => {
		const out = encodeXbm(raster(['#########']));

		// Nine set pixels are 0xff and one more bit in the low end of a second
		// byte, and the seven bits above it carry nothing.
		expect(textOf(out)).toContain('   0xff, 0x01 };');
	});

	it('writes twelve values to a line, which is what X11 emits', () => {
		// Fourteen rows of one byte each: twelve on the first line, two on the
		// second.
		const out = encodeXbm(raster(new Array<string>(14).fill('########')));
		const lines = textOf(out).trimEnd().split('\n');

		expect(lines[3]).toBe(`   ${new Array<string>(12).fill('0xff').join(', ')},`);
		expect(lines[4]).toBe('   0xff, 0xff };');
		expect(lines.length).toBe(5);
	});

	it('refuses an image with no pixels', () => {
		const empty = createRaster(0, 0);

		expect(() => encodeXbm(empty)).toThrow(EncodeFailedError);
		expect(() => encodeXbm(empty)).toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};

		expect(() => encodeXbm(short)).toThrow(EncodeFailedError);
		expect(() => encodeXbm(short)).toThrow(/shorter than/);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('XBM round trips', () => {
	it.each([
		[['#']],
		[['.']],
		[['#.#.#.#.']],
		[['#########']],
		[['#.......#', '.#.....#.', '..#...#..', '...#.#...', '....#....']],
		[['#'.repeat(17)]],
		[new Array<string>(13).fill('#..#..#..#..#')],
	])('carries %j through unchanged', (rows) => {
		const source = raster(rows);
		const back = decodeXbm(encodeXbm(source));

		expect(back.width).toBe(source.width);
		expect(back.height).toBe(source.height);
		expect(shape(back)).toEqual(rows);
	});

	it('carries a wide bitmap through two full lines of output', () => {
		const rows = [
			new Array<number>(100)
				.fill(0)
				.map((_, x) => (x % 3 === 0 ? '#' : '.'))
				.join(''),
		];
		const back = decodeXbm(encodeXbm(raster(rows)));

		expect(shape(back)).toEqual(rows);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeXbm refusals', () => {
	function expectRefusal(text: string, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeXbm(xbm(text));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('xbm');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('names the missing width line', () => {
		expectRefusal('#define a_height 4\nstatic char a_bits[] = { 0x00 };\n', /_width/);
	});

	it('names the missing height line', () => {
		expectRefusal('#define a_width 4\nstatic char a_bits[] = { 0x00 };\n', /_height/);
	});

	it('refuses a file with no defines at all', () => {
		expectRefusal('static char a_bits[] = { 0x00 };\n', /_width/);
	});

	it('refuses a define with no value after it', () => {
		expectRefusal(
			'#define a_width\n#define a_height 1\nstatic char a_bits[] = { 0x00 };\n',
			/_width/,
		);
	});

	it('refuses a width of zero', () => {
		expectRefusal(
			'#define a_width 0\n#define a_height 1\nstatic char a_bits[] = { 0x00 };\n',
			/0 pixels wide/,
		);
	});

	it('refuses a height of zero', () => {
		expectRefusal(
			'#define a_width 1\n#define a_height 0\nstatic char a_bits[] = { 0x00 };\n',
			/0 pixels tall/,
		);
	});

	it('refuses a negative width', () => {
		expectRefusal(
			'#define a_width -4\n#define a_height 1\nstatic char a_bits[] = { 0x00 };\n',
			/-4 pixels wide/,
		);
	});

	it('refuses dimensions far larger than anything it will allocate for', () => {
		expectRefusal(
			'#define a_width 60000\n#define a_height 60000\nstatic char a_bits[] = { 0x00 };\n',
			/far larger/,
		);
	});

	it('refuses a width too large to be a number at all', () => {
		expectRefusal(
			'#define a_width 99999999999\n#define a_height 1\nstatic char a_bits[] = { 0x00 };\n',
			/far larger/,
		);
	});

	it('refuses a file with dimensions and no array', () => {
		expectRefusal('#define a_width 4\n#define a_height 1\n', /no array of bits/);
	});

	it('refuses an array holding something that is not a number', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { zero };\n',
			/not a number, 0 values in/,
		);
	});

	it('names how far in the array stopped making sense', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 3\nstatic char a_bits[] = { 0x01, 0x02, ? };\n',
			/not a number, 2 values in/,
		);
	});

	it('refuses a number that runs into something else', () => {
		// `0x` with no digits, and `12abc`, both read as a number followed by a
		// character that cannot end one.
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { 0x };\n',
			/not a number/,
		);
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { 12abc };\n',
			/not a number/,
		);
	});

	it('refuses an octal value with a digit octal does not have', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { 09 };\n',
			/not a number/,
		);
	});

	it('refuses a lone minus sign', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { - };\n',
			/not a number/,
		);
	});

	it('says how many values an array holds when it holds too few', () => {
		expectRefusal(
			'#define a_width 9\n#define a_height 2\nstatic char a_bits[] = { 0x01, 0x00 };\n',
			/holds 2 values, and a 9 by 2 bitmap needs 4/,
		);
	});

	it('refuses an empty array', () => {
		expectRefusal(
			'#define a_width 4\n#define a_height 1\nstatic char a_bits[] = { };\n',
			/holds 0 values/,
		);
	});

	it('refuses an array that ends without a closing brace', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 2\nstatic char a_bits[] = { 0x01,',
			/holds 1 values/,
		);
	});

	it('refuses a value that does not fit the type the file declares', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { 0x1ff };\n',
			/511, which does not fit/,
		);
	});

	it('refuses a negative value too large for the type the file declares', () => {
		expectRefusal(
			'#define a_width 8\n#define a_height 1\nstatic char a_bits[] = { -300 };\n',
			/-300, which does not fit/,
		);
	});

	it('accepts a value that fits a short but not a char, when it declares short', () => {
		const image = decodeXbm(
			xbm('#define a_width 16\n#define a_height 1\nstatic unsigned short a_bits[] = { 0x1ff };\n'),
		);

		expect(shape(image)).toEqual(['#########.......']);
	});

	it('refuses an empty file', () => {
		expectRefusal('', /_width/);
	});
});
