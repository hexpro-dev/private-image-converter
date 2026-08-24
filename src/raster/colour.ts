/**
 * Colour space conversion.
 *
 * This exists because getting it wrong is invisible on the machine you are
 * testing on. An iPhone photograph decodes to Display P3 numbers. Writing
 * those into a file tagged sRGB, or into an untagged one, makes every colour
 * land short of where it should and the picture reads as flat. Running the
 * conversion on something already in sRGB does the same thing in reverse and
 * oversaturates it by about as much. On a wide-gamut display both mistakes
 * look plausible, so the rule is to detect per image and convert deliberately,
 * never to assume and never to batch.
 */

import type { ColourSpace, RasterImage } from '../types.js';
import { createRaster } from './image.js';

/**
 * Display P3 to sRGB, linear light, D65 throughout.
 *
 * Derived from the two sets of primaries rather than copied, so it can be
 * rederived: see the working in the commit that added this file. Both spaces
 * share a white point, so there is no chromatic adaptation step.
 */
const P3_TO_SRGB = [
	1.2249401763, -0.2249401763, 0.0, -0.0420569547, 1.0420569547, 0.0, -0.0196375546, -0.0786360456,
	1.0982736001,
] as const;

const SRGB_TO_P3 = [
	0.8224619687, 0.1775380313, 0.0, 0.0331941989, 0.9668058011, 0.0, 0.0170826307, 0.0723974407,
	0.9105199286,
] as const;

/**
 * The sRGB transfer function and its inverse, as 8 bit lookup tables.
 *
 * Display P3 uses the same transfer function as sRGB, so only the primaries
 * differ and only one pair of tables is needed. Building them once turns two
 * `Math.pow` calls per channel per pixel into two array reads, which on a 48
 * megapixel photograph is the difference between a pause and a hang.
 */
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
	const value = i / 255;
	TO_LINEAR[i] = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Encode linear light back to 8 bit, with the sRGB transfer function. */
function encode(linear: number): number {
	if (linear <= 0) return 0;
	if (linear >= 1) return 255;
	const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
	return Math.round(value * 255);
}

function convert(image: RasterImage, matrix: readonly number[], to: ColourSpace): RasterImage {
	const out = createRaster(image.width, image.height, to, image.hasAlpha);
	const source = image.data;
	const target = out.data;
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix as unknown as number[];

	for (let i = 0; i < source.length; i += 4) {
		const r = TO_LINEAR[source[i] as number] as number;
		const g = TO_LINEAR[source[i + 1] as number] as number;
		const b = TO_LINEAR[source[i + 2] as number] as number;
		target[i] = encode((m0 as number) * r + (m1 as number) * g + (m2 as number) * b);
		target[i + 1] = encode((m3 as number) * r + (m4 as number) * g + (m5 as number) * b);
		target[i + 2] = encode((m6 as number) * r + (m7 as number) * g + (m8 as number) * b);
		target[i + 3] = source[i + 3] as number;
	}
	return out;
}

/**
 * Convert an image into the given colour space.
 *
 * A no-op when it is already there, which is the common case and must stay
 * free: the conversion is lossy in both directions and doing it twice for no
 * reason costs quality as well as time.
 */
export function toColourSpace(image: RasterImage, to: ColourSpace): RasterImage {
	if (image.colourSpace === to) return image;
	if (to === 'srgb') return convert(image, P3_TO_SRGB, 'srgb');
	return convert(image, SRGB_TO_P3, 'display-p3');
}

/**
 * Whether any pixel of a Display P3 image is outside the sRGB gamut.
 *
 * Worth asking before deciding a wide-gamut output is justified. For a screen
 * capture of a dark interface the answer is usually none at all, and shipping
 * a P3 asset for that is pure cost.
 */
export function outOfSrgbGamut(image: RasterImage): number {
	if (image.colourSpace !== 'display-p3') return 0;
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = P3_TO_SRGB as unknown as number[];
	const data = image.data;
	let outside = 0;
	for (let i = 0; i < data.length; i += 4) {
		const r = TO_LINEAR[data[i] as number] as number;
		const g = TO_LINEAR[data[i + 1] as number] as number;
		const b = TO_LINEAR[data[i + 2] as number] as number;
		const cr = (m0 as number) * r + (m1 as number) * g + (m2 as number) * b;
		const cg = (m3 as number) * r + (m4 as number) * g + (m5 as number) * b;
		const cb = (m6 as number) * r + (m7 as number) * g + (m8 as number) * b;
		if (cr < 0 || cr > 1 || cg < 0 || cg > 1 || cb < 0 || cb > 1) outside += 1;
	}
	return outside / (image.width * image.height);
}
