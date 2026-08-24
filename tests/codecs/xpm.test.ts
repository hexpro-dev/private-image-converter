import { describe, expect, it } from 'vitest';

import { decodeXpm } from '../../src/codecs/xpm/decode.js';
import { encodeXpm } from '../../src/codecs/xpm/encode.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * An XPM is C source, so a fixture is the source itself.
 *
 * Every decoder fixture below is written out as the text a compiler would see
 * rather than produced by the encoder, which is the same discipline the BMP
 * tests apply to a binary header: a fixture built by calling the encoder would
 * only prove that the two halves of this package agree with each other.
 */
function xpm(lines: readonly string[]): Uint8Array {
	const text = lines.join('\n');
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
	return out;
}

/** The usual wrapper, so a fixture only has to say what is inside the array. */
function file(...strings: readonly string[]): Uint8Array {
	return xpm([
		'/* XPM */',
		'static char * fixture[] = {',
		...strings.map((line, i) => `"${line}"${i === strings.length - 1 ? '' : ','}`),
		'};',
		'',
	]);
}

function textOf(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/** One `[r, g, b, a]` per pixel, which reads better than a flat list of 64. */
function coloursOf(image: RasterImage): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < image.width * image.height; i += 1) {
		out.push(Array.from(image.data.subarray(i * 4, i * 4 + 4)));
	}
	return out;
}

function raster(width: number, height: number, pixels: readonly number[], hasAlpha = false) {
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
const CLEAR = [0, 0, 0, 0];

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodeXpm', () => {
	it('reads the smallest sensible file', () => {
		const image = decodeXpm(file('2 1 2 1', 'a c #ff0000', 'b c #00ff00', 'ab'));

		expect(image.width).toBe(2);
		expect(image.height).toBe(1);
		expect(image.hasAlpha).toBe(false);
		expect(image.colourSpace).toBe('srgb');
		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it('reads None as fully transparent', () => {
		const image = decodeXpm(file('2 1 2 1', 'a c None', 'b c #00ff00', 'ab'));

		expect(coloursOf(image)).toEqual([CLEAR, GREEN]);
		expect(image.hasAlpha).toBe(true);
	});

	it.each(['None', 'none', 'NONE', 'nOnE'])('reads %s as transparent whatever its case', (word) => {
		const image = decodeXpm(file('1 1 1 1', `a c ${word}`, 'a'));

		expect(coloursOf(image)).toEqual([CLEAR]);
	});

	it('uses a space as a pixel character, which is what most writers pick first', () => {
		// The key is the first `cpp` characters whatever they are, so a row cannot
		// be trimmed and a colour line cannot be split on whitespace.
		const image = decodeXpm(file('2 1 2 1', '  c None', '. c #ff0000', ' .'));

		expect(coloursOf(image)).toEqual([CLEAR, RED]);
	});

	it('reads two characters per pixel', () => {
		const image = decodeXpm(file('2 2 2 2', '.. c #ff0000', 'oo c #00ff00', '..oo', 'oo..'));

		expect(coloursOf(image)).toEqual([RED, GREEN, GREEN, RED]);
	});

	it('reads three characters per pixel', () => {
		const image = decodeXpm(file('2 1 2 3', 'ab. c #ff0000', 'cd. c #00ff00', 'ab.cd.'));

		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it.each([
		['#f00', [255, 0, 0, 255]],
		['#ff0000', [255, 0, 0, 255]],
		['#fff000000', [255, 0, 0, 255]],
		['#ffff00000000', [255, 0, 0, 255]],
		['#0000ffff0000', [0, 255, 0, 255]],
		['#123456', [0x12, 0x34, 0x56, 255]],
		['#123', [0x11, 0x22, 0x33, 255]],
		['#ABCDEF', [0xab, 0xcd, 0xef, 255]],
	])('reads %s as a colour', (value, expected) => {
		const image = decodeXpm(file('1 1 1 1', `a c ${value}`, 'a'));

		expect(coloursOf(image)).toEqual([expected]);
	});

	it('takes the top bits of a wide hexadecimal group rather than the bottom', () => {
		// `#fff` has to be white. Reading three digits as an eight bit number
		// would make it a very dark grey and nothing would throw.
		const image = decodeXpm(file('1 1 1 1', 'a c #fff', 'a'));

		expect(coloursOf(image)).toEqual([[255, 255, 255, 255]]);
	});

	it.each([
		['white', [255, 255, 255, 255]],
		['black', [0, 0, 0, 255]],
		['cornflowerblue', [100, 149, 237, 255]],
		['CornflowerBlue', [100, 149, 237, 255]],
		['light blue', [173, 216, 230, 255]],
		['LIGHT STEEL BLUE', [176, 196, 222, 255]],
		['navy', [0, 0, 128, 255]],
		['orange', [255, 165, 0, 255]],
	])('reads the colour name %s', (name, expected) => {
		const image = decodeXpm(file('1 1 1 1', `a c ${name}`, 'a'));

		expect(coloursOf(image)).toEqual([expected]);
	});

	it.each([
		['green', [0, 255, 0, 255]],
		['gray', [190, 190, 190, 255]],
		['grey', [190, 190, 190, 255]],
		['maroon', [176, 48, 96, 255]],
		['purple', [160, 32, 240, 255]],
	])('reads %s the way X11 means it rather than the way CSS does', (name, expected) => {
		// These four were renamed on the way into CSS. Taking the CSS value would
		// hand back a colour somebody could believe was in the file: a web page's
		// `green` is the dull half bright one, and X11's is fully saturated.
		const image = decodeXpm(file('1 1 1 1', `a c ${name}`, 'a'));

		expect(coloursOf(image)).toEqual([expected]);
	});

	it('accepts the names CSS added that X11 never had', () => {
		const image = decodeXpm(file('2 1 2 1', 'a c teal', 'b c rebeccapurple', 'ab'));

		expect(coloursOf(image)).toEqual([
			[0, 128, 128, 255],
			[102, 51, 153, 255],
		]);
	});

	it('prefers the colour key over every other visual', () => {
		// A writer lists what to do on each kind of display. A reader on a colour
		// one that took the monochrome entry would throw the colour away while
		// reading a file that had it.
		const image = decodeXpm(file('1 1 1 1', 'a m white g #808080 c #ff0000', 'a'));

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('falls back to the four level greyscale when there is no colour key', () => {
		const image = decodeXpm(file('1 1 1 1', 'a m black g4 #404040 g #808080', 'a'));

		expect(coloursOf(image)).toEqual([[0x80, 0x80, 0x80, 255]]);
	});

	it('falls back to g4 when there is neither a colour nor a g key', () => {
		const image = decodeXpm(file('1 1 1 1', 'a m black g4 #404040', 'a'));

		expect(coloursOf(image)).toEqual([[0x40, 0x40, 0x40, 255]]);
	});

	it('falls back to the monochrome key last of all', () => {
		const image = decodeXpm(file('1 1 1 1', 'a s background m white', 'a'));

		expect(coloursOf(image)).toEqual([[255, 255, 255, 255]]);
	});

	it('keeps a multi word colour name together', () => {
		// `navy blue` is one name. Splitting the pairs on whitespace would read
		// `blue` as a key, fail to find one, and lose the entry.
		const image = decodeXpm(file('1 1 1 1', 'a s sky c light sky blue', 'a'));

		expect(coloursOf(image)).toEqual([[135, 206, 250, 255]]);
	});

	it('stops reading a colour entry that does not follow the grammar', () => {
		// The word before the first key is not a key, so there is nothing to read
		// and the entry names no colour. Breaking rather than failing here is what
		// keeps a file with a stray trailing word readable.
		let thrown: unknown;
		try {
			decodeXpm(file('1 1 1 1', 'a junk c red', 'a'));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		expect((thrown as DecodeFailedError).message).toMatch(/no colour this reader can use/);
	});

	it('reads a hotspot in the values string without complaining about it', () => {
		const image = decodeXpm(file('2 1 2 1 3 4', 'a c #ff0000', 'b c #00ff00', 'ab'));

		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it('reads the XPMEXT keyword in the values string', () => {
		const image = decodeXpm(file('1 1 1 1 0 0 XPMEXT', 'a c #ff0000', 'a'));

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('skips comments between the strings', () => {
		const image = decodeXpm(
			xpm([
				'/* XPM */',
				'static char * c[] = {',
				'/* columns rows colors chars-per-pixel */',
				'"2 1 2 1 ",',
				'/* colours */',
				'"a c #ff0000",',
				'"b c #00ff00",',
				'/* pixels */',
				'"ab"',
				'};',
			]),
		);

		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it('does not treat a slash and a star inside a row as a comment', () => {
		// A picture drawn in punctuation is an ordinary thing, and swallowing from
		// there to the next star-slash would take the rest of the image with it.
		const image = decodeXpm(file('2 1 2 1', '/ c #ff0000', '* c #00ff00', '/*'));

		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it('joins two string literals that have no comma between them', () => {
		// C concatenates them, and it is how a writer breaks a wide picture across
		// several source lines.
		const image = decodeXpm(
			xpm([
				'/* XPM */',
				'static char * c[] = {',
				'"4 1 2 1",',
				'"a c #ff0000",',
				'"b c #00ff00",',
				'"ab" "ba"',
				'};',
			]),
		);

		expect(coloursOf(image)).toEqual([RED, GREEN, GREEN, RED]);
	});

	it('reads a backslash escape inside a string', () => {
		const image = decodeXpm(
			file('2 1 2 1', '\\\\ c #ff0000', '" c #00ff00'.replace('"', '\\"'), '\\\\\\"'),
		);

		expect(coloursOf(image)).toEqual([RED, GREEN]);
	});

	it('reads a file with leading whitespace before the marker', () => {
		const image = decodeXpm(
			xpm([
				'',
				'  /* XPM */',
				'static char * c[] = {',
				'"1 1 1 1",',
				'"a c #ff0000",',
				'"a"',
				'};',
			]),
		);

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const bytes = file('1 1 1 1', 'a c #ff0000', 'a');
		const padded = new Uint8Array(bytes.length + 16);
		padded.set(bytes, 8);

		expect(coloursOf(decodeXpm(padded.subarray(8, 8 + bytes.length)))).toEqual([RED]);
	});

	it('reads a colour table with more entries than the picture uses', () => {
		const image = decodeXpm(file('1 1 3 1', 'a c #ff0000', 'b c #00ff00', 'c c #0000ff', 'b'));

		expect(coloursOf(image)).toEqual([GREEN]);
	});

	it('ignores strings after the last row of pixels', () => {
		const image = decodeXpm(file('1 1 1 1', 'a c #ff0000', 'a', 'something else entirely'));

		expect(coloursOf(image)).toEqual([RED]);
	});

	it('reads a picture where two keys resolve to the same colour', () => {
		const image = decodeXpm(file('2 1 2 1', 'a c #ff0000', 'b c red', 'ab'));

		expect(coloursOf(image)).toEqual([RED, RED]);
	});
});

/* ── A file this package did not write ────────────────────────────────── */

describe('decodeXpm against a file from another writer', () => {
	/**
	 * The XPM ImageMagick 7 writes for a four by three picture with two white
	 * pixels in opposite corners and the rest transparent, character for
	 * character.
	 *
	 * Worth having because it is the shape a hand written fixture never quite
	 * produces: a trailing space inside the values string, the `columns rows`
	 * comment, a space as the transparent pixel's key, and `white` as a name
	 * rather than as a hexadecimal value.
	 */
	const magick = [
		'/* XPM */',
		'static char *tiny[] = {',
		'/* columns rows colors chars-per-pixel */',
		'"4 3 2 1 ",',
		'"  c None",',
		'". c white",',
		'/* pixels */',
		'".   ",',
		'"    ",',
		'"   ."',
		'};',
		'',
	];

	it('reads it, transparency and all', () => {
		const image = decodeXpm(xpm(magick));

		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(image.hasAlpha).toBe(true);
		expect(coloursOf(image)).toEqual([
			[255, 255, 255, 255],
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			CLEAR,
			[255, 255, 255, 255],
		]);
	});

	it('re-encodes it to something with the same pixels in it', () => {
		const once = decodeXpm(xpm(magick));
		const twice = decodeXpm(encodeXpm(once));

		expect(pixelsOf(twice)).toEqual(pixelsOf(once));
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeXpm', () => {
	it('writes the whole of a small file, character for character', () => {
		const out = encodeXpm(raster(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]));

		expect(textOf(out)).toBe(
			[
				'/* XPM */',
				'static char * image[] = {',
				'/* columns rows colours characters-per-pixel */',
				'"2 1 2 1",',
				'/* colours */',
				'"! c #ff0000",',
				'"# c #00ff00",',
				'/* pixels */',
				'"!#"',
				'};',
				'',
			].join('\n'),
		);
	});

	it('writes the transparent entry as None rather than as a colour', () => {
		const out = encodeXpm(raster(2, 1, [255, 0, 0, 255, 0, 0, 0, 0], true));

		expect(textOf(out)).toContain('c None');
	});

	it('names the array after the name it is given', () => {
		const out = encodeXpm(raster(1, 1, [1, 2, 3, 255]), { name: 'icon' });

		expect(textOf(out)).toContain('static char * icon[] = {');
	});

	it('replaces anything C cannot use in an identifier', () => {
		const out = encodeXpm(raster(1, 1, [1, 2, 3, 255]), { name: 'my logo-2' });

		expect(textOf(out)).toContain('static char * my_logo_2[] = {');
	});

	it('puts an underscore in front of a name that starts with a digit', () => {
		const out = encodeXpm(raster(1, 1, [1, 2, 3, 255]), { name: '2019' });

		expect(textOf(out)).toContain('static char * _2019[] = {');
	});

	it('falls back to a usable name when the one it is given is empty', () => {
		const out = encodeXpm(raster(1, 1, [1, 2, 3, 255]), { name: '' });

		expect(textOf(out)).toContain('static char * image[] = {');
	});

	it('never spells a pixel with a quote or a backslash', () => {
		// Either one would end the string it is in and turn the rest of the
		// picture into a syntax error in somebody else's build.
		const out = textOf(encodeXpm(noise(20, 20, false)));
		const rows = out.split('\n').filter((line) => line.startsWith('"') && !line.includes(' c '));

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.slice(1, row.lastIndexOf('"'))).not.toMatch(/["\\]/);
		}
	});

	it('stays at one character a pixel while the palette fits in the alphabet', () => {
		const image = createRaster(90, 1, 'srgb', false);
		for (let x = 0; x < 90; x += 1) image.data.set([x, 0, 0, 255], x * 4);
		const out = textOf(encodeXpm(image));

		expect(out).toContain('"90 1 90 1",');
	});

	it('moves to two characters a pixel once the palette outgrows it', () => {
		const image = createRaster(120, 1, 'srgb', false);
		for (let x = 0; x < 120; x += 1) image.data.set([x, 0, 0, 255], x * 4);
		const out = textOf(encodeXpm(image));

		expect(out).toContain('"120 1 120 2",');
	});

	it('honours a palette size that is smaller than the image needs', () => {
		const image = createRaster(64, 1, 'srgb', false);
		for (let x = 0; x < 64; x += 1) image.data.set([x * 4, 255 - x * 4, 128, 255], x * 4);
		const out = textOf(encodeXpm(image, { palette: 4 }));

		expect(out).toContain('"64 1 4 1",');
	});

	it('refuses an image with no pixels', () => {
		const empty = createRaster(0, 0);

		expect(() => encodeXpm(empty)).toThrow(EncodeFailedError);
		expect(() => encodeXpm(empty)).toThrow(/no pixels/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};

		expect(() => encodeXpm(short)).toThrow(EncodeFailedError);
		expect(() => encodeXpm(short)).toThrow(/shorter than/);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('XPM round trips', () => {
	it.each([
		[1, 1],
		[1, 7],
		[7, 1],
		[3, 3],
		[7, 5],
		[16, 16],
		[17, 2],
	])('carries a %i by %i image of few colours through unchanged', (width, height) => {
		const image = createRaster(width, height, 'srgb', false);
		for (let i = 0; i < width * height; i += 1) {
			image.data.set([(i * 40) % 256, (i * 7) % 256, 0, 255], i * 4);
		}
		const back = decodeXpm(encodeXpm(image));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(pixelsOf(back)).toEqual(pixelsOf(image));
	});

	it('carries transparency through unchanged', () => {
		const image = raster(3, 1, [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255], true);
		const back = decodeXpm(encodeXpm(image));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(image));
	});

	it('carries an image that is transparent everywhere through unchanged', () => {
		const image = createRaster(2, 2, 'srgb', true);
		const back = decodeXpm(encodeXpm(image));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual(pixelsOf(image));
	});

	it('carries a two character palette through unchanged', () => {
		const image = createRaster(200, 1, 'srgb', false);
		for (let x = 0; x < 200; x += 1) image.data.set([x, (x * 3) % 256, 0, 255], x * 4);
		const back = decodeXpm(encodeXpm(image));

		expect(pixelsOf(back)).toEqual(pixelsOf(image));
	});

	it('approximates a photograph rather than refusing it', () => {
		const image = noise(32, 32, false);
		const back = decodeXpm(encodeXpm(image));

		expect(back.width).toBe(32);
		expect(back.height).toBe(32);
		// Quantised, so the pixels move. What has to survive is the shape of the
		// picture and the fact that it came back at all.
		expect(back.data.length).toBe(image.data.length);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeXpm refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeXpm(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('xpm');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	it('refuses a file with no XPM marker', () => {
		expectRefusal(xpm(['static char * c[] = {', '"1 1 1 1",', '"a c red",', '"a"', '};']), /XPM/);
	});

	it('refuses an empty file', () => {
		expectRefusal(new Uint8Array(0), /XPM/);
	});

	it('refuses a marker with no array after it', () => {
		expectRefusal(xpm(['/* XPM */']), /no array of strings/);
	});

	it('refuses an array with no strings in it', () => {
		expectRefusal(xpm(['/* XPM */', 'static char * c[] = {', '};']), /array of strings is empty/);
	});

	it('names what the first string should have carried', () => {
		expectRefusal(file('not numbers at all', 'a c red', 'a'), /width, height, colour count/);
	});

	it('refuses a values string with only three numbers', () => {
		expectRefusal(file('1 1 1', 'a c red', 'a'), /width, height, colour count/);
	});

	it('quotes only a readable amount of a very long first string', () => {
		let thrown: unknown;
		try {
			decodeXpm(file('x'.repeat(400), 'a c red', 'a'));
		} catch (error) {
			thrown = error;
		}
		expect((thrown as DecodeFailedError).message).toContain('...');
		expect((thrown as DecodeFailedError).message.length).toBeLessThan(200);
	});

	it('refuses a width of zero', () => {
		expectRefusal(file('0 1 1 1', 'a c red', 'a'), /0 pixels wide/);
	});

	it('refuses a height of zero', () => {
		expectRefusal(file('1 0 1 1', 'a c red', 'a'), /0 pixels tall/);
	});

	it('refuses dimensions far larger than anything it will allocate for', () => {
		expectRefusal(file('60000 60000 1 1', 'a c red', 'a'), /far larger/);
	});

	it('refuses a colour table with no entries', () => {
		expectRefusal(file('1 1 0 1', 'a'), /no entries/);
	});

	it('refuses a colour count no image could have', () => {
		expectRefusal(file('1 1 99999999 1', 'a c red', 'a'), /far more than any image/);
	});

	it('refuses zero characters per pixel', () => {
		expectRefusal(file('1 1 1 0', 'a c red', 'a'), /zero characters per pixel/);
	});

	it('names the ceiling on characters per pixel', () => {
		expectRefusal(file('1 1 1 9', 'a c red', 'a'), /9 characters per pixel/);
	});

	it('refuses a file that stops before its colour table is finished', () => {
		expectRefusal(file('1 1 4 1', 'a c red', 'b c blue'), /promises 4 colours/);
	});

	it('refuses a file that stops before its last row', () => {
		expectRefusal(file('1 3 1 1', 'a c red', 'a', 'a'), /promises 3 rows/);
	});

	it('refuses a colour entry shorter than its own key', () => {
		expectRefusal(file('1 1 1 4', 'ab', 'abcd'), /shorter than the 4/);
	});

	it('refuses a colour entry that names no usable colour', () => {
		expectRefusal(file('1 1 1 1', 'a s background', 'a'), /no colour this reader can use/);
	});

	it('refuses a colour entry with a key and nothing after it', () => {
		expectRefusal(file('1 1 1 1', 'a c', 'a'), /no colour this reader can use/);
	});

	it('names HSV rather than converting it', () => {
		expectRefusal(file('1 1 1 1', 'a c %ff8040', 'a'), /HSV value which this reader does not/);
	});

	it('names a colour it does not know rather than guessing black', () => {
		expectRefusal(file('1 1 1 1', 'a c notacolour', 'a'), /"notacolour", which is not one/);
	});

	it('names a hexadecimal value of a width X11 does not define', () => {
		expectRefusal(file('1 1 1 1', 'a c #ff00', 'a'), /"#ff00", which is not a hexadecimal/);
	});

	it('refuses a hexadecimal value with a digit that is not one', () => {
		expectRefusal(file('1 1 1 1', 'a c #gg0000', 'a'), /not a hexadecimal/);
	});

	it('refuses a hexadecimal value wider than four digits a channel', () => {
		expectRefusal(file('1 1 1 1', 'a c #fffffffffffff00', 'a'), /not a hexadecimal/);
	});

	it('names how long a row should have been', () => {
		expectRefusal(
			file('4 1 1 1', 'a c red', 'aa'),
			/rows of pixels is 2 characters long, where 4 pixels at 1 characters each need 4/,
		);
	});

	it('refuses a row that is too long as well as one that is too short', () => {
		expectRefusal(file('2 1 1 1', 'a c red', 'aaaa'), /is 4 characters long/);
	});

	it('names a pixel its own colour table does not define', () => {
		expectRefusal(file('2 1 1 1', 'a c red', 'ab'), /"b", which its own colour table/);
	});

	it('flattens a control character out of the message it quotes', () => {
		// An error message is the one string that ends up in a screenshot, so a
		// name carrying a newline must not break the line it is printed on.
		let thrown: unknown;
		try {
			decodeXpm(file('1 1 1 1', 'a c no\u0007name', 'a'));
		} catch (error) {
			thrown = error;
		}
		expect((thrown as DecodeFailedError).message).toContain('"no name"');
	});

	it('refuses a string whose last character is an escape', () => {
		expectRefusal(
			xpm(['/* XPM */', 'static char * c[] = {', '"1 1 1 1",', '"a c red\\']),
			/string in it is never closed/,
		);
	});

	it('refuses a comment that is never closed', () => {
		expectRefusal(
			xpm(['/* XPM */', 'static char * c[] = {', '/* off we go', '"1 1 1 1"', '};']),
			/comment in it is never closed/,
		);
	});

	it('refuses a string that is never closed', () => {
		expectRefusal(
			xpm(['/* XPM */', 'static char * c[] = {', '"1 1 1 1",', '"a c red']),
			/string in it is never closed/,
		);
	});
});
