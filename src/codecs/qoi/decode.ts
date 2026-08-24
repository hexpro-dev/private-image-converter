/**
 * A QOI decoder, version 1.0 of the format.
 *
 * These bytes came from a stranger's file, so every read is bounded and every
 * refusal is a sentence. The format has no length fields inside the stream and
 * no checksum, which means a truncated file looks exactly like a valid one
 * until the pixels run out. The reference decoder answers that by repeating the
 * last pixel to the end of the image; this one stops and says the file is
 * truncated, because a half decoded photograph handed back as if it were whole
 * is the worse failure.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'qoi-pure';

const HEADER_LENGTH = 14;
const END_MARKER_LENGTH = 8;

const OP_INDEX = 0x00;
const OP_DIFF = 0x40;
const OP_LUMA = 0x80;
const OP_RUN = 0xc0;
const OP_RGB = 0xfe;
const OP_RGBA = 0xff;

/** One chunk can stand for at most 62 pixels, which bounds how short a real file can be. */
const MAX_RUN = 62;

/**
 * The largest image this decoder will allocate for.
 *
 * The same limit the reference implementation uses. The header is four bytes of
 * width and four of height with nothing to corroborate them, so a 12 byte file
 * can ask for a sixty four gigabyte buffer. The converter applies its own
 * `maxPixels` on top of this; this one exists so that the decoder is safe to
 * call on its own.
 */
const MAX_PIXELS = 400_000_000;

function fail(detail: string): never {
	throw new DecodeFailedError('qoi', DECODER_ID, detail);
}

function hashColour(r: number, g: number, b: number, a: number): number {
	return (r * 3 + g * 5 + b * 7 + a * 11) % 64;
}

export function decodeQoi(bytes: Uint8Array): RasterImage {
	if (bytes.length < HEADER_LENGTH + END_MARKER_LENGTH) {
		fail('it is too short to hold a header and an end marker.');
	}
	if (bytes[0] !== 0x71 || bytes[1] !== 0x6f || bytes[2] !== 0x69 || bytes[3] !== 0x66) {
		fail('it does not start with the four byte QOI signature.');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(4);
	const height = view.getUint32(8);
	const channels = bytes[12] as number;
	const colourSpaceByte = bytes[13] as number;

	if (width === 0 || height === 0) {
		fail('the header gives it a width or a height of zero.');
	}
	if (channels !== 3 && channels !== 4) {
		fail(`the header says ${channels} channels per pixel, and only 3 or 4 exist in QOI.`);
	}
	if (colourSpaceByte !== 0 && colourSpaceByte !== 1) {
		fail(`the header carries an unknown colour space value of ${colourSpaceByte}.`);
	}

	const pixels = width * height;
	if (pixels > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}

	// The marker is fixed and sits at the very end, so this also catches a file
	// with anything appended to it. Checking it before decoding means a
	// truncated file is refused before a buffer is allocated for it.
	const chunksEnd = bytes.length - END_MARKER_LENGTH;
	for (let i = 0; i < END_MARKER_LENGTH; i += 1) {
		const expected = i === END_MARKER_LENGTH - 1 ? 1 : 0;
		if (bytes[chunksEnd + i] !== expected) {
			fail('the eight byte end marker is missing, so the file is truncated or not a QOI.');
		}
	}

	// Cheapest possible encoding of one pixel is a 62 pixel run chunk, so a
	// stream this short cannot describe that many pixels however it is read.
	// Worth checking up front: it is the difference between refusing a 30 byte
	// file and allocating the gigabyte its header asked for.
	if (pixels > (chunksEnd - HEADER_LENGTH) * MAX_RUN) {
		fail('the chunk stream is too short to describe an image of that size.');
	}

	// The ceiling above is on pixels, and four bytes of raster per pixel is a
	// lot of memory to ask a phone for. A refused allocation arrives as a
	// RangeError, which would escape this decoder untyped and reach the
	// interface as a stack trace instead of a sentence.
	let image: RasterImage;
	try {
		image = createRaster(width, height, 'srgb', channels === 4);
	} catch {
		fail('there is not enough memory here to hold an image of that size.');
	}
	const out = image.data;
	const table = new Uint8Array(64 * 4);

	// Three channels means opaque, and the alpha this decoder hands back says so
	// whatever the chunk stream does. The reference decoder keeps a running
	// alpha even for a three channel file, because an RGBA chunk and the index
	// table have to stay in step with the encoder, but it writes no alpha byte
	// at all into three channel output. Skipping that here would let a file
	// whose first chunk indexes a table slot nothing has written yet, where the
	// entry is still rgba(0, 0, 0, 0), decode to a fully transparent image
	// carrying a header that says it has no alpha channel.
	const opaque = channels === 3;

	let r = 0;
	let g = 0;
	let b = 0;
	let a = 255;
	let run = 0;
	let at = HEADER_LENGTH;

	for (let i = 0; i < pixels; i += 1) {
		if (run > 0) {
			run -= 1;
		} else {
			if (at >= chunksEnd) {
				fail('the chunk stream ends before every pixel has been accounted for.');
			}
			const op = bytes[at] as number;
			at += 1;

			if (op === OP_RGB) {
				if (at + 3 > chunksEnd) fail('a colour chunk runs off the end of the file.');
				r = bytes[at] as number;
				g = bytes[at + 1] as number;
				b = bytes[at + 2] as number;
				at += 3;
			} else if (op === OP_RGBA) {
				if (at + 4 > chunksEnd) fail('a colour chunk runs off the end of the file.');
				r = bytes[at] as number;
				g = bytes[at + 1] as number;
				b = bytes[at + 2] as number;
				a = bytes[at + 3] as number;
				at += 4;
			} else if ((op & 0xc0) === OP_INDEX) {
				const slot = (op & 0x3f) * 4;
				r = table[slot] as number;
				g = table[slot + 1] as number;
				b = table[slot + 2] as number;
				a = table[slot + 3] as number;
			} else if ((op & 0xc0) === OP_DIFF) {
				// Each difference is two bits biased by 2, and each channel wraps
				// on its own, which is how the encoder gets to spend one byte on
				// a colour that crosses zero.
				r = (r + ((op >> 4) & 0x03) - 2) & 0xff;
				g = (g + ((op >> 2) & 0x03) - 2) & 0xff;
				b = (b + (op & 0x03) - 2) & 0xff;
			} else if ((op & 0xc0) === OP_LUMA) {
				if (at + 1 > chunksEnd) fail('a luma chunk runs off the end of the file.');
				const second = bytes[at] as number;
				at += 1;
				const dg = (op & 0x3f) - 32;
				r = (r + dg - 8 + ((second >> 4) & 0x0f)) & 0xff;
				g = (g + dg) & 0xff;
				b = (b + dg - 8 + (second & 0x0f)) & 0xff;
			} else if ((op & 0xc0) === OP_RUN) {
				// The count is biased by one and the current pixel is the first of
				// them, so the rest are paid out by the branch at the top. Counts
				// of 62 and 63 cannot arrive here: those two bytes are the full
				// colour tags, and they were matched before the two bit tags.
				run = op & 0x3f;
			}

			const slot = hashColour(r, g, b, a) * 4;
			table[slot] = r;
			table[slot + 1] = g;
			table[slot + 2] = b;
			table[slot + 3] = a;
		}

		const target = i * 4;
		out[target] = r;
		out[target + 1] = g;
		out[target + 2] = b;
		out[target + 3] = opaque ? 255 : a;
	}

	if (run > 0) {
		fail('the last run chunk claims more pixels than the image has.');
	}
	if (at !== chunksEnd) {
		fail('there are chunks left over after the last pixel of the image.');
	}

	// Three channel files are opaque by definition. A four channel one only
	// counts as having alpha if some pixel actually uses it, because that is
	// what the flag means to everything downstream: an image full of 255s
	// should not force the next encoder into a heavier representation.
	return { ...image, hasAlpha: channels === 4 && detectAlpha(image) };
}
