/**
 * A Sun raster writer.
 *
 * One shape, chosen so the file opens everywhere: type 1, the standard
 * uncompressed one, with no colour map. Depth is 24 for an opaque image and 32
 * for one with alpha.
 *
 * Nothing here writes the byte encoding. It is a run length coder over bytes
 * rather than over pixels, so on anything but a flat graphic it makes the file
 * larger, and the reader in the sibling file handles it because files in the
 * wild use it rather than because it is worth producing.
 *
 * Depth 32 is a small gamble, described where the alpha is written below. A
 * caller that needs the file read by something old asks for `alpha: false` and
 * gets the 24 bit form that every Sun raster reader ever written can open.
 */

import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'ras-pure';

const HEADER_BYTES = 32;

const MAGIC = 0x59a66a95;

/** RT_STANDARD: uncompressed, blue channel first. */
const TYPE_STANDARD = 1;

/** RMT_NONE: the pixels carry their own colour. */
const MAP_NONE = 0;

/** The largest number any header field can hold. */
const MAX_FIELD = 0xffffffff;

export interface RasEncodeOptions extends EncodeOptions {
	/**
	 * Write 32 bit pixels with a real alpha channel.
	 *
	 * Defaults to whatever the raster carries. Setting it to false is how to ask
	 * for the maximally compatible file: translucent pixels are composited onto
	 * `background` first and the result is a 24 bit file with nothing in it a
	 * 1987 reader could trip over.
	 */
	readonly alpha?: boolean;
}

function fail(detail: string): never {
	throw new EncodeFailedError('ras', ENCODER_ID, detail);
}

export function encodeRas(image: RasterImage, options: RasEncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the image has no pixels to write.');
	}
	// Checked before the buffer length, so a dimension no header could hold is
	// named as such rather than reported as a buffer that came up short.
	if (width > MAX_FIELD || height > MAX_FIELD) {
		fail('the image is wider or taller than the header can record.');
	}
	if (image.data.length < width * height * 4) {
		fail('the pixel buffer is shorter than the width and height say it should be.');
	}

	const withAlpha = options.alpha ?? image.hasAlpha;
	// A no-op when the raster is already opaque, so this is safe on both paths.
	const source = withAlpha ? image : flatten(image, options.background);
	const data = source.data;

	const depth = withAlpha ? 32 : 24;
	const bytesPerPixel = withAlpha ? 4 : 3;
	// Every row is padded out to a whole number of 16 bit words. At 32 bits and
	// at 24 bits on an even width there is nothing to pad, which is exactly why
	// it is easy to leave out and only notice on an odd width.
	const rowBytes = Math.ceil((width * bytesPerPixel) / 2) * 2;
	const size = rowBytes * height;

	// No guard around this allocation, unlike the encoders that widen a sample.
	// A Sun raster is three or four bytes a pixel where the raster it came from
	// is already four, so anything that exists as a raster fits as a file, and a
	// check here would be a branch nothing could ever take.
	const out = new Uint8Array(HEADER_BYTES + size);

	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC);
	view.setUint32(4, width);
	view.setUint32(8, height);
	view.setUint32(12, depth);
	view.setUint32(16, size);
	view.setUint32(20, TYPE_STANDARD);
	view.setUint32(24, MAP_NONE);
	view.setUint32(28, 0);

	for (let y = 0; y < height; y += 1) {
		let to = HEADER_BYTES + y * rowBytes;
		for (let x = 0; x < width; x += 1) {
			const from = (y * width + x) * 4;
			if (withAlpha) {
				// The specification calls this byte padding, and a reader that
				// obeys it will drop the alpha. Writing the alpha there anyway is
				// what every writer that has ever wanted alpha in this format has
				// done, and a reader that ignores it gets the right colours, so
				// the worst case is a flattened picture rather than a wrong one.
				out[to] = data[from + 3] as number;
				to += 1;
			}
			// Blue, green, red. Type 3 exists for the other order and is not
			// written here, because the readers that predate it are exactly the
			// readers a Sun raster is being written for.
			out[to] = data[from + 2] as number;
			out[to + 1] = data[from + 1] as number;
			out[to + 2] = data[from] as number;
			to += 3;
		}
		// The padding byte on an odd 24 bit row is already zero from the
		// allocation, which is what the format asks for.
	}

	return out;
}
