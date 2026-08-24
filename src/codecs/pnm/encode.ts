/**
 * A Netpbm writer: binary P6 for an opaque image, PAM (P7) for one with alpha.
 *
 * The family has seven members and five of them throw information away: P5 and
 * P2 keep only luminance, P4 and P1 keep only a single bit, and the two ASCII
 * pixmaps cost four to twelve bytes per pixel to say what three bytes already
 * say. A converter that silently chose one of those would be answering a
 * question nobody asked, so the writer chooses the two members that can hold
 * what a raster holds and the reader accepts all seven.
 *
 * PAM is the only one of the seven with an opacity channel, so a translucent
 * raster goes there rather than being composited away. Which of the two gets
 * written is decided by `RasterImage.hasAlpha` and nothing else, the same way
 * the PNG writer picks between colour types 2 and 6: the flag is trusted rather
 * than the buffer re-examined, because `convert` settles the question with
 * `detectAlpha` before an encoder ever sees the image.
 *
 * `options` is accepted for one signature across every encoder and then
 * ignored, as in the QOI writer and for the same reason. Netpbm is lossless, so
 * quality means nothing; a translucent image keeps its alpha and an opaque one
 * has none, so there is never anything for `background` to composite onto; and
 * no member of the family has room for an ICC profile or a palette.
 *
 * The one wrinkle is the name on the file. A translucent image comes out as a
 * PAM inside whatever extension the caller chose, which will usually be .ppm.
 * Netpbm's own tools and ImageMagick both read a PAM by its magic number rather
 * than by its extension, so this costs nothing at the far end.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { EncodeFailedError } from '../../errors.js';

const ENCODER_ID = 'pnm-pure';

/** Copy an ASCII header into the front of the output. One character, one byte. */
function writeHeader(out: Uint8Array, header: string): number {
	for (let i = 0; i < header.length; i += 1) out[i] = header.charCodeAt(i);
	return header.length;
}

/**
 * Write `image` as a binary P6 pixmap, or as a PAM when it carries alpha.
 *
 * A P6 header is the magic number, whitespace, the width, whitespace, the
 * height, whitespace, the maximum sample value, then exactly one whitespace
 * byte. That final byte is part of the header rather than a separator: a reader
 * consumes one byte and starts on pixel data, so a second newline here would be
 * read back as a pixel worth 10.
 *
 * A PAM header is a line each for WIDTH, HEIGHT, DEPTH, MAXVAL and TUPLTYPE and
 * then a line reading ENDHDR, and the newline that closes ENDHDR is the last
 * byte of the header. Same trap as P6, spelled differently: there is no
 * separator after it either.
 */
export function encodePnm(image: RasterImage, _options: EncodeOptions = {}): Uint8Array {
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
	const source = image.data;
	if (source.length < pixels * 4) {
		throw new EncodeFailedError(
			'pnm',
			ENCODER_ID,
			'the pixel buffer is smaller than the width and height say it should be.',
		);
	}

	if (image.hasAlpha) {
		// Straight alpha, not premultiplied, which is what PAM means by its
		// fourth sample and what a `RasterImage` holds. So the raster is the
		// raster: four bytes a pixel in the same order, copied rather than
		// walked.
		const header = `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
		const out = new Uint8Array(header.length + pixels * 4);
		const at = writeHeader(out, header);
		out.set(source.subarray(0, pixels * 4), at);
		return out;
	}

	// Digits and single byte separators only, so one character is one byte and
	// the length of the string is the length of the header.
	const header = `P6\n${width} ${height}\n255\n`;
	const out = new Uint8Array(header.length + pixels * 3);
	let at = writeHeader(out, header);
	for (let i = 0; i < pixels; i += 1) {
		const from = i * 4;
		out[at] = source[from] as number;
		out[at + 1] = source[from + 1] as number;
		out[at + 2] = source[from + 2] as number;
		at += 3;
	}
	return out;
}
