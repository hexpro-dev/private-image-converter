/**
 * Decode with the browser's own image pipeline.
 *
 * This is the fastest path for everything the browser already understands, and
 * on Safari it is also the HEIC path, because Safari 17 decodes HEIC in
 * `createImageBitmap` including the tile grid and the rotation.
 *
 * It has one hard limit that the pure paths do not: the pixels have to pass
 * through a canvas to be read back, so an image too large for a canvas cannot
 * come out this way. That is why this declines rather than throws when an
 * image is too big, so a caller can fall through to a path that does not need
 * one.
 */

import { DecodeFailedError } from '../../errors.js';
import type { ColourSpace, FormatId, RasterImage } from '../../types.js';
import {
	canvasCanHold,
	context2d,
	contextColourSpace,
	requireCanvas,
} from '../../raster/canvas.js';

export function nativeDecodeAvailable(): boolean {
	return typeof createImageBitmap === 'function' && typeof Blob !== 'undefined';
}

/**
 * Decode `bytes` as `mime`.
 *
 * `preferColourSpace` asks for a wide gamut readback. Where the browser has no
 * Display P3 canvas the request is ignored and the result is sRGB, which is
 * reported on the returned raster rather than assumed by the caller.
 */
export async function decodeNative(
	bytes: Uint8Array,
	format: FormatId,
	mime: string,
	preferColourSpace: ColourSpace = 'srgb',
): Promise<RasterImage> {
	if (!nativeDecodeAvailable()) {
		throw new DecodeFailedError(format, 'native', 'this environment has no image decoder');
	}

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
	} catch (error) {
		throw new DecodeFailedError(format, 'native', 'the browser refused it', { cause: error });
	}

	try {
		if (!canvasCanHold(bitmap.width, bitmap.height)) {
			throw new DecodeFailedError(
				format,
				'native',
				`it is ${bitmap.width} by ${bitmap.height}, which is larger than this browser can hold in a drawing surface`,
			);
		}
		const canvas = requireCanvas(bitmap.width, bitmap.height);
		const context = context2d(canvas, preferColourSpace);
		context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
		const space = contextColourSpace(context);
		const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height, {
			colorSpace: space === 'display-p3' ? 'display-p3' : 'srgb',
		});
		let hasAlpha = false;
		for (let i = 3; i < pixels.data.length; i += 4) {
			if (pixels.data[i] !== 255) {
				hasAlpha = true;
				break;
			}
		}
		return {
			data: pixels.data,
			width: bitmap.width,
			height: bitmap.height,
			colourSpace: space,
			hasAlpha,
		};
	} finally {
		// An ImageBitmap holds a decoded surface until it is closed. Leaving
		// them to the collector is what turns a batch conversion into a tab
		// that runs out of memory halfway through.
		bitmap.close();
	}
}
