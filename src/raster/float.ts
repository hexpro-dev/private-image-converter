/**
 * Rasters that hold light instead of a picture of one.
 *
 * The counterpart to `image.ts`, for the formats whose samples are radiometric
 * rather than display referred. Everything here is linear: no transfer curve
 * has been applied, 1 is a diffuse white surface, and the numbers above it are
 * the reason the format was chosen. Alpha is the exception and is straight
 * coverage in 0 to 1, exactly as it is on a `RasterImage`.
 *
 * The conversions in both directions are here rather than split across the two
 * codecs that need them, because getting the curve wrong in either direction
 * produces a file that opens, looks recognisable and is about a stop out. That
 * is the failure this module exists to have exactly one copy of.
 */

import type { ColourSpace, FloatImage, RasterImage } from '../types.js';

/** Display P3 to sRGB, in linear light. Same matrix as `colour.ts` uses. */
const P3_TO_SRGB = [
	1.2249401763, -0.2249401763, 0.0, -0.0420569547, 1.0420569547, 0.0, -0.0196375546, -0.0786360456,
	1.0982736002,
] as const;

/** sRGB to Display P3, in linear light. */
const SRGB_TO_P3 = [
	0.8224619687, 0.1775380313, 0.0, 0.0331941989, 0.9668058011, 0.0, 0.0170826307, 0.0723974407,
	0.9105199286,
] as const;

/**
 * The sRGB transfer function, undone, for all 256 byte values.
 *
 * A table because the alternative is a `Math.pow` per channel per pixel, and a
 * 48 megapixel photograph is 144 million of them. Display P3 shares this curve
 * exactly and differs only in its primaries, so both colour spaces read from
 * the same table and say what their numbers mean separately.
 */
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
	const value = i / 255;
	TO_LINEAR[i] = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function createFloat(
	width: number,
	height: number,
	colourSpace: ColourSpace = 'srgb',
	hasAlpha = false,
): FloatImage {
	return { data: new Float32Array(width * height * 4), width, height, colourSpace, hasAlpha };
}

/**
 * Read an eight bit picture as light.
 *
 * Undoing the transfer curve is the whole job, and skipping it is the mistake
 * these formats invite: the file opens, the colours are recognisable, and
 * every midtone is about twice as bright as it should be. What this cannot do
 * is invent range that was never there, so the result tops out at 1 and a
 * Radiance file written from it is a linear record of an ordinary picture
 * rather than a high dynamic range one.
 */
export function floatFromRaster(image: RasterImage): FloatImage {
	const out = createFloat(image.width, image.height, image.colourSpace, image.hasAlpha);
	const source = image.data;
	const target = out.data;
	for (let i = 0; i < source.length; i += 4) {
		target[i] = TO_LINEAR[source[i] as number] as number;
		target[i + 1] = TO_LINEAR[source[i + 1] as number] as number;
		target[i + 2] = TO_LINEAR[source[i + 2] as number] as number;
		target[i + 3] = (source[i + 3] as number) / 255;
	}
	return out;
}

/**
 * Whether any pixel is actually translucent.
 *
 * The same question `detectAlpha` answers for bytes, and asked for the same
 * reason: the buffer always has four channels and an encoder wants to know
 * whether the fourth one is carrying anything before it pays to store it.
 */
export function detectFloatAlpha(image: FloatImage): boolean {
	const data = image.data;
	for (let i = 3; i < data.length; i += 4) {
		if ((data[i] as number) < 1) return true;
	}
	return false;
}

/**
 * Move light between colour spaces.
 *
 * A matrix on linear samples, with no curve involved in either direction,
 * which is the one place working in light is simpler than working in bytes.
 * Values are not clamped: a colour outside the destination gamut comes out
 * negative and stays that way, because clamping here would quietly change a
 * measurement, and whatever eventually writes bytes is where a decision about
 * gamut belongs.
 */
export function toFloatColourSpace(image: FloatImage, to: ColourSpace): FloatImage {
	if (image.colourSpace === to) return image;
	const matrix = to === 'srgb' ? P3_TO_SRGB : SRGB_TO_P3;
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
	const source = image.data;
	const out = createFloat(image.width, image.height, to, image.hasAlpha);
	const target = out.data;
	for (let i = 0; i < source.length; i += 4) {
		const r = source[i] as number;
		const g = source[i + 1] as number;
		const b = source[i + 2] as number;
		target[i] = m0 * r + m1 * g + m2 * b;
		target[i + 1] = m3 * r + m4 * g + m5 * b;
		target[i + 2] = m6 * r + m7 * g + m8 * b;
		target[i + 3] = source[i + 3] as number;
	}
	return out;
}
