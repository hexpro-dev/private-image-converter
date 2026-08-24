/**
 * A farbfeld encoder.
 *
 * farbfeld is the suckless project's image format: sixteen bytes of header and
 * then raw 16 bit RGBA samples, big endian, in row order. No compression, no
 * palette, no chunk table, no metadata, no colour space tag. That makes it the
 * cheapest lossless target this package can write, one pass with no arithmetic
 * beyond widening a byte, and the easiest output for somebody else's twenty
 * line program to read. The price is eight bytes a pixel, so it is a format for
 * handing an image to another tool rather than for keeping.
 */

import { EncodeFailedError } from '../../errors.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'farbfeld-pure';

/** 'farbfeld', the eight magic bytes the file opens with. */
const MAGIC = Uint8Array.from([0x66, 0x61, 0x72, 0x62, 0x66, 0x65, 0x6c, 0x64]);

/** The magic, then width and height as big endian u32. */
const HEADER_BYTES = 16;

/** Four channels of two bytes. Fixed by the format: there are no variants. */
const BYTES_PER_PIXEL = 8;

/** The largest value a u32 header field can carry. */
const MAX_DIMENSION = 0xffffffff;

function fail(detail: string, options?: ErrorOptions): never {
	throw new EncodeFailedError('farbfeld', ENCODER_ID, detail, options);
}

/**
 * Encode a raster as farbfeld.
 *
 * `options` is accepted for one signature across every encoder and then
 * ignored: farbfeld is lossless so quality steers nothing, every file carries
 * alpha so there is nothing to composite a background onto, and the container
 * has no room for an ICC profile. Saying so here is better than a caller
 * wondering why the quality setting made no difference to the file.
 */
export function encodeFarbfeld(image: RasterImage, _options: EncodeOptions = {}): Uint8Array {
	const { width, height, data } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		fail('the image has no width or no height, so there is nothing to write.');
	}
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		fail('the image is wider or taller than the header can record, which stops at 4294967295.');
	}
	if (data.length < width * height * 4) {
		fail('the pixel buffer is smaller than the width and height say it should be.');
	}

	const pixels = width * height;
	// Eight bytes a pixel is twice what the raster costs, so an image that fit
	// in memory decoded can still fail to fit encoded. A failed allocation
	// throws a RangeError that says nothing about images, and one catch block
	// per caller only works if everything in here arrives as the same kind of
	// error.
	let out: Uint8Array;
	try {
		out = new Uint8Array(HEADER_BYTES + pixels * BYTES_PER_PIXEL);
	} catch (cause) {
		fail('there was not enough memory for the file, which takes eight bytes a pixel.', { cause });
	}

	out.set(MAGIC, 0);
	const view = new DataView(out.buffer);
	view.setUint32(8, width);
	view.setUint32(12, height);

	// A raster that declares itself opaque can still carry zeroed alpha bytes:
	// `createRaster` zero fills, and a decoder for a format without alpha has no
	// reason to write 255 into a channel it was told to ignore. Passing those
	// bytes through would write a completely transparent image, which reads as
	// corruption rather than as a bug, so an opaque raster is written opaque.
	const opaque = !image.hasAlpha;

	let at = HEADER_BYTES;
	for (let i = 0; i < pixels; i += 1) {
		const source = i * 4;
		const r = data[source] as number;
		const g = data[source + 1] as number;
		const b = data[source + 2] as number;
		const a = opaque ? 0xff : (data[source + 3] as number);

		// Each byte goes into both halves of its 16 bit sample, which is exactly
		// a multiply by 257. A left shift by 8 is the tempting alternative and it
		// is wrong: it maps 255 to 0xff00, so white comes back 0.4% dark and the
		// error compounds on every trip through the format. 257 is 0xffff / 0xff,
		// so 0 lands on 0 and 255 lands on 0xffff.
		out[at] = r;
		out[at + 1] = r;
		out[at + 2] = g;
		out[at + 3] = g;
		out[at + 4] = b;
		out[at + 5] = b;
		out[at + 6] = a;
		out[at + 7] = a;
		at += BYTES_PER_PIXEL;
	}

	return out;
}
