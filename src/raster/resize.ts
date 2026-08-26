/**
 * Resampling.
 *
 * Written first for the icon formats, which have no choice: an ICO holds
 * several sizes of the same picture and an Apple icon suite holds ten, and
 * neither can be written from a single raster without scaling it. It is not a
 * canvas call, for the reason on `RasterImage`: a canvas cannot hold a large
 * photograph on iOS Safari, and a resize that fails only on the device people
 * actually use is worse than no resize at all.
 *
 * It now also serves `ConvertOptions.resize`, which is a photograph rather than
 * an icon, so the sizes involved went up by three orders of magnitude and the
 * memory shape had to change with them. See `resampleAxis` on why nothing
 * materialises a premultiplied copy of the source any more.
 *
 * Alpha is premultiplied before filtering and undone afterwards. Averaging
 * straight RGBA lets the colour of fully transparent pixels leak into their
 * neighbours, and because a transparent pixel is usually black, every soft
 * edge picks up a dark halo. It is the single most common bug in hand-written
 * image scaling and it is invisible until somebody puts the icon on a light
 * background.
 */

import type { FloatImage, RasterImage } from '../types.js';
import { createFloat } from './float.js';
import { createRaster } from './image.js';

/**
 * What one unit of alpha means in the source array.
 *
 * A `RasterImage` stores alpha as 0 to 255 and a `FloatImage` stores it as 0 to
 * 1, and the filter has to normalise it to premultiply correctly. Passing the
 * reciprocal rather than a flag keeps the inner loop a multiply instead of a
 * branch.
 */
const BYTE_ALPHA = 1 / 255;
const FLOAT_ALPHA = 1;

/**
 * Scale an image to exactly `width` by `height`.
 *
 * Area averaging when shrinking, which is the correct filter for it and the
 * only one that does not alias a photograph down to a mess of moiré. Bilinear
 * when growing, where area averaging degenerates to nearest neighbour. A mixed
 * case, narrower but taller, gets area in one axis and bilinear in the other,
 * because the two passes are separate.
 */
export function resizeRaster(image: RasterImage, width: number, height: number): RasterImage {
	if (width === image.width && height === image.height) return image;
	checkSize(width, height);
	const horizontal = resampleAxis(
		image.data,
		image.width,
		image.height,
		width,
		image.height,
		true,
		BYTE_ALPHA,
	);
	const both = resampleAxis(horizontal, width, image.height, width, height, false);
	const out = createRaster(width, height, image.colourSpace, image.hasAlpha);
	const target = out.data;
	for (let i = 0; i < target.length; i += 4) {
		const alpha = both[i + 3] as number;
		if (alpha <= 0) {
			target[i] = 0;
			target[i + 1] = 0;
			target[i + 2] = 0;
			target[i + 3] = 0;
			continue;
		}
		const scale = 255 / alpha;
		target[i] = Math.round((both[i] as number) * scale);
		target[i + 1] = Math.round((both[i + 1] as number) * scale);
		target[i + 2] = Math.round((both[i + 2] as number) * scale);
		target[i + 3] = Math.round(alpha);
	}
	return out;
}

/**
 * The same filter over unbounded light.
 *
 * Separate from `resizeRaster` only at the ends: the footprint arithmetic in
 * `resampleAxis` is shared, because averaging is averaging whatever the numbers
 * mean. What differs is that alpha is already normalised and that nothing is
 * rounded or clamped on the way out, since a value above 1 is the entire point
 * of the format that produced it.
 */
export function resizeFloat(image: FloatImage, width: number, height: number): FloatImage {
	if (width === image.width && height === image.height) return image;
	checkSize(width, height);
	const horizontal = resampleAxis(
		image.data,
		image.width,
		image.height,
		width,
		image.height,
		true,
		FLOAT_ALPHA,
	);
	const both = resampleAxis(horizontal, width, image.height, width, height, false);
	const out = createFloat(width, height, image.colourSpace, image.hasAlpha);
	const target = out.data;
	for (let i = 0; i < target.length; i += 4) {
		const alpha = both[i + 3] as number;
		if (alpha <= 0) {
			target[i] = 0;
			target[i + 1] = 0;
			target[i + 2] = 0;
			target[i + 3] = 0;
			continue;
		}
		const scale = 1 / alpha;
		target[i] = (both[i] as number) * scale;
		target[i + 1] = (both[i + 1] as number) * scale;
		target[i + 2] = (both[i + 2] as number) * scale;
		target[i + 3] = alpha;
	}
	return out;
}

function checkSize(width: number, height: number): void {
	if (width < 1 || height < 1) {
		throw new RangeError('A resized image must be at least one pixel in each direction.');
	}
}

/**
 * Resample one axis.
 *
 * Both directions are the same loop over an output pixel's footprint in the
 * input. Shrinking, that footprint spans several input pixels and every one of
 * them contributes its overlap; growing, it lies inside one or two and the
 * overlap weights become a linear blend. Writing it once this way is what
 * makes the mixed case fall out for free.
 *
 * `alphaScale` is what keeps this affordable on a photograph. Passing it says
 * the source is straight rather than premultiplied, and the premultiply then
 * happens against the value already loaded for the weighted sum rather than in
 * a separate pass over a separate array. That pass used to allocate sixteen
 * bytes per *source* pixel, which on a 48 megapixel photograph is 768 megabytes
 * for a picture the caller asked to make smaller. Fused, the largest allocation
 * is the intermediate at the target width, which for any real downscale is a
 * fraction of it.
 */
function resampleAxis(
	source: ArrayLike<number>,
	sourceWidth: number,
	sourceHeight: number,
	targetWidth: number,
	targetHeight: number,
	alongX: boolean,
	alphaScale?: number,
): Float32Array {
	const outer = alongX ? sourceHeight : targetWidth;
	const from = alongX ? sourceWidth : sourceHeight;
	const to = alongX ? targetWidth : targetHeight;
	const straight = alphaScale !== undefined;
	const normalise = alphaScale ?? 1;

	// Nothing to filter along this axis. A premultiplied source can be handed
	// straight back; a straight one still owes the caller the premultiply the
	// loop below would otherwise have done.
	if (from === to) {
		if (!straight) return source as Float32Array;
		const copy = new Float32Array(sourceWidth * sourceHeight * 4);
		for (let i = 0; i < copy.length; i += 4) {
			const alpha = source[i + 3] as number;
			const premultiplier = alpha * normalise;
			copy[i] = (source[i] as number) * premultiplier;
			copy[i + 1] = (source[i + 1] as number) * premultiplier;
			copy[i + 2] = (source[i + 2] as number) * premultiplier;
			copy[i + 3] = alpha;
		}
		return copy;
	}

	const out = new Float32Array(targetWidth * targetHeight * 4);
	const scale = from / to;

	for (let o = 0; o < outer; o += 1) {
		for (let i = 0; i < to; i += 1) {
			// The footprint of this output sample in input coordinates. The half
			// pixel offsets put sample centres in the middle of their cells,
			// which is what stops a scaled image drifting half a pixel across.
			const centre = (i + 0.5) * scale;
			const radius = Math.max(scale, 1) / 2;
			const start = Math.max(0, Math.floor(centre - radius));
			const end = Math.min(from, Math.ceil(centre + radius));

			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let total = 0;
			for (let s = start; s < end; s += 1) {
				// Overlap of the input cell [s, s+1) with the footprint.
				const weight = Math.min(s + 1, centre + radius) - Math.max(s, centre - radius);
				if (weight <= 0) continue;
				const at = alongX ? (o * sourceWidth + s) * 4 : (s * targetWidth + o) * 4;
				const alpha = source[at + 3] as number;
				const colourWeight = straight ? weight * alpha * normalise : weight;
				r += (source[at] as number) * colourWeight;
				g += (source[at + 1] as number) * colourWeight;
				b += (source[at + 2] as number) * colourWeight;
				a += alpha * weight;
				total += weight;
			}
			// A footprint can miss every cell centre only when it is degenerate,
			// which the clamps above prevent, but a zero here would be a silent
			// division rather than a visible one.
			if (total === 0) total = 1;
			const at = alongX ? (o * targetWidth + i) * 4 : (i * targetWidth + o) * 4;
			out[at] = r / total;
			out[at + 1] = g / total;
			out[at + 2] = b / total;
			out[at + 3] = a / total;
		}
	}
	return out;
}

/**
 * The size an image becomes when its longest side is capped.
 *
 * Never upscales. Asking for a longest side larger than the picture already has
 * returns the picture's own size, because a conversion tool that quietly
 * invented pixels would be lying about what came out of it, and because
 * somebody who types a big number into a box means "do not shrink this" rather
 * than "interpolate it up".
 */
export function fitLongestSide(
	width: number,
	height: number,
	longestSide: number,
): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (!Number.isFinite(longestSide) || longestSide < 1 || longestSide >= longest) {
		return { width, height };
	}
	const scale = longestSide / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Scale to fit inside a square, keeping the aspect ratio, then centre it.
 *
 * What an icon needs. A 3024 by 4032 photograph in a 512 pixel icon slot has
 * to become 512 by 512 somehow, and stretching it is the one answer nobody
 * wants. The padding is transparent, which every icon format can carry.
 */
export function fitSquare(image: RasterImage, side: number): RasterImage {
	const scale = Math.min(side / image.width, side / image.height);
	const width = Math.max(1, Math.round(image.width * scale));
	const height = Math.max(1, Math.round(image.height * scale));
	const scaled = resizeRaster(image, width, height);
	if (width === side && height === side) return scaled;

	const out = createRaster(side, side, image.colourSpace, true);
	const x = Math.floor((side - width) / 2);
	const y = Math.floor((side - height) / 2);
	for (let row = 0; row < height; row += 1) {
		const source = row * width * 4;
		out.data.set(scaled.data.subarray(source, source + width * 4), ((y + row) * side + x) * 4);
	}
	return out;
}
