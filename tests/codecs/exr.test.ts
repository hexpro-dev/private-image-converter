import { describe, expect, it, vi } from 'vitest';

import { decodeExr } from '../../src/codecs/exr/decode.js';
import { deflate } from '../../src/codecs/png/deflate.js';
import { CodecUnavailableError, DecodeFailedError } from '../../src/errors.js';
import { toneMap } from '../../src/raster/tonemap.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

const NONE = 0;
const RLE = 1;
const ZIPS = 2;
const ZIP = 3;

const UINT = 0;
const HALF = 1;
const FLOAT = 2;

const INCREASING_Y = 0;
const DECREASING_Y = 1;

function ascii(text: string): number[] {
	return Array.from(text, (character) => character.charCodeAt(0));
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value: number): number[] {
	return [...u32(value % 0x100000000), ...u32(Math.floor(value / 0x100000000))];
}

function f32(value: number): number[] {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setFloat32(0, value, true);
	return Array.from(bytes);
}

/**
 * A float as the sixteen bits OpenEXR stores.
 *
 * Rounds towards zero rather than to nearest, which is why every value in these
 * fixtures is one a half can hold exactly. Subnormals, infinities and NaN are
 * written as bit patterns instead, through the `raw` flag below.
 */
function halfBits(value: number): number {
	const single = new DataView(new ArrayBuffer(4));
	single.setFloat32(0, value, true);
	const bits = single.getUint32(0, true);
	const sign = (bits >>> 16) & 0x8000;
	const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
	const mantissa = bits & 0x7fffff;
	if (exponent <= 0) return sign;
	if (exponent >= 31) return sign | 0x7c00;
	return sign | (exponent << 10) | (mantissa >>> 13);
}

interface ChannelSpec {
	readonly name: string;
	/** UINT, HALF or FLOAT. Defaults to FLOAT, which needs no conversion. */
	readonly type?: number;
	readonly xSampling?: number;
	readonly ySampling?: number;
	/** One value per pixel of the data window, row major. */
	readonly values: readonly number[];
	/** Treat the values as the stored bit patterns rather than as numbers. */
	readonly raw?: boolean;
}

interface AttributeSpec {
	readonly name: string;
	readonly type: string;
	readonly bytes: readonly number[];
}

interface ExrSpec {
	readonly width: number;
	readonly height: number;
	readonly xMin?: number;
	readonly yMin?: number;
	/** The display window, when it is not the data window. */
	readonly display?: readonly [number, number, number, number];
	readonly compression?: number;
	readonly lineOrder?: number;
	readonly version?: number;
	readonly flags?: number;
	readonly channels: readonly ChannelSpec[];
	/** Attributes written before the ones every header must carry. */
	readonly extras?: readonly AttributeSpec[];
	/** Attributes written after them. */
	readonly trailing?: readonly AttributeSpec[];
	readonly omit?: readonly string[];
	/** Write every block as it is, the way a writer does when compression failed. */
	readonly stored?: boolean;
	/** Cut the channel list about, without disturbing the attributes after it. */
	readonly rewriteChannels?: (bytes: number[]) => number[];
	readonly rewriteY?: (index: number, y: number) => number;
	readonly rewriteBlock?: (index: number, data: number[]) => number[];
	readonly rewriteOffsets?: (offsets: number[]) => number[];
}

function attribute(name: string, type: string, bytes: readonly number[]): number[] {
	return [...ascii(name), 0, ...ascii(type), 0, ...u32(bytes.length), ...bytes];
}

/**
 * The channel list, in the order given.
 *
 * Sixteen bytes follow each name: the pixel type, one byte of pLinear, three
 * reserved bytes and the two sampling rates. A real writer sorts the list
 * alphabetically, so the fixtures below pass their channels in that order and
 * the decoder has to be the one that knows where R goes.
 */
function chlist(channels: readonly ChannelSpec[]): number[] {
	const out: number[] = [];
	for (const channel of channels) {
		out.push(
			...ascii(channel.name),
			0,
			...u32(channel.type ?? FLOAT),
			0,
			0,
			0,
			0,
			...u32(channel.xSampling ?? 1),
			...u32(channel.ySampling ?? 1),
		);
	}
	out.push(0);
	return out;
}

function sampleBytes(channel: ChannelSpec, value: number): number[] {
	const type = channel.type ?? FLOAT;
	if (type === HALF) {
		const bits = channel.raw ? value : halfBits(value);
		return [bits & 0xff, (bits >>> 8) & 0xff];
	}
	if (type === FLOAT) return f32(value);
	return u32(value);
}

/** Interleave, as a writer does: the even bytes first, then the odd ones. */
function interleave(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.length);
	const half = Math.ceil(source.length / 2);
	let even = 0;
	let odd = half;
	for (let i = 0; i < source.length; i += 2) {
		out[even] = source[i] as number;
		even += 1;
		if (i + 1 < source.length) {
			out[odd] = source[i + 1] as number;
			odd += 1;
		}
	}
	return out;
}

/** Store each byte as its difference from the one before, offset by 128. */
function predict(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.length);
	out[0] = source[0] as number;
	for (let i = 1; i < source.length; i += 1) {
		out[i] = ((source[i] as number) - (source[i - 1] as number) + 128) & 0xff;
	}
	return out;
}

/**
 * OpenEXR's run length encoding.
 *
 * A count of zero or more repeats the next byte that many times plus one; a
 * negative count is minus the number of literal bytes that follow. Written out
 * here from the format rather than by inverting the decoder, so that a decoder
 * that got the asymmetry backwards fails these tests.
 */
function rleCompress(source: Uint8Array): number[] {
	const out: number[] = [];
	let at = 0;
	while (at < source.length) {
		let run = 1;
		while (at + run < source.length && source[at + run] === source[at] && run < 128) run += 1;
		if (run >= 2) {
			out.push(run - 1, source[at] as number);
			at += run;
			continue;
		}
		let literals = 1;
		while (
			at + literals < source.length &&
			literals < 127 &&
			source[at + literals] !== source[at + literals - 1]
		) {
			literals += 1;
		}
		out.push(256 - literals);
		for (let i = 0; i < literals; i += 1) out.push(source[at + i] as number);
		at += literals;
	}
	return out;
}

async function packBlock(raw: number[], compression: number, stored: boolean): Promise<number[]> {
	if (compression === NONE || stored) return raw;
	const transformed = predict(interleave(Uint8Array.from(raw)));
	const packed =
		compression === RLE ? rleCompress(transformed) : Array.from(await deflate(transformed));
	// A writer whose compressor did not shrink the block stores the pixels as
	// they are, and the size is the only record of that.
	return packed.length < raw.length ? packed : raw;
}

/**
 * Hand build an EXR from field values rather than from an encoder.
 *
 * There is no EXR encoder in this package, so every fixture here is assembled
 * from the numbers in the specification: the header, the channel list, the
 * offset table and the compression, each written the way a writer writes it.
 */
async function buildExr(spec: ExrSpec): Promise<Uint8Array> {
	const { width, height } = spec;
	const xMin = spec.xMin ?? 0;
	const yMin = spec.yMin ?? 0;
	const compression = spec.compression ?? NONE;
	const lineOrder = spec.lineOrder ?? INCREASING_Y;
	const linesPerBlock = compression === ZIP ? 16 : 1;
	const omit = spec.omit ?? [];

	const bytes: number[] = [0x76, 0x2f, 0x31, 0x01, ...u32((spec.version ?? 2) | (spec.flags ?? 0))];

	for (const extra of spec.extras ?? [])
		bytes.push(...attribute(extra.name, extra.type, extra.bytes));
	if (!omit.includes('channels')) {
		const list = chlist(spec.channels);
		bytes.push(...attribute('channels', 'chlist', spec.rewriteChannels?.(list) ?? list));
	}
	if (!omit.includes('compression')) {
		bytes.push(...attribute('compression', 'compression', [compression]));
	}
	if (!omit.includes('dataWindow')) {
		bytes.push(
			...attribute('dataWindow', 'box2i', [
				...u32(xMin),
				...u32(yMin),
				...u32(xMin + width - 1),
				...u32(yMin + height - 1),
			]),
		);
	}
	if (!omit.includes('displayWindow')) {
		const display = spec.display ?? [xMin, yMin, xMin + width - 1, yMin + height - 1];
		bytes.push(
			...attribute(
				'displayWindow',
				'box2i',
				display.flatMap((value) => u32(value)),
			),
		);
	}
	if (!omit.includes('lineOrder')) {
		bytes.push(...attribute('lineOrder', 'lineOrder', [lineOrder]));
	}
	for (const extra of spec.trailing ?? []) {
		bytes.push(...attribute(extra.name, extra.type, extra.bytes));
	}
	bytes.push(0);

	const lines: number[][] = [];
	for (let row = 0; row < height; row += 1) {
		const line: number[] = [];
		for (const channel of spec.channels) {
			for (let x = 0; x < width; x += 1) {
				line.push(...sampleBytes(channel, channel.values[row * width + x] as number));
			}
		}
		lines.push(line);
	}

	const blocks: { y: number; data: number[] }[] = [];
	for (let start = 0; start < height; start += linesPerBlock) {
		const raw: number[] = [];
		for (let i = 0; i < Math.min(linesPerBlock, height - start); i += 1) {
			raw.push(...(lines[start + i] as number[]));
		}
		const index = blocks.length;
		const packed = await packBlock(raw, compression, spec.stored ?? false);
		blocks.push({
			y: spec.rewriteY ? spec.rewriteY(index, yMin + start) : yMin + start,
			data: spec.rewriteBlock ? spec.rewriteBlock(index, packed) : packed,
		});
	}

	// A decreasing line order writes the blocks from the bottom of the picture
	// to the top, while the offset table stays in increasing y, which is what
	// the reference writer does and what a reader must not depend on either way.
	const fileOrder = blocks.map((_, index) =>
		lineOrder === DECREASING_Y ? blocks.length - 1 - index : index,
	);
	const offsets = new Array<number>(blocks.length).fill(0);
	const body: number[] = [];
	let at = bytes.length + blocks.length * 8;
	for (const index of fileOrder) {
		const block = blocks[index] as { y: number; data: number[] };
		offsets[index] = at;
		body.push(...u32(block.y), ...u32(block.data.length), ...block.data);
		at += 8 + block.data.length;
	}

	const table = spec.rewriteOffsets ? spec.rewriteOffsets(offsets) : offsets;
	return Uint8Array.from([...bytes, ...table.flatMap((offset) => u64(offset)), ...body]);
}

/** Where an attribute's value starts in a built file, for tests that corrupt one. */
function valueOf(file: Uint8Array, name: string, type: string): number {
	const needle = [...ascii(name), 0, ...ascii(type), 0];
	for (let at = 0; at + needle.length + 4 <= file.length; at += 1) {
		let found = true;
		for (let i = 0; i < needle.length; i += 1) {
			if (file[at + i] !== needle[i]) {
				found = false;
				break;
			}
		}
		if (found) return at + needle.length + 4;
	}
	throw new Error(`the built file has no ${name} attribute`);
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/**
 * What the tone mapper makes of a given set of samples.
 *
 * The decoder's job is to get the right number into the right channel of the
 * right pixel; turning linear light into eight bits is `toneMap`'s job and is
 * tested where that lives. Expecting through it keeps these assertions about
 * the decoding rather than about the exposure, and a channel read in the wrong
 * order still fails them.
 */
function toned(
	values: readonly number[],
	width: number,
	height: number,
	channels: 3 | 4,
	clip = true,
): number[] {
	return Array.from(toneMap(Float32Array.from(values), width, height, channels, { clip }).data);
}

/** A deterministic generator, so a failing block is the same one next run. */
function noise(count: number): number[] {
	const out: number[] = [];
	let state = 0x2545f491;
	for (let i = 0; i < count; i += 1) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out.push(((state >> 16) & 0xff) / 255);
	}
	return out;
}

/* ── Reading ──────────────────────────────────────────────────────────── */

describe('decodeExr', () => {
	it('reads a one pixel FLOAT file', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'B', values: [0.75] },
				{ name: 'G', values: [0.5] },
				{ name: 'R', values: [0.25] },
			],
		});
		const image = await decodeExr(file);

		expect(image.width).toBe(1);
		expect(image.height).toBe(1);
		expect(image.colourSpace).toBe('srgb');
		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual(toned([0.25, 0.5, 0.75], 1, 1, 3));
	});

	it('puts R in red although the file stores B first', async () => {
		// The single most common way to write an EXR reader that produces a
		// plausible picture with its channels swapped, so it gets its own test:
		// the three values are far enough apart that any permutation shows.
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'B', values: [0.9] },
				{ name: 'G', values: [0.5] },
				{ name: 'R', values: [0.1] },
			],
		});
		const [red, green, blue] = pixelsOf(await decodeExr(file));

		expect(red).toBeLessThan(green as number);
		expect(green).toBeLessThan(blue as number);
	});

	it('follows the channel list rather than sorting it', async () => {
		// A file whose channel list is out of order is malformed, but its own
		// list is still the layout of its pixels, and reading it any other way
		// would be reading a file the writer never wrote.
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'R', values: [0.1] },
				{ name: 'G', values: [0.5] },
				{ name: 'B', values: [0.9] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(toned([0.1, 0.5, 0.9], 1, 1, 3));
	});

	it('reads HALF channels', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'B', type: HALF, values: [0.75, 0.25] },
				{ name: 'G', type: HALF, values: [0.5, 0.5] },
				{ name: 'R', type: HALF, values: [0.25, 0.75] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned([0.25, 0.5, 0.75, 0.75, 0.5, 0.25], 2, 1, 3),
		);
	});

	it('reads UINT channels as the numbers they are', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'B', type: UINT, values: [3, 1] },
				{ name: 'G', type: UINT, values: [2, 2] },
				{ name: 'R', type: UINT, values: [1, 3] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(toned([1, 2, 3, 3, 2, 1], 2, 1, 3, false));
	});

	it('reads a file that mixes pixel types between its channels', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'B', type: UINT, values: [1] },
				{ name: 'G', type: HALF, values: [0.5] },
				{ name: 'R', type: FLOAT, values: [0.25] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(toned([0.25, 0.5, 1], 1, 1, 3));
	});

	it('reads an alpha channel', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'A', values: [1, 0.5] },
				{ name: 'B', values: [0.5, 0.5] },
				{ name: 'G', values: [0.5, 0.5] },
				{ name: 'R', values: [0.5, 0.5] },
			],
		});
		const image = await decodeExr(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual(toned([0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5], 2, 1, 4));
	});

	it('reports an alpha channel that is opaque everywhere as opaque', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'A', values: [1, 1] },
				{ name: 'B', values: [0.5, 0.5] },
				{ name: 'G', values: [0.5, 0.5] },
				{ name: 'R', values: [0.5, 0.5] },
			],
		});

		expect((await decodeExr(file)).hasAlpha).toBe(false);
	});

	it('leaves a missing colour channel at zero rather than refusing', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'G', values: [0.5] },
				{ name: 'R', values: [0.5] },
			],
		});
		const [, , blue] = pixelsOf(await decodeExr(file));

		expect(blue).toBe(0);
	});

	it('reads a luminance only file as grey', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [{ name: 'Y', values: [0.2, 0.6] }],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels[0]).toBe(pixels[1]);
		expect(pixels[1]).toBe(pixels[2]);
		expect(pixels).toEqual(toned([0.2, 0.2, 0.2, 0.6, 0.6, 0.6], 2, 1, 3));
	});

	it('reads a luminance file with an alpha channel', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'A', values: [0.5] },
				{ name: 'Y', values: [0.4] },
			],
		});
		const image = await decodeExr(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual(toned([0.4, 0.4, 0.4, 0.5], 1, 1, 4));
	});

	it('ignores a Y channel in a file that also has colour', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'B', values: [0.9] },
				{ name: 'G', values: [0.5] },
				{ name: 'R', values: [0.1] },
				{ name: 'Y', values: [0.4] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(toned([0.1, 0.5, 0.9], 1, 1, 3));
	});

	it('skips channels it has no use for, before and after the ones it wants', async () => {
		// The skipped channels still take their room in every scanline, so a
		// reader that ignores them without stepping over them reads the next
		// channel's bytes as its own.
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'AAAmask', values: [9, 9] },
				{ name: 'B', values: [0.9, 0.9] },
				{ name: 'D', type: HALF, values: [7, 7] },
				{ name: 'G', values: [0.5, 0.5] },
				{ name: 'R', values: [0.1, 0.1] },
				{ name: 'Z', type: UINT, values: [5, 5] },
			],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(toned([0.1, 0.5, 0.9, 0.1, 0.5, 0.9], 2, 1, 3));
	});

	it('reads several rows the right way up', async () => {
		const file = await buildExr({
			width: 1,
			height: 3,
			channels: [
				{ name: 'B', values: [0.1, 0.2, 0.3] },
				{ name: 'G', values: [0.1, 0.2, 0.3] },
				{ name: 'R', values: [0.1, 0.2, 0.3] },
			],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels[0]).toBeLessThan(pixels[4] as number);
		expect(pixels[4]).toBeLessThan(pixels[8] as number);
	});

	it('reads a file handed to it as a view into a larger buffer', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'B', values: [0.75] },
				{ name: 'G', values: [0.5] },
				{ name: 'R', values: [0.25] },
			],
		});
		const padded = new Uint8Array(file.length + 24);
		padded.set(file, 16);

		expect(pixelsOf(await decodeExr(padded.subarray(16, 16 + file.length)))).toEqual(
			toned([0.25, 0.5, 0.75], 1, 1, 3),
		);
	});
});

/* ── The data window ──────────────────────────────────────────────────── */

describe('decodeExr data windows', () => {
	it('counts a window that is inclusive at both ends', async () => {
		const file = await buildExr({
			width: 4,
			height: 3,
			channels: [{ name: 'Y', values: new Array<number>(12).fill(0.5) }],
		});
		const image = await decodeExr(file);

		expect([image.width, image.height]).toEqual([4, 3]);
	});

	it('decodes a data window that does not start at the origin', async () => {
		const file = await buildExr({
			width: 2,
			height: 2,
			xMin: 17,
			yMin: 9,
			channels: [{ name: 'Y', values: [0.1, 0.2, 0.3, 0.4] }],
		});
		const image = await decodeExr(file);

		expect([image.width, image.height]).toEqual([2, 2]);
		expect(pixelsOf(image)).toEqual(
			toned([0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.4, 0.4, 0.4], 2, 2, 3),
		);
	});

	it('decodes a data window that starts at negative coordinates', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			xMin: -8,
			yMin: -4,
			channels: [{ name: 'Y', values: [0.2, 0.8] }],
		});

		expect((await decodeExr(file)).width).toBe(2);
	});

	it('reads a data window that fills its display window as it is', async () => {
		// The overwhelming majority of files, where the two windows agree and
		// there is nothing to place.
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [{ name: 'Y', values: [0.2, 0.8] }],
		});
		const image = await decodeExr(file);

		expect([image.width, image.height]).toEqual([2, 1]);
		expect(pixelsOf(image)).toEqual(toned([0.2, 0.2, 0.2, 0.8, 0.8, 0.8], 2, 1, 3));
	});
});

/* ── The display window ───────────────────────────────────────────────── */

describe('decodeExr display windows', () => {
	/** The picture with the two pixels of `crop` placed at (4, 3) of a 10 by 6 frame. */
	function framed(pixels: readonly number[]): number[] {
		const out: number[] = [];
		for (let y = 0; y < 6; y += 1) {
			for (let x = 0; x < 10; x += 1) {
				const inside = y === 3 && (x === 4 || x === 5);
				out.push(...(inside ? pixels.slice((x - 4) * 4, (x - 3) * 4) : [0, 0, 0, 255]));
			}
		}
		return out;
	}

	const cropRegion = {
		width: 2,
		height: 1,
		xMin: 4,
		yMin: 3,
		display: [0, 0, 9, 5],
		channels: [{ name: 'Y', values: [0.2, 0.8] }],
	} as const;

	it('places a crop region render inside the frame its display window names', async () => {
		// The data window is the tile that was re-rendered and the display window
		// is the shot. Returning the tile is the failure that looks like success:
		// two pixels of perfectly good picture, at the wrong size, in the wrong
		// place, and disagreeing with every other reader about both.
		const image = await decodeExr(await buildExr(cropRegion));
		const grey = toned([0.2, 0.2, 0.2, 0.8, 0.8, 0.8], 2, 1, 3);

		expect([image.width, image.height]).toEqual([10, 6]);
		expect(pixelsOf(image)).toEqual(framed(grey));
	});

	it('meters the exposure on the pixels the file has rather than on the frame', async () => {
		// The same two pixels, once alone and once inside a frame that is thirty
		// times their area. Placing before tone mapping would meter the black
		// background in with them and darken the picture in proportion to how
		// much of the frame the render covers.
		const alone = await decodeExr(
			await buildExr({ width: 2, height: 1, channels: [{ name: 'Y', values: [0.2, 0.8] }] }),
		);
		const placed = await decodeExr(await buildExr(cropRegion));

		expect(pixelsOf(placed)).toEqual(framed(pixelsOf(alone)));
	});

	it('leaves the background transparent where the file has an alpha channel', async () => {
		const file = await buildExr({
			...cropRegion,
			channels: [
				{ name: 'A', values: [1, 1] },
				{ name: 'Y', values: [0.2, 0.8] },
			],
		});
		const image = await decodeExr(file);

		expect(image.hasAlpha).toBe(true);
		expect(Array.from(image.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
		// The rendered pixels are still opaque, so the transparency is the part of
		// the frame nothing was drawn in rather than the whole picture.
		expect(image.data[(3 * 10 + 4) * 4 + 3]).toBe(255);
	});

	it('does not give a file without an alpha channel one', async () => {
		const image = await decodeExr(await buildExr(cropRegion));

		expect(image.hasAlpha).toBe(false);
		expect(image.data[3]).toBe(255);
	});

	it('crops an overscan render to its frame', async () => {
		// The other direction, and the one that needs a negative offset: the data
		// window starts above and to the left of the frame, so the pixels that
		// land in it are not the pixels it starts with.
		const values = [
			0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1, 0.05, 0.15, 0.25, 0.35,
		];
		const file = await buildExr({
			width: 4,
			height: 4,
			xMin: -1,
			yMin: -1,
			display: [0, 0, 1, 1],
			channels: [{ name: 'Y', values }],
		});
		const image = await decodeExr(file);
		const whole = pixelsOf(
			await decodeExr(await buildExr({ width: 4, height: 4, channels: [{ name: 'Y', values }] })),
		);

		expect([image.width, image.height]).toEqual([2, 2]);
		expect(pixelsOf(image)).toEqual([...whole.slice(4 * 5, 4 * 7), ...whole.slice(4 * 9, 4 * 11)]);
	});

	it('returns an empty frame for a data window that misses the display window', async () => {
		// Legal, and what an overscan render of an object that moved out of shot
		// looks like. Nothing of it is in the frame, and the frame is still the
		// picture.
		const file = await buildExr({
			width: 2,
			height: 2,
			xMin: 40,
			yMin: 40,
			display: [0, 0, 2, 1],
			channels: [{ name: 'Y', values: [0.2, 0.4, 0.6, 0.8] }],
		});
		const image = await decodeExr(file);

		expect([image.width, image.height]).toEqual([3, 2]);
		expect(pixelsOf(image)).toEqual(Array.from({ length: 6 }, () => [0, 0, 0, 255]).flat());
	});

	it('places a data window that hangs over one edge of the frame', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			xMin: -1,
			yMin: 0,
			display: [0, 0, 1, 0],
			channels: [{ name: 'Y', values: [0.2, 0.8] }],
		});
		const image = await decodeExr(file);
		const grey = toned([0.2, 0.2, 0.2, 0.8, 0.8, 0.8], 2, 1, 3);

		expect([image.width, image.height]).toEqual([2, 1]);
		expect(pixelsOf(image)).toEqual([...grey.slice(4), 0, 0, 0, 255]);
	});
});

/* ── Line order ───────────────────────────────────────────────────────── */

describe('decodeExr line order', () => {
	const rows = {
		width: 1,
		height: 3,
		channels: [{ name: 'Y', values: [0.1, 0.5, 0.9] }],
	} as const;

	it('reads a bottom to top file the same way up as a top to bottom one', async () => {
		const upwards = await decodeExr(await buildExr({ ...rows, lineOrder: DECREASING_Y }));
		const downwards = await decodeExr(await buildExr({ ...rows, lineOrder: INCREASING_Y }));

		expect(pixelsOf(upwards)).toEqual(pixelsOf(downwards));
		expect(pixelsOf(upwards)).toEqual(
			toned([0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9], 1, 3, 3),
		);
	});

	it('places blocks by the y they carry rather than by their place in the table', async () => {
		// Each block says which rows it holds, so the order of the table is not
		// something a reader has to agree with the writer about: the same
		// picture comes back out of a table listed the other way round.
		const file = await buildExr({ ...rows, rewriteOffsets: (offsets) => [...offsets].reverse() });

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned([0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9], 1, 3, 3),
		);
	});
});

/* ── Compression ──────────────────────────────────────────────────────── */

describe('decodeExr compression', () => {
	const picture = {
		width: 8,
		height: 20,
		channels: [
			{ name: 'B', type: HALF, values: noise(160) },
			{ name: 'G', type: HALF, values: noise(160).reverse() },
			{ name: 'R', type: HALF, values: noise(160) },
		],
	} as const;

	async function pixelsFor(compression: number, stored = false): Promise<number[]> {
		return pixelsOf(await decodeExr(await buildExr({ ...picture, compression, stored })));
	}

	it('reads NONE, RLE, ZIPS and ZIP to the same picture', async () => {
		const plain = await pixelsFor(NONE);

		expect(await pixelsFor(RLE)).toEqual(plain);
		expect(await pixelsFor(ZIPS)).toEqual(plain);
		expect(await pixelsFor(ZIP)).toEqual(plain);
	});

	it('reads a block that was stored raw because compressing it did not help', async () => {
		// The size is the only record that the compressor was skipped, and real
		// files hit this constantly: a row of a render with any grain in it does
		// not compress.
		const plain = await pixelsFor(NONE);

		expect(await pixelsFor(RLE, true)).toEqual(plain);
		expect(await pixelsFor(ZIP, true)).toEqual(plain);
	});

	it('reads a ZIP file whose last block is a partial one', async () => {
		// Twenty rows in blocks of sixteen leaves a block of four, and a reader
		// that expects sixteen every time reads four rows of the next file.
		const image = await decodeExr(await buildExr({ ...picture, compression: ZIP }));

		expect([image.width, image.height]).toEqual([8, 20]);
	});

	it('reads a ZIPS file one scanline at a time', async () => {
		const file = await buildExr({ ...picture, compression: ZIPS });
		const image = await decodeExr(file);

		expect(image.height).toBe(20);
	});

	it('undoes the predictor and the interleave in that order', async () => {
		// A payload where every byte differs from its neighbour, so undoing the
		// two steps the other way round produces a different picture rather than
		// the same one.
		const values = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
		const file = await buildExr({
			width: 8,
			height: 1,
			compression: ZIPS,
			channels: [{ name: 'Y', type: HALF, values }],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned(
				values.flatMap((value) => [value, value, value]),
				8,
				1,
				3,
			),
		);
	});

	it('reads a run length block of repeats', async () => {
		const file = await buildExr({
			width: 16,
			height: 1,
			compression: RLE,
			channels: [{ name: 'Y', type: HALF, values: new Array<number>(16).fill(0.5) }],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned(new Array<number>(48).fill(0.5), 16, 1, 3),
		);
	});

	it('reads a run length block of literals', async () => {
		const values = noise(16);
		const file = await buildExr({
			width: 16,
			height: 1,
			compression: RLE,
			channels: [{ name: 'Y', type: HALF, values }],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned(
				values.flatMap((value) => [value, value, value]),
				16,
				1,
				3,
			),
		);
	});

	it('reads a negative count as that many literals rather than one more', async () => {
		// The stream is written out here rather than through the helper. Four
		// pixels of HALF luminance are eight bytes, and the last of them is 0.5;
		// interleaved and predicted that is 0, six copies of 128, then 184, so
		// the runs below are: minus one meaning one literal, five meaning six
		// copies, minus one meaning one literal again.
		//
		// A reader that takes minus one as two literals swallows the next count
		// as data, reads 128 as minus 128, asks for a run of literals that is
		// not there and fails. Which is the point: the two readings are not a
		// shade apart, they are a picture and an error.
		const file = await buildExr({
			width: 4,
			height: 1,
			compression: RLE,
			channels: [{ name: 'Y', type: HALF, values: [0, 0, 0, 0.5] }],
			rewriteBlock: () => [256 - 1, 0, 5, 128, 256 - 1, 184],
		});

		expect(pixelsOf(await decodeExr(file))).toEqual(
			toned([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5], 4, 1, 3),
		);
	});
});

/* ── Tone mapping ─────────────────────────────────────────────────────── */

describe('decodeExr tone mapping', () => {
	async function greyOf(values: readonly number[], width = values.length): Promise<number[]> {
		const file = await buildExr({
			width,
			height: values.length / width,
			channels: [{ name: 'Y', values }],
		});
		return pixelsOf(await decodeExr(file));
	}

	it('meters a flat grey picture to middle grey whatever its level', async () => {
		// The exposure puts the log average at 0.18, so a picture of one value
		// lands on the same grey wherever that value was.
		expect((await greyOf([0.02, 0.02])).slice(0, 3)).toEqual([118, 118, 118]);
		expect((await greyOf([0.9, 0.9])).slice(0, 3)).toEqual([118, 118, 118]);
	});

	it('leaves a black picture black', async () => {
		expect(await greyOf([0, 0])).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
	});

	it('clips a picture that never leaves 0 to 1', async () => {
		const pixels = await greyOf([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 1]);

		expect(pixels[28]).toBe(255);
		expect(pixels[0]).toBe(90);
	});

	it('rolls the highlights off a picture that goes above 1', async () => {
		// The same picture with its brightest pixel a hair over 1. Nothing else
		// changes, so the difference in the shadows is the decision itself:
		// above 1 the file is a measurement of light rather than a finished
		// frame, and clipping it would turn every lamp into a flat white shape.
		const pixels = await greyOf([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 1.0001]);

		expect(pixels[28]).toBe(255);
		expect(pixels[0]).toBe(86);
	});

	it('keeps two highlights above 1 apart rather than clipping both to white', async () => {
		const pixels = await greyOf([0.18, 5, 20]);

		expect(pixels[4]).toBeLessThan(pixels[8] as number);
		expect(pixels[4]).toBeGreaterThan(pixels[0] as number);
	});

	it('reads a negative sample as black rather than as a wrapped value', async () => {
		const pixels = await greyOf([-4, 0.5]);

		expect(pixels.slice(0, 3)).toEqual([0, 0, 0]);
	});

	it('brings an infinity down to the brightest thing really in the picture', async () => {
		// A light divided by zero is an ordinary thing to find in a render, and
		// left alone it takes the metering with it: the log average goes to
		// infinity, the exposure goes to zero and the whole frame comes out
		// black. A NaN is no light at all rather than a bright pixel.
		const file = await buildExr({
			width: 3,
			height: 1,
			// Half bit patterns: positive infinity, a quiet NaN, and 0.5.
			channels: [{ name: 'Y', type: HALF, raw: true, values: [0x7c00, 0x7e00, 0x3800] }],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels.slice(0, 3)).toEqual(pixels.slice(8, 11));
		expect(pixels[0]).toBeGreaterThan(0);
		expect(pixels.slice(4, 7)).toEqual([0, 0, 0]);
	});

	it('stands in for an infinity in a picture with nothing else lit in it', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [{ name: 'Y', type: HALF, raw: true, values: [0x7c00, 0] }],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels[0]).toBeGreaterThan(0);
		expect(pixels.slice(4, 7)).toEqual([0, 0, 0]);
	});

	it('takes a NaN in the alpha channel as opaque rather than as a hole', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'A', type: HALF, raw: true, values: [0x7e00, 0x3800] },
				{ name: 'Y', type: HALF, values: [0.5, 0.5] },
			],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels[3]).toBe(255);
		expect(pixels[7]).toBe(128);
	});

	it('passes alpha through without tone mapping it', async () => {
		// Alpha is coverage rather than light, and exposing it would make every
		// soft edge harder or softer depending on how bright the picture was.
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'A', values: [0.5, 1] },
				{ name: 'Y', values: [0.001, 900] },
			],
		});
		const pixels = pixelsOf(await decodeExr(file));

		expect(pixels[3]).toBe(128);
		expect(pixels[7]).toBe(255);
	});
});

/* ── Colour ───────────────────────────────────────────────────────────── */

describe('decodeExr colour', () => {
	const grey = { width: 1, height: 1, channels: [{ name: 'Y', values: [0.5] }] } as const;

	function chromaticities(values: readonly number[]): AttributeSpec {
		return {
			name: 'chromaticities',
			type: 'chromaticities',
			bytes: values.flatMap((value) => f32(value)),
		};
	}

	it('takes a file with no chromaticities as sRGB', async () => {
		expect((await decodeExr(await buildExr(grey))).colourSpace).toBe('srgb');
	});

	it('takes Rec. 709 primaries as sRGB', async () => {
		const file = await buildExr({
			...grey,
			extras: [chromaticities([0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329])],
		});

		expect((await decodeExr(file)).colourSpace).toBe('srgb');
	});

	it('recognises Display P3 primaries', async () => {
		const file = await buildExr({
			...grey,
			extras: [chromaticities([0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329])],
		});

		expect((await decodeExr(file)).colourSpace).toBe('display-p3');
	});
});

/* ── Bytes from other writers ─────────────────────────────────────────── */

describe('decodeExr against files from other writers', () => {
	/**
	 * An eight by eight EXR written by ffmpeg, byte for byte. Four flat
	 * quadrants: red, green, blue and grey.
	 *
	 * Every hand built fixture above is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. This one is not. It is
	 * libavcodec's output, which the header says plainly: it carries `writer`
	 * "lavc", and a `framesPerSecond` rational that libOpenEXR's own tools never
	 * write and ffmpeg's encoder always does. That makes it an independent
	 * writer, which is what it is here for, with ZIP compression, HALF channels,
	 * the alphabetical B, G, R channel list a real writer produces and a block
	 * that is genuinely deflated rather than stored, so the predictor and the
	 * interleave are exercised against somebody else's compressor.
	 *
	 * The two fixtures after it are libOpenEXR's own output, so the suite reads
	 * bytes from both of the writers anybody is likely to be handed.
	 */
	const ffmpegExr = Uint8Array.from([
		0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c, 0x73,
		0x00, 0x63, 0x68, 0x6c, 0x69, 0x73, 0x74, 0x00, 0x37, 0x00, 0x00, 0x00, 0x42, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x47, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x52, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x63, 0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x63,
		0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03,
		0x64, 0x61, 0x74, 0x61, 0x57, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69,
		0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00,
		0x00, 0x07, 0x00, 0x00, 0x00, 0x64, 0x69, 0x73, 0x70, 0x6c, 0x61, 0x79, 0x57, 0x69, 0x6e, 0x64,
		0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x66, 0x72, 0x61,
		0x6d, 0x65, 0x73, 0x50, 0x65, 0x72, 0x53, 0x65, 0x63, 0x6f, 0x6e, 0x64, 0x00, 0x72, 0x61, 0x74,
		0x69, 0x6f, 0x6e, 0x61, 0x6c, 0x00, 0x08, 0x00, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x67, 0x61, 0x6d, 0x6d, 0x61, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00, 0x04, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x6c, 0x69, 0x6e, 0x65, 0x4f, 0x72, 0x64, 0x65, 0x72, 0x00,
		0x6c, 0x69, 0x6e, 0x65, 0x4f, 0x72, 0x64, 0x65, 0x72, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x70,
		0x69, 0x78, 0x65, 0x6c, 0x41, 0x73, 0x70, 0x65, 0x63, 0x74, 0x52, 0x61, 0x74, 0x69, 0x6f, 0x00,
		0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x73, 0x63,
		0x72, 0x65, 0x65, 0x6e, 0x57, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x43, 0x65, 0x6e, 0x74, 0x65, 0x72,
		0x00, 0x76, 0x32, 0x66, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x57, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x57, 0x69, 0x64,
		0x74, 0x68, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
		0x3f, 0x74, 0x79, 0x70, 0x65, 0x00, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67, 0x00, 0x0d, 0x00, 0x00,
		0x00, 0x73, 0x63, 0x61, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x69, 0x6d, 0x61, 0x67, 0x65, 0x77, 0x72,
		0x69, 0x74, 0x65, 0x72, 0x00, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67, 0x00, 0x04, 0x00, 0x00, 0x00,
		0x6c, 0x61, 0x76, 0x63, 0x00, 0xad, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x39, 0x00, 0x00, 0x00, 0x78, 0x5e, 0x63, 0x68, 0x68, 0x68, 0x38, 0x00, 0xc4, 0x0e, 0x40,
		0x8c, 0x0e, 0xa8, 0x25, 0x8e, 0x0c, 0x18, 0xa0, 0x98, 0x9a, 0xe2, 0x7d, 0x40, 0x5c, 0x02, 0xc4,
		0x3b, 0x80, 0xb8, 0x11, 0x88, 0x5d, 0xa9, 0x28, 0xbe, 0x13, 0x88, 0xeb, 0x81, 0xd8, 0x03, 0x2a,
		0x1e, 0x02, 0xc4, 0x6b, 0xa0, 0xf2, 0xd4, 0x10, 0x07, 0x00, 0x1c, 0xd4, 0xbb, 0xb9,
	]);

	it('reads a ZIP compressed file written by ffmpeg', async () => {
		const image = await decodeExr(ffmpegExr);
		const red = [221, 0, 0, 255];
		const green = [0, 206, 1, 255];
		const blue = [1, 0, 190, 255];
		const grey = [172, 172, 172, 255];

		const expected: number[] = [];
		for (let y = 0; y < 8; y += 1) {
			for (let x = 0; x < 8; x += 1) {
				expected.push(...(y < 4 ? (x < 4 ? red : green) : x < 4 ? blue : grey));
			}
		}

		expect([image.width, image.height]).toEqual([8, 8]);
		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual(expected);
	});

	it('rejects that file with a byte knocked out of its compressed block', async () => {
		const damaged = ffmpegExr.slice();
		damaged[damaged.length - 20] ^= 0xff;

		await expect(decodeExr(damaged)).rejects.toBeInstanceOf(DecodeFailedError);
	});

	/**
	 * A crop region render written by libOpenEXR, byte for byte: eight by six
	 * pixels of flat colour sitting at (20, 14) inside a forty by thirty frame,
	 * ZIP compressed, HALF channels.
	 *
	 * This is what a renderer writes when it is asked to re-render part of a
	 * shot, and it is the case a reader gets wrong quietly: the data window on
	 * its own is a perfectly good eight by six picture. ffprobe reports the same
	 * bytes as 40x30, and ffmpeg's decode of them puts the eight by six block at
	 * the same place this test expects it.
	 */
	const cropRegionExr = Uint8Array.from([
		0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c, 0x73,
		0x00, 0x63, 0x68, 0x6c, 0x69, 0x73, 0x74, 0x00, 0x37, 0x00, 0x00, 0x00, 0x42, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x47, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x52, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x63, 0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x63,
		0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03,
		0x64, 0x61, 0x74, 0x61, 0x57, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69,
		0x00, 0x10, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x1b, 0x00, 0x00,
		0x00, 0x13, 0x00, 0x00, 0x00, 0x64, 0x69, 0x73, 0x70, 0x6c, 0x61, 0x79, 0x57, 0x69, 0x6e, 0x64,
		0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00, 0x1d, 0x00, 0x00, 0x00, 0x6c, 0x69, 0x6e,
		0x65, 0x4f, 0x72, 0x64, 0x65, 0x72, 0x00, 0x6c, 0x69, 0x6e, 0x65, 0x4f, 0x72, 0x64, 0x65, 0x72,
		0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x70, 0x69, 0x78, 0x65, 0x6c, 0x41, 0x73, 0x70, 0x65, 0x63,
		0x74, 0x52, 0x61, 0x74, 0x69, 0x6f, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00, 0x04, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x80, 0x3f, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x57, 0x69, 0x6e, 0x64, 0x6f,
		0x77, 0x43, 0x65, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x76, 0x32, 0x66, 0x00, 0x08, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x57, 0x69,
		0x6e, 0x64, 0x6f, 0x77, 0x57, 0x69, 0x64, 0x74, 0x68, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x41, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x0e, 0x00, 0x00, 0x00, 0x1d, 0x00, 0x00, 0x00, 0x78, 0x5e, 0x4b, 0x6b, 0x40, 0x05, 0xbe,
		0x50, 0x7a, 0xf3, 0x00, 0x89, 0x57, 0x43, 0xe9, 0x16, 0x28, 0xdd, 0x09, 0xa5, 0x8b, 0x07, 0x48,
		0x1c, 0x00, 0x0a, 0xbf, 0x8f, 0xbc,
	]);

	/**
	 * An overscan render written by libOpenEXR: twenty four by eighteen pixels
	 * of data window from (-4, -3), inside a sixteen by twelve frame. ffprobe
	 * reports it as 16x12.
	 */
	const overscanExr = Uint8Array.from([
		0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c, 0x73,
		0x00, 0x63, 0x68, 0x6c, 0x69, 0x73, 0x74, 0x00, 0x37, 0x00, 0x00, 0x00, 0x42, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x47, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x52, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x63, 0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x63,
		0x6f, 0x6d, 0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03,
		0x64, 0x61, 0x74, 0x61, 0x57, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69,
		0x00, 0x10, 0x00, 0x00, 0x00, 0xfc, 0xff, 0xff, 0xff, 0xfd, 0xff, 0xff, 0xff, 0x13, 0x00, 0x00,
		0x00, 0x0e, 0x00, 0x00, 0x00, 0x64, 0x69, 0x73, 0x70, 0x6c, 0x61, 0x79, 0x57, 0x69, 0x6e, 0x64,
		0x6f, 0x77, 0x00, 0x62, 0x6f, 0x78, 0x32, 0x69, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x6c, 0x69, 0x6e,
		0x65, 0x4f, 0x72, 0x64, 0x65, 0x72, 0x00, 0x6c, 0x69, 0x6e, 0x65, 0x4f, 0x72, 0x64, 0x65, 0x72,
		0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x70, 0x69, 0x78, 0x65, 0x6c, 0x41, 0x73, 0x70, 0x65, 0x63,
		0x74, 0x52, 0x61, 0x74, 0x69, 0x6f, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00, 0x04, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x80, 0x3f, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x57, 0x69, 0x6e, 0x64, 0x6f,
		0x77, 0x43, 0x65, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x76, 0x32, 0x66, 0x00, 0x08, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x57, 0x69,
		0x6e, 0x64, 0x6f, 0x77, 0x57, 0x69, 0x64, 0x74, 0x68, 0x00, 0x66, 0x6c, 0x6f, 0x61, 0x74, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x49, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x6f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd, 0xff, 0xff, 0xff, 0x1e, 0x00, 0x00,
		0x00, 0x78, 0x5e, 0x63, 0x68, 0x18, 0x05, 0xa3, 0x60, 0x14, 0x8c, 0x82, 0x81, 0x01, 0x3b, 0xb0,
		0x88, 0x8d, 0x82, 0x51, 0x30, 0x0a, 0x46, 0x01, 0x3d, 0x00, 0x00, 0xf4, 0xb1, 0x7f, 0xf5, 0x0d,
		0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x78, 0x5e, 0x63, 0x68, 0x18, 0x5c, 0x60, 0x07, 0x16,
		0xb1, 0x81, 0x04, 0x00, 0xdd, 0x50, 0x8f, 0xb9,
	]);

	/** The same file with its display window overwritten by its data window. */
	function withoutFrame(file: Uint8Array, window: readonly number[]): Uint8Array {
		const out = file.slice();
		const view = new DataView(out.buffer);
		const at = valueOf(out, 'displayWindow', 'box2i');
		window.forEach((value, i) => view.setInt32(at + i * 4, value, true));
		return out;
	}

	it('places a libOpenEXR crop region render in its frame', async () => {
		const image = await decodeExr(cropRegionExr);
		// The same bytes with the frame taken away, which is what the pixels of
		// the data window come to on their own. Comparing against it is what
		// says the block was placed rather than resampled or shifted.
		const tile = await decodeExr(withoutFrame(cropRegionExr, [20, 14, 27, 19]));

		expect([image.width, image.height]).toEqual([40, 30]);
		expect([tile.width, tile.height]).toEqual([8, 6]);
		expect(image.hasAlpha).toBe(false);

		// Flat colour, so a block placed anywhere but here would leave black
		// where the render is and colour where it is not.
		expect(Array.from(tile.data.slice(0, 4))).not.toEqual([0, 0, 0, 255]);

		const expected: number[] = [];
		for (let y = 0; y < 30; y += 1) {
			for (let x = 0; x < 40; x += 1) {
				const inside = x >= 20 && x <= 27 && y >= 14 && y <= 19;
				const at = ((y - 14) * 8 + (x - 20)) * 4;
				expected.push(...(inside ? Array.from(tile.data.slice(at, at + 4)) : [0, 0, 0, 255]));
			}
		}
		expect(pixelsOf(image)).toEqual(expected);
	});

	it('crops a libOpenEXR overscan render to its frame', async () => {
		const image = await decodeExr(overscanExr);
		const whole = await decodeExr(withoutFrame(overscanExr, [-4, -3, 19, 14]));

		expect([image.width, image.height]).toEqual([16, 12]);
		expect([whole.width, whole.height]).toEqual([24, 18]);

		// The frame is the middle of the data window, four in and three down.
		const expected: number[] = [];
		for (let y = 0; y < 12; y += 1) {
			const from = ((y + 3) * 24 + 4) * 4;
			expected.push(...Array.from(whole.data.slice(from, from + 16 * 4)));
		}
		expect(pixelsOf(image)).toEqual(expected);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeExr refusals', () => {
	async function expectRefusal(bytes: Uint8Array, pattern: RegExp): Promise<void> {
		let thrown: unknown;
		try {
			await decodeExr(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('exr');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	const grey = { width: 2, height: 2, channels: [{ name: 'Y', values: [0.1, 0.2, 0.3, 0.4] }] };

	/* Version and flags */

	it('rejects a file that does not start with the magic number', async () => {
		const file = await buildExr(grey);
		file[2] = 0x30;
		await expectRefusal(file, /magic number/);
	});

	it.each([0, 1, 4, 7])('rejects a file cut off at %i bytes', async (length) => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, length), /magic number and version/);
	});

	it('rejects a version it does not implement', async () => {
		const file = await buildExr({ ...grey, version: 1 });
		await expectRefusal(file, /version 1/);
	});

	it('names a tiled file rather than reading its offset table as scanlines', async () => {
		const file = await buildExr({ ...grey, flags: 0x200 });
		await expectRefusal(file, /tiled/);
	});

	it('names a deep file', async () => {
		const file = await buildExr({ ...grey, flags: 0x800 });
		await expectRefusal(file, /deep pixels/);
	});

	it('names a multi-part file', async () => {
		const file = await buildExr({ ...grey, flags: 0x1000 });
		await expectRefusal(file, /multi-part/);
	});

	it.each([
		['just above the four flags', 0x100],
		['well above them', 0x2000],
		['at the top of the field', 0x80000000],
	])('rejects a version field with a reserved bit set %s', async (_where, flags) => {
		// libOpenEXR declines to open all three, because a reserved bit is the
		// next storage layout rather than spare room. Reading one as scanlines
		// would produce a plausible wrong picture, the same way reading a tiled
		// file as scanlines would.
		const file = await buildExr({ ...grey, flags });
		await expectRefusal(file, /bits the format does not define/);
	});

	it('accepts the long names flag', async () => {
		const file = await buildExr({
			...grey,
			flags: 0x400,
			extras: [{ name: 'a'.repeat(40), type: 'string', bytes: [0] }],
		});

		expect((await decodeExr(file)).width).toBe(2);
	});

	it('rejects a name longer than a file without the long names flag allows', async () => {
		const file = await buildExr({
			...grey,
			extras: [{ name: 'a'.repeat(40), type: 'string', bytes: [0] }],
		});
		await expectRefusal(file, /longer than the 31 bytes/);
	});

	/* Attributes */

	it('rejects a header whose attribute name never ends', async () => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, 12), /an attribute name/);
	});

	it('rejects a header cut off before an attribute size', async () => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, 24), /size of one of its attributes/);
	});

	it('rejects an attribute whose size runs past the end of the file', async () => {
		const file = await buildExr(grey);
		new DataView(file.buffer).setUint32(valueOf(file, 'channels', 'chlist') - 4, 0xffff, true);
		await expectRefusal(file, /end of one of its attributes/);
	});

	it('skips attributes it does not understand', async () => {
		const file = await buildExr({
			...grey,
			extras: [{ name: 'comments', type: 'string', bytes: ascii('a'.repeat(200)) }],
			trailing: [{ name: 'owner', type: 'string', bytes: ascii('nobody') }],
		});

		expect((await decodeExr(file)).width).toBe(2);
	});

	it('keeps the first of a repeated attribute', async () => {
		// The format forbids a repeat, and taking the first means a file that
		// repeats one cannot change a header a reader has already acted on.
		const file = await buildExr({
			...grey,
			trailing: [{ name: 'compression', type: 'compression', bytes: [RLE] }],
		});

		expect((await decodeExr(file)).width).toBe(2);
	});

	it.each(['channels', 'compression', 'dataWindow', 'displayWindow', 'lineOrder'])(
		'rejects a header with no %s attribute',
		async (name) => {
			const file = await buildExr({ ...grey, omit: [name] });
			await expectRefusal(file, new RegExp(`no ${name} attribute`));
		},
	);

	it('rejects an attribute that is not the type it has to be', async () => {
		const file = await buildExr({
			...grey,
			omit: ['compression'],
			extras: [{ name: 'compression', type: 'int', bytes: [NONE] }],
		});
		await expectRefusal(file, /compression attribute is not the compression/);
	});

	it('rejects an attribute that is not the size it has to be', async () => {
		const file = await buildExr({
			...grey,
			omit: ['dataWindow'],
			extras: [{ name: 'dataWindow', type: 'box2i', bytes: u32(0) }],
		});
		await expectRefusal(file, /dataWindow attribute is not the 16 bytes/);
	});

	it('rejects a chromaticities attribute that is not eight floats', async () => {
		const file = await buildExr({
			...grey,
			extras: [{ name: 'chromaticities', type: 'chromaticities', bytes: u32(0) }],
		});
		await expectRefusal(file, /chromaticities attribute/);
	});

	it('reads a file whose pixelAspectRatio says its pixels are square', async () => {
		// Every libOpenEXR file carries this attribute, almost always at 1.
		const file = await buildExr({
			...grey,
			extras: [{ name: 'pixelAspectRatio', type: 'float', bytes: f32(1) }],
		});

		expect((await decodeExr(file)).width).toBe(2);
	});

	it('names pixels that are not square rather than squeezing the picture', async () => {
		// An anamorphic render, where every pixel is twice as wide as it is
		// tall. Ignoring the attribute hands back a picture at half its width
		// with nothing on it to say so, and the Radiance reader in this package
		// refuses the same thing for the same reason.
		const file = await buildExr({
			...grey,
			extras: [{ name: 'pixelAspectRatio', type: 'float', bytes: f32(2) }],
		});
		await expectRefusal(file, /pixels are not square/);
	});

	it('refuses a pixelAspectRatio that is not a number rather than passing it', async () => {
		const file = await buildExr({
			...grey,
			extras: [{ name: 'pixelAspectRatio', type: 'float', bytes: f32(Number.NaN) }],
		});
		await expectRefusal(file, /pixels are not square/);
	});

	it('rejects a pixelAspectRatio that is not a single float', async () => {
		const file = await buildExr({
			...grey,
			extras: [{ name: 'pixelAspectRatio', type: 'float', bytes: [...f32(1), ...f32(1)] }],
		});
		await expectRefusal(file, /pixelAspectRatio attribute/);
	});

	it('names primaries it has no transform for rather than reading them as sRGB', async () => {
		// The ACES primaries, which is what an EXR out of a colour managed
		// pipeline carries. Reading those numbers as sRGB is not slightly wrong,
		// it is a colour cast over the whole picture.
		const file = await buildExr({
			...grey,
			extras: [
				{
					name: 'chromaticities',
					type: 'chromaticities',
					bytes: [0.7347, 0.2653, 0.0, 1.0, 0.0001, -0.077, 0.32168, 0.33767].flatMap((value) =>
						f32(value),
					),
				},
			],
		});
		await expectRefusal(file, /colour primaries/);
	});

	/* Channels */

	it('rejects an empty channel list', async () => {
		const file = await buildExr({ width: 1, height: 1, channels: [] });
		await expectRefusal(file, /channel list is empty/);
	});

	it('rejects a channel list that ends inside a channel description', async () => {
		const file = await buildExr({ ...grey, rewriteChannels: (list) => list.slice(0, 10) });
		await expectRefusal(file, /inside a channel description/);
	});

	it('rejects a channel name that never ends inside the list', async () => {
		const file = await buildExr({ ...grey, rewriteChannels: (list) => list.slice(0, 1) });
		await expectRefusal(file, /a channel name/);
	});

	it('rejects a channel list with no terminator on the end', async () => {
		const file = await buildExr({ ...grey, rewriteChannels: (list) => list.slice(0, -1) });
		await expectRefusal(file, /a channel name/);
	});

	it('rejects a pixel type that does not exist', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [{ name: 'Y', type: 3, values: [1] }],
		});
		await expectRefusal(file, /pixel type 3/);
	});

	it('names subsampling rather than reading a short scanline', async () => {
		const file = await buildExr({
			width: 2,
			height: 1,
			channels: [
				{ name: 'B', values: [1, 1] },
				{ name: 'G', values: [1, 1], xSampling: 2 },
				{ name: 'R', values: [1, 1] },
			],
		});
		await expectRefusal(file, /subsamples/);
	});

	it('names the luminance and chroma layout by its channels', async () => {
		// The shape `RgbaOutputFile` writes for WRITE_YCA, which is the only way
		// anybody produces one of these: Y at full resolution and the two chroma
		// channels at half in both directions. Since the layout is refused before
		// a pixel is read, the samples below are written at full resolution,
		// which is not what a real writer stores.
		//
		// Naming the subsampling instead would be true and useless. The layout is
		// the thing whoever exported the file chose and can choose differently.
		const file = await buildExr({
			width: 2,
			height: 2,
			channels: [
				{ name: 'BY', values: [0.1, 0.1, 0.1, 0.1], xSampling: 2, ySampling: 2 },
				{ name: 'RY', values: [0.2, 0.2, 0.2, 0.2], xSampling: 2, ySampling: 2 },
				{ name: 'Y', values: [0.5, 0.5, 0.5, 0.5] },
			],
		});
		await expectRefusal(file, /luminance and chroma/);
	});

	it('rejects a file with no channel it can make a picture from', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [{ name: 'Z', values: [1] }],
		});
		await expectRefusal(file, /no R, G, B or Y channel/);
	});

	it('names layered channels rather than choosing a layer', async () => {
		const file = await buildExr({
			width: 1,
			height: 1,
			channels: [
				{ name: 'diffuse.B', values: [1] },
				{ name: 'diffuse.G', values: [1] },
				{ name: 'diffuse.R', values: [1] },
			],
		});
		await expectRefusal(file, /named layers/);
	});

	/* Windows and sizes */

	it('rejects a data window that ends before it begins', async () => {
		const file = await buildExr(grey);
		new DataView(file.buffer).setInt32(valueOf(file, 'dataWindow', 'box2i') + 8, -5, true);
		await expectRefusal(file, /ends before it begins/);
	});

	it('rejects a data window whose rows end before they begin', async () => {
		const file = await buildExr(grey);
		new DataView(file.buffer).setInt32(valueOf(file, 'dataWindow', 'box2i') + 12, -5, true);
		await expectRefusal(file, /ends before it begins/);
	});

	it('refuses an enormous data window before allocating for it', async () => {
		const file = await buildExr(grey);
		const at = valueOf(file, 'dataWindow', 'box2i');
		const view = new DataView(file.buffer);
		view.setInt32(at + 8, 59999, true);
		view.setInt32(at + 12, 59999, true);
		await expectRefusal(file, /data window describes an image far larger/);
	});

	it('rejects a display window that ends before it begins', async () => {
		const file = await buildExr({ ...grey, display: [0, 0, -5, 1] });
		await expectRefusal(file, /display window ends before it begins/);
	});

	it('refuses an enormous display window before allocating for it', async () => {
		// Two pixels of data inside a frame of sixty thousand square. The data
		// window is what the file spends its bytes on and the display window is
		// what gets allocated, so checking only the first checks the wrong one.
		const file = await buildExr({ ...grey, display: [0, 0, 59999, 59999] });
		await expectRefusal(file, /display window describes an image far larger/);
	});

	/* Compression and line order */

	it.each([
		[4, /PIZ/],
		[5, /PXR24/],
		[6, /B44/],
		[7, /B44A/],
		[8, /DWAA/],
		[9, /DWAB/],
	])('names compression method %i rather than half implementing it', async (method, pattern) => {
		const file = await buildExr(grey);
		file[valueOf(file, 'compression', 'compression')] = method;
		await expectRefusal(file, pattern);
	});

	it('reports a compression method it has never heard of by number', async () => {
		const file = await buildExr(grey);
		file[valueOf(file, 'compression', 'compression')] = 42;
		await expectRefusal(file, /compression method 42/);
	});

	it('names random line order rather than guessing at the rows', async () => {
		const file = await buildExr({ ...grey, lineOrder: 2 });
		await expectRefusal(file, /no particular order/);
	});

	it('rejects a line order that does not exist', async () => {
		const file = await buildExr({ ...grey, lineOrder: 7 });
		await expectRefusal(file, /line order 7/);
	});

	/* The offset table and the blocks */

	it('rejects a file cut off inside its offset table', async () => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, file.length - 40), /offset table/);
	});

	it('rejects an offset table claiming more blocks than the file could hold', async () => {
		const file = await buildExr({
			width: 1,
			height: 4000,
			channels: [{ name: 'Y', values: new Array<number>(4000).fill(0.5) }],
		});
		// The table itself is present, but the blocks it points at cannot be:
		// every one of them costs at least its own eight byte header.
		await expectRefusal(file.subarray(0, 8 + 4000 * 8 + 200), /more scanline blocks/);
	});

	it('rejects an offset that points past the end of the file', async () => {
		const file = await buildExr({ ...grey, rewriteOffsets: (offsets) => offsets.map(() => 1e9) });
		await expectRefusal(file, /start of one of its scanline blocks/);
	});

	it('rejects a file cut off inside a block header', async () => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, file.length - 24), /scanline block/);
	});

	it('rejects a file cut off inside a block', async () => {
		const file = await buildExr(grey);
		await expectRefusal(file.subarray(0, file.length - 4), /end of one of its scanline blocks/);
	});

	it('rejects a block whose y is outside the data window', async () => {
		const file = await buildExr({ ...grey, rewriteY: () => 900 });
		await expectRefusal(file, /outside the data window/);
	});

	it('rejects a block that starts partway through the block grid', async () => {
		const file = await buildExr({
			width: 1,
			height: 20,
			compression: ZIP,
			channels: [{ name: 'Y', values: new Array<number>(20).fill(0.5) }],
			rewriteY: (index, y) => (index === 1 ? y - 1 : y),
		});
		await expectRefusal(file, /partway through/);
	});

	it('rejects two blocks that claim the same rows', async () => {
		const file = await buildExr({ ...grey, rewriteY: () => 0 });
		await expectRefusal(file, /same rows/);
	});

	it('rejects a block holding more bytes than its scanlines can take', async () => {
		const file = await buildExr({ ...grey, rewriteBlock: (_index, data) => [...data, 0] });
		await expectRefusal(file, /more bytes than the scanlines/);
	});

	it('rejects an uncompressed block that is short of its scanlines', async () => {
		const file = await buildExr({ ...grey, rewriteBlock: (_index, data) => data.slice(0, -1) });
		await expectRefusal(file, /shorter than its scanlines/);
	});

	/**
	 * A row long enough that a damaged block is smaller than the row it claims
	 * to hold, so the size check does not turn every one of these into the same
	 * refusal before the block is ever unpacked.
	 */
	const wide = {
		width: 32,
		height: 1,
		channels: [{ name: 'Y', values: new Array<number>(32).fill(0.5) }],
	};

	it('rejects a ZIP block that is not deflate data at all', async () => {
		const file = await buildExr({
			...wide,
			compression: ZIPS,
			rewriteBlock: () => [1, 2, 3, 4],
		});
		await expectRefusal(file, /could not be decompressed/);
	});

	it('rejects a ZIP block that unpacks short of its scanlines', async () => {
		const short = Array.from(await deflate(Uint8Array.from([1, 2, 3, 4])));
		const file = await buildExr({ ...wide, compression: ZIPS, rewriteBlock: () => short });
		await expectRefusal(file, /fewer bytes than its scanlines need/);
	});

	it('stops inflating a ZIP block the moment it outgrows its scanlines', async () => {
		// A decompression bomb, which is a real thing to be handed rather than a
		// theoretical one: deflate is about a thousand to one on zeroes, so a
		// four kilobyte block declares four megabytes here and the same trick at
		// file scale reaches tens of gigabytes. The number of bytes the block can
		// hold is known before a single one is inflated, and the refusal has to
		// come from that rather than from a length compared afterwards. Compared
		// afterwards, this file allocates the whole four megabytes first, and the
		// version of it somebody would actually send takes the tab with it.
		//
		// Four thousand and ninety six pixels of HALF luminance is 8192 bytes,
		// which leaves room for the compressed bomb to be the smaller of the two
		// and so reach the decompressor at all.
		const bomb = Array.from(await deflate(new Uint8Array(4_000_000)));
		const file = await buildExr({
			width: 4096,
			height: 1,
			compression: ZIPS,
			channels: [{ name: 'Y', type: HALF, values: new Array<number>(4096).fill(0.5) }],
			rewriteBlock: () => bomb,
		});

		expect(bomb.length).toBeLessThan(4096 * 2);
		await expectRefusal(file, /more bytes than its scanlines hold/);
	});

	it('rejects a run length block that ends inside a run of literals', async () => {
		const file = await buildExr({ ...wide, compression: RLE, rewriteBlock: () => [256 - 8, 1, 2] });
		await expectRefusal(file, /inside a run of literal bytes/);
	});

	it('rejects a run length block that ends before the byte it repeats', async () => {
		const file = await buildExr({ ...wide, compression: RLE, rewriteBlock: () => [4] });
		await expectRefusal(file, /before the byte it repeats/);
	});

	it('rejects a run length block whose repeats overrun its scanlines', async () => {
		const file = await buildExr({
			...wide,
			compression: RLE,
			rewriteBlock: () => [127, 0, 127, 0],
		});
		await expectRefusal(file, /more bytes than its scanlines/);
	});

	it('rejects a run length block whose literals overrun its scanlines', async () => {
		// The repeats fill the row exactly, and the literal run after them has
		// nowhere left to go.
		const file = await buildExr({
			...wide,
			compression: RLE,
			rewriteBlock: () => [127, 0, 256 - 1, 5],
		});
		await expectRefusal(file, /more bytes than its scanlines/);
	});

	it('rejects a run length block that unpacks to fewer bytes than its scanlines need', async () => {
		const file = await buildExr({ ...wide, compression: RLE, rewriteBlock: () => [0, 7] });
		await expectRefusal(file, /fewer bytes/);
	});

	it('reports a browser with no DecompressionStream as a platform problem', async () => {
		// The file is fine and we are not, which is a different error with a
		// different message, and turning it into "this file is damaged" would
		// send somebody looking for a fault in their own picture.
		const file = await buildExr({ ...wide, compression: ZIPS });
		vi.stubGlobal('DecompressionStream', undefined);
		try {
			await expect(decodeExr(file)).rejects.toBeInstanceOf(CodecUnavailableError);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
