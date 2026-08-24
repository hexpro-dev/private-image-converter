/**
 * An X PixMap reader, version 3.
 *
 * XPM is XBM's colour successor and, like XBM, it is a fragment of C rather than
 * a binary format: a marker comment, an array of string literals, and a small
 * grammar inside the strings. The first string gives the dimensions, how many
 * colours there are and how many characters stand for one pixel. Then come that
 * many colour lines, then one string per row of the picture.
 *
 * Three details are worth naming because each of them silently returns a
 * picture rather than an error when it is got wrong.
 *
 * A colour line carries several colours, not one: the same entry can name what
 * to draw on a colour screen, on a four level greyscale, on a two level
 * greyscale and on a monochrome one. A reader that takes the first it sees gets
 * a black and white version of a colour image whenever the writer put the
 * monochrome key first, which plenty do.
 *
 * The characters that stand for a pixel are fixed width and may be any printable
 * character, including spaces, so a row cannot be split on whitespace and a
 * colour line's key cannot be found by looking for the first non-space. The key
 * is the first `cpp` characters, whatever they happen to be.
 *
 * And C comments may appear between any two strings, including inside the
 * colour table, so the strings have to be found by a scan rather than by
 * splitting the file into lines.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';
import { X11_COLOURS } from './colours.js';

const DECODER_ID = 'xpm-pure';

/**
 * The largest image this reader will allocate for.
 *
 * The same ceiling the QOI, TGA and PNM readers use. The converter applies its
 * own `maxPixels` on top of this; this one exists so the decoder is safe to
 * call on its own.
 */
const MAX_PIXELS = 400_000_000;

/**
 * The most characters per pixel this reader will accept.
 *
 * The format puts no limit on it, but four characters already index four
 * thousand million colours, and this field is what decides how many characters
 * are taken off the front of every pixel row. A file claiming a large one is
 * either damaged or is trying to make that arithmetic overflow.
 */
const MAX_CHARS_PER_PIXEL = 8;

/** Far more entries than any real image has, and well short of an allocation bomb. */
const MAX_COLOURS = 1 << 20;

/** The keys a colour line may use. */
const COLOUR_KEYS: readonly string[] = ['c', 'g', 'g4', 'm', 's'];

/**
 * The keys that actually name a colour, in the order this reader prefers them.
 *
 * `s` is missing on purpose: it is a symbolic name for the entry, meant to be
 * resolved against the application's own colour scheme at load time, and there
 * is nothing here to resolve it against.
 */
const VISUAL_KEYS: readonly string[] = ['c', 'g', 'g4', 'm'];

interface Colour {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

const TRANSPARENT: Colour = { r: 0, g: 0, b: 0, a: 0 };

function fail(detail: string): never {
	throw new DecodeFailedError('xpm', DECODER_ID, detail);
}

/**
 * Quote a fragment of the file for an error message.
 *
 * Bounded, because the "name" a damaged file gives a colour can be the rest of
 * the file. An error message is the one string that ends up in a screenshot, so
 * it gets a readable amount of it and nothing more, with control characters
 * flattened so the message stays on one line.
 */
function quoted(text: string): string {
	const trimmed = text.length > 32 ? `${text.slice(0, 32)}...` : text;
	let safe = '';
	for (const character of trimmed) {
		const code = character.charCodeAt(0);
		safe += code < 0x20 || code === 0x7f ? ' ' : character;
	}
	return `"${safe}"`;
}

/**
 * The file as text.
 *
 * Chunked rather than one spread call: `String.fromCharCode(...bytes)` puts the
 * whole array on the argument stack, which throws a RangeError somewhere above
 * a hundred thousand arguments and would take every ordinary XPM larger than a
 * small icon with it. Each byte becomes the character of the same value, so a
 * high byte inside a colour name survives to be reported rather than turning
 * into a replacement character.
 */
function textOf(bytes: Uint8Array): string {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return text;
}

/**
 * Every string literal in the initialiser, in order.
 *
 * Adjacent literals with no comma between them are joined, because that is what
 * C does with them and because it is how a writer breaks a wide picture across
 * several source lines. Comments are skipped, but only outside a literal: a
 * pixel row of a picture drawn in slashes and stars is a perfectly ordinary
 * thing, and treating one as the start of a comment would swallow the rest of
 * the image.
 */
function readStrings(text: string, from: number): string[] {
	const strings: string[] = [];
	let current: string | undefined;
	let at = from;

	while (at < text.length) {
		const character = text[at] as string;
		if (character === '/' && text[at + 1] === '*') {
			const end = text.indexOf('*/', at + 2);
			if (end < 0) fail('a comment in it is never closed.');
			at = end + 2;
			continue;
		}
		if (character === '"') {
			let literal = '';
			at += 1;
			while (at < text.length && text[at] !== '"') {
				// A backslash makes the next character literal, which is how a
				// colour name containing a quote is written. Nothing else about
				// C's escapes is reproduced: a `\n` in a pixel row would stand
				// for a pixel nothing can index, so leaving it as the letter is
				// both simpler and easier to explain when it goes wrong.
				if (text[at] === '\\') at += 1;
				literal += text[at] ?? '';
				at += 1;
			}
			if (at >= text.length) fail('a string in it is never closed.');
			at += 1;
			current = current === undefined ? literal : current + literal;
			continue;
		}
		if (character === ',') {
			if (current !== undefined) strings.push(current);
			current = undefined;
			at += 1;
			continue;
		}
		if (character === '}') break;
		at += 1;
	}

	if (current !== undefined) strings.push(current);
	return strings;
}

interface Values {
	readonly width: number;
	readonly height: number;
	readonly colours: number;
	readonly charsPerPixel: number;
}

/**
 * The first string: four numbers, then an optional hotspot and an optional
 * XPMEXT keyword.
 *
 * The hotspot is read past rather than refused. It is where a cursor's point
 * sits, which means nothing once the pixmap is a picture, and every X cursor
 * ever drawn carries one. XPMEXT announces extension data after the pixels,
 * which is application defined and none of a decoder's business.
 */
function readValues(text: string): Values {
	const fields = text.trim().split(/\s+/);
	const numbers: number[] = [];
	for (const field of fields.slice(0, 4)) {
		if (!/^\d+$/.test(field)) break;
		numbers.push(Number.parseInt(field, 10));
	}
	if (numbers.length < 4) {
		fail(
			`its first string is ${quoted(text)}, where the width, height, colour count and characters per pixel should be.`,
		);
	}

	const [width, height, colours, charsPerPixel] = numbers as [number, number, number, number];
	if (width < 1 || height < 1) {
		fail(`it declares an image ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('it declares an image far larger than anything this reader will allocate for.');
	}
	if (colours < 1) fail('it declares a colour table with no entries in it.');
	if (colours > MAX_COLOURS) fail(`it declares ${colours} colours, far more than any image uses.`);
	if (charsPerPixel < 1) fail('it declares zero characters per pixel, which indexes nothing.');
	if (charsPerPixel > MAX_CHARS_PER_PIXEL) {
		fail(
			`it declares ${charsPerPixel} characters per pixel, and this reader stops at ${MAX_CHARS_PER_PIXEL}.`,
		);
	}
	return { width, height, colours, charsPerPixel };
}

/** Widen one hexadecimal group to eight bits, whatever width it was written at. */
function channelOf(digits: string): number {
	const value = Number.parseInt(digits, 16);
	// The top bits, which is what X11 does: `#fff` is white, where reading three
	// digits as an eight bit number would make it a very dark grey.
	if (digits.length === 1) return value * 0x11;
	if (digits.length === 2) return value;
	if (digits.length === 3) return value >> 4;
	return value >> 8;
}

function parseColour(value: string): Colour {
	// Case insensitive, because the specification writes it `None` and writers
	// in the wild have used every other spelling of it.
	if (value.toLowerCase() === 'none') return TRANSPARENT;

	if (value.startsWith('#')) {
		const digits = value.slice(1);
		// One, two, three or four digits a channel. X11 accepts all four widths
		// and XPM inherits the lot, so refusing the odd ones would refuse files
		// that every other reader opens.
		if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length % 3 !== 0 || digits.length > 12) {
			fail(`it gives a colour as ${quoted(value)}, which is not a hexadecimal value X11 defines.`);
		}
		const each = digits.length / 3;
		return {
			r: channelOf(digits.slice(0, each)),
			g: channelOf(digits.slice(each, each * 2)),
			b: channelOf(digits.slice(each * 2)),
			a: 255,
		};
	}

	if (value.startsWith('%')) {
		// X11's own parser has never implemented these either. The syntax is
		// reserved in the XPM specification and the few files using it came out
		// of one editor, so a sentence naming it is worth more than a conversion
		// with nothing to check it against.
		fail(`it gives a colour as ${quoted(value)}, an HSV value which this reader does not convert.`);
	}

	// X11 matches a colour name with case and spaces ignored, so `Navy Blue`,
	// `navyblue` and `NAVYBLUE` are one name.
	const packed = X11_COLOURS[value.toLowerCase().replace(/\s+/g, '')];
	if (packed === undefined) {
		fail(`it names the colour ${quoted(value)}, which is not one this reader knows.`);
	}
	return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff, a: 255 };
}

/**
 * Split the part of a colour line after the key into its key and value pairs.
 *
 * A value may be several words long, because X11 colour names are: `navy blue`
 * and `light steel blue` are both in `rgb.txt`. So a value runs until the next
 * word that is one of the five keys rather than until the next space. That is
 * how libXpm does it, and it is the only reading that survives a real file.
 */
function readPairs(line: string): Map<string, string> {
	const pairs = new Map<string, string>();
	const words = line.trim().split(/\s+/).filter(Boolean);
	let at = 0;
	while (at < words.length) {
		const key = words[at] as string;
		if (!COLOUR_KEYS.includes(key)) {
			// Not a key, so the line stops following the grammar here. Breaking
			// rather than failing keeps a file with a stray trailing word
			// readable, and an entry that named no usable colour is still
			// refused by the caller.
			break;
		}
		at += 1;
		const value: string[] = [];
		while (at < words.length && !COLOUR_KEYS.includes(words[at] as string)) {
			value.push(words[at] as string);
			at += 1;
		}
		if (value.length > 0) pairs.set(key, value.join(' '));
	}
	return pairs;
}

export function decodeXpm(bytes: Uint8Array): RasterImage {
	const text = textOf(bytes);
	if (!/^\s*\/\*\s*XPM\s*\*\//.test(text)) {
		fail('it does not begin with the "/* XPM */" comment every XPM version 3 file opens with.');
	}

	const brace = text.indexOf('{');
	if (brace < 0) fail('it has no array of strings, so there is nothing to read.');

	const strings = readStrings(text, brace + 1);
	if (strings.length === 0) fail('its array of strings is empty.');

	const { width, height, colours, charsPerPixel } = readValues(strings[0] as string);
	if (strings.length < 1 + colours) {
		fail(
			`it promises ${colours} colours and carries only ${strings.length - 1} strings after its first.`,
		);
	}
	if (strings.length < 1 + colours + height) {
		fail(
			`it promises ${height} rows of pixels and carries only ${strings.length - 1 - colours} strings after its colour table.`,
		);
	}

	const table = new Map<string, Colour>();
	for (let i = 0; i < colours; i += 1) {
		const line = strings[1 + i] as string;
		if (line.length < charsPerPixel) {
			fail(
				`one of its colour entries is ${line.length} characters long, which is shorter than the ${charsPerPixel} that stand for a pixel.`,
			);
		}
		const key = line.slice(0, charsPerPixel);
		const pairs = readPairs(line.slice(charsPerPixel));

		// Colour first, then the two greyscales, then monochrome. Taking them in
		// this order is the whole point of the multi-key grammar: a writer lists
		// what to do on every visual it supports, and a reader on a colour
		// display that took the monochrome entry would throw the colour away
		// while reading a file that had it.
		let chosen: string | undefined;
		for (const visual of VISUAL_KEYS) {
			chosen = pairs.get(visual);
			if (chosen !== undefined) break;
		}
		if (chosen === undefined) {
			fail('one of its colour entries gives no colour this reader can use.');
		}
		table.set(key, parseColour(chosen));
	}

	const image = createRaster(width, height, 'srgb', true);
	const target = image.data;
	const expected = width * charsPerPixel;

	for (let y = 0; y < height; y += 1) {
		const row = strings[1 + colours + y] as string;
		if (row.length !== expected) {
			fail(
				`one of its rows of pixels is ${row.length} characters long, where ${width} pixels at ${charsPerPixel} characters each need ${expected}.`,
			);
		}
		for (let x = 0; x < width; x += 1) {
			const key = row.slice(x * charsPerPixel, (x + 1) * charsPerPixel);
			const colour = table.get(key);
			if (colour === undefined) {
				fail(`one of its rows uses ${quoted(key)}, which its own colour table does not define.`);
			}
			const at = (y * width + x) * 4;
			target[at] = colour.r;
			target[at + 1] = colour.g;
			target[at + 2] = colour.b;
			target[at + 3] = colour.a;
		}
	}

	// XPM has no way to record a colour space, so the numbers are sRGB by the
	// same convention every reader of it applies.
	return { ...image, hasAlpha: detectAlpha(image) };
}
