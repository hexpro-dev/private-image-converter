import { describe, expect, it } from 'vitest';

import { decodeDds } from '../../src/codecs/dds/decode.js';
import { DecodeFailedError } from '../../src/errors.js';
import type { RasterImage } from '../../src/types.js';

/* ── Building files ───────────────────────────────────────────────────── */

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_YUV = 0x200;
const DDPF_LUMINANCE = 0x20000;
const DDPF_BUMPDUDV = 0x80000;

const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_VOLUME = 0x200000;

/** 'DDS ' plus the 124 byte DDS_HEADER. */
const HEADER_TOTAL = 128;
const DX10_HEADER_BYTES = 20;

interface Dx10Spec {
	readonly format: number;
	readonly dimension?: number;
	readonly miscFlag?: number;
	readonly arraySize?: number;
	readonly miscFlags2?: number;
}

interface DdsSpec {
	readonly width: number;
	readonly height: number;
	readonly pixelFlags: number;
	readonly fourCC?: string;
	/** A raw fourCC word, for the files that put a D3D format number there. */
	readonly fourCcWord?: number;
	readonly bitCount?: number;
	/** Red, green, blue and alpha masks, in that order. */
	readonly masks?: readonly [number, number, number, number];
	readonly headerSize?: number;
	readonly pixelFormatSize?: number;
	readonly pitch?: number;
	readonly depth?: number;
	readonly mipMapCount?: number;
	readonly caps2?: number;
	readonly dx10?: Dx10Spec;
	readonly data: readonly number[];
}

/**
 * Hand build a DDS from field values rather than from a writer.
 *
 * Every decoder fixture here is assembled from the numbers in the
 * specification, because the point is to read files this package did not
 * produce. The three at the bottom of this file, which ImageMagick wrote, are
 * the check that the specification was read the same way somebody else read it.
 */
function buildDds(spec: DdsSpec): Uint8Array {
	const extension = spec.dx10 ? DX10_HEADER_BYTES : 0;
	const out = new Uint8Array(HEADER_TOTAL + extension + spec.data.length);
	const view = new DataView(out.buffer);

	out.set([0x44, 0x44, 0x53, 0x20], 0);
	view.setUint32(4, spec.headerSize ?? 124, true);
	// DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT.
	view.setUint32(8, 0x1007, true);
	view.setUint32(12, spec.height, true);
	view.setUint32(16, spec.width, true);
	view.setUint32(20, spec.pitch ?? 0, true);
	view.setUint32(24, spec.depth ?? 0, true);
	view.setUint32(28, spec.mipMapCount ?? 1, true);
	view.setUint32(76, spec.pixelFormatSize ?? 32, true);
	view.setUint32(80, spec.pixelFlags, true);
	if (spec.fourCC !== undefined) {
		for (let i = 0; i < 4; i += 1) out[84 + i] = spec.fourCC.charCodeAt(i);
	} else if (spec.fourCcWord !== undefined) {
		view.setUint32(84, spec.fourCcWord, true);
	}
	view.setUint32(88, spec.bitCount ?? 0, true);
	if (spec.masks) spec.masks.forEach((mask, i) => view.setUint32(92 + i * 4, mask, true));
	// DDSCAPS_TEXTURE, which every DDS sets.
	view.setUint32(108, 0x1000, true);
	view.setUint32(112, spec.caps2 ?? 0, true);

	if (spec.dx10) {
		view.setUint32(128, spec.dx10.format, true);
		view.setUint32(132, spec.dx10.dimension ?? 3, true);
		view.setUint32(136, spec.dx10.miscFlag ?? 0, true);
		view.setUint32(140, spec.dx10.arraySize ?? 1, true);
		view.setUint32(144, spec.dx10.miscFlags2 ?? 0, true);
	}

	out.set(spec.data, HEADER_TOTAL + extension);
	return out;
}

/** Eight bit RGB packed into the 565 word a colour block stores. */
function rgb565(r: number, g: number, b: number): number {
	return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** Two 565 endpoints and sixteen two bit indices, little endian throughout. */
function colourBlock(c0: number, c1: number, indices: readonly number[]): number[] {
	let packed = 0;
	indices.forEach((index, i) => {
		packed |= (index & 3) << (i * 2);
	});
	return [
		c0 & 0xff,
		c0 >> 8,
		c1 & 0xff,
		c1 >> 8,
		packed & 0xff,
		(packed >>> 8) & 0xff,
		(packed >>> 16) & 0xff,
		(packed >>> 24) & 0xff,
	];
}

/** A block of one solid colour, for fixtures where only the position matters. */
function solidBlock(r: number, g: number, b: number): number[] {
	return colourBlock(rgb565(r, g, b), 0, new Array<number>(16).fill(0));
}

/** BC2's alpha: sixteen four bit values, two to a byte, earlier one low. */
function nibbleAlphaBlock(values: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < 16; i += 2) {
		out.push(((values[i] as number) & 0x0f) | (((values[i + 1] as number) & 0x0f) << 4));
	}
	return out;
}

/** The BC4 style block BC3, BC4 and BC5 all use: two endpoints, three bit indices. */
function ladderBlock(first: number, second: number, indices: readonly number[]): number[] {
	let low = 0;
	let high = 0;
	for (let i = 0; i < 8; i += 1) low |= ((indices[i] as number) & 7) << (i * 3);
	for (let i = 8; i < 16; i += 1) high |= ((indices[i] as number) & 7) << ((i - 8) * 3);
	return [
		first & 0xff,
		second & 0xff,
		low & 0xff,
		(low >>> 8) & 0xff,
		(low >>> 16) & 0xff,
		high & 0xff,
		(high >>> 8) & 0xff,
		(high >>> 16) & 0xff,
	];
}

const RUNG = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
const QUARTERS = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

function texel(image: RasterImage, x: number, y: number): number[] {
	const at = (y * image.width + x) * 4;
	return Array.from(image.data.subarray(at, at + 4));
}

/** One channel of every texel in row order, for the single channel layouts. */
function channelOf(image: RasterImage, offset: number): number[] {
	const out: number[] = [];
	for (let i = offset; i < image.data.length; i += 4) out.push(image.data[i] as number);
	return out;
}

/* ── BC1 ──────────────────────────────────────────────────────────────── */

describe('decodeDds on BC1', () => {
	it('interpolates four colours when the first endpoint is the larger', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0xffff, 0x0000, QUARTERS),
		});
		const image = decodeDds(file);

		expect(image.width).toBe(4);
		expect(image.height).toBe(4);
		expect(image.colourSpace).toBe('srgb');
		// White, black, then two thirds and one third of the way between them.
		expect(texel(image, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(texel(image, 1, 0)).toEqual([0, 0, 0, 255]);
		expect(texel(image, 2, 0)).toEqual([170, 170, 170, 255]);
		expect(texel(image, 3, 0)).toEqual([85, 85, 85, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('truncates a four colour interpolation rather than rounding it', () => {
		// Endpoints (0, 4, 41) and black. Two thirds of the way is 2.67 and 27.33,
		// one third is 1.33 and 13.67, and every decoder in circulation truncates.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0x0025, 0x0000, QUARTERS),
		});
		const image = decodeDds(file);

		expect(texel(image, 0, 0)).toEqual([0, 4, 41, 255]);
		expect(texel(image, 2, 0)).toEqual([0, 2, 27, 255]);
		expect(texel(image, 3, 0)).toEqual([0, 1, 13, 255]);
	});

	it('switches to three colours and a hole when the endpoints are the other way round', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(rgb565(0, 0, 255), rgb565(255, 0, 0), QUARTERS),
		});
		const image = decodeDds(file);

		expect(texel(image, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(texel(image, 1, 0)).toEqual([255, 0, 0, 255]);
		// The midpoint, not a two thirds interpolation.
		expect(texel(image, 2, 0)).toEqual([127, 0, 127, 255]);
		// The fourth entry is a hole: transparent, and black rather than blended.
		expect(texel(image, 3, 0)).toEqual([0, 0, 0, 0]);
		expect(image.hasAlpha).toBe(true);
	});

	it('truncates the midpoint of a three colour block', () => {
		// Five bits of red expand to 16 and 33, whose midpoint is 24.5.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(2 << 11, 4 << 11, QUARTERS),
		});

		expect(texel(decodeDds(file), 2, 0)).toEqual([24, 0, 0, 255]);
	});

	it('reads the punch through alpha even when the file declares no alpha channel', () => {
		// DDPF_ALPHAPIXELS is not set here, and it makes no difference: a DXT1
		// surface always carries the one bit alpha, and a reader that gated it on
		// the flag would fill every cut out with black.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(rgb565(0, 0, 255), rgb565(255, 0, 0), QUARTERS),
		});

		expect(decodeDds(file).hasAlpha).toBe(true);
	});

	it('repeats the top bits when widening 565, so a full channel reaches 255', () => {
		const flat = new Array<number>(16).fill(0);
		const file = buildDds({
			width: 8,
			height: 8,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: [
				...colourBlock(0xf800, 0x0000, flat),
				...colourBlock(0x07e0, 0x0000, flat),
				...colourBlock(0x001f, 0x0000, flat),
				...colourBlock(0xffff, 0x0000, flat),
			],
		});
		const image = decodeDds(file);

		// A shift alone would give 248 for five bits and 252 for six.
		expect(texel(image, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(texel(image, 4, 0)).toEqual([0, 255, 0, 255]);
		expect(texel(image, 0, 4)).toEqual([0, 0, 255, 255]);
		expect(texel(image, 4, 4)).toEqual([255, 255, 255, 255]);
	});

	it('reads the sixteen indices in row order, the first texel in the lowest bits', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0xffff, 0x0000, [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]),
		});
		const image = decodeDds(file);

		expect(channelOf(image, 0)).toEqual([
			255, 255, 255, 255, 0, 0, 0, 0, 170, 170, 170, 170, 85, 85, 85, 85,
		]);
	});

	it('lays blocks out left to right and then top to bottom', () => {
		const file = buildDds({
			width: 8,
			height: 8,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: [
				...solidBlock(255, 0, 0),
				...solidBlock(0, 255, 0),
				...solidBlock(0, 0, 255),
				...solidBlock(255, 255, 255),
			],
		});
		const image = decodeDds(file);

		expect(texel(image, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(texel(image, 4, 0)).toEqual([0, 255, 0, 255]);
		expect(texel(image, 0, 4)).toEqual([0, 0, 255, 255]);
		expect(texel(image, 4, 4)).toEqual([255, 255, 255, 255]);
	});

	it('crops the blocks that hang over the edge of a size that is not a multiple of four', () => {
		const file = buildDds({
			width: 6,
			height: 5,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: [
				...solidBlock(255, 0, 0),
				...solidBlock(0, 255, 0),
				...solidBlock(0, 0, 255),
				...solidBlock(255, 255, 255),
			],
		});
		const image = decodeDds(file);

		expect(image.width).toBe(6);
		expect(image.height).toBe(5);
		expect(texel(image, 3, 3)).toEqual([255, 0, 0, 255]);
		// Only two columns of the second block and one row of the third survive.
		expect(texel(image, 5, 3)).toEqual([0, 255, 0, 255]);
		expect(texel(image, 3, 4)).toEqual([0, 0, 255, 255]);
		expect(texel(image, 5, 4)).toEqual([255, 255, 255, 255]);
	});

	it('reads a one pixel image, where fifteen texels of the block are discarded', () => {
		const file = buildDds({
			width: 1,
			height: 1,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(rgb565(255, 0, 0), 0, QUARTERS),
		});
		const image = decodeDds(file);

		expect(image.width).toBe(1);
		expect(image.height).toBe(1);
		expect(pixelsOf(image)).toEqual([255, 0, 0, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0xffff, 0x0000, QUARTERS),
		});
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(texel(decodeDds(padded.subarray(8, 8 + file.length)), 2, 0)).toEqual([
			170, 170, 170, 255,
		]);
	});
});

/* ── BC2 ──────────────────────────────────────────────────────────────── */

describe('decodeDds on BC2', () => {
	const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

	it('reads four bits of alpha a texel, the earlier one in the low nibble', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT3',
			data: [
				...nibbleAlphaBlock(values),
				...colourBlock(0xffff, 0x0000, new Array<number>(16).fill(0)),
			],
		});
		const image = decodeDds(file);

		// A nibble is widened by repetition, so 15 lands on 255 rather than 240.
		expect(channelOf(image, 3)).toEqual(values.map((value) => (value << 4) | value));
		expect(image.hasAlpha).toBe(true);
	});

	it('reads the colour block as four colours whatever order its endpoints are in', () => {
		// The same endpoints that give BC1 a transparent fourth entry. Inside BC2
		// the alpha lives in its own block, so the fourth entry is a real colour
		// and a reader that punched a hole here would perforate the texture.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT3',
			data: [
				...nibbleAlphaBlock(new Array<number>(16).fill(15)),
				...colourBlock(rgb565(0, 0, 255), rgb565(255, 0, 0), QUARTERS),
			],
		});
		const image = decodeDds(file);

		expect(texel(image, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(texel(image, 1, 0)).toEqual([255, 0, 0, 255]);
		expect(texel(image, 2, 0)).toEqual([85, 0, 170, 255]);
		expect(texel(image, 3, 0)).toEqual([170, 0, 85, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('reads DXT2 as DXT3 with the colour already multiplied by the alpha', () => {
		const data = [
			...nibbleAlphaBlock([15, 5, 10, 0, ...new Array<number>(12).fill(15)]),
			...colourBlock(0xffff, 0x0000, [0, 3, 2, 1, ...new Array<number>(12).fill(0)]),
		];
		const straight = decodeDds(
			buildDds({ width: 4, height: 4, pixelFlags: DDPF_FOURCC, fourCC: 'DXT3', data }),
		);
		const premultiplied = decodeDds(
			buildDds({ width: 4, height: 4, pixelFlags: DDPF_FOURCC, fourCC: 'DXT2', data }),
		);

		expect(texel(straight, 1, 0)).toEqual([85, 85, 85, 85]);
		expect(texel(straight, 2, 0)).toEqual([170, 170, 170, 170]);
		expect(texel(straight, 3, 0)).toEqual([0, 0, 0, 0]);

		// Dividing the colour back out by its own coverage restores full white.
		expect(texel(premultiplied, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(texel(premultiplied, 1, 0)).toEqual([255, 255, 255, 85]);
		expect(texel(premultiplied, 2, 0)).toEqual([255, 255, 255, 170]);
		// Nothing survives division by no coverage at all.
		expect(texel(premultiplied, 3, 0)).toEqual([0, 0, 0, 0]);
	});

	it('caps a premultiplied colour that is brighter than its own coverage', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT2',
			data: [
				...nibbleAlphaBlock(new Array<number>(16).fill(1)),
				...colourBlock(0xffff, 0x0000, new Array<number>(16).fill(0)),
			],
		});

		// White at an alpha of 17 is not a valid premultiplied pixel, and files
		// like it exist. It clamps rather than wrapping round to something dark.
		expect(texel(decodeDds(file), 0, 0)).toEqual([255, 255, 255, 17]);
	});
});

/* ── BC3 ──────────────────────────────────────────────────────────────── */

describe('decodeDds on BC3', () => {
	function dxt5(first: number, second: number, indices: readonly number[]): Uint8Array {
		return buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT5',
			data: [...ladderBlock(first, second, indices), ...colourBlock(0xffff, 0x0000, QUARTERS)],
		});
	}

	it('builds six interpolated alphas when the first endpoint is the larger', () => {
		const image = decodeDds(dxt5(200, 10, RUNG));

		expect(channelOf(image, 3).slice(0, 8)).toEqual([200, 10, 172, 145, 118, 91, 64, 37]);
	});

	it('builds four interpolated alphas plus fully clear and fully opaque otherwise', () => {
		const image = decodeDds(dxt5(10, 200, RUNG));

		// The classic mistake is reading this as six interpolated values, which
		// gives an alpha channel that never reaches either extreme.
		expect(channelOf(image, 3).slice(0, 8)).toEqual([10, 200, 48, 86, 124, 162, 0, 255]);
	});

	it('reads three bit alpha indices from both halves of the six byte run', () => {
		const image = decodeDds(dxt5(200, 10, [7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7]));

		expect(channelOf(image, 3)).toEqual([
			37, 64, 91, 118, 145, 172, 10, 200, 200, 10, 172, 145, 118, 91, 64, 37,
		]);
	});

	it('reads its colour block as four colours whatever order the endpoints are in', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT5',
			data: [
				...ladderBlock(255, 255, new Array<number>(16).fill(0)),
				...colourBlock(rgb565(0, 0, 255), rgb565(255, 0, 0), QUARTERS),
			],
		});
		const image = decodeDds(file);

		expect(texel(image, 3, 0)).toEqual([170, 0, 85, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('reads DXT4 as DXT5 with the colour already multiplied by the alpha', () => {
		const data = [
			...ladderBlock(255, 0, [0, 1, ...new Array<number>(14).fill(0)]),
			...colourBlock(0xffff, 0x0000, new Array<number>(16).fill(0)),
		];
		const straight = decodeDds(
			buildDds({ width: 4, height: 4, pixelFlags: DDPF_FOURCC, fourCC: 'DXT5', data }),
		);
		const premultiplied = decodeDds(
			buildDds({ width: 4, height: 4, pixelFlags: DDPF_FOURCC, fourCC: 'DXT4', data }),
		);

		expect(texel(straight, 1, 0)).toEqual([255, 255, 255, 0]);
		expect(texel(premultiplied, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(texel(premultiplied, 1, 0)).toEqual([0, 0, 0, 0]);
	});
});

/* ── BC4 ──────────────────────────────────────────────────────────────── */

describe('decodeDds on BC4', () => {
	function single(tag: string, first: number, second: number): Uint8Array {
		return buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: tag,
			data: ladderBlock(first, second, RUNG),
		});
	}

	it.each(['ATI1', 'BC4U'])('reads %s as one interpolated channel shown as grey', (tag) => {
		const image = decodeDds(single(tag, 200, 10));

		expect(channelOf(image, 0).slice(0, 8)).toEqual([200, 10, 172, 145, 118, 91, 64, 37]);
		expect(texel(image, 2, 0)).toEqual([172, 172, 172, 255]);
		// One channel and no coverage: a BC4 surface is opaque by construction.
		expect(image.hasAlpha).toBe(false);
	});

	it('uses the four value ladder when the endpoints are the other way round', () => {
		const image = decodeDds(single('ATI1', 10, 200));

		expect(channelOf(image, 0).slice(0, 8)).toEqual([10, 200, 48, 86, 124, 162, 0, 255]);
	});

	it('reads BC4S endpoints as signed and puts zero in the middle of the range', () => {
		// Stored 0 and 64, so the ladder runs between them and the two extremes
		// are -1 and 1 rather than 0 and 255.
		const image = decodeDds(single('BC4S', 0x00, 0x40));

		expect(channelOf(image, 0).slice(0, 8)).toEqual([128, 192, 140, 153, 166, 179, 0, 255]);
	});

	it.each([
		[0x80, 0x7f, [0, 255]],
		[0x7f, 0x80, [255, 0]],
	])(
		'reads the second spelling of -1 as the first, at either endpoint (%i, %i)',
		(first, second, expected) => {
			// SNORM has two bit patterns for -1 and uses only one of them. Left
			// alone, -128 would put the whole ladder half a step out, and the two
			// endpoints take separate paths through the reader.
			const image = decodeDds(single('BC4S', first, second));

			expect(channelOf(image, 0).slice(0, 2)).toEqual(expected);
		},
	);
});

/* ── BC5 ──────────────────────────────────────────────────────────────── */

describe('decodeDds on BC5', () => {
	function twoChannel(tag: string): Uint8Array {
		return buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: tag,
			data: [...ladderBlock(200, 10, RUNG), ...ladderBlock(30, 220, RUNG)],
		});
	}

	it.each(['ATI2', 'BC5U'])(
		'reads %s as red from the first block and green from the second',
		(tag) => {
			const image = decodeDds(twoChannel(tag));

			expect(channelOf(image, 0).slice(0, 8)).toEqual([200, 10, 172, 145, 118, 91, 64, 37]);
			expect(channelOf(image, 1).slice(0, 8)).toEqual([30, 220, 68, 106, 144, 182, 0, 255]);
		},
	);

	it('leaves blue at zero rather than reconstructing a normal from the other two', () => {
		const image = decodeDds(twoChannel('ATI2'));

		expect(channelOf(image, 2)).toEqual(new Array<number>(16).fill(0));
		expect(channelOf(image, 3)).toEqual(new Array<number>(16).fill(255));
		expect(image.hasAlpha).toBe(false);
	});

	it('reads BC5S as two signed channels', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'BC5S',
			data: [...ladderBlock(0x7f, 0x81, RUNG), ...ladderBlock(0x00, 0x40, RUNG)],
		});
		const image = decodeDds(file);

		expect(channelOf(image, 0).slice(0, 8)).toEqual([255, 0, 218, 182, 146, 108, 72, 36]);
		expect(channelOf(image, 1).slice(0, 8)).toEqual([128, 192, 140, 153, 166, 179, 0, 255]);
	});
});

/* ── Uncompressed surfaces ────────────────────────────────────────────── */

describe('decodeDds on uncompressed surfaces', () => {
	it('reads 32 bit A8R8G8B8', () => {
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
			bitCount: 32,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
			data: [30, 20, 10, 128, 60, 50, 40, 255],
		});
		const image = decodeDds(file);

		expect(pixelsOf(image)).toEqual([10, 20, 30, 128, 40, 50, 60, 255]);
		expect(image.hasAlpha).toBe(true);
	});

	it('ignores the fourth byte of X8R8G8B8, which the file did not call alpha', () => {
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_RGB,
			bitCount: 32,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
			data: [30, 20, 10, 0, 60, 50, 40, 0],
		});
		const image = decodeDds(file);

		expect(pixelsOf(image)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('honours a declared alpha mask whose bits are all clear', () => {
		// The other half of the rule above. DDS names its alpha rather than
		// leaving a reader to guess, so an image that is transparent everywhere
		// survives being read.
		const file = buildDds({
			width: 1,
			height: 1,
			pixelFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
			bitCount: 32,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
			data: [30, 20, 10, 0],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([10, 20, 30, 0]);
	});

	it('reads 32 bit A8B8G8R8, where the masks run the other way', () => {
		const file = buildDds({
			width: 1,
			height: 1,
			pixelFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
			bitCount: 32,
			masks: [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000],
			data: [10, 20, 30, 40],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([10, 20, 30, 40]);
	});

	it('reads 24 bit R8G8B8', () => {
		const file = buildDds({
			width: 2,
			height: 2,
			pixelFlags: DDPF_RGB,
			bitCount: 24,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
			data: [3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10],
		});
		const image = decodeDds(file);

		// Rows run top to bottom, which is the one thing DDS does not argue about.
		expect(pixelsOf(image)).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
	});

	it('reads 16 bit R5G6B5 and scales each channel to full range', () => {
		const file = buildDds({
			width: 3,
			height: 1,
			pixelFlags: DDPF_RGB,
			bitCount: 16,
			masks: [0xf800, 0x07e0, 0x001f, 0],
			data: [0xff, 0xff, 0xe0, 0x07, 0x00, 0xf8],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([255, 255, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
	});

	it('reads 16 bit A1R5G5B5, where one bit of alpha is all or nothing', () => {
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
			bitCount: 16,
			masks: [0x7c00, 0x03e0, 0x001f, 0x8000],
			data: [0x1f, 0x80, 0x1f, 0x00],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([0, 0, 255, 255, 0, 0, 255, 0]);
	});

	it('reads 16 bit A4R4G4B4', () => {
		const file = buildDds({
			width: 1,
			height: 1,
			pixelFlags: DDPF_RGB | DDPF_ALPHAPIXELS,
			bitCount: 16,
			masks: [0x0f00, 0x00f0, 0x000f, 0xf000],
			data: [0x0f, 0x8f],
		});

		// Four bits of ones has to reach 255, and eight of alpha is 8 of 15.
		expect(pixelsOf(decodeDds(file))).toEqual([255, 0, 255, 136]);
	});

	it('reads an 8 bit luminance surface as grey', () => {
		const file = buildDds({
			width: 3,
			height: 1,
			pixelFlags: DDPF_LUMINANCE,
			bitCount: 8,
			masks: [0xff, 0, 0, 0],
			data: [0, 128, 255],
		});
		const image = decodeDds(file);

		expect(pixelsOf(image)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
		expect(image.hasAlpha).toBe(false);
	});

	it('reads a 16 bit luminance surface, scaled down from its own range', () => {
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_LUMINANCE,
			bitCount: 16,
			masks: [0xffff, 0, 0, 0],
			data: [0x82, 0x82, 0xff, 0xff],
		});

		// 0x8282 is 130 repeated, which is exactly 130 out of 255.
		expect(pixelsOf(decodeDds(file))).toEqual([130, 130, 130, 255, 255, 255, 255, 255]);
	});

	it('reads luminance with alpha beside it', () => {
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_LUMINANCE | DDPF_ALPHAPIXELS,
			bitCount: 16,
			masks: [0x00ff, 0, 0, 0xff00],
			data: [200, 128, 100, 255],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([200, 200, 200, 128, 100, 100, 100, 255]);
	});

	it('reads an alpha only surface and leaves the colour black', () => {
		// The format carries no colour at all, so one has to be chosen. Black is
		// what a shader sampling D3DFMT_A8 gets, and it is also the choice that
		// survives being flattened onto a light background, where white would
		// come out as a blank rectangle.
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_ALPHA,
			bitCount: 8,
			masks: [0, 0, 0, 0xff],
			data: [64, 255],
		});
		const image = decodeDds(file);

		expect(pixelsOf(image)).toEqual([0, 0, 0, 64, 0, 0, 0, 255]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads an alpha only surface that also sets DDPF_ALPHAPIXELS', () => {
		const file = buildDds({
			width: 1,
			height: 1,
			pixelFlags: DDPF_ALPHA | DDPF_ALPHAPIXELS,
			bitCount: 8,
			masks: [0, 0, 0, 0xff],
			data: [90],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([0, 0, 0, 90]);
	});

	it('reads only the lowest contiguous run of a mask that is not contiguous', () => {
		// Red claims bits 4 to 7 and, dishonestly, bits 12 to 15 as well. The run
		// this reader uses is the low one, so the first texel, which sets only the
		// high group, is not red at all. Extracting through the mask as declared
		// would produce a number far larger than four bits can hold, which scales
		// past 255 and clamps, and both texels would come out fully lit.
		const file = buildDds({
			width: 2,
			height: 1,
			pixelFlags: DDPF_RGB,
			bitCount: 32,
			masks: [0x0000f0f0, 0x000f0000, 0x00f00000, 0],
			data: [0x00, 0xf0, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x00],
		});

		expect(pixelsOf(decodeDds(file))).toEqual([0, 0, 0, 255, 255, 0, 0, 255]);
	});

	it('computes the row length itself rather than trusting the pitch field', () => {
		// Writers disagree about dwPitchOrLinearSize: some put the whole surface
		// size in it and some leave it at zero. A DDS surface is tightly packed,
		// so a reader that honoured this number would read the second row of a
		// perfectly good file out of the middle of the first.
		const file = buildDds({
			width: 2,
			height: 2,
			pixelFlags: DDPF_RGB,
			bitCount: 24,
			pitch: 4096,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
			data: [3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10],
		});

		expect(texel(decodeDds(file), 0, 1)).toEqual([7, 8, 9, 255]);
	});
});

/* ── The DX10 extension header ────────────────────────────────────────── */

describe('decodeDds with a DX10 header', () => {
	const bc1 = colourBlock(0xffff, 0x0000, QUARTERS);

	function dx10(format: number, data: readonly number[], extra: Partial<Dx10Spec> = {}) {
		return buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format, ...extra },
			data,
		});
	}

	it.each([70, 71, 72])('reads DXGI format %i as BC1', (format) => {
		expect(texel(decodeDds(dx10(format, bc1)), 2, 0)).toEqual([170, 170, 170, 255]);
	});

	it.each([73, 74, 75])('reads DXGI format %i as BC2', (format) => {
		const data = [...nibbleAlphaBlock(new Array<number>(16).fill(8)), ...bc1];
		expect(texel(decodeDds(dx10(format, data)), 2, 0)).toEqual([170, 170, 170, 136]);
	});

	it.each([76, 77, 78])('reads DXGI format %i as BC3', (format) => {
		const data = [...ladderBlock(200, 10, RUNG), ...bc1];
		expect(texel(decodeDds(dx10(format, data)), 2, 0)).toEqual([170, 170, 170, 172]);
	});

	it.each([79, 80])('reads DXGI format %i as BC4', (format) => {
		const data = ladderBlock(200, 10, RUNG);
		expect(texel(decodeDds(dx10(format, data)), 2, 0)).toEqual([172, 172, 172, 255]);
	});

	it('reads DXGI format 81 as signed BC4', () => {
		const data = ladderBlock(0x00, 0x40, RUNG);
		expect(texel(decodeDds(dx10(81, data)), 0, 0)).toEqual([128, 128, 128, 255]);
	});

	it.each([82, 83])('reads DXGI format %i as BC5', (format) => {
		const data = [...ladderBlock(200, 10, RUNG), ...ladderBlock(30, 220, RUNG)];
		expect(texel(decodeDds(dx10(format, data)), 0, 0)).toEqual([200, 30, 0, 255]);
	});

	it('reads DXGI format 84 as signed BC5', () => {
		const data = [...ladderBlock(0x7f, 0x81, RUNG), ...ladderBlock(0x00, 0x40, RUNG)];
		expect(texel(decodeDds(dx10(84, data)), 0, 0)).toEqual([255, 128, 0, 255]);
	});

	it.each([27, 28, 29])('reads DXGI format %i as eight bit RGBA in that order', (format) => {
		const image = decodeDds(dx10(format, [10, 20, 30, 40, ...new Array<number>(60).fill(0)]));

		// An sRGB spelling is the same numbers with a note to the sampler about
		// how to read them, so it decodes identically.
		expect(texel(image, 0, 0)).toEqual([10, 20, 30, 40]);
	});

	it.each([87, 90, 91])('reads DXGI format %i as eight bit BGRA', (format) => {
		const image = decodeDds(dx10(format, [30, 20, 10, 40, ...new Array<number>(60).fill(0)]));

		expect(texel(image, 0, 0)).toEqual([10, 20, 30, 40]);
	});

	it.each([60, 61])(
		'reads DXGI format %i as a single eight bit channel shown as grey',
		(format) => {
			const image = decodeDds(dx10(format, [0, 128, 255, 7, ...new Array<number>(12).fill(0)]));

			expect(texel(image, 1, 0)).toEqual([128, 128, 128, 255]);
			expect(image.hasAlpha).toBe(false);
		},
	);

	it.each([48, 49])('reads DXGI format %i as red and green with blue left at zero', (format) => {
		const image = decodeDds(dx10(format, [10, 200, ...new Array<number>(30).fill(0)]));

		expect(texel(image, 0, 0)).toEqual([10, 200, 0, 255]);
	});

	it('undoes the multiplication when the alpha mode says premultiplied', () => {
		const data = [...nibbleAlphaBlock(new Array<number>(16).fill(10)), ...bc1];
		const straight = decodeDds(dx10(74, data));
		const premultiplied = decodeDds(dx10(74, data, { miscFlags2: 2 }));

		expect(texel(straight, 2, 0)).toEqual([170, 170, 170, 170]);
		expect(texel(premultiplied, 2, 0)).toEqual([255, 255, 255, 170]);
	});

	it('reads a cube map, which is six 2D textures and reports itself as one', () => {
		const image = decodeDds(dx10(71, bc1, { miscFlag: 0x4, arraySize: 6 }));

		expect(texel(image, 0, 0)).toEqual([255, 255, 255, 255]);
	});
});

/* ── Surfaces after the first ─────────────────────────────────────────── */

describe('decodeDds on files with more than one surface', () => {
	const top = solidBlock(255, 0, 0);
	const next = solidBlock(0, 255, 0);

	it('reads the largest mip level and ignores the rest of the chain', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			mipMapCount: 3,
			data: [...top, ...next, ...next],
		});

		expect(texel(decodeDds(file), 0, 0)).toEqual([255, 0, 0, 255]);
	});

	it('reads the first cube map face and ignores the other five', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			// DDSCAPS2_CUBEMAP with all six face flags.
			caps2: DDSCAPS2_CUBEMAP | 0xfc00,
			data: [...top, ...next, ...next, ...next, ...next, ...next],
		});

		expect(texel(decodeDds(file), 0, 0)).toEqual([255, 0, 0, 255]);
	});

	it('reads the first slice of a volume texture and ignores the depth', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			caps2: DDSCAPS2_VOLUME,
			depth: 4,
			data: [...top, ...next, ...next, ...next],
		});

		expect(texel(decodeDds(file), 0, 0)).toEqual([255, 0, 0, 255]);
	});

	it('does not need the surfaces it is ignoring to be present', () => {
		// A mip count of ten with only the top level behind it is a truncated
		// file as far as a graphics card is concerned, and a perfectly readable
		// picture as far as this is.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			mipMapCount: 10,
			data: top,
		});

		expect(texel(decodeDds(file), 0, 0)).toEqual([255, 0, 0, 255]);
	});
});

/* ── Files this package did not write ─────────────────────────────────── */

describe('decodeDds against files from another writer', () => {
	/**
	 * A 16 by 16 gradient compressed to DXT1 by ImageMagick 7, byte for byte.
	 *
	 * Every other decoder fixture here is assembled from the field values in the
	 * specification, which is a better test than a round trip but is still this
	 * package's reading of the format on both sides. These three are not: they
	 * came out of an implementation with no connection to this one, and the
	 * pixels asserted below are what ImageMagick itself reads back out of them.
	 */
	const magickDxt1 = Uint8Array.from([
		0x44, 0x44, 0x53, 0x20, 0x7c, 0x00, 0x00, 0x00, 0x07, 0x10, 0x08, 0x00, 0x10, 0x00, 0x00, 0x00,
		0x10, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x49, 0x4d, 0x41, 0x47, 0x45, 0x4d, 0x41, 0x47, 0x49, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x44, 0x58, 0x54, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x78, 0x82, 0xf8, 0x79, 0xd5, 0xff, 0xab, 0x02, 0x77, 0x92, 0xf7, 0x89, 0xd5, 0xfd, 0xab, 0x02,
		0x76, 0xa2, 0xf6, 0x91, 0xfd, 0xaf, 0x2b, 0x0a, 0x75, 0xb2, 0xf5, 0xa1, 0xfd, 0xaf, 0xab, 0x0a,
		0x38, 0x83, 0xb8, 0x7a, 0x55, 0xfd, 0xab, 0x02, 0x37, 0x93, 0xb7, 0x8a, 0x55, 0xfd, 0xab, 0x02,
		0x36, 0xa3, 0xb6, 0x92, 0xfd, 0xaf, 0xab, 0x0a, 0x35, 0xb3, 0xb5, 0xa2, 0xfd, 0xaf, 0xab, 0x0a,
		0xf8, 0x83, 0x78, 0x7b, 0x55, 0xfd, 0xab, 0x02, 0xf7, 0x93, 0x77, 0x8b, 0x55, 0xfd, 0xab, 0x0a,
		0xf6, 0xa3, 0x76, 0x93, 0xfd, 0xaf, 0xab, 0x0a, 0xf5, 0xb3, 0x75, 0xa3, 0xfd, 0xbf, 0xab, 0x0a,
		0xb8, 0x84, 0x38, 0x7c, 0x55, 0xfd, 0xab, 0x0a, 0xb7, 0x94, 0x37, 0x8c, 0x55, 0xfd, 0xab, 0x0a,
		0xb6, 0xa4, 0x36, 0x94, 0xfd, 0xaf, 0xab, 0x0a, 0xb5, 0xb4, 0x35, 0xa4, 0xfd, 0xbf, 0xab, 0x0a,
	]);

	/** The same 4 by 4 picture as `magickPlain` below, compressed to DXT5. */
	const magickDxt5 = Uint8Array.from([
		0x44, 0x44, 0x53, 0x20, 0x7c, 0x00, 0x00, 0x00, 0x07, 0x10, 0x08, 0x00, 0x04, 0x00, 0x00, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x49, 0x4d, 0x41, 0x47, 0x45, 0x4d, 0x41, 0x47, 0x49, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x44, 0x58, 0x54, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x40, 0x80, 0xff, 0xff, 0xff, 0xff, 0xef, 0xe0, 0xff, 0xff, 0x00, 0x00, 0x3f, 0xa9, 0x7e, 0xfc,
	]);

	/** The same picture again, uncompressed, with the masks in the header. */
	const magickPlain = Uint8Array.from([
		0x44, 0x44, 0x53, 0x20, 0x7c, 0x00, 0x00, 0x00, 0x0f, 0x10, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
		0x04, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x49, 0x4d, 0x41, 0x47, 0x45, 0x4d, 0x41, 0x47, 0x49, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
		0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00,
		0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x10, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
		0x00, 0x00, 0x00, 0xff, 0x80, 0x80, 0x80, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff,
		0xff, 0x00, 0xff, 0xff, 0xc0, 0x40, 0x40, 0xff, 0x32, 0x64, 0xc8, 0xff, 0x1e, 0x14, 0x0a, 0xff,
		0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x80, 0x00, 0xff, 0x00, 0x40, 0xff, 0x00, 0x00, 0xff,
	]);

	it('reads a 16 by 16 DXT1 texture ImageMagick compressed', () => {
		const image = decodeDds(magickDxt1);

		expect(image.width).toBe(16);
		expect(image.height).toBe(16);
		expect(image.hasAlpha).toBe(false);
		expect(texel(image, 0, 0)).toEqual([123, 60, 198, 255]);
		expect(texel(image, 15, 0)).toEqual([170, 65, 173, 255]);
		expect(texel(image, 0, 15)).toEqual([129, 144, 198, 255]);
	});

	it('stays within twelve levels of the gradient that was compressed', () => {
		// The source was red = 120 + 4x, green = 60 + 6y, blue = 200 - 2x, which
		// is about as easy as a picture gets. BC1 still loses two things on it:
		// the endpoints of each block are quantised to five, six and five bits,
		// and every texel in a 4 by 4 block has to land on one of four colours
		// along the line between them. Twelve is the worst any channel drifts
		// here, and a decoder that got the interpolation or the endpoint
		// expansion wrong would miss by far more than that rather than by one.
		const image = decodeDds(magickDxt1);
		let worst = 0;
		for (let y = 0; y < 16; y += 1) {
			for (let x = 0; x < 16; x += 1) {
				const want = [120 + x * 4, 60 + y * 6, 200 - x * 2];
				const got = texel(image, x, y);
				for (let channel = 0; channel < 3; channel += 1) {
					worst = Math.max(worst, Math.abs((got[channel] as number) - (want[channel] as number)));
				}
			}
		}

		expect(worst).toBeLessThanOrEqual(12);
	});

	it('reads a DXT5 texture ImageMagick compressed, alpha and all', () => {
		const image = decodeDds(magickDxt5);

		expect(image.width).toBe(4);
		expect(image.height).toBe(4);
		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual([
			85, 85, 85, 255, 85, 85, 85, 255, 85, 85, 85, 255, 255, 255, 255, 255, 0, 0, 0, 255, 170, 170,
			170, 255, 170, 170, 170, 255, 170, 170, 170, 255, 170, 170, 170, 255, 85, 85, 85, 255, 85, 85,
			85, 255, 0, 0, 0, 255, 255, 255, 255, 0, 85, 85, 85, 128, 85, 85, 85, 64, 85, 85, 85, 255,
		]);
	});

	it('reads the uncompressed spelling of the same picture exactly', () => {
		const image = decodeDds(magickPlain);

		// Nothing is lost here, so these are the numbers that went in.
		expect(pixelsOf(image)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128,
			128, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255, 64, 64, 192, 255, 200, 100,
			50, 255, 10, 20, 30, 255, 255, 255, 255, 0, 255, 0, 0, 128, 0, 255, 0, 64, 0, 0, 255, 255,
		]);
		expect(image.hasAlpha).toBe(true);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeDds refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeDds(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('dds');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	const dxt1 = buildDds({
		width: 4,
		height: 4,
		pixelFlags: DDPF_FOURCC,
		fourCC: 'DXT1',
		data: colourBlock(0xffff, 0x0000, QUARTERS),
	});

	it.each([0, 1, 3])('rejects a file cut off at %i bytes', (length) => {
		expectRefusal(dxt1.subarray(0, length), /four byte signature/);
	});

	it('rejects a file that does not start with "DDS "', () => {
		const file = Uint8Array.from(dxt1);
		file[3] = 0x21;
		expectRefusal(file, /"DDS "/);
	});

	it('rejects a file cut off inside its header', () => {
		expectRefusal(dxt1.subarray(0, 100), /its header/);
	});

	it('rejects a header that declares a size other than 124', () => {
		const file = Uint8Array.from(dxt1);
		new DataView(file.buffer).setUint32(4, 128, true);
		expectRefusal(file, /size of 128 bytes/);
	});

	it('rejects a pixel format that declares a size other than 32', () => {
		const file = Uint8Array.from(dxt1);
		new DataView(file.buffer).setUint32(76, 24, true);
		expectRefusal(file, /size of 24 bytes/);
	});

	it.each([
		[0, 4],
		[4, 0],
	])('rejects a surface %i by %i', (width, height) => {
		const file = buildDds({
			width,
			height,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file, /width or a height of zero/);
	});

	it('refuses an implausible size before it allocates anything for it', () => {
		const file = buildDds({
			width: 60000,
			height: 60000,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DXT1',
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file, /far larger than anything this tool will allocate/);
	});

	it('rejects a block compressed file cut off before the end of its surface', () => {
		expectRefusal(dxt1.subarray(0, dxt1.length - 1), /its first surface/);
	});

	it('rejects an uncompressed file cut off before the end of its surface', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_RGB,
			bitCount: 32,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
			data: new Array<number>(60).fill(0),
		});
		expectRefusal(file, /its first surface/);
	});

	it('names a fourCC it does not implement', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'UYVY',
			data: new Array<number>(64).fill(0),
		});
		expectRefusal(file, /fourCC "UYVY"/);
	});

	it('names a D3D format number when the fourCC field is not four characters', () => {
		// 113 is A16B16G16R16F, which is how a half float surface is spelled.
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCcWord: 113,
			data: new Array<number>(128).fill(0),
		});
		expectRefusal(file, /D3D format code 113/);
	});

	it('refuses a YUV surface by name', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_YUV,
			bitCount: 32,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
			data: new Array<number>(64).fill(0),
		});
		expectRefusal(file, /YUV/);
	});

	it('refuses a signed bump map by name', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_BUMPDUDV,
			bitCount: 16,
			masks: [0x00ff, 0xff00, 0, 0],
			data: new Array<number>(32).fill(0),
		});
		expectRefusal(file, /DDPF_BUMPDUDV/);
	});

	it('reports pixel format flags that name no layout at all', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: 0x80,
			bitCount: 32,
			data: new Array<number>(64).fill(0),
		});
		expectRefusal(file, /flags are 0x80/);
	});

	it.each([4, 12, 48, 64])('rejects %i bits per pixel', (bitCount) => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_RGB,
			bitCount,
			masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
			data: new Array<number>(256).fill(0),
		});
		expectRefusal(file, new RegExp(`${bitCount} bits per pixel`));
	});

	it('rejects an RGB surface with every colour mask empty', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_RGB,
			bitCount: 32,
			masks: [0, 0, 0, 0xff000000],
			data: new Array<number>(64).fill(0),
		});
		expectRefusal(file, /every channel mask empty/);
	});

	it('rejects a luminance surface with an empty mask', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_LUMINANCE,
			bitCount: 8,
			masks: [0, 0, 0, 0],
			data: new Array<number>(16).fill(0),
		});
		expectRefusal(file, /luminance surface but leaves its channel mask empty/);
	});

	it('rejects an alpha only surface with an empty mask', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_ALPHA,
			bitCount: 8,
			masks: [0, 0, 0, 0],
			data: new Array<number>(16).fill(0),
		});
		expectRefusal(file, /alpha only surface but leaves its alpha mask empty/);
	});

	it('rejects a file cut off inside its DX10 header', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format: 71 },
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file.subarray(0, 140), /DX10 header/);
	});

	it.each([94, 95, 96])('refuses DXGI format %i as BC6H by name', (format) => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format },
			data: new Array<number>(16).fill(0),
		});
		expectRefusal(file, /BC6H/);
	});

	it.each([97, 98, 99])('refuses DXGI format %i as BC7 by name', (format) => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format },
			data: new Array<number>(16).fill(0),
		});
		expectRefusal(file, /BC7/);
	});

	it('refuses a DXGI format it does not implement, by number', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			// 10 is R16G16B16A16_UNORM, which this reader does not carry.
			dx10: { format: 10 },
			data: new Array<number>(128).fill(0),
		});
		expectRefusal(file, /DXGI format 10/);
	});

	it('refuses a 1D texture by name', () => {
		const file = buildDds({
			width: 4,
			height: 1,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format: 71, dimension: 2 },
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file, /1D texture/);
	});

	it('refuses a 3D volume texture by name', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format: 71, dimension: 4 },
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file, /3D volume texture/);
	});

	it('reports a resource dimension it does not recognise', () => {
		const file = buildDds({
			width: 4,
			height: 4,
			pixelFlags: DDPF_FOURCC,
			fourCC: 'DX10',
			dx10: { format: 71, dimension: 0 },
			data: colourBlock(0xffff, 0, QUARTERS),
		});
		expectRefusal(file, /resource dimension 0/);
	});
});
