/**
 * Raster operation and colour space tests.
 *
 * The rasters here are tiny and every pixel carries a different value, because
 * the failures these functions actually have are transpositions: a rotation
 * that turns the right way but reads the source with the wrong stride, a
 * mirror applied on the wrong axis, a tile blitted with the target's row length
 * instead of its own. On a symmetrical or single-colour test raster every one
 * of those produces the correct answer.
 *
 * The colour expectations are worked out from the matrices and the sRGB
 * transfer function rather than captured from a run, so they pin the
 * conversion rather than recording whatever it currently does.
 */

import { describe, expect, it } from 'vitest';
import {
	applyOrientation,
	attachAlpha,
	blit,
	createRaster,
	crop,
	detectAlpha,
	flatten,
	mirror,
	rotate,
} from '../../src/raster/image.js';
import { outOfSrgbGamut, toColourSpace } from '../../src/raster/colour.js';
import type { ColourSpace, RasterImage } from '../../src/types.js';

/**
 * A raster where every pixel is distinguishable.
 *
 * Each label becomes red, and green and blue follow one and two above it, so a
 * channel swap shows up as well as a pixel swap.
 */
function labelled(width: number, height: number, labels: readonly number[]): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	labels.forEach((label, index) => {
		const at = index * 4;
		image.data[at] = label;
		image.data[at + 1] = label + 1;
		image.data[at + 2] = label + 2;
		image.data[at + 3] = 255;
	});
	return image;
}

/** Read the labels back as rows, so an expectation reads like the picture. */
function labels(image: RasterImage): number[][] {
	const rows: number[][] = [];
	for (let y = 0; y < image.height; y += 1) {
		const row: number[] = [];
		for (let x = 0; x < image.width; x += 1) {
			row.push(image.data[(y * image.width + x) * 4] as number);
		}
		rows.push(row);
	}
	return rows;
}

function pixel(image: RasterImage, x: number, y: number): number[] {
	const at = (y * image.width + x) * 4;
	return [...image.data.subarray(at, at + 4)];
}

/**
 * Three by two, wider than it is tall, with six distinct pixels:
 *
 *     10 20 30
 *     40 50 60
 */
function asymmetric(): RasterImage {
	return labelled(3, 2, [10, 20, 30, 40, 50, 60]);
}

function solid(
	width: number,
	height: number,
	colour: readonly [number, number, number, number],
	colourSpace: ColourSpace,
): RasterImage {
	const image = createRaster(width, height, colourSpace, colour[3] !== 255);
	for (let index = 0; index < width * height; index += 1) image.data.set(colour, index * 4);
	return image;
}

/** An eight bit round trip is lossy, so compare within a level rather than exactly. */
function expectClose(actual: readonly number[], expected: readonly number[], tolerance: number) {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((value, index) => {
		expect(Math.abs(value - (expected[index] as number))).toBeLessThanOrEqual(tolerance);
	});
}

describe('rotation', () => {
	it('hands back the same raster at zero degrees rather than copying it', () => {
		// The zero case is on the hot path for every upright photograph, and a
		// copy of a 48 megapixel buffer for no change is 190 megabytes of churn.
		const image = asymmetric();
		expect(rotate(image, 0)).toBe(image);
	});

	it('sends the right hand column to the top row at 90, swapping the dimensions', () => {
		const turned = rotate(asymmetric(), 90);
		expect([turned.width, turned.height]).toEqual([2, 3]);
		expect(labels(turned)).toEqual([
			[30, 60],
			[20, 50],
			[10, 40],
		]);
	});

	it('reverses both axes at 180 and leaves the dimensions alone', () => {
		const turned = rotate(asymmetric(), 180);
		expect([turned.width, turned.height]).toEqual([3, 2]);
		expect(labels(turned)).toEqual([
			[60, 50, 40],
			[30, 20, 10],
		]);
	});

	it('sends the top row to the right hand column at 270, the opposite way from 90', () => {
		// 90 and 270 differ only in sense, so a rotation written the wrong way
		// round passes every test that checks dimensions alone. HEIF `irot`
		// counts anticlockwise, and getting the sense wrong turns every portrait
		// photograph upside down rather than sideways, which nobody reports as a
		// rotation bug.
		const turned = rotate(asymmetric(), 270);
		expect([turned.width, turned.height]).toEqual([2, 3]);
		expect(labels(turned)).toEqual([
			[40, 10],
			[50, 20],
			[60, 30],
		]);
		expect(labels(turned)).not.toEqual(labels(rotate(asymmetric(), 90)));
	});

	it('carries all four channels round a quarter turn, not only the red one', () => {
		// `labels` only reads red, so on its own it would not catch a rotation
		// that moved three channels and left alpha where it was.
		const image = asymmetric();
		image.data[3] = 17;
		expect(pixel(rotate(image, 90), 0, 2)).toEqual([10, 11, 12, 17]);
	});

	it('returns the original raster after four quarter turns', () => {
		const image = asymmetric();
		let turned = image;
		for (let step = 0; step < 4; step += 1) turned = rotate(turned, 90);
		expect([turned.width, turned.height]).toEqual([3, 2]);
		expect([...turned.data]).toEqual([...image.data]);
	});
});

describe('mirroring', () => {
	it('hands back the same raster for an axis of none', () => {
		const image = asymmetric();
		expect(mirror(image, 'none')).toBe(image);
	});

	it('flips left to right on the horizontal axis', () => {
		expect(labels(mirror(asymmetric(), 'horizontal'))).toEqual([
			[30, 20, 10],
			[60, 50, 40],
		]);
	});

	it('flips top to bottom on the vertical axis', () => {
		// Named for the axis the pixels move along rather than the axis they are
		// reflected in, which is the convention HEIF `imir` uses and the reverse
		// of what "vertical flip" suggests to some readers.
		expect(labels(mirror(asymmetric(), 'vertical'))).toEqual([
			[40, 50, 60],
			[10, 20, 30],
		]);
	});

	it.each(['horizontal', 'vertical'] as const)('is its own inverse on the %s axis', (axis) => {
		const image = asymmetric();
		const twice = mirror(mirror(image, axis), axis);
		expect([...twice.data]).toEqual([...image.data]);
	});
});

describe('applying an orientation', () => {
	it('mirrors before rotating, as ISO/IEC 23008-12 requires', () => {
		// A mirror and a rotation do not commute. Both orders are correct for a
		// file that carries only one of the two, so the wrong order survives
		// every photograph until one turns up with both, and then it is wrong in
		// a way that looks like a rotation bug rather than an ordering one.
		const applied = applyOrientation(asymmetric(), {
			mirror: 'horizontal',
			rotation: 90,
			source: 'heif-irot',
		});
		expect(labels(applied)).toEqual([
			[10, 40],
			[20, 50],
			[30, 60],
		]);
	});

	it('gives a different answer from rotating before mirroring', () => {
		// Pins the previous test to the specified order rather than to whichever
		// order the implementation happens to use.
		const specified = applyOrientation(asymmetric(), {
			mirror: 'horizontal',
			rotation: 90,
			source: 'heif-irot',
		});
		const reversed = mirror(rotate(asymmetric(), 90), 'horizontal');
		expect(labels(reversed)).toEqual([
			[60, 30],
			[50, 20],
			[40, 10],
		]);
		expect(labels(specified)).not.toEqual(labels(reversed));
	});

	it('leaves an upright image alone without allocating', () => {
		const image = asymmetric();
		expect(applyOrientation(image, { mirror: 'none', rotation: 0, source: 'none' })).toBe(image);
	});
});

describe('cropping', () => {
	it('takes a window out of the middle without shifting the rows', () => {
		// A crop that forgets to advance by the source stride slides each row
		// sideways by the width difference, which reads as a skew.
		const image = labelled(4, 3, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
		const window = crop(image, 1, 1, 2, 2);
		expect([window.width, window.height]).toEqual([2, 2]);
		expect(labels(window)).toEqual([
			[60, 70],
			[100, 110],
		]);
	});

	it('keeps the full first row when the window starts at the origin', () => {
		const image = labelled(4, 3, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
		expect(labels(crop(image, 0, 0, 4, 2))).toEqual([
			[10, 20, 30, 40],
			[50, 60, 70, 80],
		]);
	});

	it('hands back the same raster when the window is the whole image', () => {
		const image = asymmetric();
		expect(crop(image, 0, 0, 3, 2)).toBe(image);
	});

	it('carries the colour space and the alpha flag into the cropped raster', () => {
		const image = createRaster(4, 4, 'display-p3', true);
		const window = crop(image, 1, 1, 2, 2);
		expect(window.colourSpace).toBe('display-p3');
		expect(window.hasAlpha).toBe(true);
	});
});

describe('blitting a tile', () => {
	/** A four by three target filled with a value no tile uses. */
	function target(): RasterImage {
		return labelled(4, 3, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
	}

	it('copies a tile that fits entirely inside the target', () => {
		const into = target();
		blit(into, labelled(2, 2, [10, 20, 30, 40]), 1, 0);
		expect(labels(into)).toEqual([
			[5, 10, 20, 5],
			[5, 30, 40, 5],
			[5, 5, 5, 5],
		]);
	});

	it('clips a tile hanging off both the right and the bottom edge', () => {
		// Every real grid does this: an image whose dimensions are not a whole
		// number of tiles has an overhanging last row and column, which is almost
		// every photograph. The trap is the source stride. Reading the clipped
		// width from the tile row by row is right; reading it as one run gives
		// 10, 20, 30, 40 here instead of 10, 20, 40, 50.
		const into = target();
		blit(into, labelled(3, 3, [10, 20, 30, 40, 50, 60, 70, 80, 90]), 2, 1);
		expect(labels(into)).toEqual([
			[5, 5, 5, 5],
			[5, 5, 10, 20],
			[5, 5, 40, 50],
		]);
	});

	it('clips a tile that hangs off the right edge only', () => {
		const into = target();
		blit(into, labelled(2, 2, [10, 20, 30, 40]), 3, 0);
		expect(labels(into)).toEqual([
			[5, 5, 5, 10],
			[5, 5, 5, 30],
			[5, 5, 5, 5],
		]);
	});

	it('writes nothing at all when the tile starts past the edge', () => {
		const into = target();
		const before = [...into.data];
		blit(into, labelled(2, 2, [10, 20, 30, 40]), 4, 0);
		blit(into, labelled(2, 2, [10, 20, 30, 40]), 0, 3);
		expect([...into.data]).toEqual(before);
	});

	it('copies every channel of the tile, alpha included', () => {
		const into = target();
		const tile = labelled(1, 1, [10]);
		tile.data[3] = 64;
		blit(into, tile, 2, 2);
		expect(pixel(into, 2, 2)).toEqual([10, 11, 12, 64]);
	});
});

describe('flattening onto a background', () => {
	function translucent(): RasterImage {
		const image = createRaster(2, 2, 'srgb', true);
		image.data.set([200, 100, 50, 128], 0);
		image.data.set([200, 100, 50, 255], 4);
		image.data.set([200, 100, 50, 0], 8);
		image.data.set([12, 20, 30, 64], 12);
		return image;
	}

	it('composites straight alpha against the background, to the byte', () => {
		// Worked from the definition: out = source * a + background * (1 - a)
		// with a = alpha / 255. A half transparent 200 over a background of 0 is
		// 200 * 128 / 255, which is 100.4 and lands on 100, not on 128 as a
		// premultiplied reading of the same pixel would give.
		const flat = flatten(translucent(), [0, 0, 255]);
		expect(pixel(flat, 0, 0)).toEqual([100, 50, 152, 255]);
		expect(pixel(flat, 1, 1)).toEqual([3, 5, 199, 255]);
	});

	it('leaves an opaque pixel exactly where it was', () => {
		const flat = flatten(translucent(), [0, 0, 255]);
		expect(pixel(flat, 1, 0)).toEqual([200, 100, 50, 255]);
	});

	it('replaces a fully transparent pixel with the background exactly', () => {
		// Not "close to the background". A rounding error here tiles a flat area
		// with two alternating values, which is visible as banding in a sky.
		const flat = flatten(translucent(), [0, 0, 255]);
		expect(pixel(flat, 0, 1)).toEqual([0, 0, 255, 255]);
	});

	it('defaults the background to white, because black turns a logo into a slab', () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([40, 80, 120, 192], 0);
		expect(pixel(flatten(image), 0, 0)).toEqual([93, 123, 153, 255]);
	});

	it('clears the alpha flag and writes 255 into every alpha byte', () => {
		const flat = flatten(translucent(), [0, 0, 255]);
		expect(flat.hasAlpha).toBe(false);
		expect([...flat.data.filter((_value, index) => index % 4 === 3)]).toEqual([255, 255, 255, 255]);
	});

	it('hands back the same raster when it carries no alpha', () => {
		const image = asymmetric();
		expect(flatten(image, [0, 0, 0])).toBe(image);
	});
});

describe('detecting alpha', () => {
	it('is false when every pixel is opaque', () => {
		expect(detectAlpha(asymmetric())).toBe(false);
	});

	it('is true for a single pixel one step below opaque', () => {
		// 254 rather than 0. A check written against zero rather than against 255
		// calls a photograph with a soft antialiased edge fully opaque and the
		// encoder then drops the channel that edge lives in.
		const image = asymmetric();
		image.data[4 * 4 + 3] = 254;
		expect(detectAlpha(image)).toBe(true);
	});

	it('is true when a pixel is fully transparent', () => {
		const image = asymmetric();
		image.data[3] = 0;
		expect(detectAlpha(image)).toBe(true);
	});

	it('reads the alpha byte rather than any colour byte', () => {
		// Every colour byte here is zero and every alpha byte is 255. A loop
		// starting at the wrong offset reports alpha on a perfectly opaque black.
		const image = createRaster(2, 2, 'srgb', false);
		for (let index = 0; index < 4; index += 1) image.data[index * 4 + 3] = 255;
		expect(detectAlpha(image)).toBe(false);
	});
});

describe('attaching an auxiliary alpha image', () => {
	it('takes the alpha from the red channel of the auxiliary image', () => {
		// An auxiliary alpha item decodes as a monochrome picture, so the value
		// is in red. Reading its alpha channel instead gives a fully opaque
		// result, because the decoder filled that with 255.
		const image = asymmetric();
		const alpha = labelled(3, 2, [0, 64, 128, 192, 255, 32]);
		const attached = attachAlpha(image, alpha);
		expect([...attached.data.filter((_value, index) => index % 4 === 3)]).toEqual([
			0, 64, 128, 192, 255, 32,
		]);
	});

	it('leaves the colour bytes alone and marks the raster as carrying alpha', () => {
		const image = asymmetric();
		const attached = attachAlpha(image, labelled(3, 2, [0, 64, 128, 192, 255, 32]));
		expect(attached.hasAlpha).toBe(true);
		expect(labels(attached)).toEqual([
			[10, 20, 30],
			[40, 50, 60],
		]);
		expect(pixel(attached, 1, 0).slice(0, 3)).toEqual([20, 21, 22]);
	});

	it('keeps the colour space of the colour image, not of the alpha image', () => {
		const image = createRaster(2, 1, 'display-p3', false);
		expect(attachAlpha(image, createRaster(2, 1, 'srgb', false)).colourSpace).toBe('display-p3');
	});

	it('stops at the smaller of the two pixel counts rather than running off the end', () => {
		// A HEIF alpha item is allowed to be a different size from the image it
		// belongs to, and reading past the end of the shorter one gives undefined,
		// which lands in the buffer as zero and punches a transparent hole.
		const image = asymmetric();
		image.data[3] = 200;
		image.data[7] = 201;
		image.data[11] = 202;
		image.data[15] = 203;
		image.data[19] = 204;
		image.data[23] = 205;
		const attached = attachAlpha(image, labelled(2, 1, [11, 22]));
		expect([...attached.data.filter((_value, index) => index % 4 === 3)]).toEqual([
			11, 22, 202, 203, 204, 205,
		]);
	});
});

describe('converting between colour spaces', () => {
	it.each(['srgb', 'display-p3'] as const)(
		'hands back the same object when the image is already %s',
		(space) => {
			// The conversion is lossy both ways, so running it for no reason costs
			// quality as well as time. Identity is the assertion, not equality.
			const image = solid(2, 2, [200, 40, 40, 255], space);
			expect(toColourSpace(image, space)).toBe(image);
		},
	);

	it('pushes a saturated Display P3 red further out in sRGB numbers', () => {
		// P3 red sits outside sRGB, so describing the same colour in sRGB
		// primaries needs more red and less green than the P3 numbers carried.
		// A conversion left out entirely leaves 200, 40, 40 and the picture
		// reads flat; a conversion run the wrong way pulls the red down instead.
		const converted = toColourSpace(solid(1, 1, [200, 40, 40, 255], 'display-p3'), 'srgb');
		expect(converted.colourSpace).toBe('srgb');
		expect(pixel(converted, 0, 0)).toEqual([218, 0, 26, 255]);
	});

	it('clamps rather than wrapping when a P3 colour cannot be represented', () => {
		// Pure P3 red is well outside sRGB. The green and blue components come
		// out negative, and a conversion that writes them without clamping wraps
		// them to near 255 and turns the reddest pixel in the picture white.
		const converted = toColourSpace(solid(1, 1, [255, 0, 0, 255], 'display-p3'), 'srgb');
		expect(pixel(converted, 0, 0)).toEqual([255, 0, 0, 255]);
	});

	it('round trips an in gamut colour back to where it started', () => {
		const original = solid(1, 1, [128, 100, 90, 255], 'display-p3');
		const there = toColourSpace(original, 'srgb');
		const back = toColourSpace(there, 'display-p3');
		expect(pixel(there, 0, 0)).toEqual([133, 99, 88, 255]);
		expectClose(pixel(back, 0, 0), [128, 100, 90, 255], 1);
	});

	it('round trips an in gamut colour the other way as well', () => {
		const original = solid(1, 1, [120, 140, 160, 255], 'srgb');
		const back = toColourSpace(toColourSpace(original, 'display-p3'), 'srgb');
		expectClose(pixel(back, 0, 0), [120, 140, 160, 255], 1);
	});

	it.each(['srgb', 'display-p3'] as const)('preserves pure white converting from %s', (from) => {
		// Both spaces share a white point, so each matrix row sums to one and
		// white must survive untouched. A transposed matrix, a row of the wrong
		// matrix, or a missing transfer function all move it, and this is the
		// cheapest place any of those shows up.
		const to = from === 'srgb' ? 'display-p3' : 'srgb';
		const converted = toColourSpace(solid(1, 1, [255, 255, 255, 255], from), to);
		expect(pixel(converted, 0, 0)).toEqual([255, 255, 255, 255]);
	});

	it.each(['srgb', 'display-p3'] as const)('preserves pure black converting from %s', (from) => {
		const to = from === 'srgb' ? 'display-p3' : 'srgb';
		const converted = toColourSpace(solid(1, 1, [0, 0, 0, 255], from), to);
		expect(pixel(converted, 0, 0)).toEqual([0, 0, 0, 255]);
	});

	it('preserves a neutral grey, which no colour matrix should touch', () => {
		const converted = toColourSpace(solid(1, 1, [64, 64, 64, 255], 'display-p3'), 'srgb');
		expect(pixel(converted, 0, 0)).toEqual([64, 64, 64, 255]);
	});

	it('passes alpha through untouched in both directions', () => {
		// Alpha is not a colour and running it through the matrix would tint
		// every soft edge in the picture.
		const toSrgb = toColourSpace(solid(1, 1, [120, 140, 160, 77], 'display-p3'), 'srgb');
		const toP3 = toColourSpace(solid(1, 1, [120, 140, 160, 77], 'srgb'), 'display-p3');
		expect(pixel(toSrgb, 0, 0)[3]).toBe(77);
		expect(pixel(toP3, 0, 0)[3]).toBe(77);
		expect(toSrgb.hasAlpha).toBe(true);
	});

	it('converts every pixel, not only the first', () => {
		const image = solid(2, 2, [200, 40, 40, 255], 'display-p3');
		const converted = toColourSpace(image, 'srgb');
		expect([converted.width, converted.height]).toEqual([2, 2]);
		for (let index = 0; index < 4; index += 1) {
			expect([...converted.data.subarray(index * 4, index * 4 + 4)]).toEqual([218, 0, 26, 255]);
		}
	});
});

describe('measuring the sRGB gamut overflow', () => {
	it('is zero for an sRGB image, whatever colours it holds', () => {
		// The numbers are already sRGB, so nothing can be outside it. Measuring
		// them through the P3 matrix anyway would call a saturated red image
		// wide gamut and justify a P3 output that gains nothing.
		expect(outOfSrgbGamut(solid(2, 2, [255, 0, 0, 255], 'srgb'))).toBe(0);
	});

	it('reports the fraction of a Display P3 image outside sRGB', () => {
		const image = createRaster(2, 2, 'display-p3', false);
		image.data.set([255, 0, 0, 255], 0);
		image.data.set([0, 255, 0, 255], 4);
		image.data.set([128, 128, 128, 255], 8);
		image.data.set([0, 0, 0, 255], 12);
		expect(outOfSrgbGamut(image)).toBe(0.5);
	});

	it('is zero for a Display P3 image whose colours all fit inside sRGB', () => {
		// The case worth knowing about before shipping a wide gamut asset: a
		// screen capture of a dark interface has no out of gamut pixel at all.
		expect(outOfSrgbGamut(solid(4, 4, [30, 30, 34, 255], 'display-p3'))).toBe(0);
	});

	it('counts a fully saturated Display P3 image as entirely outside', () => {
		expect(outOfSrgbGamut(solid(3, 3, [0, 0, 255, 255], 'display-p3'))).toBe(1);
	});
});
