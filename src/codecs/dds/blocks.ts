/**
 * The block compressed layouts a DDS carries: BC1 to BC5.
 *
 * All five are 4 by 4 tiles of texels packed into eight or sixteen bytes, and
 * all five are built out of the same two pieces. A colour block is two RGB565
 * endpoints and sixteen two bit indices into four colours derived from them.
 * An interpolated block is two eight bit endpoints and sixteen three bit
 * indices into eight values derived from them. BC1 is the first piece alone,
 * BC4 the second alone, and BC2, BC3 and BC5 are combinations.
 *
 * Three rules here produce a plausible looking picture rather than an error
 * when they are got wrong, so each is spelled out where it applies:
 *
 * - A colour block whose first endpoint is not greater than its second holds
 *   three colours and a transparent fourth, not four colours.
 * - Inside BC2 and BC3 that never happens: the colour block is read as four
 *   colours whatever order the endpoints are in, because the alpha lives
 *   elsewhere and the fourth entry is a real colour.
 * - An interpolated block whose first endpoint is not greater than its second
 *   holds four interpolated values plus the two extremes, not six interpolated
 *   values.
 *
 * Every division here truncates. The specification fixes the ratios and not
 * the rounding, and hardware decoders differ from each other by a level, but
 * every software decoder in circulation truncates, so a texture read here
 * matches what the tool that wrote it shows.
 */

import type { RasterImage } from '../../types.js';

/** A decoded 4 by 4 block, written as 16 straight RGBA texels in row order. */
export type BlockDecoder = (bytes: Uint8Array, at: number, out: Uint8Array) => void;

export interface Block {
	readonly decode: BlockDecoder;
	/** Bytes one 4 by 4 block occupies in the file. */
	readonly bytes: number;
}

/**
 * Scratch shared by every call rather than allocated per block.
 *
 * A 4096 square texture is a quarter of a million blocks, and at sixteen bytes
 * a time the allocation would be most of the work. Nothing here is reentrant
 * or asynchronous and each array is consumed before the next call begins, so
 * the sharing is invisible from the outside.
 */
const colours = new Uint8Array(16);
/** The eight values an interpolated block indexes. Signed, so an Int16Array. */
const ladder = new Int16Array(8);
/** The sixteen texels of one interpolated channel, already mapped to 0 to 255. */
const samples = new Uint8Array(16);

/**
 * RGB565 to eight bits a channel, by repeating the top bits into the gap.
 *
 * A plain shift maps five bits of ones to 248 rather than 255, so a white
 * texel would come back a light grey and every saturated block would be
 * slightly dark. Repetition is what the specification asks for and what the
 * hardware does.
 */
function expand565(value: number, into: Uint8Array, at: number): void {
	const r = (value >> 11) & 0x1f;
	const g = (value >> 5) & 0x3f;
	const b = value & 0x1f;
	into[at] = (r << 3) | (r >> 2);
	into[at + 1] = (g << 2) | (g >> 4);
	into[at + 2] = (b << 3) | (b >> 2);
	into[at + 3] = 255;
}

/**
 * The eight byte colour block shared by BC1, BC2 and BC3.
 *
 * `fourColourOnly` is what BC2 and BC3 pass. Their alpha comes from their own
 * block, so the endpoint order carries no meaning for them and reading it as
 * though it did would punch transparent holes through an opaque texture
 * wherever the encoder happened to order a block the other way.
 */
function colourBlock(
	bytes: Uint8Array,
	at: number,
	out: Uint8Array,
	fourColourOnly: boolean,
): void {
	// The comparison is between the packed 16 bit endpoints as written, not
	// between the colours they expand to. Two different 565 values can expand to
	// the same eight bit triple, and comparing after the expansion would then
	// pick the wrong branch for the block.
	const c0 = (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
	const c1 = (bytes[at + 2] as number) | ((bytes[at + 3] as number) << 8);
	expand565(c0, colours, 0);
	expand565(c1, colours, 4);

	if (!fourColourOnly && c0 <= c1) {
		for (let i = 0; i < 3; i += 1) {
			colours[8 + i] = Math.floor(((colours[i] as number) + (colours[4 + i] as number)) / 2);
			// The fourth entry of a three colour block is not a colour. It is the
			// hole, and the specification gives it black rather than an
			// interpolation, so a reader that blended it would leave a coloured
			// fringe wherever a texture was cut out.
			colours[12 + i] = 0;
		}
		colours[11] = 255;
		colours[15] = 0;
	} else {
		for (let i = 0; i < 3; i += 1) {
			const first = colours[i] as number;
			const second = colours[4 + i] as number;
			colours[8 + i] = Math.floor((2 * first + second) / 3);
			colours[12 + i] = Math.floor((first + 2 * second) / 3);
		}
		colours[11] = 255;
		colours[15] = 255;
	}

	// Two bits a texel, the first texel in the lowest bits, sixteen of them in
	// one little endian word. `>>>` rather than `>>` because the top texel's
	// bits reach bit 31 and a signed shift would carry the sign down with them.
	const indices =
		((bytes[at + 4] as number) |
			((bytes[at + 5] as number) << 8) |
			((bytes[at + 6] as number) << 16) |
			((bytes[at + 7] as number) << 24)) >>>
		0;
	for (let i = 0; i < 16; i += 1) {
		const entry = ((indices >>> (i * 2)) & 3) * 4;
		out[i * 4] = colours[entry] as number;
		out[i * 4 + 1] = colours[entry + 1] as number;
		out[i * 4 + 2] = colours[entry + 2] as number;
		out[i * 4 + 3] = colours[entry + 3] as number;
	}
}

/** BC2's alpha: four bits a texel, straight through, no interpolation at all. */
function alphaNibbles(bytes: Uint8Array, at: number, out: Uint8Array): void {
	for (let i = 0; i < 16; i += 1) {
		const byte = bytes[at + (i >> 1)] as number;
		// Two texels a byte, the earlier one in the low nibble.
		const value = (i & 1) === 0 ? byte & 0x0f : byte >> 4;
		// Repeated rather than shifted, for the reason `expand565` gives: a
		// nibble of ones has to reach 255 or every opaque texel in the file
		// comes back a little translucent.
		out[i * 4 + 3] = (value << 4) | value;
	}
}

/**
 * Map an interpolated sample onto the 0 to 255 a raster holds.
 *
 * A signed channel runs from -127 to 127 and is shown by moving its zero to
 * the middle of the range. That is not an interpretation of the content: it is
 * exactly the encoding the unsigned spelling of the same normal map uses, so
 * BC5_SNORM and BC5_UNORM versions of one texture come out looking the same.
 */
function display(value: number, signed: boolean): number {
	if (!signed) return value;
	return Math.round(((value + 127) * 255) / 254);
}

/**
 * Expand one eight byte interpolated channel block into `samples`.
 *
 * This is BC4, and it is also the alpha half of BC3. The endpoint order picks
 * the ladder: greater first means six values evenly spaced between the
 * endpoints, and anything else means four values plus the two extremes of the
 * range. Reading the second case as the first is the classic mistake, and it
 * shows up as an alpha channel that never quite reaches transparent.
 */
function expandInterpolated(bytes: Uint8Array, at: number, signed: boolean): void {
	let first = bytes[at] as number;
	let second = bytes[at + 1] as number;
	if (signed) {
		first = first > 127 ? first - 256 : first;
		second = second > 127 ? second - 256 : second;
		// SNORM has two spellings of -1 and uses only one of them, so -128 is
		// read as -127. Left alone it would make the range asymmetric and put
		// the interpolated values half a step out.
		if (first === -128) first = -127;
		if (second === -128) second = -127;
	}
	ladder[0] = first;
	ladder[1] = second;

	if (first > second) {
		for (let i = 1; i <= 6; i += 1) {
			ladder[i + 1] = Math.floor(((7 - i) * first + i * second) / 7);
		}
	} else {
		for (let i = 1; i <= 4; i += 1) {
			ladder[i + 1] = Math.floor(((5 - i) * first + i * second) / 5);
		}
		ladder[6] = signed ? -127 : 0;
		ladder[7] = signed ? 127 : 255;
	}

	// Three bits a texel across six bytes, filled from the low end. Split into
	// two 24 bit halves because 48 bits does not fit in the 32 bit integers
	// JavaScript's bitwise operators work on, and a code straddling the halves
	// would otherwise lose its top bits.
	const low =
		(bytes[at + 2] as number) |
		((bytes[at + 3] as number) << 8) |
		((bytes[at + 4] as number) << 16);
	const high =
		(bytes[at + 5] as number) |
		((bytes[at + 6] as number) << 8) |
		((bytes[at + 7] as number) << 16);
	for (let i = 0; i < 16; i += 1) {
		const code = i < 8 ? (low >> (i * 3)) & 7 : (high >> ((i - 8) * 3)) & 7;
		samples[i] = display(ladder[code] as number, signed);
	}
}

const bc1Block: BlockDecoder = (bytes, at, out) => {
	colourBlock(bytes, at, out, false);
};

const bc2Block: BlockDecoder = (bytes, at, out) => {
	// Colour first, then alpha over the top of it: the colour block writes an
	// alpha of 255 into every texel and the alpha half is the authority.
	colourBlock(bytes, at + 8, out, true);
	alphaNibbles(bytes, at, out);
};

const bc3Block: BlockDecoder = (bytes, at, out) => {
	colourBlock(bytes, at + 8, out, true);
	expandInterpolated(bytes, at, false);
	for (let i = 0; i < 16; i += 1) out[i * 4 + 3] = samples[i] as number;
};

function bc4Into(bytes: Uint8Array, at: number, out: Uint8Array, signed: boolean): void {
	expandInterpolated(bytes, at, signed);
	for (let i = 0; i < 16; i += 1) {
		const value = samples[i] as number;
		out[i * 4] = value;
		out[i * 4 + 1] = value;
		out[i * 4 + 2] = value;
		out[i * 4 + 3] = 255;
	}
}

function bc5Into(bytes: Uint8Array, at: number, out: Uint8Array, signed: boolean): void {
	expandInterpolated(bytes, at, signed);
	for (let i = 0; i < 16; i += 1) {
		out[i * 4] = samples[i] as number;
		// Blue is left at zero rather than reconstructed from the other two.
		// A BC5 surface is almost always a tangent space normal map, where the
		// third component can be recovered as the square root of what is left of
		// a unit vector, but "almost always" is an assumption about content and
		// this is a reader. A file that turns out to hold two unrelated channels
		// would come back with a blue channel nobody put there.
		out[i * 4 + 2] = 0;
		out[i * 4 + 3] = 255;
	}
	expandInterpolated(bytes, at + 8, signed);
	for (let i = 0; i < 16; i += 1) out[i * 4 + 1] = samples[i] as number;
}

export const BC1: Block = { decode: bc1Block, bytes: 8 };
export const BC2: Block = { decode: bc2Block, bytes: 16 };
export const BC3: Block = { decode: bc3Block, bytes: 16 };
export const BC4: Block = {
	decode: (bytes, at, out) => bc4Into(bytes, at, out, false),
	bytes: 8,
};
export const BC4_SIGNED: Block = {
	decode: (bytes, at, out) => bc4Into(bytes, at, out, true),
	bytes: 8,
};
export const BC5: Block = {
	decode: (bytes, at, out) => bc5Into(bytes, at, out, false),
	bytes: 16,
};
export const BC5_SIGNED: Block = {
	decode: (bytes, at, out) => bc5Into(bytes, at, out, true),
	bytes: 16,
};

/** How many bytes a block compressed surface of this size occupies. */
export function blockSurfaceBytes(width: number, height: number, block: Block): number {
	return Math.ceil(width / 4) * Math.ceil(height / 4) * block.bytes;
}

/**
 * Read one whole block compressed surface into `image`.
 *
 * Width and height that are not multiples of four are legal and common: the
 * last block of a row and the last row of blocks hang over the edge, carrying
 * texels that were never part of the picture. They are dropped here rather
 * than decoded into a padded raster and cropped afterwards, which would cost a
 * second buffer the size of the image for nothing.
 */
export function decodeBlockSurface(
	bytes: Uint8Array,
	at: number,
	image: RasterImage,
	block: Block,
): void {
	const { width, height, data } = image;
	const across = Math.ceil(width / 4);
	const down = Math.ceil(height / 4);
	const texels = new Uint8Array(64);

	for (let by = 0; by < down; by += 1) {
		const top = by * 4;
		const rows = Math.min(4, height - top);
		for (let bx = 0; bx < across; bx += 1) {
			block.decode(bytes, at + (by * across + bx) * block.bytes, texels);
			const left = bx * 4;
			const columns = Math.min(4, width - left);
			for (let y = 0; y < rows; y += 1) {
				const from = y * 16;
				data.set(texels.subarray(from, from + columns * 4), ((top + y) * width + left) * 4);
			}
		}
	}
}
