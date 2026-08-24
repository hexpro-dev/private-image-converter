/**
 * A BMP writer.
 *
 * BMP exists in this package for the places that still insist on it: Windows
 * tooling, embedded firmware image tables, and the occasional printer driver.
 * Nothing here compresses, so the writer is short and the output is exactly as
 * large as the arithmetic says it will be.
 *
 * Two shapes come out of it. Without alpha it writes the plain 24 bit file that
 * every reader ever written can open. With alpha it writes 32 bit BGRA behind a
 * BITMAPV4HEADER with explicit channel masks, because a 32 bit BI_RGB file has
 * an alpha byte that the specification calls reserved, and readers are entitled
 * to ignore it. Saying BI_BITFIELDS and naming the masks is the only way to
 * claim that byte in a file a stranger will open somewhere else.
 */

import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'bmp';

const FILE_HEADER_BYTES = 14;
const INFO_HEADER_BYTES = 40;
const V4_HEADER_BYTES = 108;

const BI_RGB = 0;
const BI_BITFIELDS = 3;

/**
 * 2835 pixels per metre, which is 72 dots per inch.
 *
 * Zero is legal here and common, but a reader that scales by print density
 * treats zero as "no information" and picks its own number, so writing a
 * defensible one costs nothing and removes a guess.
 */
const PIXELS_PER_METRE = 2835;

/** LCS_sRGB, which is the ASCII 'sRGB' read as a big endian word. */
const LCS_SRGB = 0x73524742;

/** LCS_CALIBRATED_RGB with no endpoints filled in: no claim about the numbers. */
const LCS_CALIBRATED_RGB = 0;

export interface BmpEncodeOptions extends EncodeOptions {
	/**
	 * Write 32 bit BGRA with a real alpha channel.
	 *
	 * Defaults to whatever the raster carries. Setting it to false is how to ask
	 * for the maximally compatible file: translucent pixels are composited onto
	 * `background` first and the result is a 24 bit BI_RGB BMP with no extension
	 * headers at all.
	 */
	readonly alpha?: boolean;
}

export function encodeBmp(image: RasterImage, options: BmpEncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new EncodeFailedError('bmp', ENCODER_ID, 'the image has no pixels to write.');
	}
	if (image.data.length < width * height * 4) {
		throw new EncodeFailedError(
			'bmp',
			ENCODER_ID,
			'the pixel buffer is shorter than the width and height say it should be.',
		);
	}

	const withAlpha = options.alpha ?? image.hasAlpha;
	// A no-op when the raster is already opaque, so this is safe on both paths.
	const source = withAlpha ? image : flatten(image, options.background);

	const bytesPerPixel = withAlpha ? 4 : 3;
	// Every row starts on a four byte boundary. At 32 bits that is free; at 24
	// it is where the padding comes from, and it is the single most common way
	// to get a BMP writer wrong.
	const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
	const headerBytes = withAlpha ? V4_HEADER_BYTES : INFO_HEADER_BYTES;
	const pixelOffset = FILE_HEADER_BYTES + headerBytes;
	const imageBytes = stride * height;
	const fileBytes = pixelOffset + imageBytes;

	if (fileBytes > 0xffffffff) {
		throw new EncodeFailedError(
			'bmp',
			ENCODER_ID,
			'the file would be larger than the four byte size field in its own header can describe.',
		);
	}

	const out = new Uint8Array(fileBytes);
	const view = new DataView(out.buffer);

	// BITMAPFILEHEADER. Both reserved words stay zero, which is what the
	// allocation already gives us.
	out[0] = 0x42; // 'B'
	out[1] = 0x4d; // 'M'
	view.setUint32(2, fileBytes, true);
	view.setUint32(10, pixelOffset, true);

	// BITMAPINFOHEADER, which is also the first 40 bytes of BITMAPV4HEADER.
	view.setUint32(14, headerBytes, true);
	view.setInt32(18, width, true);
	// A positive height means the rows are stored bottom to top. That is the
	// order every reader handles; top-down is legal but less well travelled.
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true); // colour planes, always one
	view.setUint16(28, withAlpha ? 32 : 24, true);
	view.setUint32(30, withAlpha ? BI_BITFIELDS : BI_RGB, true);
	view.setUint32(34, imageBytes, true);
	view.setInt32(38, PIXELS_PER_METRE, true);
	view.setInt32(42, PIXELS_PER_METRE, true);
	view.setUint32(46, 0, true); // colours used: none, this is not palettised
	view.setUint32(50, 0, true); // colours important

	if (withAlpha) {
		// The masks describe a little endian 32 bit word, so on disk the bytes
		// run blue, green, red, alpha.
		view.setUint32(54, 0x00ff0000, true);
		view.setUint32(58, 0x0000ff00, true);
		view.setUint32(62, 0x000000ff, true);
		view.setUint32(66, 0xff000000, true);
		// BMP has no way to name Display P3 short of embedding a profile in a
		// BITMAPV5HEADER, so a wide gamut raster gets LCS_CALIBRATED_RGB with
		// empty endpoints, which says nothing, rather than LCS_sRGB, which
		// would say something false. Endpoints and the three gamma words stay
		// zero on both paths.
		view.setUint32(70, image.colourSpace === 'srgb' ? LCS_SRGB : LCS_CALIBRATED_RGB, true);
	}

	const data = source.data;
	for (let y = 0; y < height; y += 1) {
		const rowAt = pixelOffset + (height - 1 - y) * stride;
		const from = y * width * 4;
		for (let x = 0; x < width; x += 1) {
			const read = from + x * 4;
			const write = rowAt + x * bytesPerPixel;
			out[write] = data[read + 2] as number;
			out[write + 1] = data[read + 1] as number;
			out[write + 2] = data[read] as number;
			if (withAlpha) out[write + 3] = data[read + 3] as number;
		}
		// The padding bytes at the end of the row are already zero.
	}

	return out;
}
