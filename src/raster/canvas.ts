/**
 * The small amount of canvas this package touches.
 *
 * Kept in one place because canvas is where the platform limits live, and
 * because every one of these calls has a browser-specific trap attached to it
 * that is worth writing down once rather than rediscovering per caller.
 */

import { CodecUnavailableError } from '../errors.js';
import type { ColourSpace, RasterImage } from '../types.js';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The largest canvas area that works everywhere.
 *
 * iOS Safari caps a single canvas at 16,777,216 pixels and additionally holds
 * a budget across every live canvas in the tab, beyond which allocations come
 * back blank rather than throwing. Chrome and Firefox allow far more. This is
 * the smallest of the three, because a limit that only bites on a phone is a
 * limit that only bites on the device most likely to be holding the HEIC.
 */
export const MAX_CANVAS_AREA = 16_777_216;

/** The largest side any browser accepts. Chrome is the binding constraint. */
export const MAX_CANVAS_SIDE = 32_767;

export function canvasCanHold(width: number, height: number): boolean {
	return width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && width * height <= MAX_CANVAS_AREA;
}

export function makeCanvas(width: number, height: number): AnyCanvas | undefined {
	if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
	return undefined;
}

export function requireCanvas(width: number, height: number): AnyCanvas {
	const canvas = makeCanvas(width, height);
	if (!canvas) {
		throw new CodecUnavailableError('canvas', 'This environment has no drawing surface.');
	}
	return canvas;
}

/**
 * A 2D context, in a colour space, when the browser understands the request.
 *
 * A browser that does not understand `colorSpace` ignores it rather than
 * failing, so the caller cannot tell from the call whether it worked. That is
 * what `contextColourSpace` is for.
 */
export function context2d(canvas: AnyCanvas, colourSpace: ColourSpace = 'srgb') {
	const options = colourSpace === 'display-p3' ? { colorSpace: 'display-p3' as const } : undefined;
	const context = canvas.getContext('2d', options) as
		(CanvasRenderingContext2D & { getContextAttributes?: () => { colorSpace?: string } }) | null;
	if (!context) {
		throw new CodecUnavailableError('canvas', 'This browser could not open a drawing surface.');
	}
	return context;
}

export function contextColourSpace(context: {
	getContextAttributes?: () => { colorSpace?: string };
}): ColourSpace {
	return context.getContextAttributes?.().colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
}

export function toBlob(canvas: AnyCanvas, mime: string, quality?: number): Promise<Blob | null> {
	if ('convertToBlob' in canvas) {
		return canvas.convertToBlob({ type: mime, quality }).catch(() => null);
	}
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), mime, quality);
	});
}

/** Draw a raster onto a fresh canvas, preserving its colour space where possible. */
export function rasterToCanvas(image: RasterImage): AnyCanvas {
	const canvas = requireCanvas(image.width, image.height);
	const context = context2d(canvas, image.colourSpace);
	const space = contextColourSpace(context);
	// `ImageData` wants a view over a plain `ArrayBuffer`, while a bare
	// `Uint8ClampedArray` is declared over `ArrayBufferLike`, which also admits
	// `SharedArrayBuffer`. Every raster here is allocated privately, so the
	// cast states what is already true. Keeping the public `RasterImage.data`
	// unparameterised is deliberate: it lets a consumer on an older TypeScript
	// build against this package.
	const pixels =
		typeof ImageData === 'function'
			? new ImageData(
					image.data as unknown as Uint8ClampedArray<ArrayBuffer>,
					image.width,
					image.height,
					{ colorSpace: space },
				)
			: undefined;
	if (!pixels) {
		throw new CodecUnavailableError('ImageData', 'This environment cannot build image data.');
	}
	context.putImageData(pixels, 0, 0);
	return canvas;
}
