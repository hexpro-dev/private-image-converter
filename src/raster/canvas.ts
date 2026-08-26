/**
 * The small amount of canvas this package touches.
 *
 * Kept in one place because canvas is where the platform limits live, and
 * because every one of these calls has a browser-specific trap attached to it
 * that is worth writing down once rather than rediscovering per caller.
 */

import { CodecUnavailableError, SurfaceTooLargeError } from '../errors.js';
import type { ColourSpace, RasterImage } from '../types.js';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The area below which no browser needs asking.
 *
 * iOS Safari caps a single canvas at 16,777,216 pixels, which is the smallest
 * ceiling of any browser, so anything at or under this is known to work without
 * a probe. It is deliberately no longer used as *the* limit. Applying iOS's
 * number everywhere refused a 24 megapixel photograph on a desktop machine that
 * would have handled four times as much, and every recent iPhone shoots 24
 * megapixels, so the number that was meant to protect the phone was the number
 * that broke the phone's own photographs.
 */
export const MAX_CANVAS_AREA = 16_777_216;

/**
 * The area above which nothing is worth attempting.
 *
 * Chrome is the most generous of the three at roughly 268 megapixels, so past
 * this a probe is a guaranteed failure that allocates a gigabyte to discover
 * it. Below it, ask the browser rather than guessing.
 */
export const MAX_CANVAS_AREA_CEILING = 268_435_456;

/** The largest side any browser accepts. Chrome is the binding constraint. */
export const MAX_CANVAS_SIDE = 32_767;

/** The cheap, certain part of the question. A probe cannot rescue these. */
function withinStaticLimits(width: number, height: number): boolean {
	return (
		width >= 1 &&
		height >= 1 &&
		width <= MAX_CANVAS_SIDE &&
		height <= MAX_CANVAS_SIDE &&
		width * height <= MAX_CANVAS_AREA_CEILING
	);
}

/**
 * Whether a surface this size is known to work without asking.
 *
 * Retained because it is the honest answer for the one case it covers, and
 * because a caller that only wants the conservative floor should not have to
 * allocate to get it. It is not the gate any more; `openCanvas` is.
 */
export function canvasCanHold(width: number, height: number): boolean {
	return withinStaticLimits(width, height) && width * height <= MAX_CANVAS_AREA;
}

/**
 * Paint one pixel and read it back, to find out whether the surface is real.
 *
 * iOS Safari does not throw when it runs past its budget. It hands back a
 * canvas of the requested size whose pixels are all zero, and every drawing
 * call onto it succeeds and does nothing. There is no flag to read and no event
 * to catch, so the only way to know is to write a value and see whether it
 * comes back.
 *
 * Alpha is what gets tested rather than the colour. A context may be colour
 * managed, so the red that goes in is not necessarily the red that comes out,
 * but a live surface always returns an opaque pixel where one was painted and a
 * dead one always returns zero.
 */
function surfaceIsLive(context: CanvasRenderingContext2D): boolean {
	try {
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, 1, 1);
		const probe = context.getImageData(0, 0, 1, 1);
		return probe.data[3] === 255;
	} catch {
		// A context that refuses `getImageData` cannot be read back at all,
		// which for every caller here is the same as not working.
		return false;
	}
}

/**
 * Release a canvas now rather than when the collector gets to it.
 *
 * WebKit frees the backing store on a size change, and the budget this exists
 * to stay inside is measured across live surfaces. Waiting for collection means
 * the probe's allocation is still counted against the allocation it was
 * probing for.
 */
function release(canvas: AnyCanvas): void {
	try {
		canvas.width = 0;
		canvas.height = 0;
	} catch {
		// Nothing to do. A canvas that will not resize will be collected.
	}
}

/**
 * Ask the browser whether it can hold a surface this size, and free it again.
 *
 * For a caller that has to decide before it has the pixels. The transient
 * allocation is the price of the answer, and it is released before returning so
 * that the real allocation which follows is measured against the same budget
 * this call was.
 *
 * Callers that are about to draw should use `openCanvas` instead, which hands
 * back the probed surface rather than throwing it away.
 */
export function canvasHolds(width: number, height: number): boolean {
	if (!withinStaticLimits(width, height)) return false;
	if (width * height <= MAX_CANVAS_AREA) return true;
	let canvas: AnyCanvas | undefined;
	try {
		canvas = makeCanvas(width, height);
		if (!canvas) return false;
		const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
		if (!context) return false;
		return surfaceIsLive(context);
	} catch {
		return false;
	} finally {
		if (canvas) release(canvas);
	}
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

/**
 * A drawing surface that has been proved to work, or nothing.
 *
 * The one call every drawing path should make. It allocates, opens the context,
 * writes a pixel and reads it back, and only hands the canvas over once that
 * round trip succeeded. A caller that gets `undefined` has learnt that this
 * browser will not hold a surface this size *right now*, which is a different
 * statement from a constant and a more useful one: the limit it is up against
 * on iOS moves with whatever else the tab is holding.
 *
 * The pixel it paints is at 0,0 and is overwritten by whatever the caller draws
 * next, so no caller has to clean up after it.
 */
export function openCanvas(
	width: number,
	height: number,
	colourSpace: ColourSpace = 'srgb',
): { canvas: AnyCanvas; context: CanvasRenderingContext2D; space: ColourSpace } | undefined {
	if (!withinStaticLimits(width, height)) return undefined;
	let canvas: AnyCanvas | undefined;
	try {
		canvas = requireCanvas(width, height);
		const context = context2d(canvas, colourSpace);
		if (!surfaceIsLive(context)) {
			release(canvas);
			return undefined;
		}
		return { canvas, context, space: contextColourSpace(context) };
	} catch (error) {
		if (canvas) release(canvas);
		// A missing canvas API is an environment fact and belongs to the
		// caller; a surface that would not allocate is this function's answer.
		if (error instanceof CodecUnavailableError) throw error;
		return undefined;
	}
}

export function toBlob(canvas: AnyCanvas, mime: string, quality?: number): Promise<Blob | null> {
	if ('convertToBlob' in canvas) {
		return canvas.convertToBlob({ type: mime, quality }).catch(() => null);
	}
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), mime, quality);
	});
}

/**
 * Draw a raster onto a fresh canvas, preserving its colour space where possible.
 *
 * Throws `SurfaceTooLargeError` rather than returning a dead canvas, because
 * every caller here goes on to read pixels back out and a blank readback would
 * be written out as a file full of transparent black.
 */
export function rasterToCanvas(image: RasterImage): AnyCanvas {
	const opened = openCanvas(image.width, image.height, image.colourSpace);
	if (!opened) throw new SurfaceTooLargeError(image.width, image.height);
	const { canvas, context, space } = opened;
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
