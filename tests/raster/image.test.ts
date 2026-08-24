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
 * The colour expectations are worked out from the published primaries rather
 * than captured from a run or read back out of the package's own constants.
 * Both matrices were rederived from the BT.709 and Display P3 chromaticities
 * against a D65 white, composed through XYZ, and the numbers below are what
 * that derivation produces to the byte.
 *
 * Anchoring matters more in one direction than the other. A matrix whose rows
 * still sum to one preserves white, black and every neutral grey, and its
 * inverse still round trips, so a matrix that is wrong by a hundredth in a row
 * passes a round trip and a white check and shifts every saturated colour in
 * the picture. Both directions therefore need a saturated colour pinned to a
 * number.
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
	withColourSpace,
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

describe('creating a raster', () => {
	it('allocates four bytes a pixel and zeroes every one of them', () => {
		// A fresh raster is transparent black, and `blit` relies on that: a grid
		// whose tiles do not cover the whole buffer leaves the gaps as they were
		// allocated, so a buffer of anything other than zero shows up as fringing
		// along the edge of an assembled photograph.
		const image = createRaster(3, 2);
		expect(image.data).toBeInstanceOf(Uint8ClampedArray);
		expect(image.data.length).toBe(3 * 2 * 4);
		expect([...image.data].every((byte) => byte === 0)).toBe(true);
		expect([image.width, image.height]).toEqual([3, 2]);
	});

	it('defaults to sRGB without alpha, which is the conservative pair', () => {
		// Defaulting the other way is silent in both directions. A raster that
		// claims Display P3 by default tags sRGB numbers as wide gamut and
		// oversaturates, and one that claims alpha by default makes every encoder
		// carry a channel that holds nothing.
		const image = createRaster(1, 1);
		expect(image.colourSpace).toBe('srgb');
		expect(image.hasAlpha).toBe(false);
	});

	it('records the colour space and alpha flag it was given', () => {
		const image = createRaster(1, 1, 'display-p3', true);
		expect(image.colourSpace).toBe('display-p3');
		expect(image.hasAlpha).toBe(true);
	});
});

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

	it('carries the colour space and the alpha flag through a quarter turn', () => {
		// Every photograph taken sideways goes through here, and a photograph off
		// an iPhone is Display P3. A rotation that rebuilds the raster as sRGB
		// moves the pixels correctly and relabels them, so the numbers are read
		// as sRGB from then on and the picture comes out flat. Nothing in the
		// pixel values says it happened and every geometric assertion above still
		// passes.
		const image = createRaster(3, 2, 'display-p3', true);
		const turned = rotate(image, 90);
		expect(turned.colourSpace).toBe('display-p3');
		expect(turned.hasAlpha).toBe(true);
	});

	it('turns a single column into a single row', () => {
		// Width one is where a stride mistake stops cancelling itself out. On a
		// square or near-square raster a rotation that reads with the output's row
		// length instead of the input's still lands on plausible bytes; with one
		// column there is nothing for it to land on.
		const turned = rotate(labelled(1, 3, [10, 20, 30]), 90);
		expect([turned.width, turned.height]).toEqual([3, 1]);
		expect(labels(turned)).toEqual([[10, 20, 30]]);
	});

	it('turns a single row into a single column', () => {
		const turned = rotate(labelled(3, 1, [10, 20, 30]), 90);
		expect([turned.width, turned.height]).toEqual([1, 3]);
		expect(labels(turned)).toEqual([[30], [20], [10]]);
	});

	it.each([90, 180, 270] as const)('leaves a one pixel raster alone at %s degrees', (angle) => {
		// The smallest legal raster, through every branch of the switch. Each one
		// computes a target coordinate from a dimension of one, where every off by
		// one lands outside the buffer and writes nothing.
		const turned = rotate(labelled(1, 1, [77]), angle);
		expect([turned.width, turned.height]).toEqual([1, 1]);
		expect(pixel(turned, 0, 0)).toEqual([77, 78, 79, 255]);
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

	it.each(['horizontal', 'vertical'] as const)(
		'carries the colour space and the alpha flag across the %s axis',
		(axis) => {
			// Same silent relabelling as a rotation. A mirrored Display P3 photo
			// that comes back tagged sRGB is pixel for pixel correct and reads flat.
			const image = createRaster(3, 2, 'display-p3', true);
			const flipped = mirror(image, axis);
			expect(flipped.colourSpace).toBe('display-p3');
			expect(flipped.hasAlpha).toBe(true);
		},
	);

	it('carries all four channels across the flip, not only the three colours', () => {
		// `labels` reads red alone, so on its own it passes a mirror that moves the
		// colours and writes 255 into every alpha byte. That turns a transparent
		// logo opaque while leaving the picture correct, which is the same class of
		// defect as the rotation case above and needs the same check.
		const image = asymmetric();
		image.data[3] = 17;
		expect(pixel(mirror(image, 'horizontal'), 2, 0)).toEqual([10, 11, 12, 17]);
		expect(pixel(mirror(image, 'vertical'), 0, 1)).toEqual([10, 11, 12, 17]);
	});

	it('reverses a single row and leaves a single column alone on the horizontal axis', () => {
		// One row and one column are the two degenerate cases, and they must move
		// in opposite ways for the same axis. An axis mixup is invisible on a
		// square raster and total on these.
		expect(labels(mirror(labelled(3, 1, [10, 20, 30]), 'horizontal'))).toEqual([[30, 20, 10]]);
		expect(labels(mirror(labelled(1, 3, [10, 20, 30]), 'horizontal'))).toEqual([[10], [20], [30]]);
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

	it('takes a single pixel out of the bottom right corner', () => {
		// The smallest legal window at the furthest offset, which is where the
		// stride arithmetic has the most room to overshoot: the read starts at the
		// last pixel of the buffer and any excess runs off the end, where
		// `subarray` clamps and hands back a short row rather than throwing.
		const image = labelled(4, 3, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
		const window = crop(image, 3, 2, 1, 1);
		expect([window.width, window.height]).toEqual([1, 1]);
		expect(pixel(window, 0, 0)).toEqual([120, 121, 122, 255]);
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

	it('lands a single pixel tile in the very last position', () => {
		// The last pixel of the buffer. A clip computed one short drops it and
		// leaves a single wrong pixel in the bottom right corner of every
		// assembled image, which is exactly the size of defect nobody reports.
		const into = target();
		blit(into, labelled(1, 1, [99]), 3, 2);
		expect(labels(into)).toEqual([
			[5, 5, 5, 5],
			[5, 5, 5, 5],
			[5, 5, 5, 99],
		]);
	});

	it('clips a tile larger than the target in both directions', () => {
		// The other end of the range from the tile that fits. Here both clips come
		// from the target rather than from the tile, and the source stride is still
		// the tile's: reading it as one run gives 10, 20, 30, 40 then 50, 60, 70,
		// 80 instead of skipping the fifth column each row.
		const into = target();
		const big = labelled(
			5,
			5,
			// prettier-ignore
			[
				10, 20, 30, 40, 50,
				60, 70, 80, 90, 100,
				110, 120, 130, 140, 150,
				160, 170, 180, 190, 200,
				210, 220, 230, 240, 250,
			],
		);
		blit(into, big, 0, 0);
		expect(labels(into)).toEqual([
			[10, 20, 30, 40],
			[60, 70, 80, 90],
			[110, 120, 130, 140],
		]);
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

	it('keeps the colour space of the raster it flattened', () => {
		// Flattening happens on the way into a format with no alpha channel, which
		// for a phone photograph means JPEG. Rebuilding the raster as sRGB here
		// hands Display P3 numbers to the encoder labelled sRGB, and the file is
		// flat with nothing in it to say why.
		const image = createRaster(1, 1, 'display-p3', true);
		image.data.set([200, 40, 40, 128], 0);
		expect(flatten(image).colourSpace).toBe('display-p3');
	});

	it('leaves the raster it was handed exactly as it found it', () => {
		// "In place on a copy" is the contract. Compositing into the caller's own
		// buffer destroys the original, which the converter still needs whenever
		// one decode feeds more than one output.
		const image = translucent();
		const before = [...image.data];
		const flat = flatten(image, [0, 0, 255]);
		expect([...image.data]).toEqual(before);
		expect(flat.data).not.toBe(image.data);
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

	it('finds a translucent pixel that is the last one in the buffer', () => {
		// The existing cases sit at the front and in the middle, and a scan that
		// stops one pixel short passes both. The last pixel is the bottom right
		// corner of the picture, which for a rounded icon or a photograph on a
		// transparent background is precisely where the translucency is.
		const image = asymmetric();
		image.data[image.data.length - 1] = 254;
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

	it('stops at the colour image when the alpha image is the larger of the two', () => {
		// The truncation has to hold in both directions and only the shorter alpha
		// image was pinned. Overrunning the other way is currently caught by the
		// output buffer rather than by the `Math.min`, because a typed array drops
		// an out of range write without complaint, so this is the contract being
		// asserted rather than the arithmetic: a mismatched auxiliary item leaves a
		// raster the size of the colour image, carrying its alpha values in order.
		const image = asymmetric();
		const attached = attachAlpha(
			image,
			labelled(4, 3, [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176]),
		);
		expect(attached.data.length).toBe(3 * 2 * 4);
		expect([attached.width, attached.height]).toEqual([3, 2]);
		expect([...attached.data.filter((_value, index) => index % 4 === 3)]).toEqual([
			0, 16, 32, 48, 64, 80,
		]);
	});

	it('leaves the colour raster it was handed exactly as it found it', () => {
		// The HEIF path attaches an auxiliary alpha item to a raster it has just
		// assembled from tiles. Writing the alpha back into that raster instead of
		// into the copy would be invisible here and wrong for any caller that
		// still holds the original.
		const image = asymmetric();
		const before = [...image.data];
		const attached = attachAlpha(image, labelled(3, 2, [0, 64, 128, 192, 255, 32]));
		expect([...image.data]).toEqual(before);
		expect(attached.data).not.toBe(image.data);
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

	it('pulls pure sRGB red in from the edge of the wider gamut', () => {
		// The reverse direction, pinned to a number instead of to a round trip.
		// A round trip passes for any matrix that is the true inverse of the one
		// going the other way, and passes again for a pair that are inverses of
		// each other and both wrong. White, black and grey add nothing to that,
		// because they only test that the rows sum to one.
		//
		// 234, 51, 35 is what the BT.709 and Display P3 primaries give. sRGB red
		// sits well inside the P3 gamut, so describing the same colour in P3
		// primaries takes less red and a real amount of green and blue. A
		// conversion left out entirely leaves 255, 0, 0 and the picture
		// oversaturates.
		const converted = toColourSpace(solid(1, 1, [255, 0, 0, 255], 'srgb'), 'display-p3');
		expect(converted.colourSpace).toBe('display-p3');
		expect(pixel(converted, 0, 0)).toEqual([234, 51, 35, 255]);
	});

	it('pulls pure sRGB green and blue in as well', () => {
		// Red on its own pins one row of three. Blue moves least, because the two
		// spaces share a blue primary and only the white balancing separates them.
		const green = toColourSpace(solid(1, 1, [0, 255, 0, 255], 'srgb'), 'display-p3');
		const blue = toColourSpace(solid(1, 1, [0, 0, 255, 255], 'srgb'), 'display-p3');
		expect(pixel(green, 0, 0)).toEqual([117, 251, 76, 255]);
		expect(pixel(blue, 0, 0)).toEqual([0, 0, 245, 255]);
	});

	it('shifts a mid tone by a few levels rather than leaving it alone', () => {
		// Not a corner of the cube, so it exercises all three rows at once against
		// a number rather than against a tolerance.
		const converted = toColourSpace(solid(1, 1, [120, 140, 160, 255], 'srgb'), 'display-p3');
		expect(pixel(converted, 0, 0)).toEqual([124, 139, 158, 255]);
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

	it('counts white and black as inside, since both spaces share them', () => {
		// The boundary is inclusive at both ends. White comes out of the matrix at
		// exactly 1.0 in all three components because the rows sum to one, so a
		// check written with >= rather than > calls the whitest pixel in the
		// picture wide gamut, and any photograph with a highlight in it then
		// justifies a P3 asset on its own.
		expect(outOfSrgbGamut(solid(2, 2, [255, 255, 255, 255], 'display-p3'))).toBe(0);
		expect(outOfSrgbGamut(solid(2, 2, [0, 0, 0, 255], 'display-p3'))).toBe(0);
	});

	it('counts a colour that only just falls outside', () => {
		// P3 200, 40, 40 needs a green of -0.0022 in sRGB. That is outside by a
		// fifth of one percent, and outside is the whole question: the number is
		// there to decide whether a wide gamut file carries anything sRGB cannot,
		// so a tolerance would be answering something else. A tolerance of a
		// couple of percent still reports the extremes and quietly swallows most
		// of what a real photograph has out there.
		expect(outOfSrgbGamut(solid(1, 1, [200, 40, 40, 255], 'display-p3'))).toBe(1);
		expect(outOfSrgbGamut(solid(1, 1, [30, 30, 34, 255], 'display-p3'))).toBe(0);
	});
});

describe('retagging a colour space without converting', () => {
	it('changes the tag and leaves every byte where it was', () => {
		// The dangerous twin of `toColourSpace`. This one says the numbers were
		// always in that space; the other one moves them into it. Using this where
		// the conversion was meant gives the flat picture, and the conversion
		// where this was meant gives the oversaturated one, and neither throws.
		const image = solid(2, 1, [200, 40, 40, 255], 'srgb');
		const retagged = withColourSpace(image, 'display-p3');
		expect(retagged.colourSpace).toBe('display-p3');
		expect([...retagged.data]).toEqual([200, 40, 40, 255, 200, 40, 40, 255]);
	});

	it('shares the pixel buffer rather than copying it', () => {
		// Same reason the identity paths above hand back the raster they were
		// given. Retagging 48 megapixels should cost one object, not 190 megabytes.
		const image = solid(2, 1, [200, 40, 40, 255], 'srgb');
		expect(withColourSpace(image, 'display-p3').data).toBe(image.data);
	});

	it('hands back the same raster when the tag already matches', () => {
		const image = solid(2, 1, [200, 40, 40, 255], 'display-p3');
		expect(withColourSpace(image, 'display-p3')).toBe(image);
	});

	it('carries the dimensions and the alpha flag across', () => {
		const image = createRaster(3, 2, 'srgb', true);
		const retagged = withColourSpace(image, 'display-p3');
		expect([retagged.width, retagged.height, retagged.hasAlpha]).toEqual([3, 2, true]);
	});
});
