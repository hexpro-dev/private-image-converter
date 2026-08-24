/**
 * An X BitMap reader.
 *
 * XBM is not a binary format. It is a fragment of C that an X11 program used to
 * `#include` and hand straight to `XCreateBitmapFromData`, so a reader for it is
 * a very small C parser rather than a byte layout. Two `#define` lines give the
 * dimensions, two more optionally give a cursor hotspot, and then an array
 * initialiser holds the bits.
 *
 * Three things about it are counterintuitive and each one produces a plausible
 * looking picture rather than an error when it is got wrong.
 *
 * The bits run from the least significant end of each unit, which is the
 * opposite of every other bit-packed format in this package. A reader that fills
 * from the top bit down returns each group of eight pixels mirrored, which on a
 * pattern looks like a slightly different pattern rather than like damage.
 *
 * The unit is usually a byte, but the X10 files still in circulation declare
 * `short` and pack sixteen pixels into each one, which also changes the row
 * padding: a nine pixel row costs two bytes either way, but a seventeen pixel
 * row costs three as bytes and four as shorts. The declared type is the only
 * thing in the file that says which, so it is read rather than assumed.
 *
 * And a set bit is the foreground. That is drawn here as opaque black over
 * transparency rather than as black on white, because a converted XBM is
 * usually an icon or a stipple that is about to go on top of something, and
 * handing back a solid white rectangle with a shape in it is the one result
 * nobody wants. Every viewer draws it this way.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'xbm-pure';

/**
 * The largest image this reader will allocate for.
 *
 * The same ceiling the QOI, TGA and PNM readers use. The dimensions here are
 * two decimal numbers in a text file with nothing to corroborate them, so a
 * forty byte file can honestly claim two billion pixels. The converter applies
 * its own `maxPixels` on top of this; this one exists so the decoder is safe to
 * call on its own.
 */
const MAX_PIXELS = 400_000_000;

/** The largest number any field here is allowed to reach. */
const MAX_NUMBER = 0x7fffffff;

function fail(detail: string): never {
	throw new DecodeFailedError('xbm', DECODER_ID, detail);
}

/** Space, tab, line feed, vertical tab, form feed, carriage return. */
function isSpace(byte: number | undefined): boolean {
	return byte === 0x20 || (byte !== undefined && byte >= 0x09 && byte <= 0x0d);
}

/** What C allows in an identifier, which is also what it allows in a type name. */
function isWordByte(byte: number | undefined): boolean {
	if (byte === undefined) return false;
	return (
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		(byte >= 0x30 && byte <= 0x39) ||
		byte === 0x5f
	);
}

/** The value of one hexadecimal digit, or -1 for anything else. */
function hexDigit(byte: number | undefined): number {
	if (byte === undefined) return -1;
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
	return -1;
}

interface Cursor {
	at: number;
}

/**
 * Read one integer written the way C spells them.
 *
 * All three bases occur. X11's own tools emit hexadecimal, the bitmaps that
 * shipped inside older toolkits are octal, and anything hand written tends to
 * be decimal. A leading zero means octal, which is the trap: `010` is eight,
 * and reading it as ten shifts one row of eight pixels into a different shape.
 *
 * A leading minus is accepted because `static char` is signed on most compilers
 * and a writer that emitted the bytes from a signed array wrote -1 where the
 * file means 0xff. `undefined` comes back when there is no number here at all,
 * which is how the caller tells a finished array from a malformed one.
 */
function readNumber(bytes: Uint8Array, cursor: Cursor): number | undefined {
	const negative = bytes[cursor.at] === 0x2d;
	if (negative) cursor.at += 1;

	let value = 0;
	let digits = 0;
	if (
		bytes[cursor.at] === 0x30 &&
		(bytes[cursor.at + 1] === 0x78 || bytes[cursor.at + 1] === 0x58)
	) {
		cursor.at += 2;
		for (let digit = hexDigit(bytes[cursor.at]); digit >= 0; digit = hexDigit(bytes[cursor.at])) {
			if (value <= MAX_NUMBER) value = value * 16 + digit;
			digits += 1;
			cursor.at += 1;
		}
	} else {
		// A leading zero makes the rest octal, so 8 and 9 end the number rather
		// than continuing it. That is C's rule and it is worth reproducing
		// exactly: `010` is eight, and reading it as ten moves one row of eight
		// pixels into a different shape without anything looking wrong. A file
		// with `09` in it stops at the 9, which the caller then sees as a stray
		// digit where a separator should be and refuses by name.
		const octal = bytes[cursor.at] === 0x30;
		const last = octal ? 0x37 : 0x39;
		while (true) {
			const byte = bytes[cursor.at];
			if (byte === undefined || byte < 0x30 || byte > last) break;
			if (value <= MAX_NUMBER) value = value * (octal ? 8 : 10) + (byte - 0x30);
			digits += 1;
			cursor.at += 1;
		}
	}

	if (digits === 0) {
		// The minus was not part of a number after all, so put it back rather
		// than leaving the cursor somewhere the caller did not expect.
		if (negative) cursor.at -= 1;
		return undefined;
	}
	if (value > MAX_NUMBER) return MAX_NUMBER + 1;
	return negative ? -value : value;
}

interface Dimensions {
	readonly width: number;
	readonly height: number;
	/** Where the last `#define` ended, which is where the declaration begins. */
	readonly after: number;
}

/**
 * Read every `#define` in the file and keep the ones that name a dimension.
 *
 * Matched by suffix rather than by full name, because the identifier is derived
 * from whatever the file was called when somebody ran `bitmap` on it and is
 * never the same twice. The hotspot pair is read and discarded: it is where a
 * cursor's point is, which means nothing once the bitmap is a picture, and a
 * reader that refused files carrying one would refuse every mouse cursor in X.
 */
function readDefines(bytes: Uint8Array): Dimensions {
	let width: number | undefined;
	let height: number | undefined;
	let after = 0;

	for (let at = 0; at + 7 <= bytes.length; at += 1) {
		if (bytes[at] !== 0x23) continue;
		if (
			bytes[at + 1] !== 0x64 ||
			bytes[at + 2] !== 0x65 ||
			bytes[at + 3] !== 0x66 ||
			bytes[at + 4] !== 0x69 ||
			bytes[at + 5] !== 0x6e ||
			bytes[at + 6] !== 0x65
		) {
			continue;
		}

		const cursor: Cursor = { at: at + 7 };
		while (isSpace(bytes[cursor.at])) cursor.at += 1;
		const nameFrom = cursor.at;
		while (isWordByte(bytes[cursor.at])) cursor.at += 1;
		const name = asciiOf(bytes, nameFrom, cursor.at);
		while (isSpace(bytes[cursor.at])) cursor.at += 1;
		const value = readNumber(bytes, cursor);

		at = cursor.at - 1;
		if (value === undefined) continue;
		after = cursor.at;
		if (name.endsWith('width')) width = value;
		else if (name.endsWith('height')) height = value;
	}

	if (width === undefined) {
		fail('it has no "#define" line ending in "_width", so nothing in it says how wide it is.');
	}
	if (height === undefined) {
		fail('it has no "#define" line ending in "_height", so nothing in it says how tall it is.');
	}
	if (width < 1 || height < 1) {
		fail(`it declares an image ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width > MAX_NUMBER || height > MAX_NUMBER || width * height > MAX_PIXELS) {
		fail('it declares an image far larger than anything this reader will allocate for.');
	}
	return { width, height, after };
}

/** A short run of bytes as text. Only ever called on an identifier or a declaration. */
function asciiOf(bytes: Uint8Array, from: number, to: number): string {
	let text = '';
	for (let at = from; at < to; at += 1) text += String.fromCharCode(bytes[at] as number);
	return text;
}

/**
 * Whether the array is declared as shorts rather than as bytes.
 *
 * The word boundaries matter more than they look. An X10 file is
 * `static unsigned short frog_bits[]`, and the identifier itself often ends in
 * `_bits` but can be anything: a bitmap called `shortcut` would give
 * `shortcut_bits`, and a plain substring test would read its bytes as shorts
 * and return a picture stretched to twice the width with every other column
 * blank. Underscore counts as a word byte, so `short_bits` does not match
 * either, which is exactly right: that is a name, not a type.
 */
function declaresShorts(declaration: string): boolean {
	return /(^|[^\w])short([^\w]|$)/.test(declaration);
}

export function decodeXbm(bytes: Uint8Array): RasterImage {
	const { width, height, after } = readDefines(bytes);

	let brace = -1;
	for (let at = after; at < bytes.length; at += 1) {
		if (bytes[at] === 0x7b) {
			brace = at;
			break;
		}
	}
	if (brace < 0) fail('it has no array of bits after its dimensions, so there is nothing to draw.');

	const unitBits = declaresShorts(asciiOf(bytes, after, brace)) ? 16 : 8;
	const unitMax = unitBits === 16 ? 0xffff : 0xff;
	const unitsPerRow = Math.ceil(width / unitBits);
	const needed = unitsPerRow * height;

	// Allocated for exactly what the dimensions ask for rather than grown as the
	// array is read, so a file that claims a small image and then carries a
	// hundred megabytes of values cannot spend memory on any of them.
	const units = new Uint16Array(needed);
	const cursor: Cursor = { at: brace + 1 };
	let count = 0;

	while (cursor.at < bytes.length) {
		const byte = bytes[cursor.at];
		if (isSpace(byte) || byte === 0x2c) {
			cursor.at += 1;
			continue;
		}
		if (byte === 0x7d) break;
		const value = readNumber(bytes, cursor);
		if (value === undefined) {
			fail(`its array holds something that is not a number, ${count} values in.`);
		}
		// A value has to end where a value can end. Without this a truncated
		// `0x` or a stray letter would be read as the number in front of it and
		// the array would come up one value short somewhere else entirely.
		const next = bytes[cursor.at];
		if (next !== undefined && !isSpace(next) && next !== 0x2c && next !== 0x7d) {
			fail(`its array holds something that is not a number, ${count} values in.`);
		}
		if (value > unitMax || value < -unitMax - 1) {
			fail(`its array holds the value ${value}, which does not fit in the type it declares.`);
		}
		// Negative values are what a signed `char` array looks like when it was
		// written out from memory, and & is exactly the conversion a C compiler
		// would apply on the way back in.
		if (count < needed) units[count] = value & unitMax;
		count += 1;
	}

	if (count < needed) {
		fail(`its array holds ${count} values, and a ${width} by ${height} bitmap needs ${needed}.`);
	}

	const image = createRaster(width, height, 'srgb', true);
	const target = image.data;
	for (let y = 0; y < height; y += 1) {
		const row = y * unitsPerRow;
		for (let x = 0; x < width; x += 1) {
			const unit = units[row + Math.floor(x / unitBits)] as number;
			// Least significant bit first, which is the whole trap of the format.
			if (((unit >> (x % unitBits)) & 1) === 1) {
				// The colour channels are already zero from the allocation, so a
				// set bit only has to become opaque to be black.
				target[(y * width + x) * 4 + 3] = 255;
			}
		}
	}

	return { ...image, hasAlpha: detectAlpha(image) };
}
