/**
 * Reduce an image to a colour table.
 *
 * Needed by every format that stores indices rather than pixels: GIF, PCX, the
 * palettised half of PNG and BMP, XPM, and the older entries in an Apple icon
 * suite. Written once here rather than once per codec, because the quality of
 * the result is entirely a property of this file and a codec that rolled its
 * own would be quietly worse than its neighbour for no reason anybody could
 * see from the outside.
 *
 * Two paths, and the first one matters more than it looks. An image that
 * already has few enough colours gets its exact palette, which is lossless: a
 * screenshot, a logo, a diagram and a pixel-art sprite all land here, and those
 * are most of what anybody converts to GIF. Only a photograph reaches the
 * median cut, where the result is an approximation and says so.
 */

import type { RasterImage } from '../types.js';
import { createRaster } from './image.js';

export interface Palette {
	/** Entries as straight RGBA, four bytes each. */
	readonly colours: Uint8Array;
	/** The fully transparent entry, or -1 when the image is opaque. */
	readonly transparentIndex: number;
}

export interface IndexedImage {
	/** One palette index per pixel, in row order. */
	readonly indices: Uint8Array;
	readonly palette: Palette;
	readonly width: number;
	readonly height: number;
	/** True when the palette holds every colour of the source exactly. */
	readonly exact: boolean;
}

export interface QuantiseOptions {
	/** Entries the palette may hold, including the transparent one. Default 256. */
	readonly maxColours?: number;
	/**
	 * Diffuse the rounding error into neighbouring pixels.
	 *
	 * On by default, and it is the difference between a sky that bands into
	 * visible stripes and one that does not. Skipped automatically when the
	 * palette turned out to be exact, where there is no error to diffuse.
	 */
	readonly dither?: boolean;
	/**
	 * Alpha below this becomes fully transparent, and at or above it opaque.
	 *
	 * Indexed formats have one transparent entry and no partial coverage, so
	 * every soft edge has to fall to one side. Halfway is the least wrong place
	 * to put the line.
	 */
	readonly alphaThreshold?: number;
}

/**
 * A small open-addressed map from a packed colour to an index.
 *
 * A `Map` would do the same job, but this runs once per pixel on an image that
 * can be fifty million pixels, and the difference between a typed array probe
 * and a `Map` lookup at that scale is the difference between a moment and a
 * hang. Keys are 24 bit colours, so -1 is free as the empty marker.
 */
class ColourTable {
	private keys: Int32Array;
	private values: Int32Array;
	private mask: number;
	private used = 0;

	constructor(capacity = 1024) {
		let size = 16;
		while (size < capacity * 2) size *= 2;
		this.keys = new Int32Array(size).fill(-1);
		this.values = new Int32Array(size);
		this.mask = size - 1;
	}

	get size(): number {
		return this.used;
	}

	private slot(key: number): number {
		// Knuth's multiplicative hash. The colours in an image are anything but
		// uniformly distributed, and probing on the raw value clusters badly:
		// a greyscale image has every key on the r === g === b diagonal.
		let at = (Math.imul(key, 2654435761) >>> 0) & this.mask;
		while (this.keys[at] !== -1 && this.keys[at] !== key) {
			at = (at + 1) & this.mask;
		}
		return at;
	}

	private rehash(): void {
		const keys = this.keys;
		const values = this.values;
		const size = keys.length * 2;
		this.keys = new Int32Array(size).fill(-1);
		this.values = new Int32Array(size);
		this.mask = size - 1;
		for (let i = 0; i < keys.length; i += 1) {
			const key = keys[i] as number;
			if (key === -1) continue;
			const at = this.slot(key);
			this.keys[at] = key;
			this.values[at] = values[i] as number;
		}
	}

	/** The index stored for `key`, or -1. */
	get(key: number): number {
		const at = this.slot(key);
		return this.keys[at] === key ? (this.values[at] as number) : -1;
	}

	set(key: number, value: number): void {
		// Kept below two thirds full. Linear probing degrades sharply past
		// that, and the table is small enough that growing early is free.
		if ((this.used + 1) * 3 > this.keys.length * 2) this.rehash();
		const at = this.slot(key);
		if (this.keys[at] !== key) {
			this.keys[at] = key;
			this.used += 1;
		}
		this.values[at] = value;
	}
}

function packRgb(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/**
 * The exact palette of an image, when it has few enough colours to have one.
 *
 * Returns undefined the moment the count passes `maxColours`, so a photograph
 * costs a few hundred pixels of work rather than a pass over the whole image.
 */
export function exactPalette(
	image: RasterImage,
	maxColours = 256,
	alphaThreshold = 128,
): IndexedImage | undefined {
	const { data, width, height } = image;
	const pixels = width * height;
	const table = new ColourTable(maxColours + 2);
	const found: number[] = [];
	let transparent = false;

	for (let i = 0; i < pixels; i += 1) {
		const at = i * 4;
		if ((data[at + 3] as number) < alphaThreshold) {
			transparent = true;
			continue;
		}
		const key = packRgb(data[at] as number, data[at + 1] as number, data[at + 2] as number);
		if (table.get(key) === -1) {
			table.set(key, found.length);
			found.push(key);
			if (found.length + (transparent ? 1 : 0) > maxColours) return undefined;
		}
	}
	// The count can still pass the limit on the last pixel, because a
	// transparent one may turn up after the table is already full.
	if (found.length + (transparent ? 1 : 0) > maxColours) return undefined;

	const count = found.length + (transparent ? 1 : 0);
	// A palette of zero entries is not a thing any format can write, and an
	// image that is entirely transparent would produce one.
	const colours = new Uint8Array(Math.max(1, count) * 4);
	for (let i = 0; i < found.length; i += 1) {
		const key = found[i] as number;
		colours[i * 4] = (key >> 16) & 0xff;
		colours[i * 4 + 1] = (key >> 8) & 0xff;
		colours[i * 4 + 2] = key & 0xff;
		colours[i * 4 + 3] = 255;
	}
	const transparentIndex = transparent ? found.length : -1;

	const indices = new Uint8Array(pixels);
	for (let i = 0; i < pixels; i += 1) {
		const at = i * 4;
		if ((data[at + 3] as number) < alphaThreshold) {
			indices[i] = transparentIndex;
			continue;
		}
		indices[i] = table.get(
			packRgb(data[at] as number, data[at + 1] as number, data[at + 2] as number),
		);
	}

	return {
		indices,
		palette: { colours, transparentIndex },
		width,
		height,
		exact: true,
	};
}

/* ── Median cut ───────────────────────────────────────────────────────── */

/**
 * Bits per channel in the histogram.
 *
 * Five is the number every implementation of this algorithm has used since
 * Heckbert described it, and the reason is arithmetic rather than tradition:
 * 32768 bins fit in cache and hold enough structure to split on, while a sixth
 * bit octuples the work for a difference that dithering erases anyway.
 */
const BITS = 5;
const LEVELS = 1 << BITS;
const BINS = LEVELS * LEVELS * LEVELS;
const DROP = 8 - BITS;

interface Box {
	/** Half-open range into the occupied-bin list. */
	start: number;
	end: number;
	count: number;
	rMin: number;
	rMax: number;
	gMin: number;
	gMax: number;
	bMin: number;
	bMax: number;
}

function binOf(r: number, g: number, b: number): number {
	return ((r >> DROP) << (BITS * 2)) | ((g >> DROP) << BITS) | (b >> DROP);
}

function shrink(box: Box, occupied: Int32Array, counts: Uint32Array): void {
	let rMin = LEVELS;
	let rMax = -1;
	let gMin = LEVELS;
	let gMax = -1;
	let bMin = LEVELS;
	let bMax = -1;
	let count = 0;
	for (let i = box.start; i < box.end; i += 1) {
		const bin = occupied[i] as number;
		const r = bin >> (BITS * 2);
		const g = (bin >> BITS) & (LEVELS - 1);
		const b = bin & (LEVELS - 1);
		if (r < rMin) rMin = r;
		if (r > rMax) rMax = r;
		if (g < gMin) gMin = g;
		if (g > gMax) gMax = g;
		if (b < bMin) bMin = b;
		if (b > bMax) bMax = b;
		count += counts[bin] as number;
	}
	box.rMin = rMin;
	box.rMax = rMax;
	box.gMin = gMin;
	box.gMax = gMax;
	box.bMin = bMin;
	box.bMax = bMax;
	box.count = count;
}

function volume(box: Box): number {
	return (box.rMax - box.rMin + 1) * (box.gMax - box.gMin + 1) * (box.bMax - box.bMin + 1);
}

/**
 * Split the box with the most to gain, or return false when none can be split.
 *
 * The choice of which box to split is the whole quality of the algorithm.
 * Population alone gives the largest area of the picture the most entries,
 * which is right until the point where a big flat region has already been
 * described perfectly and is still winning; from there, population times volume
 * moves the remaining entries to the colours that are still badly served. The
 * changeover at half the palette is Heckbert's, and it is still what the good
 * implementations do.
 */
function splitOnce(
	boxes: Box[],
	occupied: Int32Array,
	counts: Uint32Array,
	byPopulation: boolean,
): boolean {
	let best = -1;
	let bestScore = 0;
	for (let i = 0; i < boxes.length; i += 1) {
		const box = boxes[i] as Box;
		if (box.end - box.start < 2) continue;
		const score = byPopulation ? box.count : box.count * volume(box);
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	if (best < 0) return false;

	const box = boxes[best] as Box;
	const rangeR = box.rMax - box.rMin;
	const rangeG = box.gMax - box.gMin;
	const rangeB = box.bMax - box.bMin;
	// Green is weighted, as everywhere else that compares colours: the eye
	// resolves about twice as much detail in green as in red and four times as
	// much as in blue, so splitting on the raw range spends entries on blue
	// detail nobody can see.
	const shiftR = BITS * 2;
	let channelShift = shiftR;
	let widest = rangeR * 2;
	if (rangeG * 3 > widest) {
		widest = rangeG * 3;
		channelShift = BITS;
	}
	if (rangeB > widest) {
		channelShift = 0;
	}

	const mask = LEVELS - 1;
	const slice = Array.from(occupied.subarray(box.start, box.end));
	slice.sort((a, b) => ((a >> channelShift) & mask) - ((b >> channelShift) & mask));
	occupied.set(slice, box.start);

	// Cut at the weighted median, so both halves hold a similar number of
	// pixels rather than a similar number of distinct colours.
	const half = box.count / 2;
	let running = 0;
	let cut = box.start;
	for (let i = box.start; i < box.end - 1; i += 1) {
		running += counts[occupied[i] as number] as number;
		cut = i + 1;
		if (running >= half) break;
	}

	const right: Box = {
		start: cut,
		end: box.end,
		count: 0,
		rMin: 0,
		rMax: 0,
		gMin: 0,
		gMax: 0,
		bMin: 0,
		bMax: 0,
	};
	box.end = cut;
	shrink(box, occupied, counts);
	shrink(right, occupied, counts);
	boxes.push(right);
	return true;
}

/**
 * Reduce an image to at most `maxColours` entries.
 *
 * Tries the exact palette first, so anything that did not need approximating
 * does not get approximated.
 */
export function quantise(image: RasterImage, options: QuantiseOptions = {}): IndexedImage {
	const maxColours = Math.max(2, Math.min(256, options.maxColours ?? 256));
	const alphaThreshold = options.alphaThreshold ?? 128;

	const exact = exactPalette(image, maxColours, alphaThreshold);
	if (exact) return exact;

	const { data, width, height } = image;
	const pixels = width * height;

	const counts = new Uint32Array(BINS);
	const sumR = new Float64Array(BINS);
	const sumG = new Float64Array(BINS);
	const sumB = new Float64Array(BINS);
	let transparent = false;

	for (let i = 0; i < pixels; i += 1) {
		const at = i * 4;
		if ((data[at + 3] as number) < alphaThreshold) {
			transparent = true;
			continue;
		}
		const r = data[at] as number;
		const g = data[at + 1] as number;
		const b = data[at + 2] as number;
		const bin = binOf(r, g, b);
		counts[bin] += 1;
		sumR[bin] += r;
		sumG[bin] += g;
		sumB[bin] += b;
	}

	const occupiedList: number[] = [];
	for (let bin = 0; bin < BINS; bin += 1) {
		if (counts[bin] !== 0) occupiedList.push(bin);
	}
	const occupied = Int32Array.from(occupiedList);

	const budget = Math.max(1, maxColours - (transparent ? 1 : 0));
	const root: Box = {
		start: 0,
		end: occupied.length,
		count: 0,
		rMin: 0,
		rMax: 0,
		gMin: 0,
		gMax: 0,
		bMin: 0,
		bMax: 0,
	};
	shrink(root, occupied, counts);
	const boxes: Box[] = [root];
	const changeover = Math.max(1, Math.floor(budget / 2));
	while (boxes.length < budget) {
		if (!splitOnce(boxes, occupied, counts, boxes.length < changeover)) break;
	}

	const entries = boxes.length + (transparent ? 1 : 0);
	const colours = new Uint8Array(entries * 4);
	for (let i = 0; i < boxes.length; i += 1) {
		const box = boxes[i] as Box;
		let r = 0;
		let g = 0;
		let b = 0;
		let count = 0;
		for (let j = box.start; j < box.end; j += 1) {
			const bin = occupied[j] as number;
			r += sumR[bin] as number;
			g += sumG[bin] as number;
			b += sumB[bin] as number;
			count += counts[bin] as number;
		}
		// The average of the pixels themselves, not the centre of the bin. The
		// bin centre is up to four units away in each channel, and on a flat
		// area of near-uniform colour that shift is visible as a wash.
		colours[i * 4] = count === 0 ? 0 : Math.round(r / count);
		colours[i * 4 + 1] = count === 0 ? 0 : Math.round(g / count);
		colours[i * 4 + 2] = count === 0 ? 0 : Math.round(b / count);
		colours[i * 4 + 3] = 255;
	}
	const transparentIndex = transparent ? boxes.length : -1;

	const indices = mapToPalette(
		image,
		colours,
		boxes.length,
		transparentIndex,
		alphaThreshold,
		options.dither ?? true,
	);

	return { indices, palette: { colours, transparentIndex }, width, height, exact: false };
}

function nearest(colours: Uint8Array, count: number, r: number, g: number, b: number): number {
	let best = 0;
	let bestDistance = Infinity;
	for (let i = 0; i < count; i += 1) {
		const dr = r - (colours[i * 4] as number);
		const dg = g - (colours[i * 4 + 1] as number);
		const db = b - (colours[i * 4 + 2] as number);
		// Weighted the way the eye weights them, and the same weighting the
		// split above uses, so the two halves of the algorithm agree about what
		// "close" means.
		const distance = dr * dr * 3 + dg * dg * 6 + db * db;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
	}
	return best;
}

/**
 * Assign every pixel an index, diffusing the error when asked.
 *
 * Floyd and Steinberg's weights, serpentine so the error does not build a
 * diagonal grain running one way across the whole image. A transparent pixel
 * neither produces error nor consumes any: it has no colour to be wrong about,
 * and letting one take a share would put a coloured fringe around every
 * cut-out edge. Error aimed at a transparent neighbour is simply dropped,
 * which is what every implementation that handles this at all does.
 */
function mapToPalette(
	image: RasterImage,
	colours: Uint8Array,
	count: number,
	transparentIndex: number,
	alphaThreshold: number,
	dither: boolean,
): Uint8Array {
	const { data, width, height } = image;
	const indices = new Uint8Array(width * height);
	// Keyed on the five bit bin rather than the exact colour, which bounds the
	// table at 32768 entries instead of sixteen million. Two colours in one bin
	// differ by at most seven per channel and land on the same palette entry
	// almost always; where they would not, the error is smaller than the
	// quantisation that produced the palette in the first place.
	const cache = new Int16Array(BINS).fill(-1);

	if (!dither) {
		for (let i = 0; i < width * height; i += 1) {
			const at = i * 4;
			if ((data[at + 3] as number) < alphaThreshold && transparentIndex >= 0) {
				indices[i] = transparentIndex;
				continue;
			}
			const r = data[at] as number;
			const g = data[at + 1] as number;
			const b = data[at + 2] as number;
			const bin = binOf(r, g, b);
			let index = cache[bin] as number;
			if (index < 0) {
				index = nearest(colours, count, r, g, b);
				cache[bin] = index;
			}
			indices[i] = index;
		}
		return indices;
	}

	// One row of error ahead and one row after, as floats. Carrying the error
	// in the source buffer instead would corrupt the caller's image.
	let thisRow = new Float32Array(width * 3);
	let nextRow = new Float32Array(width * 3);

	for (let y = 0; y < height; y += 1) {
		const leftToRight = y % 2 === 0;
		for (let step = 0; step < width; step += 1) {
			const x = leftToRight ? step : width - 1 - step;
			const i = y * width + x;
			const at = i * 4;
			if ((data[at + 3] as number) < alphaThreshold && transparentIndex >= 0) {
				indices[i] = transparentIndex;
				continue;
			}
			const r = clamp255((data[at] as number) + (thisRow[x * 3] as number));
			const g = clamp255((data[at + 1] as number) + (thisRow[x * 3 + 1] as number));
			const b = clamp255((data[at + 2] as number) + (thisRow[x * 3 + 2] as number));
			const bin = binOf(r, g, b);
			let index = cache[bin] as number;
			if (index < 0) {
				index = nearest(colours, count, r, g, b);
				cache[bin] = index;
			}
			indices[i] = index;

			const errR = r - (colours[index * 4] as number);
			const errG = g - (colours[index * 4 + 1] as number);
			const errB = b - (colours[index * 4 + 2] as number);
			const ahead = leftToRight ? 1 : -1;
			spread(thisRow, x + ahead, width, errR, errG, errB, 7 / 16);
			spread(nextRow, x - ahead, width, errR, errG, errB, 3 / 16);
			spread(nextRow, x, width, errR, errG, errB, 5 / 16);
			spread(nextRow, x + ahead, width, errR, errG, errB, 1 / 16);
		}
		const spent = thisRow;
		thisRow = nextRow;
		nextRow = spent;
		nextRow.fill(0);
	}
	return indices;
}

function clamp255(value: number): number {
	return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function spread(
	row: Float32Array,
	x: number,
	width: number,
	r: number,
	g: number,
	b: number,
	weight: number,
): void {
	if (x < 0 || x >= width) return;
	row[x * 3] += r * weight;
	row[x * 3 + 1] += g * weight;
	row[x * 3 + 2] += b * weight;
}

/** Expand an indexed image back to RGBA. Used by decoders and by the tests. */
export function indexedToRaster(
	indexed: IndexedImage,
	colourSpace: RasterImage['colourSpace'] = 'srgb',
): RasterImage {
	const { indices, palette, width, height } = indexed;
	const out = createRaster(width, height, colourSpace, palette.transparentIndex >= 0);
	const entries = palette.colours.length / 4;
	for (let i = 0; i < indices.length; i += 1) {
		const index = Math.min(indices[i] as number, entries - 1);
		const from = index * 4;
		const at = i * 4;
		out.data[at] = palette.colours[from] as number;
		out.data[at + 1] = palette.colours[from + 1] as number;
		out.data[at + 2] = palette.colours[from + 2] as number;
		out.data[at + 3] = palette.colours[from + 3] as number;
	}
	return out;
}
