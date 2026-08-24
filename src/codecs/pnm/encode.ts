/**
 * A Netpbm (PNM) writer.
 *
 * Always binary P6, the 24 bit colour pixmap. The family has six members and
 * five of them throw information away: P5 and P2 keep only luminance, P4 and P1
 * keep only a single bit, and the two ASCII pixmaps cost four to twelve bytes
 * per pixel to say what three bytes already say. A converter that silently
 * chose one of those would be answering a question nobody asked, so the writer
 * chooses the one member that can hold what a raster holds and the reader
 * accepts all six.
 *
 * No alpha channel exists anywhere in Netpbm, so translucent pixels are
 * composited before they are written.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';

const ENCODER_ID = 'pnm-p6';

/**
 * Write `image` as a binary P6 pixmap.
 *
 * The header is the magic number, whitespace, the width, whitespace, the
 * height, whitespace, the maximum sample value, then exactly one whitespace
 * byte. That final byte is part of the header rather than a separator: a reader
 * consumes one byte and starts on pixel data, so a second newline here would be
 * read back as a pixel worth 10.
 */
export function encodePnm(image: RasterImage, options: EncodeOptions = {}): Uint8Array {
	const { width, height } = image;
	if (width < 1 || height < 1) {
		throw new EncodeFailedError(
			'pnm',
			ENCODER_ID,
			'Netpbm has no way to describe an image with no pixels in it.',
		);
	}
	if (!Number.isInteger(width) || !Number.isInteger(height)) {
		throw new EncodeFailedError('pnm', ENCODER_ID, 'the image has fractional dimensions.');
	}

	// The header is written from the width and the height, so a buffer that does
	// not agree with them would be padded out with zeroes to whatever the header
	// promised, and a short raster would come back as a black band nobody asked
	// about. Refused instead, as the other writers here refuse it.
	const pixels = width * height;
	if (image.data.length < pixels * 4) {
		throw new EncodeFailedError(
			'pnm',
			ENCODER_ID,
			'the pixel buffer is smaller than the width and height say it should be.',
		);
	}

	const opaque = flatten(image, options.background);
	const source = opaque.data;

	// Digits and single byte separators only, so one character is one byte and
	// the length of the string is the length of the header.
	const header = `P6\n${width} ${height}\n255\n`;
	const out = new Uint8Array(header.length + pixels * 3);
	for (let i = 0; i < header.length; i += 1) out[i] = header.charCodeAt(i);

	let at = header.length;
	for (let i = 0; i < pixels; i += 1) {
		const from = i * 4;
		out[at] = source[from] as number;
		out[at + 1] = source[from + 1] as number;
		out[at + 2] = source[from + 2] as number;
		at += 3;
	}
	return out;
}
