/**
 * A Netpbm (PNM) reader, covering all seven of P1 to P6 and PAM.
 *
 * P1 to P6 are one header grammar over two encodings of three pixel types, so
 * they are one reader rather than six: the header parser is shared, and the
 * only real divergence is how a sample is spelled once the header ends. PAM
 * (P7) is a second header grammar over the same sample encodings, which is why
 * it is here rather than in a file of its own: its header is named lines rather
 * than bare numbers, and everything after ENDHDR is read by the code P5 and P6
 * already use.
 *
 * Three traps are worth naming, because each produces a plausible looking image
 * rather than an error when it is got wrong. In P1 and P4 a set bit means
 * black, which is the reverse of every other member of the family, PAM's own
 * BLACKANDWHITE included, and of every other image format in this package. A
 * comment may appear anywhere in a P1 to P6 header, including between the width
 * and the height, so that header cannot be read by splitting on whitespace. And
 * a PAM comment is a whole line rather than a run to the end of one, so the two
 * header grammars do not share a comment rule either.
 */

import type { RasterImage } from '../../types.js';
import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';

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

function setPixel(
	target: Uint8ClampedArray,
	at: number,
	r: number,
	g: number,
	b: number,
	a = 255,
): void {
	target[at] = r;
	target[at + 1] = g;
	target[at + 2] = b;
	target[at + 3] = a;
}

/**
 * The two header checks every member of the family shares.
 *
 * P1 to P6 spell their dimensions as two bare numbers and PAM spells them as
 * two named lines, but a zero is malformed and an implausible size is a bomb in
 * either grammar, so the answers are given in one place rather than twice.
 */
function checkDimensions(width: number, height: number): void {
	if (width < 1 || height < 1) {
		fail(`the header describes an image ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}
}

function checkMaxval(maxval: number): void {
	if (maxval < 1) fail('the header gives a maximum sample value of zero.');
	if (maxval > 65535) {
		fail(`the header gives a maximum sample value of ${maxval}, and Netpbm stops at 65535.`);
	}
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

/* ── P5, P6 and PAM: binary samples ───────────────────────────────────── */

/**
 * Read `channels` binary samples per pixel.
 *
 * One to four of them. P5 asks for one and P6 for three; the even counts are
 * PAM's, where a second sample after a grey one and a fourth after a triple are
 * both opacity. Straight opacity, not premultiplied: a fully transparent pixel
 * in a PAM keeps whatever colour was written under it, which is what ImageMagick
 * writes and what this package's rasters mean by alpha.
 */
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

	// An even channel count is the one with opacity on the end of it. Both odd
	// counts are opaque, and the raster says so rather than carrying an alpha
	// channel of 255s that a later encoder would take seriously.
	const carriesAlpha = channels % 2 === 0;
	const image = createRaster(width, height, 'srgb', carriesAlpha);
	const target = image.data;
	let at = cursor.at;
	const values = [0, 0, 0, 0];

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
		if (channels <= 2) {
			// One luminance sample fills all three colour channels, so a grey
			// image reaches the raster as grey rather than as red.
			setPixel(target, i * 4, first, first, first, carriesAlpha ? (values[1] as number) : 255);
		} else {
			const alpha = carriesAlpha ? (values[3] as number) : 255;
			setPixel(target, i * 4, first, values[1] as number, values[2] as number, alpha);
		}
	}
	cursor.at = at;
	// A PAM whose alpha channel turned out to be solid is an opaque image. The
	// flag is a promise about the pixels rather than a record of what the file
	// spent bytes on, and leaving it set would have every later encoder write an
	// alpha channel nothing needs.
	return carriesAlpha ? { ...image, hasAlpha: detectAlpha(image) } : image;
}

/* ── P7: PAM ──────────────────────────────────────────────────────────── */

/**
 * The tuple types this reader can turn into pixels, and the DEPTH each one has.
 *
 * A PAM may name any tuple type at all, and the ones outside this table are not
 * pictures in the sense this package means. ImageMagick writes and reads
 * `TUPLTYPE CMYK` at DEPTH 4, and reading those four samples as red, green,
 * blue and opacity produces a picture rather than an error: inverted, wrongly
 * coloured, and perfectly plausible on its own. So an unrecognised tuple type
 * is refused rather than assumed, and a recognised one has to agree with DEPTH,
 * because DEPTH is what decides where one pixel ends and the next begins.
 */
const PAM_TUPLE_DEPTHS = new Map<string, number>([
	['BLACKANDWHITE', 1],
	['GRAYSCALE', 1],
	['BLACKANDWHITE_ALPHA', 2],
	['GRAYSCALE_ALPHA', 2],
	['RGB', 3],
	['RGB_ALPHA', 4],
]);

/**
 * The longest header line this reader will assemble.
 *
 * A header line is a keyword, a space and a value, so nothing legitimate comes
 * within an order of magnitude of this. The bound is here because the line is
 * built as a string: a file with no newline anywhere in it would otherwise be
 * copied into one, which is an allocation the size of the file for a file that
 * has already proved it is not a PAM.
 */
const MAX_HEADER_LINE = 1024;

interface PamHeader {
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	readonly maxval: number;
}

/**
 * Read one line of a PAM header, without its terminator.
 *
 * None of the token reading above applies here. A newline ends a field in this
 * grammar rather than merely separating two of them, so `WIDTH 4 HEIGHT 4` on
 * one line is malformed rather than two fields, and the newline that closes
 * ENDHDR is the last byte of the header rather than the first byte of anything.
 *
 * Carriage returns are dropped rather than kept, so a header written on Windows
 * does not arrive with a stray byte glued to the end of ENDHDR. Returns
 * undefined at the end of the file, which is a header that never closed.
 */
function readHeaderLine(bytes: Uint8Array, cursor: Cursor): string | undefined {
	let text = '';
	while (cursor.at < bytes.length) {
		const byte = bytes[cursor.at] as number;
		cursor.at += 1;
		if (byte === 0x0a) return text;
		if (byte !== 0x0d) text += String.fromCharCode(byte);
		if (text.length > MAX_HEADER_LINE) {
			fail('a line of the header is longer than any header line has cause to be.');
		}
	}
	return undefined;
}

/** A header value, which the four numeric fields all spell as plain digits. */
function pamNumber(value: string, what: string): number {
	for (let i = 0; i < value.length; i += 1) {
		const byte = value.charCodeAt(i);
		if (byte < ZERO || byte > NINE) fail(`the ${what} in the header is not a number.`);
	}
	const number = Number(value);
	if (number > MAX_HEADER_NUMBER) fail(`the ${what} in the header is implausibly large.`);
	return number;
}

/**
 * Read the header lines between 'P7' and 'ENDHDR'.
 *
 * The keys may arrive in any order and any of them may be missing, so each is
 * collected and the four that are required are checked for afterwards by name.
 * A key this reader does not know is skipped rather than refused: it cannot
 * change how the raster is grouped, since that is DEPTH and MAXVAL, and a
 * misspelled WIDTH still ends up reported as a missing one.
 */
function readPamHeader(bytes: Uint8Array, cursor: Cursor): PamHeader {
	let width: number | undefined;
	let height: number | undefined;
	let depth: number | undefined;
	let maxval: number | undefined;
	let tupleType: string | undefined;

	for (;;) {
		const line = readHeaderLine(bytes, cursor);
		if (line === undefined) fail('the header has no ENDHDR line, so it never ends.');
		const trimmed = line.trim();
		if (trimmed === 'ENDHDR') break;
		// A comment is a whole line here, so unlike P1 to P6 a '#' cannot follow
		// a field on the same line. A blank line is ignored rather than refused,
		// which is what Netpbm's own reader does with one.
		if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

		const gap = trimmed.search(/\s/);
		const key = gap === -1 ? trimmed : trimmed.slice(0, gap);
		const value = gap === -1 ? '' : trimmed.slice(gap + 1).trim();
		// The key is deliberately not repeated into the message. It is text out
		// of a stranger's file, and an error message is the one string that gets
		// screenshot into a bug report.
		if (value.length === 0) fail('a line of the header carries a keyword with no value.');

		switch (key) {
			case 'WIDTH':
				if (width !== undefined) fail('the header has more than one WIDTH line.');
				width = pamNumber(value, 'width');
				break;
			case 'HEIGHT':
				if (height !== undefined) fail('the header has more than one HEIGHT line.');
				height = pamNumber(value, 'height');
				break;
			case 'DEPTH':
				if (depth !== undefined) fail('the header has more than one DEPTH line.');
				depth = pamNumber(value, 'depth');
				break;
			case 'MAXVAL':
				if (maxval !== undefined) fail('the header has more than one MAXVAL line.');
				maxval = pamNumber(value, 'maximum sample value');
				break;
			case 'TUPLTYPE':
				// Repeats are joined rather than refused, because the format lets
				// a long tuple type be written across several lines and means the
				// concatenation of them.
				tupleType = tupleType === undefined ? value : `${tupleType} ${value}`;
				break;
			default:
				break;
		}
	}

	if (width === undefined) fail('the header has no WIDTH line.');
	if (height === undefined) fail('the header has no HEIGHT line.');
	if (depth === undefined) fail('the header has no DEPTH line.');
	if (maxval === undefined) fail('the header has no MAXVAL line.');

	checkDimensions(width, height);
	checkMaxval(maxval);
	if (depth < 1) fail('the header gives a DEPTH of zero, so a pixel holds no samples.');
	if (depth > 4) {
		fail(
			`the header gives a DEPTH of ${depth}, which is a tuple of measurements rather than an image, and this reader only reads the greyscale and RGB tuples.`,
		);
	}

	if (tupleType !== undefined) {
		const expected = PAM_TUPLE_DEPTHS.get(tupleType);
		if (expected === undefined) {
			fail(
				'its TUPLTYPE is none of BLACKANDWHITE, GRAYSCALE, RGB or their alpha forms, and this reader has no way to turn a tuple whose channels it does not know into pixels.',
			);
		}
		if (expected !== depth) {
			// Interpolated because it matched one of our own constants above, so
			// it is this reader's word rather than the file's.
			fail(
				`the header pairs a TUPLTYPE of ${tupleType} with a DEPTH of ${depth}, and the two contradict each other.`,
			);
		}
	}

	return { width, height, depth, maxval };
}

function decodePam(bytes: Uint8Array, cursor: Cursor): RasterImage {
	const { width, height, depth, maxval } = readPamHeader(bytes, cursor);
	// The newline that ends the ENDHDR line is the last byte of the header, and
	// `readHeaderLine` has already eaten it. There is no separate whitespace
	// byte to consume the way P4 to P6 have one, so a reader that called
	// `endBinaryHeader` here would swallow the first sample of the image.
	//
	// Nothing below inverts anything, which is the point worth stopping on:
	// BLACKANDWHITE with MAXVAL 1 reads 1 as white, where P1 and P4 read a set
	// bit as black. PAM samples are intensities like every other greyscale, so
	// the ordinary scaling from 0..MAXVAL onto 0..255 already lands 1 on white.
	// A reader that carried the bitmap polarity across returns a photographic
	// negative of every black and white PAM, and a negative looks enough like a
	// picture to survive review.
	return decodeBinarySamples(bytes, cursor, width, height, maxval, depth);
}

/* ── Entry point ──────────────────────────────────────────────────────── */

/**
 * Read a Netpbm file of any of the seven types P1 to P6 and PAM.
 *
 * The result is RGBA in sRGB, opaque unless the file was a PAM carrying an
 * opacity channel: no member of the family has a way to record a colour space,
 * and inventing one would be worse than saying plainly that it is sRGB. Bytes
 * after the first image are ignored, so a concatenated multi-image file reads
 * as its first frame rather than as damage.
 */
export function decodePnm(bytes: Uint8Array): RasterImage {
	if (bytes.length < 3) fail('the file is too short to be a Netpbm image.');
	if (bytes[0] !== 0x50) fail('the file does not begin with the Netpbm magic number.');

	const kind = (bytes[1] as number) - ZERO;
	if (kind < 1 || kind > 7) fail('the magic number is not one of P1 to P7.');

	const afterMagic = bytes[2] as number;
	if (!isWhitespace(afterMagic) && afterMagic !== HASH) {
		fail('the magic number is not followed by whitespace.');
	}

	const cursor: Cursor = { at: 2 };
	// The cursor sits on the newline after 'P7' rather than past it, so the
	// first line PAM reads is the remainder of the magic number's own line,
	// which is empty in every file anybody writes. Netpbm reads it the same way,
	// having consumed two characters of magic and nothing more.
	if (kind === 7) return decodePam(bytes, cursor);

	const width = readHeaderNumber(bytes, cursor, 'width');
	const height = readHeaderNumber(bytes, cursor, 'height');
	checkDimensions(width, height);

	const bitmap = kind === 1 || kind === 4;
	let maxval = 1;
	if (!bitmap) {
		maxval = readHeaderNumber(bytes, cursor, 'maximum sample value');
		checkMaxval(maxval);
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
