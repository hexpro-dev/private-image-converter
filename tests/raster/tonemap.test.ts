/**
 * Tone mapping and half precision tests.
 *
 * The half precision expectations come from IEEE 754 rather than from a run.
 * A subnormal is its mantissa times two to the minus twenty four, a normal is
 * one plus the mantissa over 1024 times two to the exponent less fifteen, and
 * every value below is written as that arithmetic so a wrong bias or a dropped
 * implicit one cannot be papered over by a decimal literal copied out of the
 * output. Zero and negative zero are told apart with `Object.is`, because
 * `toBe` treats them as equal and a sign lost on zero is a sign lost on
 * everything near it.
 *
 * The tone mapping expectations are properties rather than a captured picture,
 * with one exception. Mid grey is pinned to the byte: 0.18 linear metered onto
 * itself and encoded through the sRGB curve is 1.055 times 0.18 to the power of
 * one over 2.4, less 0.055, which is 0.4614 and lands on 118. That number is
 * the whole claim of the module, so it is stated rather than bounded.
 */

import { describe, expect, it } from 'vitest';
import { halfToFloat, toneMap } from '../../src/raster/tonemap.js';
import type { RasterImage } from '../../src/types.js';

/** Every pixel the same linear value, which meters onto mid grey. */
function uniform(value: number, pixels: number, channels: 3 | 4 = 3): Float32Array {
	const source = new Float32Array(pixels * channels);
	for (let i = 0; i < pixels; i += 1) {
		source[i * channels] = value;
		source[i * channels + 1] = value;
		source[i * channels + 2] = value;
		if (channels === 4) source[i * channels + 3] = 1;
	}
	return source;
}

function pixel(image: RasterImage, x: number, y: number): number[] {
	const at = (y * image.width + x) * 4;
	return [...image.data.subarray(at, at + 4)];
}

/** The red byte of each pixel, which is enough for a neutral test picture. */
function levels(image: RasterImage): number[] {
	const out: number[] = [];
	for (let i = 0; i < image.width * image.height; i += 1) out.push(image.data[i * 4] as number);
	return out;
}

describe('decoding a half precision float', () => {
	it.each([
		['zero', 0x0000, 0],
		['one', 0x3c00, 1],
		['minus one', 0xbc00, -1],
		['two', 0x4000, 2],
		['minus two', 0xc000, -2],
		['a half', 0x3800, 0.5],
		['the smallest positive subnormal', 0x0001, 2 ** -24],
		['the largest subnormal', 0x03ff, 1023 * 2 ** -24],
		['the smallest positive normal', 0x0400, 2 ** -14],
		['the largest finite value', 0x7bff, 65504],
		['the largest finite negative value', 0xfbff, -65504],
		['a value with a mantissa in every bit', 0x3555, (1 + 341 / 1024) * 2 ** -2],
	])('reads %s', (_name, bits, expected) => {
		expect(halfToFloat(bits)).toBe(expected);
	});

	it('keeps the sign of negative zero', () => {
		// `toBe` would pass here for a positive zero, so the identity has to be
		// asserted directly. A sign dropped on zero is a sign dropped on the
		// subnormals either side of it, which is where the darkest part of a
		// render lives.
		expect(Object.is(halfToFloat(0x8000), -0)).toBe(true);
		expect(Object.is(halfToFloat(0x0000), 0)).toBe(true);
	});

	it('joins the subnormals to the normals without a step', () => {
		// The largest subnormal and the smallest normal are one unit apart in the
		// last place, which is the property the implicit leading one exists to
		// give. A bias out by one opens a visible gap right here.
		expect(halfToFloat(0x0400) - halfToFloat(0x03ff)).toBeCloseTo(2 ** -24, 30);
	});

	it('reads an infinity of either sign', () => {
		// An infinity turns up where a light source was divided by zero, which is
		// common enough in a render that it cannot be treated as corruption.
		expect(halfToFloat(0x7c00)).toBe(Infinity);
		expect(halfToFloat(0xfc00)).toBe(-Infinity);
	});

	it.each([0x7e00, 0x7c01, 0xfe00, 0x7fff])('reads %i as not a number', (bits) => {
		// The top exponent with any mantissa at all is a NaN, of either sign. A
		// reader that only checked for the canonical pattern would hand back an
		// enormous finite number instead, which then meters the whole picture.
		expect(Number.isNaN(halfToFloat(bits))).toBe(true);
	});

	it('separates an infinity from the NaN one bit away from it', () => {
		expect(halfToFloat(0x7c00)).toBe(Infinity);
		expect(Number.isNaN(halfToFloat(0x7c01))).toBe(true);
	});
});

describe('tone mapping linear light', () => {
	it('places a mid grey linear input on mid grey', () => {
		// 0.18 is diffuse white's eighteen percent grey card. The metering puts
		// the log average there, so a picture that is already there comes back
		// unchanged, and the sRGB curve turns it into 118.
		expect(pixel(toneMap(uniform(0.18, 16), 4, 4, 3).image, 0, 0)).toEqual([118, 118, 118, 255]);
	});

	it.each([0.001, 4, 1000])('meters a picture around %d onto the same mid grey', (value) => {
		// The exposure comes from the picture, the way a camera chooses one. A
		// fixed exposure would leave the first of these black and the last of them
		// solid white, and both are ordinary contents for a file with no ceiling.
		expect(pixel(toneMap(uniform(value, 16), 4, 4, 3).image, 0, 0)).toEqual([118, 118, 118, 255]);
	});

	it('brightens by a stop and darkens by a stop in the right directions', () => {
		// A sign error here is invisible on any single picture, because a stop
		// down still looks like a plausible photograph. Both directions from the
		// same source are what pin it.
		const source = uniform(0.18, 16);
		const darker = pixel(toneMap(source, 4, 4, 3, { stops: -1 }).image, 0, 0)[0] as number;
		const middle = pixel(toneMap(source, 4, 4, 3).image, 0, 0)[0] as number;
		const brighter = pixel(toneMap(source, 4, 4, 3, { stops: 1 }).image, 0, 0)[0] as number;
		expect(darker).toBeLessThan(middle);
		expect(middle).toBeLessThan(brighter);
		// A stop is a factor of two in linear light, so 0.18 becomes 0.09 and
		// 0.36, which encode to 85 and 162.
		expect([darker, middle, brighter]).toEqual([85, 118, 162]);
	});

	it('does not take the picture down to black for one very bright pixel', () => {
		// Scaling by the maximum is the obvious answer and the wrong one: a
		// specular highlight thousands of times brighter than the subject would
		// put every other pixel within a fraction of a level of zero. The log
		// average ignores it, so the subject stays where a camera would put it.
		const source = uniform(0.18, 64);
		source[0] = 1000;
		source[1] = 1000;
		source[2] = 1000;
		const mapped = toneMap(source, 8, 8, 3).image;
		expect(pixel(mapped, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(levels(mapped)[1] as number).toBeGreaterThan(80);
	});

	it('brings the brightest pixel up to white and no further', () => {
		// White is taken from the brightest pixel in the picture, so the highlight
		// that is actually there lands just short of clipping rather than being
		// cut off or left grey.
		const source = uniform(0.18, 16);
		source[0] = 50;
		source[1] = 50;
		source[2] = 50;
		expect(pixel(toneMap(source, 4, 4, 3).image, 0, 0)).toEqual([255, 255, 255, 255]);
	});

	it('clips two separate highlights to the same white when asked to clip', () => {
		// Clipping is correct for a file that is already display referred and
		// wrong for anything scene referred, and this is the difference: two
		// highlights a factor of ten apart become the same flat white, which is
		// the failure the roll-off exists to avoid.
		const source = uniform(0.18, 4);
		source.set([100, 100, 100], 3);
		source.set([1000, 1000, 1000], 6);
		const clipped = levels(toneMap(source, 4, 1, 3, { clip: true }).image);
		expect(clipped[1]).toBe(255);
		expect(clipped[2]).toBe(255);
	});

	it('keeps the same two highlights apart when rolling them off', () => {
		const source = uniform(0.18, 4);
		source.set([100, 100, 100], 3);
		source.set([1000, 1000, 1000], 6);
		const rolled = levels(toneMap(source, 4, 1, 3).image);
		expect(rolled[1]).toBeLessThan(255);
		expect(rolled[1] as number).toBeGreaterThan(150);
		expect(rolled[2]).toBe(255);
	});

	it('never puts a pixel lower under clipping than under the roll-off', () => {
		// The roll-off compresses everything above the midtones towards white, so
		// clipping can only be the brighter of the two. A comparison that came out
		// the other way round would mean the operator had been applied upside
		// down, which reads as a picture that is merely a bit dark.
		const source = uniform(0.18, 16);
		for (let i = 0; i < 8; i += 1) source[i * 3] = source[i * 3 + 1] = source[i * 3 + 2] = i + 1;
		const rolled = levels(toneMap(source, 4, 4, 3).image);
		const clipped = levels(toneMap(source, 4, 4, 3, { clip: true }).image);
		rolled.forEach((value, index) =>
			expect(clipped[index] as number).toBeGreaterThanOrEqual(value),
		);
	});

	it('passes a four channel alpha through untouched', () => {
		// Alpha is coverage rather than light. Running it through the exposure and
		// the curve would make every soft edge harder or softer depending on how
		// bright the picture happened to be.
		const source = new Float32Array([0.18, 0.18, 0.18, 0.5, 0.18, 0.18, 0.18, 1]);
		const mapped = toneMap(source, 2, 1, 4).image;
		expect(pixel(mapped, 0, 0)[3]).toBe(128);
		expect(pixel(mapped, 1, 0)[3]).toBe(255);
		expect(mapped.hasAlpha).toBe(true);
	});

	it('clamps an alpha that falls outside the range a byte can hold', () => {
		// A NaN turns up in an alpha channel more often than anybody would like,
		// and so do values a compositor left outside zero to one. Neither may wrap.
		const source = new Float32Array([0.18, 0.18, 0.18, -0.25, 0.18, 0.18, 0.18, 2]);
		const mapped = toneMap(source, 2, 1, 4).image;
		expect(pixel(mapped, 0, 0)[3]).toBe(0);
		expect(pixel(mapped, 1, 0)[3]).toBe(255);
	});

	it('leaves the alpha where it was however the exposure moves', () => {
		// The same coverage in a dark picture and a bright one. A tone mapped
		// alpha would come out different in the two.
		const dark = new Float32Array([0.001, 0.001, 0.001, 0.5]);
		const bright = new Float32Array([1000, 1000, 1000, 0.5]);
		expect(pixel(toneMap(dark, 1, 1, 4).image, 0, 0)[3]).toBe(128);
		expect(pixel(toneMap(bright, 1, 1, 4).image, 0, 0)[3]).toBe(128);
	});

	it('makes a three channel picture opaque and says it carries no alpha', () => {
		const mapped = toneMap(uniform(0.18, 4), 2, 2, 3).image;
		expect(mapped.hasAlpha).toBe(false);
		expect([...mapped.data.filter((_value, index) => index % 4 === 3)]).toEqual([
			255, 255, 255, 255,
		]);
	});

	it('reads four floats a pixel when told there are four', () => {
		// The stride is the whole difference between the two shapes. Reading a
		// four channel source three at a time walks the colours out of step with
		// the pixels and produces a picture that is plausibly wrong.
		const four = new Float32Array(4 * 4);
		const three = new Float32Array(4 * 3);
		for (let i = 0; i < 4; i += 1) {
			four.set([0.18, 0.36, 0.09, 0.25], i * 4);
			three.set([0.18, 0.36, 0.09], i * 3);
		}
		expect(pixel(toneMap(four, 4, 1, 4).image, 0, 0).slice(0, 3)).toEqual(
			pixel(toneMap(three, 4, 1, 3).image, 0, 0).slice(0, 3),
		);
		expect(pixel(toneMap(four, 4, 1, 4).image, 0, 0)[3]).toBe(64);
	});

	it('returns a black picture rather than a buffer of NaN when nothing is lit', () => {
		// An all black frame divides by the average luminance of zero unless the
		// metering has a floor. NaN written into a clamped byte array is zero, so
		// the failure would only show as an alpha channel of nothing on the paths
		// that carry one.
		const mapped = toneMap(new Float32Array(4 * 4), 2, 2, 4).image;
		expect([...mapped.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
		expect([...mapped.data].some((value) => Number.isNaN(value))).toBe(false);
	});

	it('clamps a negative sample to black instead of wrapping it', () => {
		// An EXR is allowed to hold negative light, and a colour matrix applied
		// before this point can produce one out of a perfectly ordinary picture.
		const source = uniform(0.18, 4);
		source[0] = -0.5;
		source[1] = -0.5;
		source[2] = -0.5;
		expect(pixel(toneMap(source, 4, 1, 3).image, 0, 0)).toEqual([0, 0, 0, 255]);
	});

	it('uses the linear foot of the sRGB curve deep in the shadows', () => {
		// Below 0.0031308 the sRGB transfer function is a straight line rather
		// than the power law, and the difference is the whole of the darkest few
		// levels: the power law alone returns a negative number here, which lands
		// on black and takes the shadow detail with it.
		const source = uniform(0.18, 64);
		source[0] = 0.0006;
		source[1] = 0.0006;
		source[2] = 0.0006;
		expect(pixel(toneMap(source, 8, 8, 3).image, 0, 0)).toEqual([2, 2, 2, 255]);
	});

	it('keeps the colours apart rather than driving everything to white', () => {
		// The plain Reinhard operator pushes every bright colour towards white.
		// The extended one lets the chosen white reach exactly one and leaves the
		// rest where the exposure put them, so a saturated colour stays saturated.
		const source = new Float32Array([0.4, 0.1, 0.05, 0.18, 0.18, 0.18]);
		const mapped = toneMap(source, 2, 1, 3).image;
		const [r, g, b] = pixel(mapped, 0, 0);
		expect(r as number).toBeGreaterThan(g as number);
		expect(g as number).toBeGreaterThan(b as number);
	});

	it('carries the colour space it was given and defaults to sRGB', () => {
		expect(toneMap(uniform(0.18, 4), 2, 2, 3).image.colourSpace).toBe('srgb');
		expect(
			toneMap(uniform(0.18, 4), 2, 2, 3, { colourSpace: 'display-p3' }).image.colourSpace,
		).toBe('display-p3');
	});

	it('produces a raster of the size it was told, four bytes a pixel', () => {
		const mapped = toneMap(uniform(0.18, 6), 3, 2, 3).image;
		expect([mapped.width, mapped.height]).toEqual([3, 2]);
		expect(mapped.data.length).toBe(3 * 2 * 4);
	});

	it('maps a single pixel picture', () => {
		// One pixel is the whole histogram, so the log average is that pixel and
		// the exposure puts it on mid grey whatever it holds.
		expect(pixel(toneMap(new Float32Array([7, 7, 7]), 1, 1, 3).image, 0, 0)).toEqual([
			118, 118, 118, 255,
		]);
	});
});
