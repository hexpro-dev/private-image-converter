/**
 * A Netpbm (PNM) reader, covering all six of P1 to P6.
 *
 * The six are one header grammar over two encodings of three pixel types, so
 * they are one reader rather than six: the header parser is shared, and the
 * only real divergence is how a sample is spelled once the header ends.
 *
 * Two traps are worth naming, because both produce a plausible looking image
 * rather than an error when they are got wrong. In P1 and P4 a set bit means
 * black, which is the reverse of every other member of the family and of every
 * other image format in this package. And a comment may appear anywhere in the
 * header, including between the width and the height, so a header cannot be
 * read by splitting on whitespace.
 */

import type { RasterImage } from '../../types.js';
import { DecodeFailedError } from '../../errors.js';
import { createRaster } from '../../raster/image.js';

const DECODER_ID = 'pnm-pure';

const HASH = 0x23;
const ZERO = 0x30;
const ONE = 0x31;
const NINE = 0x39;

/**
 * The largest number a header field is allowed to reach.
 *
 * Nothing in the format bounds a dimension, but the accumulator has to stay a
 * safe integer for the size arithmetic below to mean anything, and a file
 * claiming two billion pixels across is not a file we are going to finish
 * reading either way.
 */
const MAX_HEADER_NUMBER = 0x7fffffff;

/**
 * The largest image this decoder will allocate for.
 *
 * The same ceiling the QOI and TGA readers use. The room check below is
 * relative to what is left of the file, which is enough for the formats that
 * spend a byte or more on a pixel, but P4 spends a bit: a hundred megabyte
 * bitmap honestly describes eight hundred million pixels and asks for three
 * gigabytes of raster for them. The converter applies its own `maxPixels` on
 * top of this; this one exists so the decoder is safe to call on its own.
 */
const MAX_PIXELS = 400_000_000;

function fail(detail: string): never {
	throw new DecodeFailedError('pnm', DECODER_ID, detail);
}

/** Space, tab, line feed, vertical tab, form feed, carriage return. */
function isWhitespace(byte: number): boolean {
	return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

interface Cursor {
	at: number;
}

/**
 * Advance past whitespace and comments.
 *
 * A comment runs from '#' to the end of the line. The terminating newline is
 * left for the whitespace branch to eat, which also handles a comment that runs
 * to the end of the file.
 */
function skipGaps(bytes: Uint8Array, cursor: Cursor): void {
	while (cursor.at < bytes.length) {
		const byte = bytes[cursor.at] as number;
		if (isWhitespace(byte)) {
			cursor.at += 1;
		} else if (byte === HASH) {
			while (cursor.at < bytes.length) {
				const inner = bytes[cursor.at] as number;
				if (inner === 0x0a || inner === 0x0d) break;
				cursor.at += 1;
			}
		} else {
			return;
		}
	}
}

/**
 * Read a run of decimal digits at the cursor, without skipping anything first.
 *
 * Returns undefined when there are no digits there. Accumulation saturates
 * rather than overflowing, because a caller either clamps the result against
 * the maximum sample value or rejects it as implausible, and neither wants a
 * number that has silently stopped being an integer.
 */
function readDecimal(bytes: Uint8Array, cursor: Cursor): number | undefined {
	const start = cursor.at;
	let value = 0;
	while (cursor.at < bytes.length) {
		const byte = bytes[cursor.at] as number;
		if (byte < ZERO || byte > NINE) break;
		if (value <= MAX_HEADER_NUMBER) value = value * 10 + (byte - ZERO);
		cursor.at += 1;
	}
	if (cursor.at === start) return undefined;
	return Math.min(value, MAX_HEADER_NUMBER + 1);
}

function readHeaderNumber(bytes: Uint8Array, cursor: Cursor, what: string): number {
	skipGaps(bytes, cursor);
	if (cursor.at >= bytes.length) fail(`the header ends before the ${what}.`);
	const value = readDecimal(bytes, cursor);
	if (value === undefined) fail(`the ${what} in the header is not a number.`);
	if (value > MAX_HEADER_NUMBER) fail(`the ${what} in the header is implausibly large.`);
	// A field has to end at whitespace, a comment or the end of the file.
	// Anything else means we have misread the header and would otherwise carry
	// on confidently into the wrong bytes.
	if (cursor.at < bytes.length) {
		const after = bytes[cursor.at] as number;
		if (!isWhitespace(after) && after !== HASH) fail(`the ${what} in the header is not a number.`);
	}
	return value;
}

/**
 * Consume the one whitespace byte that ends a binary header.
 *
 * Exactly one. Once that byte is gone the next byte is a pixel, and a pixel
 * worth 35 is indistinguishable from the start of a comment, so a '#' after the
 * whitespace is data and eating it would take a row of a legitimate file with
 * it.
 *
 * A '#' *before* that whitespace is the other case, and it is a comment. The
 * last header field ended at the hash rather than at a space, so the comment is
 * still inside the header and the newline that closes it is the byte that ends
 * the header. Netpbm reads it this way and so does ImageMagick, and a writer
 * that puts a note straight after the maximum sample value is otherwise writing
 * a file nothing else refuses.
 */
function endBinaryHeader(bytes: Uint8Array, cursor: Cursor): void {
	if (cursor.at >= bytes.length) fail('the file ends where the pixel data should begin.');
	if ((bytes[cursor.at] as number) === HASH) {
		while (cursor.at < bytes.length) {
			const byte = bytes[cursor.at] as number;
			cursor.at += 1;
			if (byte === 0x0a || byte === 0x0d) return;
		}
		fail('a comment at the end of the header runs off the end of the file.');
	}
	if (!isWhitespace(bytes[cursor.at] as number)) {
		fail('the header is not followed by a whitespace byte.');
	}
	cursor.at += 1;
}

/** Rescale a sample from its own range onto the 0 to 255 the raster uses. */
function scaleSample(value: number, maxval: number): number {
	const clamped = value > maxval ? maxval : value;
	if (maxval === 255) return clamped;
	return Math.round((clamped * 255) / maxval);
}

function setPixel(target: Uint8ClampedArray, at: number, r: number, g: number, b: number): void {
	target[at] = r;
	target[at + 1] = g;
	target[at + 2] = b;
	target[at + 3] = 255;
}

/**
 * Refuse a header that describes more pixels than the rest of the file could
 * possibly hold, before anything is allocated.
 *
 * A two byte change to a header turns a small file into a claim of a billion
 * pixels, and the buffer for that is allocated long before the read runs out of
 * bytes and notices. `minimumBytes` is the smallest the data could be under the
 * encoding in question, so this rejects only headers that are already lying.
 */
function requireRoom(bytes: Uint8Array, cursor: Cursor, minimumBytes: number, what: string): void {
	const remaining = bytes.length - cursor.at;
	if (minimumBytes > remaining) {
		fail(`the header describes ${what}, which is more than the remaining ${remaining} bytes hold.`);
	}
}

/* ── P1: ASCII bitmap ─────────────────────────────────────────────────── */

function decodeAsciiBitmap(
	bytes: Uint8Array,
	cursor: Cursor,
	width: number,
	height: number,
): RasterImage {
	const pixels = width * height;
	// One character per pixel is legal in P1: the separating whitespace is
	// optional because a sample is a single digit.
	requireRoom(bytes, cursor, pixels, `${width} by ${height} pixels`);

	const image = createRaster(width, height, 'srgb', false);
	for (let i = 0; i < pixels; i += 1) {
		skipGaps(bytes, cursor);
		if (cursor.at >= bytes.length) fail(`the pixel data ends after ${i} of ${pixels} pixels.`);
		const byte = bytes[cursor.at] as number;
		if (byte !== ZERO && byte !== ONE) {
			fail(`the pixel data holds something other than 0 or 1 at pixel ${i}.`);
		}
		cursor.at += 1;
		// A set bit is black here, the reverse of every other Netpbm format.
		const level = byte === ZERO ? 255 : 0;
		setPixel(image.data, i * 4, level, level, level);
	}
	return image;
}

/* ── P2 and P3: ASCII greymap and pixmap ──────────────────────────────── */

function decodeAsciiSamples(
	bytes: Uint8Array,
	cursor: Cursor,
	width: number,
	height: number,
	maxval: number,
	channels: number,
): RasterImage {
	const pixels = width * height;
	const samples = pixels * channels;
	// Every sample needs at least one digit, and all but the last needs a
	// separator as well.
	requireRoom(bytes, cursor, samples * 2 - 1, `${width} by ${height} pixels`);

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;
	const values = [0, 0, 0];

	for (let i = 0; i < pixels; i += 1) {
		for (let channel = 0; channel < channels; channel += 1) {
			// Comments are tolerated in the data as well as the header. Netpbm's
			// own reader allows them, and '#' cannot begin a sample, so there is
			// nothing a valid file could mean by it instead.
			skipGaps(bytes, cursor);
			if (cursor.at >= bytes.length) {
				fail(`the pixel data ends after ${i * channels + channel} of ${samples} samples.`);
			}
			const value = readDecimal(bytes, cursor);
			if (value === undefined) {
				fail(
					`the pixel data holds something that is not a number at sample ${i * channels + channel}.`,
				);
			}
			values[channel] = scaleSample(value, maxval);
		}
		const first = values[0] as number;
		if (channels === 1) {
			setPixel(target, i * 4, first, first, first);
		} else {
			setPixel(target, i * 4, first, values[1] as number, values[2] as number);
		}
	}
	return image;
}

/* ── P4: binary bitmap ────────────────────────────────────────────────── */

function decodeBinaryBitmap(
	bytes: Uint8Array,
	cursor: Cursor,
	width: number,
	height: number,
): RasterImage {
	// Each row starts on a byte boundary, so a row of 9 pixels costs 2 bytes and
	// the last 7 bits are padding that carries no pixel.
	//
	// Divided rather than shifted. `>>` truncates to a signed 32 bit integer
	// first, so `(width + 7) >> 3` turns negative for the top seven widths a
	// header can carry, the room check below then passes against a negative
	// requirement, and a twelve byte file gets to ask for an eight gigabyte
	// buffer and a two billion pixel image made of nothing.
	const rowBytes = Math.ceil(width / 8);
	requireRoom(bytes, cursor, rowBytes * height, `${width} by ${height} pixels`);

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;
	for (let y = 0; y < height; y += 1) {
		const row = cursor.at + y * rowBytes;
		for (let x = 0; x < width; x += 1) {
			const byte = bytes[row + (x >> 3)] as number;
			// The most significant bit is the leftmost pixel.
			const bit = (byte >> (7 - (x & 7))) & 1;
			const level = bit === 1 ? 0 : 255;
			setPixel(target, (y * width + x) * 4, level, level, level);
		}
	}
	cursor.at += rowBytes * height;
	return image;
}

/* ── P5 and P6: binary greymap and pixmap ─────────────────────────────── */

function decodeBinarySamples(
	bytes: Uint8Array,
	cursor: Cursor,
	width: number,
	height: number,
	maxval: number,
	channels: number,
): RasterImage {
	// A maximum above 255 means each sample is two bytes, most significant
	// first. Nothing else in the header says so.
	const sampleBytes = maxval > 255 ? 2 : 1;
	const pixels = width * height;
	requireRoom(bytes, cursor, pixels * channels * sampleBytes, `${width} by ${height} pixels`);

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;
	let at = cursor.at;
	const values = [0, 0, 0];

	for (let i = 0; i < pixels; i += 1) {
		for (let channel = 0; channel < channels; channel += 1) {
			let raw: number;
			if (sampleBytes === 2) {
				raw = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
				at += 2;
			} else {
				raw = bytes[at] as number;
				at += 1;
			}
			values[channel] = scaleSample(raw, maxval);
		}
		const first = values[0] as number;
		if (channels === 1) {
			setPixel(target, i * 4, first, first, first);
		} else {
			setPixel(target, i * 4, first, values[1] as number, values[2] as number);
		}
	}
	cursor.at = at;
	return image;
}

/* ── Entry point ──────────────────────────────────────────────────────── */

/**
 * Read a Netpbm file of any of the six types P1 to P6.
 *
 * The result is always opaque RGBA in sRGB: the format has no alpha channel and
 * no way to record a colour space, and inventing either would be worse than
 * saying plainly that it is sRGB. Bytes after the first image are ignored, so a
 * concatenated multi-image file reads as its first frame rather than as damage.
 */
export function decodePnm(bytes: Uint8Array): RasterImage {
	if (bytes.length < 3) fail('the file is too short to be a Netpbm image.');
	if (bytes[0] !== 0x50) fail('the file does not begin with the Netpbm magic number.');

	const kind = (bytes[1] as number) - ZERO;
	if (kind === 7) {
		// P7 is PAM, a different header grammar with named fields and an alpha
		// channel. The sniffer accepts it as PNM, so it is refused by name here
		// rather than misread as a pixmap.
		fail('this is a PAM (P7) file, which this reader does not handle.');
	}
	if (kind < 1 || kind > 6) fail('the magic number is not one of P1 to P6.');

	const afterMagic = bytes[2] as number;
	if (!isWhitespace(afterMagic) && afterMagic !== HASH) {
		fail('the magic number is not followed by whitespace.');
	}

	const cursor: Cursor = { at: 2 };
	const width = readHeaderNumber(bytes, cursor, 'width');
	const height = readHeaderNumber(bytes, cursor, 'height');
	if (width < 1 || height < 1) {
		fail(`the header describes an image ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}

	const bitmap = kind === 1 || kind === 4;
	let maxval = 1;
	if (!bitmap) {
		maxval = readHeaderNumber(bytes, cursor, 'maximum sample value');
		if (maxval < 1) fail('the header gives a maximum sample value of zero.');
		if (maxval > 65535) {
			fail(`the header gives a maximum sample value of ${maxval}, and Netpbm stops at 65535.`);
		}
	}
	if (kind >= 4) endBinaryHeader(bytes, cursor);

	switch (kind) {
		case 1:
			return decodeAsciiBitmap(bytes, cursor, width, height);
		case 2:
			return decodeAsciiSamples(bytes, cursor, width, height, maxval, 1);
		case 3:
			return decodeAsciiSamples(bytes, cursor, width, height, maxval, 3);
		case 4:
			return decodeBinaryBitmap(bytes, cursor, width, height);
		case 5:
			return decodeBinarySamples(bytes, cursor, width, height, maxval, 1);
		default:
			return decodeBinarySamples(bytes, cursor, width, height, maxval, 3);
	}
}
