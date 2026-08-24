/**
 * Colour table tests.
 *
 * The property that matters most here is the one that is easiest to lose. An
 * image that already has few enough colours must come back byte for byte, not
 * approximately: a screenshot, a logo, a diagram and a pixel-art sprite are
 * most of what anybody converts to GIF, and a fast path that quietly rounds
 * them turns a lossless conversion into a lossy one that nobody asked for.
 * Every test on the exact path therefore asserts pixel equality after the
 * round trip rather than closeness.
 *
 * The approximate path is tested as a property rather than against captured
 * output. Median cut is deterministic, so pinning its palette to a list of
 * numbers would pass forever and say nothing; a bound on the error and a bound
 * on the number of entries are the two things a caller actually relies on, and
 * both fail loudly if the algorithm collapses onto a handful of colours.
 */

import { describe, expect, it } from 'vitest';
import { exactPalette, indexedToRaster, quantise } from '../../src/raster/quantise.js';
import type { IndexedImage } from '../../src/raster/quantise.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

type Pixel = readonly [number, number, number, number];

/** A raster written out pixel by pixel, in row order. */
function imageOf(width: number, height: number, pixels: readonly Pixel[]): RasterImage {
	const hasAlpha = pixels.some((colour) => colour[3] !== 255);
	const image = createRaster(width, height, 'srgb', hasAlpha);
	pixels.forEach((colour, index) => image.data.set(colour, index * 4));
	return image;
}

function entriesOf(indexed: IndexedImage): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < indexed.palette.colours.length; i += 4) {
		out.push([...indexed.palette.colours.subarray(i, i + 4)]);
	}
	return out;
}

/** A gradient with far more colours than any palette here can hold. */
function gradient(width = 64, height = 64): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			image.data.set([x * 4, y * 4, (x + y) * 2, 255], (y * width + x) * 4);
		}
	}
	return image;
}

/** A ramp along one channel only, for checking which channel a box splits on. */
function ramp(channel: 0 | 1 | 2, steps = 64): RasterImage {
	const image = createRaster(steps, 1, 'srgb', false);
	for (let i = 0; i < steps; i += 1) {
		const colour: [number, number, number, number] = [0, 0, 0, 255];
		colour[channel] = i * 4;
		image.data.set(colour, i * 4);
	}
	return image;
}

/** Mean absolute difference per colour channel, ignoring alpha. */
function meanChannelError(a: RasterImage, b: RasterImage): number {
	let sum = 0;
	let counted = 0;
	for (let i = 0; i < a.data.length; i += 1) {
		if (i % 4 === 3) continue;
		sum += Math.abs((a.data[i] as number) - (b.data[i] as number));
		counted += 1;
	}
	return sum / counted;
}

describe('taking the exact palette of an image', () => {
	it('reproduces a few coloured image byte for byte', () => {
		// The whole reason the fast path exists. Approximate equality would pass
		// here for a palette that had rounded every colour by a level or two,
		// which is exactly the failure this path is meant to rule out.
		const image = imageOf(2, 3, [
			[10, 20, 30, 255],
			[200, 100, 50, 255],
			[10, 20, 30, 255],
			[0, 0, 0, 255],
			[255, 255, 255, 255],
			[200, 100, 50, 255],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(indexed.exact).toBe(true);
		expect([...indexedToRaster(indexed).data]).toEqual([...image.data]);
	});

	it('numbers the entries in the order the colours first appear', () => {
		const image = imageOf(2, 2, [
			[10, 20, 30, 255],
			[40, 50, 60, 255],
			[10, 20, 30, 255],
			[70, 80, 90, 255],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(entriesOf(indexed)).toEqual([
			[10, 20, 30, 255],
			[40, 50, 60, 255],
			[70, 80, 90, 255],
		]);
		expect([...indexed.indices]).toEqual([0, 1, 0, 2]);
	});

	it('carries the dimensions of the image it was given', () => {
		const indexed = exactPalette(
			imageOf(3, 1, [
				[1, 1, 1, 255],
				[2, 2, 2, 255],
				[3, 3, 3, 255],
			]),
		) as IndexedImage;
		expect([indexed.width, indexed.height]).toEqual([3, 1]);
		expect(indexed.indices.length).toBe(3);
	});

	it('accepts an image with exactly as many colours as the palette holds', () => {
		const image = imageOf(2, 2, [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
			[4, 4, 4, 255],
		]);
		const indexed = exactPalette(image, 4) as IndexedImage;
		expect(entriesOf(indexed)).toHaveLength(4);
	});

	it('gives up as soon as the image has one colour too many', () => {
		const image = imageOf(2, 2, [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
			[4, 4, 4, 255],
		]);
		expect(exactPalette(image, 3)).toBeUndefined();
	});

	it('does not spend a slot on transparency when every pixel is opaque', () => {
		// The limit includes the transparent entry, so an opaque image that
		// reserved one anyway would be refused a colour it could have had, and a
		// 256 colour screenshot would fall to the median cut for nothing.
		const image = imageOf(2, 2, [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
			[4, 4, 4, 255],
		]);
		const indexed = exactPalette(image, 4) as IndexedImage;
		expect(indexed.palette.transparentIndex).toBe(-1);
		expect(entriesOf(indexed)).toHaveLength(4);
	});

	it('gives transparency an entry of its own after the colours', () => {
		// The transparent pixel is first in the image and last in the palette. A
		// palette that numbered it where it appeared would shift every colour
		// index by one and reorder the table a caller is about to write out.
		const image = imageOf(2, 2, [
			[9, 9, 9, 0],
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[1, 1, 1, 255],
		]);
		const indexed = exactPalette(image, 4) as IndexedImage;
		expect(indexed.palette.transparentIndex).toBe(2);
		expect(entriesOf(indexed)).toEqual([
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[0, 0, 0, 0],
		]);
		expect([...indexed.indices]).toEqual([2, 0, 1, 0]);
	});

	it('counts the transparent entry against the limit', () => {
		// The same three colours fit in a palette of three when the image is
		// opaque and do not when one pixel is transparent.
		const colours: Pixel[] = [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
		];
		expect(exactPalette(imageOf(3, 1, colours), 3)).toBeDefined();
		expect(exactPalette(imageOf(4, 1, [...colours, [4, 4, 4, 0]]), 3)).toBeUndefined();
	});

	it('refuses an image whose transparency only turns up after the table is full', () => {
		// The count can pass the limit on the very last pixel, because a
		// transparent one adds an entry without adding a colour. A check written
		// only inside the colour loop accepts this image and then writes a
		// palette with one entry more than the format allows.
		const image = imageOf(3, 1, [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 0],
		]);
		expect(exactPalette(image, 2)).toBeUndefined();
	});

	it('treats alpha at the threshold as opaque and one level below it as transparent', () => {
		// An indexed format has one transparent entry and no partial coverage, so
		// every soft edge has to fall to one side of a line. Where the line sits
		// decides whether a feathered edge comes out solid or disappears.
		const image = imageOf(2, 1, [
			[10, 20, 30, 128],
			[40, 50, 60, 127],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(entriesOf(indexed)).toEqual([
			[10, 20, 30, 255],
			[0, 0, 0, 0],
		]);
		expect([...indexed.indices]).toEqual([0, 1]);
	});

	it('moves the line when it is given a different threshold', () => {
		const image = imageOf(2, 1, [
			[10, 20, 30, 200],
			[40, 50, 60, 190],
		]);
		const indexed = exactPalette(image, 256, 200) as IndexedImage;
		expect(indexed.palette.transparentIndex).toBe(1);
		expect([...indexed.indices]).toEqual([0, 1]);
	});

	it('gives an entirely transparent image a palette of one entry rather than none', () => {
		// No format can write a palette of zero entries, and an image that is
		// entirely transparent is a real thing to be handed: it is what a crop of
		// the empty margin of an icon looks like.
		const image = imageOf(2, 2, [
			[1, 2, 3, 0],
			[4, 5, 6, 0],
			[7, 8, 9, 0],
			[0, 0, 0, 0],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(entriesOf(indexed)).toEqual([[0, 0, 0, 0]]);
		expect([...indexed.indices]).toEqual([0, 0, 0, 0]);
	});

	it('drops the colour underneath a transparent pixel', () => {
		// An indexed image has one transparent entry, so the colour a transparent
		// pixel was carrying cannot be kept. Saying so here is better than an
		// exact round trip test that quietly uses transparent black everywhere
		// and never notices.
		const image = imageOf(2, 1, [
			[200, 100, 50, 0],
			[10, 20, 30, 255],
		]);
		const back = indexedToRaster(exactPalette(image) as IndexedImage);
		expect([...back.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
	});

	it('handles an image of a single pixel', () => {
		const indexed = exactPalette(imageOf(1, 1, [[7, 8, 9, 255]])) as IndexedImage;
		expect(entriesOf(indexed)).toEqual([[7, 8, 9, 255]]);
		expect([...indexed.indices]).toEqual([0]);
	});

	it('handles an image of a single colour', () => {
		const image = imageOf(2, 2, [
			[7, 8, 9, 255],
			[7, 8, 9, 255],
			[7, 8, 9, 255],
			[7, 8, 9, 255],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(entriesOf(indexed)).toEqual([[7, 8, 9, 255]]);
		expect([...indexed.indices]).toEqual([0, 0, 0, 0]);
	});

	it('separates colours that differ in one channel by one level', () => {
		// The histogram the approximate path uses keeps five bits a channel, so
		// these two colours share a bin. The exact path must not: a logo with two
		// near-identical greys is a normal thing, and merging them is visible as a
		// flat patch where a subtle edge was.
		const image = imageOf(2, 1, [
			[100, 100, 100, 255],
			[100, 100, 101, 255],
		]);
		const indexed = exactPalette(image) as IndexedImage;
		expect(entriesOf(indexed)).toHaveLength(2);
		expect([...indexedToRaster(indexed).data]).toEqual([...image.data]);
	});

	it('gives up on an image with more colours than a full palette holds', () => {
		expect(exactPalette(gradient())).toBeUndefined();
	});
});

describe('quantising an image', () => {
	it('takes the exact palette when the image has few enough colours', () => {
		// Anything that did not need approximating must not be approximated, so
		// this is the same byte for byte assertion as the exact path itself.
		const image = imageOf(2, 2, [
			[10, 20, 30, 255],
			[200, 100, 50, 255],
			[0, 0, 0, 255],
			[255, 255, 255, 255],
		]);
		const indexed = quantise(image, { maxColours: 16 });
		expect(indexed.exact).toBe(true);
		expect([...indexedToRaster(indexed).data]).toEqual([...image.data]);
	});

	it('reduces a gradient to no more entries than it was allowed', () => {
		const indexed = quantise(gradient(), { maxColours: 16 });
		expect(indexed.exact).toBe(false);
		expect(entriesOf(indexed)).toHaveLength(16);
	});

	it('keeps the error on a gradient inside a few levels of the palette spacing', () => {
		// Sixteen entries spread over a picture that visits several thousand
		// colours leaves neighbouring entries tens of levels apart, so a mean
		// under twenty says the table covers the picture. A palette that had
		// collapsed onto two or three colours, which is what a broken split
		// produces, lands above sixty.
		const image = gradient();
		const back = indexedToRaster(quantise(image, { maxColours: 16 }));
		expect(meanChannelError(image, back)).toBeLessThan(20);
	});

	it('improves as the palette is allowed more entries', () => {
		// The direction is the assertion. A quantiser that ignored `maxColours`
		// after the first split would pass the bound above and fail here.
		const image = gradient();
		const coarse = meanChannelError(image, indexedToRaster(quantise(image, { maxColours: 4 })));
		const fine = meanChannelError(image, indexedToRaster(quantise(image, { maxColours: 64 })));
		expect(fine).toBeLessThan(coarse);
	});

	it.each([true, false])('keeps every index inside the palette with dithering %s', (dither) => {
		// An index past the end of the table is not a rounding error, it is a
		// palette lookup into whatever follows the table in the file.
		const indexed = quantise(gradient(), { maxColours: 16, dither });
		const entries = entriesOf(indexed).length;
		expect(indexed.indices.length).toBe(64 * 64);
		expect([...indexed.indices].every((index) => index >= 0 && index < entries)).toBe(true);
	});

	it.each([true, false])('keeps the error bounded with dithering %s', (dither) => {
		const image = gradient();
		const back = indexedToRaster(quantise(image, { maxColours: 16, dither }));
		expect(meanChannelError(image, back)).toBeLessThan(25);
	});

	it('produces a different picture with dithering than without it', () => {
		// Both are legitimate outputs, so the assertion is that the option does
		// something at all. An option that is accepted and ignored is worse than
		// one that does not exist, and banding in a sky is exactly what somebody
		// turns this on to fix.
		const image = gradient();
		const dithered = quantise(image, { maxColours: 16, dither: true });
		const flat = quantise(image, { maxColours: 16, dither: false });
		expect([...dithered.indices]).not.toEqual([...flat.indices]);
	});

	it('leaves the image it was given exactly as it found it', () => {
		// The diffused error is carried in rows of its own rather than added back
		// into the source. Writing it into the caller's buffer would corrupt an
		// image the converter still needs whenever one decode feeds two outputs,
		// and it would do it only when dithering was on.
		const image = gradient(16, 16);
		const before = [...image.data];
		quantise(image, { maxColours: 8, dither: true });
		expect([...image.data]).toEqual(before);
	});

	it('counts the transparent entry against the limit here as well', () => {
		const image = gradient();
		for (let i = 0; i < image.width * image.height; i += 97) image.data[i * 4 + 3] = 0;
		const indexed = quantise(image, { maxColours: 16 });
		const entries = entriesOf(indexed);
		expect(entries.length).toBeLessThanOrEqual(16);
		expect(indexed.palette.transparentIndex).toBe(entries.length - 1);
		expect(entries[entries.length - 1]).toEqual([0, 0, 0, 0]);
	});

	it.each([true, false])(
		'sends every transparent pixel to the transparent entry with dithering %s',
		(dither) => {
			// A transparent pixel neither produces error nor takes a share of it.
			// Letting one take a share puts a coloured fringe around every cut-out
			// edge, and letting one be mapped by colour turns the hole opaque.
			const image = gradient(32, 32);
			for (let i = 0; i < 32; i += 1) image.data[i * 4 + 3] = 0;
			const indexed = quantise(image, { maxColours: 16, dither });
			const transparent = indexed.palette.transparentIndex;
			expect(transparent).toBeGreaterThanOrEqual(0);
			for (let i = 0; i < 32; i += 1) expect(indexed.indices[i]).toBe(transparent);
			expect(indexed.indices[32]).not.toBe(transparent);
		},
	);

	it('raises a palette of fewer than two entries to two', () => {
		// No format writes a table of one colour, and a caller can arrive here
		// with a zero from a header field it did not check.
		expect(entriesOf(quantise(gradient(), { maxColours: 1 }))).toHaveLength(2);
		expect(entriesOf(quantise(gradient(), { maxColours: 0 }))).toHaveLength(2);
	});

	it('holds a palette of more than 256 entries down to 256', () => {
		// An index is a byte everywhere this is used, so 256 is the ceiling
		// whatever the caller asks for.
		expect(entriesOf(quantise(gradient(), { maxColours: 9999 })).length).toBeLessThanOrEqual(256);
	});

	it('defaults to a full palette of 256 entries', () => {
		expect(entriesOf(quantise(gradient())).length).toBeLessThanOrEqual(256);
	});

	it.each([
		['red', 0],
		['green', 1],
		['blue', 2],
	] as const)('splits a %s ramp along the channel that carries it', (_name, channel) => {
		// Boxes are split on the widest channel, weighted the way the eye weights
		// them. A split that always took the same channel would put every entry of
		// a blue ramp at the same blue and the picture would come out flat, so
		// each channel needs its own case.
		const image = ramp(channel);
		const indexed = quantise(image, { maxColours: 4, dither: false });
		const entries = entriesOf(indexed);
		expect(entries).toHaveLength(4);
		const others = [0, 1, 2].filter((index) => index !== channel);
		for (const entry of entries) {
			for (const other of others) expect(entry[other]).toBe(0);
		}
		const values = entries.map((entry) => entry[channel] as number);
		expect(new Set(values).size).toBe(4);
		expect(meanChannelError(image, indexedToRaster(indexed))).toBeLessThan(20);
	});

	it('stops splitting once every box holds a single colour of the histogram', () => {
		// Five hundred colours packed into sixty three histogram bins cannot be
		// split into the 256 boxes that were asked for. The loop has to notice and
		// stop rather than spin, and the palette it returns is honestly short.
		const image = createRaster(512, 1, 'srgb', false);
		for (let i = 0; i < 256; i += 1) {
			image.data.set([i, 0, 0, 255], i * 4);
			image.data.set([0, i, 0, 255], (256 + i) * 4);
		}
		const indexed = quantise(image, { maxColours: 256 });
		expect(indexed.exact).toBe(false);
		expect(entriesOf(indexed).length).toBeLessThan(256);
		expect(entriesOf(indexed).length).toBeGreaterThan(1);
	});

	it('quantises an image of a single pixel', () => {
		const indexed = quantise(imageOf(1, 1, [[7, 8, 9, 255]]), { maxColours: 4 });
		expect(entriesOf(indexed)).toEqual([[7, 8, 9, 255]]);
	});

	it('honours a custom alpha threshold', () => {
		const image = gradient(32, 32);
		for (let i = 0; i < 32; i += 1) image.data[i * 4 + 3] = 190;
		expect(quantise(image, { maxColours: 16 }).palette.transparentIndex).toBe(-1);
		const strict = quantise(image, { maxColours: 16, alphaThreshold: 200 });
		expect(strict.palette.transparentIndex).toBeGreaterThanOrEqual(0);
	});

	it('carries the dimensions of the image it was given', () => {
		const indexed = quantise(gradient(8, 5), { maxColours: 4 });
		expect([indexed.width, indexed.height]).toEqual([8, 5]);
		expect(indexed.indices.length).toBe(40);
	});
});

describe('expanding an indexed image back to a raster', () => {
	const palette = {
		colours: Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 255]),
		transparentIndex: -1,
	};

	it('writes the palette colour of every index', () => {
		const raster = indexedToRaster({
			indices: Uint8Array.from([1, 0, 0, 1]),
			palette,
			width: 2,
			height: 2,
			exact: true,
		});
		expect([...raster.data]).toEqual([
			200, 100, 50, 255, 10, 20, 30, 255, 10, 20, 30, 255, 200, 100, 50, 255,
		]);
	});

	it('clamps an index past the end of the palette to the last entry', () => {
		// A palette index comes out of somebody's file, and a table shorter than
		// the indices that address it is a normal kind of malformed. Reading past
		// the end would take four bytes of whatever followed the table.
		const raster = indexedToRaster({
			indices: Uint8Array.from([250]),
			palette,
			width: 1,
			height: 1,
			exact: false,
		});
		expect([...raster.data]).toEqual([200, 100, 50, 255]);
	});

	it('marks the raster as carrying alpha only when the palette has a transparent entry', () => {
		const opaque = indexedToRaster({
			indices: Uint8Array.from([0]),
			palette,
			width: 1,
			height: 1,
			exact: true,
		});
		const cut = indexedToRaster({
			indices: Uint8Array.from([1]),
			palette: { colours: palette.colours, transparentIndex: 1 },
			width: 1,
			height: 1,
			exact: true,
		});
		expect(opaque.hasAlpha).toBe(false);
		expect(cut.hasAlpha).toBe(true);
	});

	it('defaults to sRGB and takes a colour space when it is given one', () => {
		// A palette carries numbers and nothing that says what space they are in,
		// so the caller has to say. Defaulting the other way would tag an ordinary
		// GIF as wide gamut and oversaturate it.
		const indexed: IndexedImage = {
			indices: Uint8Array.from([0]),
			palette,
			width: 1,
			height: 1,
			exact: true,
		};
		expect(indexedToRaster(indexed).colourSpace).toBe('srgb');
		expect(indexedToRaster(indexed, 'display-p3').colourSpace).toBe('display-p3');
	});

	it('carries the dimensions of the indexed image', () => {
		const raster = indexedToRaster({
			indices: new Uint8Array(6),
			palette,
			width: 3,
			height: 2,
			exact: true,
		});
		expect([raster.width, raster.height]).toEqual([3, 2]);
		expect(raster.data.length).toBe(3 * 2 * 4);
	});
});
