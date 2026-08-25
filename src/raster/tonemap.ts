/**
 * High dynamic range to eight bits.
 *
 * Radiance and OpenEXR both store linear light with no ceiling: a value of 1
 * is a diffuse white surface and the sun in the same picture is somewhere past
 * 10000. Nothing here can display that, and the two obvious answers are both
 * wrong. Clipping at 1 turns every window and every lamp into a flat white
 * shape. Scaling by the maximum turns the whole picture black, because one
 * specular highlight is thousands of times brighter than the subject.
 *
 * So the exposure is chosen from the picture, the way a camera chooses one,
 * and the roll-off above it is Reinhard's, which compresses the highlights
 * instead of cutting them off. The result is a photograph rather than a
 * measurement, which is what somebody converting an EXR to a PNG wants. What
 * they lose is said plainly in the report rather than left to be discovered.
 */

import type { FloatImage, ToneMapOptions, ToneMapResult } from '../types.js';
import { createRaster } from './image.js';

export type { ToneMapOptions, ToneMapResult };

/** Rec. 709 luminance, which both formats' primaries agree on. */
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function encodeSrgb(linear: number): number {
	if (!(linear > 0)) return 0;
	if (linear >= 1) return 255;
	const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
	return Math.round(value * 255);
}

/**
 * Map linear floating point light to a displayable raster.
 *
 * `source` is `channels` floats per pixel in row order, red first. Alpha, when
 * present, is passed through untouched: it is coverage rather than light and
 * tone mapping it would make every soft edge harder or softer depending on how
 * bright the picture happened to be.
 *
 * The exposure and the white point come back with the picture rather than
 * being kept private, because they are the two numbers that explain why the
 * result looks the way it does, and a person who disagrees with the automatic
 * choice can only argue with a number they can see.
 */
export function toneMap(
	source: Float32Array,
	width: number,
	height: number,
	channels: 3 | 4,
	options: ToneMapOptions = {},
): ToneMapResult {
	const pixels = width * height;
	const out = createRaster(width, height, options.colourSpace ?? 'srgb', channels === 4);
	const target = out.data;

	// The log average, which is the geometric mean of the luminances. An
	// ordinary mean is dominated by the handful of pixels that are thousands of
	// times brighter than everything else, which is precisely the situation
	// this format exists to represent, so it would meter for the sun and
	// underexpose the entire subject.
	let logSum = 0;
	let lit = 0;
	for (let i = 0; i < pixels; i += 1) {
		const at = i * channels;
		const l = luminance(source[at] as number, source[at + 1] as number, source[at + 2] as number);
		if (l > 0) {
			logSum += Math.log(l + 1e-6);
			lit += 1;
		}
	}
	const average = lit === 0 ? 0.18 : Math.exp(logSum / lit);
	const metered = 0.18 / Math.max(average, 1e-6);
	const exposure = metered * Math.pow(2, options.stops ?? 0);

	// White is where the roll-off asymptotes. Taking it from the brightest
	// pixel keeps the highlight that is actually in the picture just short of
	// clipping; taking it from a constant would clip a bright picture and
	// leave a dim one looking washed out.
	let white = 1;
	if (!options.clip) {
		white = 0;
		for (let i = 0; i < pixels; i += 1) {
			const at = i * channels;
			const l =
				luminance(source[at] as number, source[at + 1] as number, source[at + 2] as number) *
				exposure;
			if (l > white) white = l;
		}
		if (!(white > 1)) white = 1;
	}
	const whiteSquared = white * white;

	for (let i = 0; i < pixels; i += 1) {
		const at = i * channels;
		const r = (source[at] as number) * exposure;
		const g = (source[at + 1] as number) * exposure;
		const b = (source[at + 2] as number) * exposure;

		let scale = 1;
		if (!options.clip) {
			const l = luminance(r, g, b);
			if (l > 0) {
				// Reinhard's extended operator. The plain form drives everything
				// towards white; the extended one lets a chosen luminance reach
				// exactly 1 and leaves the midtones where the exposure put them.
				const mapped = (l * (1 + l / whiteSquared)) / (1 + l);
				scale = mapped / l;
			}
		}

		const to = i * 4;
		target[to] = encodeSrgb(r * scale);
		target[to + 1] = encodeSrgb(g * scale);
		target[to + 2] = encodeSrgb(b * scale);
		target[to + 3] =
			channels === 4
				? Math.max(0, Math.min(255, Math.round((source[at + 3] as number) * 255)))
				: 255;
	}

	return { image: out, stops: options.stops ?? 0, white };
}

/**
 * Tone map a `FloatImage`, which is always four channels.
 *
 * What `convert` calls. The four-argument form above stays for the decoders,
 * which have their samples as a bare buffer and know their own channel count
 * before they have anywhere to put it.
 */
export function toneMapImage(image: FloatImage, options: ToneMapOptions = {}): ToneMapResult {
	return toneMap(image.data, image.width, image.height, 4, {
		colourSpace: image.colourSpace,
		...options,
	});
}

/**
 * Decode a half-precision float.
 *
 * OpenEXR's usual channel type, and there is no typed array for it. The three
 * special cases are all real: a subnormal is common in the darkest parts of a
 * render, an infinity turns up where a light source was divided by zero, and a
 * NaN turns up in an alpha channel more often than anybody would like.
 */
export function halfToFloat(bits: number): number {
	const sign = bits & 0x8000 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const mantissa = bits & 0x03ff;
	if (exponent === 0) return sign * mantissa * 2 ** -24;
	if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
	return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
