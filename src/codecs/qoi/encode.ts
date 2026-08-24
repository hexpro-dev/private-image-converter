/**
 * A QOI encoder, version 1.0 of the format.
 *
 * QOI is worth carrying because it is the one lossless format this package can
 * write with no compressor at all: no deflate, no entropy coder, one pass over
 * the pixels and a 64 entry lookup table. That matters on a phone, where the
 * PNG path has to hand a whole image to `CompressionStream` and wait for it.
 *
 * The stream is a run of chunks against a rolling prediction: the pixel before,
 * a small colour difference from it, or a slot in a table of the last 64
 * distinct colours seen. Nothing here is a heuristic with a knob on it, so the
 * output of this encoder is byte for byte what the reference encoder produces.
 */

import { EncodeFailedError } from '../../errors.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'qoi-pure';

/** 'qoif', the four magic bytes the stream opens with. */
const MAGIC = Uint8Array.from([0x71, 0x6f, 0x69, 0x66]);

const OP_INDEX = 0x00;
const OP_DIFF = 0x40;
const OP_LUMA = 0x80;
const OP_RUN = 0xc0;
const OP_RGB = 0xfe;
const OP_RGBA = 0xff;

/** The longest run one chunk can carry. 63 and 64 would collide with the two RGB tags. */
const MAX_RUN = 62;

/** Seven zero bytes and a one. Anything else at the tail is a truncated file. */
const END_MARKER = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);

/**
 * Where a colour lands in the running table.
 *
 * The multipliers are the ones the specification fixes, not a choice: a decoder
 * rebuilds the same table by running the same arithmetic, so changing them
 * would produce a file only this encoder could read.
 */
function hashColour(r: number, g: number, b: number, a: number): number {
	return (r * 3 + g * 5 + b * 7 + a * 11) % 64;
}

/**
 * A byte difference as the format reads it: wrapped into -128..127.
 *
 * The reference encoder does this by assigning to a signed char and letting it
 * wrap, and a decoder adds the difference back with the same wraparound. So a
 * difference of 250 to 4 is +10 and fits in a two byte chunk, and refusing to
 * wrap here would cost bytes on every image with a channel that crosses zero.
 */
function wrapDifference(value: number): number {
	return (((value + 128) & 0xff) - 128) | 0;
}

/**
 * Encode a raster as QOI.
 *
 * `options` is accepted for one signature across every encoder and then
 * ignored: QOI is lossless so quality means nothing, it carries alpha so there
 * is nothing to composite a background onto, and it has no room for an ICC
 * profile. Saying so here is better than a caller wondering why the quality
 * setting made no difference to the file.
 */
export function encodeQoi(image: RasterImage, _options: EncodeOptions = {}): Uint8Array {
	const { width, height, data } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new EncodeFailedError(
			'qoi',
			ENCODER_ID,
			'the image has no width or no height, so there is nothing to write.',
		);
	}
	if (data.length < width * height * 4) {
		throw new EncodeFailedError(
			'qoi',
			ENCODER_ID,
			'the pixel buffer is smaller than the width and height say it should be.',
		);
	}

	// The header records 3 or 4 channels, and the chunk stream has to agree with
	// it: an alpha chunk in a file that claims three channels is a contradiction
	// a reader is entitled to reject. A raster that declares itself opaque is
	// therefore encoded as opaque, which also rescues the common case of a
	// buffer straight from `createRaster`, where every byte including alpha is
	// still zero and honouring it would write a fully transparent image.
	const channels = image.hasAlpha ? 4 : 3;

	// Worst case is one five byte RGBA chunk per pixel. Allocating for it once
	// costs a pass of nothing, where growing the buffer costs a copy of
	// everything written so far each time it fills. It is a quarter more memory
	// than the raster the caller already holds, so on a large photograph it is
	// also the request most likely to be refused, and a refusal arrives as a
	// RangeError that would reach the interface as a stack trace.
	let out: Uint8Array;
	try {
		out = new Uint8Array(14 + width * height * 5 + END_MARKER.length);
	} catch {
		throw new EncodeFailedError(
			'qoi',
			ENCODER_ID,
			'there is not enough memory here to build a file that size.',
		);
	}
	out.set(MAGIC, 0);
	const view = new DataView(out.buffer);
	view.setUint32(4, width);
	view.setUint32(8, height);
	out[12] = channels;
	// 0 is sRGB with a linear alpha channel. This package's rasters are either
	// sRGB or Display P3, and the format has no way to say Display P3, so a wide
	// gamut image is written with its numbers intact and tagged sRGB.
	out[13] = 0;
	let at = 14;

	const table = new Uint8Array(64 * 4);
	let previousR = 0;
	let previousG = 0;
	let previousB = 0;
	let previousA = 255;
	let run = 0;

	const pixels = width * height;
	for (let i = 0; i < pixels; i += 1) {
		const source = i * 4;
		const r = data[source] as number;
		const g = data[source + 1] as number;
		const b = data[source + 2] as number;
		const a = channels === 4 ? (data[source + 3] as number) : 255;

		if (r === previousR && g === previousG && b === previousB && a === previousA) {
			run += 1;
			// Flushed at the last pixel as well, or the tail of an image ending
			// in flat colour would never be written.
			if (run === MAX_RUN || i === pixels - 1) {
				out[at] = OP_RUN | (run - 1);
				at += 1;
				run = 0;
			}
			continue;
		}

		if (run > 0) {
			out[at] = OP_RUN | (run - 1);
			at += 1;
			run = 0;
		}

		const hash = hashColour(r, g, b, a);
		const slot = hash * 4;
		if (
			table[slot] === r &&
			table[slot + 1] === g &&
			table[slot + 2] === b &&
			table[slot + 3] === a
		) {
			out[at] = OP_INDEX | hash;
			at += 1;
		} else {
			table[slot] = r;
			table[slot + 1] = g;
			table[slot + 2] = b;
			table[slot + 3] = a;

			if (a === previousA) {
				const dr = wrapDifference(r - previousR);
				const dg = wrapDifference(g - previousG);
				const db = wrapDifference(b - previousB);
				// Red and blue are stored relative to green because the three
				// channels of a photograph move together, and taking green out
				// leaves a residual small enough for four bits.
				const drg = wrapDifference(dr - dg);
				const dbg = wrapDifference(db - dg);

				if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) {
					out[at] = OP_DIFF | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2);
					at += 1;
				} else if (drg > -9 && drg < 8 && dg > -33 && dg < 32 && dbg > -9 && dbg < 8) {
					out[at] = OP_LUMA | (dg + 32);
					out[at + 1] = ((drg + 8) << 4) | (dbg + 8);
					at += 2;
				} else {
					out[at] = OP_RGB;
					out[at + 1] = r;
					out[at + 2] = g;
					out[at + 3] = b;
					at += 4;
				}
			} else {
				out[at] = OP_RGBA;
				out[at + 1] = r;
				out[at + 2] = g;
				out[at + 3] = b;
				out[at + 4] = a;
				at += 5;
			}
		}

		previousR = r;
		previousG = g;
		previousB = b;
		previousA = a;
	}

	out.set(END_MARKER, at);
	at += END_MARKER.length;

	// Copied rather than returned as a view over the worst case buffer. A view
	// would keep all five bytes per pixel alive for as long as the caller holds
	// the result, and a typical QOI file is a fifth of that.
	return out.slice(0, at);
}
