/**
 * Resampling.
 *
 * Only two callers need it, and both are icon formats: an ICO holds several
 * sizes of the same picture and an Apple icon suite holds ten. Neither can be
 * written from a single raster without scaling it, so this exists rather than
 * a canvas call, for the reason on `RasterImage`: a canvas cannot hold a large
 * photograph on iOS Safari, and a resize that fails only on the device people
 * actually use is worse than no resize at all.
 *
 * Alpha is premultiplied before filtering and undone afterwards. Averaging
 * straight RGBA lets the colour of fully transparent pixels leak into their
 * neighbours, and because a transparent pixel is usually black, every soft
 * edge picks up a dark halo. It is the single most common bug in hand-written
 * image scaling and it is invisible until somebody puts the icon on a light
 * background.
 */

import type { RasterImage } from '../types.js';
import { createRaster } from './image.js';

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
	if (width < 1 || height < 1) {
		throw new RangeError('A resized image must be at least one pixel in each direction.');
	}
	const horizontal = resampleAxis(
		premultiply(image),
		image.width,
		image.height,
		width,
		image.height,
		true,
	);
	const both = resampleAxis(horizontal, width, image.height, width, height, false);
	return unpremultiply(both, width, height, image);
}

/** Straight RGBA to premultiplied floats. */
function premultiply(image: RasterImage): Float32Array {
	const { data } = image;
	const out = new Float32Array(data.length);
	for (let i = 0; i < data.length; i += 4) {
		const a = (data[i + 3] as number) / 255;
		out[i] = (data[i] as number) * a;
		out[i + 1] = (data[i + 1] as number) * a;
		out[i + 2] = (data[i + 2] as number) * a;
		out[i + 3] = data[i + 3] as number;
	}
	return out;
}

function unpremultiply(
	source: Float32Array,
	width: number,
	height: number,
	like: RasterImage,
): RasterImage {
	const out = createRaster(width, height, like.colourSpace, like.hasAlpha);
	const target = out.data;
	for (let i = 0; i < target.length; i += 4) {
		const alpha = source[i + 3] as number;
		if (alpha <= 0) {
			target[i] = 0;
			target[i + 1] = 0;
			target[i + 2] = 0;
			target[i + 3] = 0;
			continue;
		}
		const scale = 255 / alpha;
		target[i] = Math.round((source[i] as number) * scale);
		target[i + 1] = Math.round((source[i + 1] as number) * scale);
		target[i + 2] = Math.round((source[i + 2] as number) * scale);
		target[i + 3] = Math.round(alpha);
	}
	return out;
}

/**
 * Resample one axis.
 *
 * Both directions are the same loop over an output pixel's footprint in the
 * input. Shrinking, that footprint spans several input pixels and every one of
 * them contributes its overlap; growing, it lies inside one or two and the
 * overlap weights become a linear blend. Writing it once this way is what
 * makes the mixed case fall out for free.
 */
function resampleAxis(
	source: Float32Array,
	sourceWidth: number,
	sourceHeight: number,
	targetWidth: number,
	targetHeight: number,
	alongX: boolean,
): Float32Array {
	const out = new Float32Array(targetWidth * targetHeight * 4);
	const outer = alongX ? sourceHeight : targetWidth;
	const from = alongX ? sourceWidth : sourceHeight;
	const to = alongX ? targetWidth : targetHeight;
	if (from === to) return source;
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
				r += (source[at] as number) * weight;
				g += (source[at + 1] as number) * weight;
				b += (source[at + 2] as number) * weight;
				a += (source[at + 3] as number) * weight;
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
