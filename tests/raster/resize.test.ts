/**
 * Resampling tests.
 *
 * The expectations here are worked out from the area rule rather than captured
 * from a run. An output pixel covers a footprint in the input, every input cell
 * that overlaps it contributes its overlap, and the result is the weighted
 * mean. Where a test asserts 40 and 200 rather than a tolerance, the comment
 * above it does the arithmetic, because a tolerance would pass for a filter
 * that had drifted half a pixel sideways and that is the failure worth
 * catching: it is invisible on one image and obvious once two scaled tiles sit
 * next to each other.
 *
 * The premultiplication test is the one that matters. Averaging straight RGBA
 * lets the colour of a fully transparent pixel into the result, and because a
 * transparent pixel is usually black, every soft edge picks up a dark halo. It
 * is invisible until somebody puts the icon on a light background, by which
 * time the icon is shipped.
 */

import { describe, expect, it } from 'vitest';
import { fitSquare, resizeRaster } from '../../src/raster/resize.js';
import { createRaster } from '../../src/raster/image.js';
import type { ColourSpace, RasterImage } from '../../src/types.js';

type Pixel = readonly [number, number, number, number];

function imageOf(
	width: number,
	height: number,
	pixels: readonly Pixel[],
	colourSpace: ColourSpace = 'srgb',
): RasterImage {
	const hasAlpha = pixels.some((colour) => colour[3] !== 255);
	const image = createRaster(width, height, colourSpace, hasAlpha);
	pixels.forEach((colour, index) => image.data.set(colour, index * 4));
	return image;
}

/** A grey of the given level, opaque. Keeps the ramps below readable. */
function grey(level: number, alpha = 255): Pixel {
	return [level, level, level, alpha];
}

function pixel(image: RasterImage, x: number, y: number): number[] {
	const at = (y * image.width + x) * 4;
	return [...image.data.subarray(at, at + 4)];
}

/** The red channel of every pixel, as rows, which is enough for a grey ramp. */
function levels(image: RasterImage): number[][] {
	const rows: number[][] = [];
	for (let y = 0; y < image.height; y += 1) {
		const row: number[] = [];
		for (let x = 0; x < image.width; x += 1)
			row.push(image.data[(y * image.width + x) * 4] as number);
		rows.push(row);
	}
	return rows;
}

describe('resizing a raster', () => {
	it('hands back the same raster when the size has not changed', () => {
		// An icon suite asks for the size it already has as one of its ten, and a
		// copy of the buffer for no change is pure waste. Identity is the
		// assertion rather than equality.
		const image = imageOf(2, 2, [grey(1), grey(2), grey(3), grey(4)]);
		expect(resizeRaster(image, 2, 2)).toBe(image);
	});

	it.each([
		[0, 4],
		[4, 0],
		[-1, 4],
		[4, -2],
	])('refuses a target of %i by %i', (width, height) => {
		const image = imageOf(2, 2, [grey(1), grey(2), grey(3), grey(4)]);
		expect(() => resizeRaster(image, width, height)).toThrow(RangeError);
		expect(() => resizeRaster(image, width, height)).toThrow(
			'A resized image must be at least one pixel in each direction.',
		);
	});

	it('gives back the colour of a block that is all one colour', () => {
		// The simplest thing a resize can get wrong, and the one every wrong
		// weighting still gets right unless the weights fail to sum to one.
		const image = imageOf(2, 2, [grey(77), grey(77), grey(77), grey(77)]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([77, 77, 77, 255]);
	});

	it('averages each pair of cells when halving a row', () => {
		// Two whole cells fall inside each output footprint: (0 + 100) / 2 and
		// (200 + 255) / 2, which is 227.5 and rounds to 228.
		const image = imageOf(4, 1, [grey(0), grey(100), grey(200), grey(255)]);
		expect(levels(resizeRaster(image, 2, 1))).toEqual([[50, 228]]);
	});

	it('weights a partial overlap when the factor is not a whole number', () => {
		// Three cells into two: each output footprint is 1.5 cells wide. The first
		// covers all of cell 0 and half of cell 1, so it is (0 + 120 * 0.5) / 1.5,
		// which is 40 and not the 60 a plain average of the two would give.
		const image = imageOf(3, 1, [grey(0), grey(120), grey(240)]);
		expect(levels(resizeRaster(image, 2, 1))).toEqual([[40, 200]]);
	});

	it('blends between the two nearest cells when growing', () => {
		// Growing, the footprint lies inside one or two cells and the overlaps
		// become a linear blend: a quarter and three quarters of the way between
		// 0 and 200 are 50 and 150. The half pixel offset is what puts them there
		// rather than at 0, 67, 133, 200.
		const image = imageOf(2, 1, [grey(0), grey(200)]);
		expect(levels(resizeRaster(image, 4, 1))).toEqual([[0, 50, 150, 200]]);
	});

	it('does not overshoot at a sharp edge', () => {
		// Area averaging has no negative lobes, so nothing in the output can fall
		// outside the range of the input. A sharpening filter of the kind people
		// reach for instead would ring here and put a value below 0 or above 240
		// on each side of the edge, which clamps to a visible dark and light line.
		const image = imageOf(6, 1, [grey(0), grey(0), grey(0), grey(240), grey(240), grey(240)]);
		const smaller = resizeRaster(image, 4, 1);
		expect(levels(smaller)).toEqual([[0, 0, 240, 240]]);
		expect([...smaller.data].every((value) => value >= 0 && value <= 255)).toBe(true);
	});

	it('reduces a whole image to one pixel by averaging all of it', () => {
		// (0 + 100 + 200 + 255) / 4 is 138.75, so every pixel has to reach the
		// result. A resize that took one axis and forgot the other lands on 50.
		const image = imageOf(2, 2, [grey(0), grey(100), grey(200), grey(255)]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([139, 139, 139, 255]);
	});

	it('rounds a half up rather than truncating it', () => {
		// Truncation biases every downscale one level dark, which on an icon
		// rendered ten times over is a visible difference between sizes.
		const image = imageOf(2, 1, [grey(0), grey(255)]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([128, 128, 128, 255]);
	});

	it('shrinks one axis while growing the other', () => {
		// The two passes are separate, so a mixed target gets area averaging in
		// one direction and a linear blend in the other. Halving the row gives 50
		// and 228 on the top and 40 throughout the bottom; doubling the column
		// then places quarter and three quarter blends between them.
		const image = imageOf(4, 2, [
			grey(0),
			grey(100),
			grey(200),
			grey(255),
			grey(40),
			grey(40),
			grey(40),
			grey(40),
		]);
		expect(levels(resizeRaster(image, 2, 4))).toEqual([
			[50, 228],
			[48, 181],
			[43, 87],
			[40, 40],
		]);
	});

	it('leaves an axis alone when only the other one changes', () => {
		// The pass for the unchanged axis is skipped rather than run with equal
		// weights, and a skip that handed back the wrong buffer would scramble the
		// rows rather than lose a level of precision.
		const image = imageOf(4, 2, [
			grey(0),
			grey(100),
			grey(200),
			grey(255),
			grey(10),
			grey(30),
			grey(50),
			grey(70),
		]);
		expect(levels(resizeRaster(image, 2, 2))).toEqual([
			[50, 228],
			[20, 60],
		]);
	});

	it('grows a single pixel into a block of the same colour', () => {
		const image = imageOf(1, 1, [[12, 34, 56, 255]]);
		const bigger = resizeRaster(image, 3, 3);
		expect([bigger.width, bigger.height]).toEqual([3, 3]);
		for (let y = 0; y < 3; y += 1) {
			for (let x = 0; x < 3; x += 1) expect(pixel(bigger, x, y)).toEqual([12, 34, 56, 255]);
		}
	});

	it('carries the colour space and the alpha flag of the source', () => {
		// Every icon in an Apple suite is scaled from one raster, and a scale that
		// rebuilt it as sRGB would relabel a Display P3 photograph without moving
		// a single number, which reads as flat and says nothing about why.
		const image = imageOf(
			4,
			4,
			Array.from({ length: 16 }, () => grey(10, 200)),
			'display-p3',
		);
		const smaller = resizeRaster(image, 2, 2);
		expect(smaller.colourSpace).toBe('display-p3');
		expect(smaller.hasAlpha).toBe(true);
	});

	it('leaves the raster it was handed exactly as it found it', () => {
		const image = imageOf(4, 1, [grey(0), grey(100), grey(200), grey(255)]);
		const before = [...image.data];
		resizeRaster(image, 2, 1);
		expect([...image.data]).toEqual(before);
	});

	it('does not turn the edge between opaque white and transparent black grey', () => {
		// The reason the whole module premultiplies. Averaging straight RGBA gives
		// (255 + 0) / 2 for the colour and (255 + 0) / 2 for the alpha, so the
		// pixel comes out mid grey at half alpha and every soft edge in the icon
		// picks up a dark halo. Premultiplied, the transparent side contributes no
		// colour at all: the colour stays white and only the coverage falls.
		const image = imageOf(2, 1, [
			[255, 255, 255, 255],
			[0, 0, 0, 0],
		]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([255, 255, 255, 128]);
	});

	it('ignores the colour underneath a fully transparent pixel entirely', () => {
		// The same geometry with a bright green hidden under the transparent side.
		// A straight average would tint the edge green; premultiplied, a pixel
		// with no coverage cannot contribute a colour whatever it is carrying.
		const image = imageOf(2, 1, [
			[255, 255, 255, 255],
			[0, 255, 0, 0],
		]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([255, 255, 255, 128]);
	});

	it('weights a partly transparent neighbour by its coverage', () => {
		// Half transparent black beside opaque white. Premultiplied the colour is
		// 255 * 1 against 0 * 0.502, averaged to 127.5, and dividing by the mean
		// coverage of 191.5 brings it back to 170. A straight average would give
		// 128, which is a whole stop darker.
		const image = imageOf(2, 1, [
			[255, 255, 255, 255],
			[0, 0, 0, 128],
		]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([170, 170, 170, 192]);
	});

	it('leaves a region that is transparent on every side as transparent black', () => {
		// Undoing the premultiplication divides by the coverage, so a pixel with
		// none of it has to be special cased. Dividing anyway gives NaN, which
		// lands in the buffer as zero on some paths and as 255 on others.
		const image = imageOf(2, 2, [
			[10, 20, 30, 0],
			[40, 50, 60, 0],
			[70, 80, 90, 0],
			[100, 110, 120, 0],
		]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
	});

	it('averages the coverage itself across the footprint', () => {
		// Three opaque and one transparent gives three quarters of 255, which is
		// 191.25 and rounds to 191. The colour stays put because all four carry
		// the same one.
		const image = imageOf(4, 1, [
			[80, 80, 80, 255],
			[80, 80, 80, 255],
			[80, 80, 80, 255],
			[80, 80, 80, 0],
		]);
		expect(pixel(resizeRaster(image, 1, 1), 0, 0)).toEqual([80, 80, 80, 191]);
	});

	it('scales a tall image down in both directions at once', () => {
		const image = createRaster(4, 4, 'srgb', false);
		for (let i = 0; i < 16; i += 1) image.data.set([i * 16, i * 16, i * 16, 255], i * 4);
		const smaller = resizeRaster(image, 2, 2);
		// Each output pixel is the mean of its own two by two block: the first is
		// (0 + 16 + 64 + 80) / 4, which is 40.
		expect(levels(smaller)).toEqual([
			[40, 72],
			[168, 200],
		]);
	});
});

describe('fitting a raster into a square', () => {
	it('hands back the same raster when it is already that square', () => {
		const image = imageOf(2, 2, [grey(1), grey(2), grey(3), grey(4)]);
		expect(fitSquare(image, 2)).toBe(image);
	});

	it('scales a square down without padding it', () => {
		const image = createRaster(4, 4, 'srgb', false);
		for (let i = 0; i < 16; i += 1) image.data.set([i * 16, i * 16, i * 16, 255], i * 4);
		const fitted = fitSquare(image, 2);
		expect([fitted.width, fitted.height]).toEqual([2, 2]);
		expect(levels(fitted)).toEqual([
			[40, 72],
			[168, 200],
		]);
		expect(fitted.hasAlpha).toBe(false);
	});

	it('letterboxes a wide image rather than stretching it', () => {
		// Stretching is the one answer nobody wants: a photograph squeezed into a
		// square icon slot is immediately wrong in a way a scaled one never is.
		// The source is already four wide, so it lands unchanged in the middle
		// two rows and the aspect ratio is visible in the result.
		const image = imageOf(4, 2, [
			grey(10),
			grey(20),
			grey(30),
			grey(40),
			grey(50),
			grey(60),
			grey(70),
			grey(80),
		]);
		expect(levels(fitSquare(image, 4))).toEqual([
			[0, 0, 0, 0],
			[10, 20, 30, 40],
			[50, 60, 70, 80],
			[0, 0, 0, 0],
		]);
	});

	it('pillarboxes a tall image', () => {
		const image = imageOf(2, 4, [
			grey(10),
			grey(20),
			grey(30),
			grey(40),
			grey(50),
			grey(60),
			grey(70),
			grey(80),
		]);
		expect(levels(fitSquare(image, 4))).toEqual([
			[0, 10, 20, 0],
			[0, 30, 40, 0],
			[0, 50, 60, 0],
			[0, 70, 80, 0],
		]);
	});

	it('pads with transparent black rather than with a colour', () => {
		// Every icon format can carry transparency, and padding with white or
		// black would put a visible box around a logo on the first background
		// that did not match.
		const image = imageOf(4, 2, [
			grey(10),
			grey(20),
			grey(30),
			grey(40),
			grey(50),
			grey(60),
			grey(70),
			grey(80),
		]);
		const fitted = fitSquare(image, 4);
		expect(pixel(fitted, 0, 0)).toEqual([0, 0, 0, 0]);
		expect(pixel(fitted, 3, 3)).toEqual([0, 0, 0, 0]);
	});

	it('marks a padded raster as carrying alpha even when the source did not', () => {
		// The padding is the alpha. An encoder told the raster is opaque would
		// drop the channel and write the padding as black.
		const image = imageOf(
			4,
			2,
			Array.from({ length: 8 }, () => grey(10)),
		);
		expect(image.hasAlpha).toBe(false);
		expect(fitSquare(image, 4).hasAlpha).toBe(true);
	});

	it('scales down to fit before padding the rest', () => {
		// Eight by four into a side of four is a half in both directions, so the
		// content becomes four by two and then sits in the middle.
		const image = createRaster(8, 4, 'srgb', false);
		for (let i = 0; i < 32; i += 1) image.data.set([100, 100, 100, 255], i * 4);
		const fitted = fitSquare(image, 4);
		expect([fitted.width, fitted.height]).toEqual([4, 4]);
		expect(levels(fitted)).toEqual([
			[0, 0, 0, 0],
			[100, 100, 100, 100],
			[100, 100, 100, 100],
			[0, 0, 0, 0],
		]);
	});

	it('centres the content as nearly as an odd margin allows', () => {
		// A single row inside a square of four leaves three rows of margin, which
		// cannot be split evenly. It goes above rather than below, and the point
		// is that it is deterministic rather than drifting with the size.
		const image = imageOf(4, 1, [grey(10), grey(20), grey(30), grey(40)]);
		expect(levels(fitSquare(image, 4))).toEqual([
			[0, 0, 0, 0],
			[10, 20, 30, 40],
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		]);
	});

	it('keeps a row of an extremely wide image rather than scaling it away', () => {
		// A hundred by one into a side of four scales the height to a twenty fifth
		// of a pixel. Rounding that to zero would ask for a raster of no height at
		// all, and the caller would see a range error rather than an icon.
		const image = createRaster(100, 1, 'srgb', false);
		for (let i = 0; i < 100; i += 1) image.data.set([200, 200, 200, 255], i * 4);
		const fitted = fitSquare(image, 4);
		expect([fitted.width, fitted.height]).toEqual([4, 4]);
		expect(levels(fitted)).toEqual([
			[0, 0, 0, 0],
			[200, 200, 200, 200],
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		]);
	});

	it('carries the colour space of the source', () => {
		const image = imageOf(
			4,
			2,
			Array.from({ length: 8 }, () => grey(10)),
			'display-p3',
		);
		expect(fitSquare(image, 4).colourSpace).toBe('display-p3');
		expect(fitSquare(image, 2).colourSpace).toBe('display-p3');
	});

	it('refuses a side of zero', () => {
		// There is no image of no pixels to hand back, so this has to fail rather
		// than return an empty raster that every caller downstream then divides by.
		const image = imageOf(
			4,
			2,
			Array.from({ length: 8 }, () => grey(10)),
		);
		expect(() => fitSquare(image, 0)).toThrow(RangeError);
	});
});
