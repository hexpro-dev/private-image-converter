/**
 * Operations on a decoded raster.
 *
 * All of these work on plain RGBA bytes and none of them touch a canvas, for
 * the reason given on `RasterImage`: a 48 megapixel photograph cannot be a
 * canvas on iOS Safari, so the assembly and orientation of one cannot depend
 * on being able to make one.
 */

import type { ColourSpace, Mirror, Orientation, RasterImage, Rotation } from '../types.js';

export function createRaster(
	width: number,
	height: number,
	colourSpace: ColourSpace = 'srgb',
	hasAlpha = false,
): RasterImage {
	return { data: new Uint8ClampedArray(width * height * 4), width, height, colourSpace, hasAlpha };
}

/**
 * Copy `tile` into `target` with its top left corner at (x, y).
 *
 * Clipped rather than checked: a grid's last row and column of tiles hang over
 * the edge of the real image by design, and refusing them would refuse every
 * photograph whose dimensions are not a multiple of the tile size, which is
 * almost all of them.
 */
export function blit(target: RasterImage, tile: RasterImage, x: number, y: number): void {
	const width = Math.min(tile.width, target.width - x);
	const height = Math.min(tile.height, target.height - y);
	if (width <= 0 || height <= 0) return;

	for (let row = 0; row < height; row += 1) {
		const from = row * tile.width * 4;
		const to = ((y + row) * target.width + x) * 4;
		target.data.set(tile.data.subarray(from, from + width * 4), to);
	}
}

export function crop(
	image: RasterImage,
	x: number,
	y: number,
	width: number,
	height: number,
): RasterImage {
	if (x === 0 && y === 0 && width === image.width && height === image.height) return image;
	const out = createRaster(width, height, image.colourSpace, image.hasAlpha);
	for (let row = 0; row < height; row += 1) {
		const from = ((y + row) * image.width + x) * 4;
		out.data.set(image.data.subarray(from, from + width * 4), row * width * 4);
	}
	return out;
}

/** Rotate anticlockwise by a right angle, matching the sense of HEIF `irot`. */
export function rotate(image: RasterImage, rotation: Rotation): RasterImage {
	if (rotation === 0) return image;
	const { width, height, data } = image;
	const turned = rotation === 90 || rotation === 270;
	const outWidth = turned ? height : width;
	const outHeight = turned ? width : height;
	const out = createRaster(outWidth, outHeight, image.colourSpace, image.hasAlpha);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let tx: number;
			let ty: number;
			switch (rotation) {
				case 90:
					// Anticlockwise: the right hand column becomes the top row.
					tx = y;
					ty = width - 1 - x;
					break;
				case 180:
					tx = width - 1 - x;
					ty = height - 1 - y;
					break;
				default:
					tx = height - 1 - y;
					ty = x;
					break;
			}
			const from = (y * width + x) * 4;
			const to = (ty * outWidth + tx) * 4;
			out.data[to] = data[from] as number;
			out.data[to + 1] = data[from + 1] as number;
			out.data[to + 2] = data[from + 2] as number;
			out.data[to + 3] = data[from + 3] as number;
		}
	}
	return out;
}

export function mirror(image: RasterImage, axis: Mirror): RasterImage {
	if (axis === 'none') return image;
	const { width, height, data } = image;
	const out = createRaster(width, height, image.colourSpace, image.hasAlpha);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sx = axis === 'horizontal' ? width - 1 - x : x;
			const sy = axis === 'vertical' ? height - 1 - y : y;
			const from = (sy * width + sx) * 4;
			const to = (y * width + x) * 4;
			out.data[to] = data[from] as number;
			out.data[to + 1] = data[from + 1] as number;
			out.data[to + 2] = data[from + 2] as number;
			out.data[to + 3] = data[from + 3] as number;
		}
	}
	return out;
}

/**
 * Apply an orientation.
 *
 * Mirror first, then rotate, which is the order ISO/IEC 23008-12 specifies for
 * `imir` and `irot`. Reversing them is wrong for every case where both are
 * present and indistinguishable for every case where only one is, so it
 * survives testing on real photographs and fails on the rare file that has
 * both.
 */
export function applyOrientation(image: RasterImage, orientation: Orientation): RasterImage {
	return rotate(mirror(image, orientation.mirror), orientation.rotation);
}

/** Whether any pixel is actually translucent. */
export function detectAlpha(image: RasterImage): boolean {
	const { data } = image;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] !== 255) return true;
	}
	return false;
}

/**
 * Composite onto an opaque background.
 *
 * Needed before writing a format with no alpha channel. Straight alpha in,
 * opaque out, done in place on a copy.
 */
export function flatten(
	image: RasterImage,
	background: readonly [number, number, number] = [255, 255, 255],
): RasterImage {
	if (!image.hasAlpha) return image;
	const out = createRaster(image.width, image.height, image.colourSpace, false);
	const [br, bg, bb] = background;
	const source = image.data;
	const target = out.data;
	for (let i = 0; i < source.length; i += 4) {
		const alpha = (source[i + 3] as number) / 255;
		const inverse = 1 - alpha;
		target[i] = (source[i] as number) * alpha + br * inverse;
		target[i + 1] = (source[i + 1] as number) * alpha + bg * inverse;
		target[i + 2] = (source[i + 2] as number) * alpha + bb * inverse;
		target[i + 3] = 255;
	}
	return out;
}

/** Replace the alpha channel of `image` from the luminance-free A of `alpha`. */
export function attachAlpha(image: RasterImage, alpha: RasterImage): RasterImage {
	const out = createRaster(image.width, image.height, image.colourSpace, true);
	out.data.set(image.data);
	const count = Math.min(image.width * image.height, alpha.width * alpha.height);
	for (let i = 0; i < count; i += 1) {
		// An auxiliary alpha image is monochrome; its red channel is the value.
		out.data[i * 4 + 3] = alpha.data[i * 4] as number;
	}
	return out;
}

export function withColourSpace(image: RasterImage, colourSpace: ColourSpace): RasterImage {
	if (image.colourSpace === colourSpace) return image;
	return { ...image, colourSpace };
}
