/**
 * A DirectDraw Surface reader.
 *
 * DDS is a container for whatever a graphics card wanted to sample, which is
 * why nothing else opens one. Most of them hold a block compressed texture,
 * BC1 to BC5, and the rest hold a plain buffer described the way Windows has
 * always described one: a bit count and a channel mask per component. Both are
 * here. The block layouts themselves live in `blocks.ts`.
 *
 * What it reads: DXT1 to DXT5 and the ATI1, ATI2, BC4 and BC5 spellings of the
 * two single channel layouts; the same set again through a DX10 extension
 * header, along with the four uncompressed DXGI formats that turn up in real
 * files; and uncompressed RGB, RGBA, luminance, luminance with alpha and alpha
 * only at 8, 16, 24 and 32 bits. What it refuses by name: BC6H, BC7, YUV
 * surfaces, signed bump maps, anything that is not a 2D texture, and every
 * fourCC and DXGI format outside that list.
 *
 * A file may carry a mip chain, six cube map faces or a stack of volume
 * slices. All of them are laid out with the largest surface of the first face
 * first, so this reads that surface and ignores the rest: a texture asset has
 * one picture in it and the smaller copies are the same picture. None of them
 * is a reason to refuse a file.
 *
 * Every read is bounds checked. Width, height and depth are three unsigned 32
 * bit fields with nothing to corroborate them, so a 128 byte file can claim
 * four billion pixels, and that has to be a sentence rather than an allocation
 * failure somewhere else.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';
import {
	BC1,
	BC2,
	BC3,
	BC4,
	BC4_SIGNED,
	BC5,
	BC5_SIGNED,
	blockSurfaceBytes,
	decodeBlockSurface,
	type Block,
} from './blocks.js';

const DECODER_ID = 'dds-pure';

/** 'DDS ', with the trailing space that is part of it. */
const MAGIC_BYTES = 4;
/** DDS_HEADER, fixed. The file states its own size and it has to be this. */
const HEADER_BYTES = 124;
/** DDS_PIXELFORMAT, nested inside the header and likewise fixed. */
const PIXEL_FORMAT_BYTES = 32;
/** DDS_HEADER_DXT10, present only when the fourCC is 'DX10'. */
const DX10_HEADER_BYTES = 20;

/* Offsets from the start of the file, so they read as DataView arguments. */
const HEADER_SIZE_AT = 4;
const HEIGHT_AT = 12;
const WIDTH_AT = 16;
const PIXEL_FORMAT_AT = 76;
const PIXEL_FLAGS_AT = 80;
const FOUR_CC_AT = 84;
const BIT_COUNT_AT = 88;
const RED_MASK_AT = 92;
const GREEN_MASK_AT = 96;
const BLUE_MASK_AT = 100;
const ALPHA_MASK_AT = 104;
const DX10_AT = MAGIC_BYTES + HEADER_BYTES;
const LEGACY_DATA_AT = DX10_AT;
const DX10_DATA_AT = DX10_AT + DX10_HEADER_BYTES;

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_YUV = 0x200;
const DDPF_LUMINANCE = 0x20000;
/** A signed du/dv surface. Never an official flag, and written all the same. */
const DDPF_BUMPDUDV = 0x80000;

const DIMENSION_TEXTURE_1D = 2;
const DIMENSION_TEXTURE_2D = 3;
const DIMENSION_TEXTURE_3D = 4;

/** The low three bits of miscFlags2. 2 is DDS_ALPHA_MODE_PREMULTIPLIED. */
const ALPHA_MODE_MASK = 0x7;
const ALPHA_MODE_PREMULTIPLIED = 2;

/**
 * The largest image this decoder will allocate for.
 *
 * The converter applies its own `maxPixels` on top of this; this one exists so
 * the decoder is safe to call on its own. The number is the converter's own
 * default budget rather than the four hundred million it used to be: two
 * ceilings five times apart are not two defences, and nothing a caller would
 * accept ever lived in the range between them.
 *
 * Worth saying what this is not, because the same problem in PNG and PCX is
 * answered with a `measure` hook and this file deliberately has none. Nothing
 * sits between a DDS header and its surface: every layout here costs a fixed
 * number of bytes a pixel, and the cheapest of them is BC1 at half a byte, so
 * the `requireBytes` further down proves the file really is that long before
 * the raster is allocated. A DDS cannot declare an image its own length does
 * not back up, which is the entire reason a header measurement is worth having
 * in the formats that can. One here would refuse the same files this already
 * refuses, one step earlier, and would be another place to get the block size
 * arithmetic wrong.
 */
const MAX_PIXELS = 80_000_000;

function fail(detail: string): never {
	throw new DecodeFailedError('dds', DECODER_ID, detail);
}

/**
 * The one place a length is compared against the buffer.
 *
 * Funnelling every read through this is what keeps the failure mode honest: a
 * short file names the structure it stopped inside instead of reading
 * undefined and painting it.
 */
function requireBytes(bytes: Uint8Array, at: number, count: number, what: string): void {
	if (at + count > bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

/* ── Channel masks ────────────────────────────────────────────────────── */

/**
 * One channel of an uncompressed surface, reduced to the arithmetic that
 * extracts it.
 *
 * The same reduction the BMP reader performs on its BI_BITFIELDS masks, and
 * the same for a reason: DDS inherited the idea from Windows and inherited its
 * failure modes with it. A mask has to be cut down to its lowest contiguous
 * run before it is used, or a scattered one yields a number larger than the
 * channel's own maximum, which scales past 255 and clamps, and a channel that
 * is actually dark comes out fully lit.
 */
interface Channel {
	readonly mask: number;
	readonly shift: number;
	/** The largest value the run can hold, which is what scales it to 0 to 255. */
	readonly max: number;
}

const EMPTY_CHANNEL: Channel = { mask: 0, shift: 0, max: 0 };

function channelOf(mask: number): Channel {
	if (mask === 0) return EMPTY_CHANNEL;
	let shift = 0;
	while (((mask >>> shift) & 1) === 0) shift += 1;
	let bits = 0;
	// The bound matters: `x >>> 32` is `x >>> 0` in JavaScript, so a mask of all
	// ones would spin here forever without it.
	while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits += 1;
	const max = 2 ** bits - 1;
	return { mask: (max << shift) >>> 0, shift, max };
}

function sample(raw: number, channel: Channel): number {
	if (channel.max === 0) return 0;
	if (channel.max === 255) return (raw & channel.mask) >>> channel.shift;
	// Five bits of red are 0 to 31, and 31 has to land on 255 rather than 248,
	// or every white texel in a 16 bit surface comes out slightly grey.
	return Math.round((((raw & channel.mask) >>> channel.shift) * 255) / channel.max);
}

/* ── Surface layouts ──────────────────────────────────────────────────── */

interface Plain {
	readonly bytesPerPixel: number;
	readonly red: Channel;
	readonly green: Channel;
	readonly blue: Channel;
	readonly alpha: Channel;
}

type Surface =
	| { readonly kind: 'block'; readonly block: Block }
	| { readonly kind: 'plain'; readonly plain: Plain };

interface Layout {
	readonly surface: Surface;
	/** Where the largest surface of the first face begins. */
	readonly dataAt: number;
	/** True when the colour channels have already been multiplied by alpha. */
	readonly premultiplied: boolean;
}

function blockLayout(block: Block, dataAt: number, premultiplied = false): Layout {
	return { surface: { kind: 'block', block }, dataAt, premultiplied };
}

/**
 * The fourCC as four printable characters, or undefined when it is not text.
 *
 * A DDS may put a D3DFMT enumeration value in this field instead of a tag,
 * which is how the floating point and 16 bit per channel surfaces are spelled.
 * Those are refused by their number, because that is the only name they have.
 */
function fourCcOf(bytes: Uint8Array, at: number): string | undefined {
	let text = '';
	for (let i = 0; i < 4; i += 1) {
		const byte = bytes[at + i] as number;
		if (byte < 0x20 || byte > 0x7e) return undefined;
		text += String.fromCharCode(byte);
	}
	return text;
}

function legacyFourCc(tag: string): Layout {
	switch (tag) {
		case 'DXT1':
			return blockLayout(BC1, LEGACY_DATA_AT);
		// DXT2 and DXT4 are DXT3 and DXT5 with the colour already multiplied by
		// the alpha. The bits are laid out identically and only the meaning
		// differs, which is why a decoder that ignores the distinction produces
		// an image that is merely too dark at the edges rather than one that
		// looks broken.
		case 'DXT2':
			return blockLayout(BC2, LEGACY_DATA_AT, true);
		case 'DXT3':
			return blockLayout(BC2, LEGACY_DATA_AT);
		case 'DXT4':
			return blockLayout(BC3, LEGACY_DATA_AT, true);
		case 'DXT5':
			return blockLayout(BC3, LEGACY_DATA_AT);
		case 'ATI1':
		case 'BC4U':
			return blockLayout(BC4, LEGACY_DATA_AT);
		case 'BC4S':
			return blockLayout(BC4_SIGNED, LEGACY_DATA_AT);
		// ATI2 is 3Dc, which AMD documented with its two channels named the other
		// way round, and a few readers still swap them for it while leaving BC5U
		// alone. DirectXTex maps both straight onto BC5_UNORM and so does
		// ImageMagick, so a swap here would put red where every other tool puts
		// green on the same bytes.
		case 'ATI2':
		case 'BC5U':
			return blockLayout(BC5, LEGACY_DATA_AT);
		case 'BC5S':
			return blockLayout(BC5_SIGNED, LEGACY_DATA_AT);
		default:
			fail(`it uses the fourCC "${tag}", which this reader does not implement.`);
	}
}

/** A plain layout built from explicit masks, for the DX10 formats that need one. */
function plainLayout(
	bytesPerPixel: number,
	red: number,
	green: number,
	blue: number,
	alpha: number,
	premultiplied: boolean,
): Layout {
	return {
		surface: {
			kind: 'plain',
			plain: {
				bytesPerPixel,
				red: channelOf(red),
				green: channelOf(green),
				blue: channelOf(blue),
				alpha: channelOf(alpha),
			},
		},
		dataAt: DX10_DATA_AT,
		premultiplied,
	};
}

function dxgiLayout(format: number, premultiplied: boolean): Layout {
	switch (format) {
		// Each block format has a typeless, a UNORM and usually an sRGB
		// spelling. They differ in how a shader is told to read the numbers, not
		// in how the numbers are stored, and an sRGB texture holds exactly the
		// values a raster here already holds, so all three decode the same way.
		case 70:
		case 71:
		case 72:
			return blockLayout(BC1, DX10_DATA_AT, premultiplied);
		case 73:
		case 74:
		case 75:
			return blockLayout(BC2, DX10_DATA_AT, premultiplied);
		case 76:
		case 77:
		case 78:
			return blockLayout(BC3, DX10_DATA_AT, premultiplied);
		case 79:
		case 80:
			return blockLayout(BC4, DX10_DATA_AT, premultiplied);
		case 81:
			return blockLayout(BC4_SIGNED, DX10_DATA_AT, premultiplied);
		case 82:
		case 83:
			return blockLayout(BC5, DX10_DATA_AT, premultiplied);
		case 84:
			return blockLayout(BC5_SIGNED, DX10_DATA_AT, premultiplied);
		case 94:
		case 95:
		case 96:
			fail('it stores BC6H compressed pixels, which this reader does not implement.');
			break;
		case 97:
		case 98:
		case 99:
			fail('it stores BC7 compressed pixels, which this reader does not implement.');
			break;
		case 27:
		case 28:
		case 29:
			return plainLayout(4, 0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000, premultiplied);
		case 87:
		case 90:
		case 91:
			return plainLayout(4, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000, premultiplied);
		case 60:
		case 61:
			return plainLayout(1, 0xff, 0xff, 0xff, 0, premultiplied);
		// Two channels and no third. Blue is left at zero for the reason BC5
		// leaves it at zero: filling it in would be a guess about content.
		case 48:
		case 49:
			return plainLayout(2, 0x00ff, 0xff00, 0, 0, premultiplied);
		default:
			fail(`it stores DXGI format ${format}, which this reader does not implement.`);
	}
}

function readDx10(bytes: Uint8Array, view: DataView): Layout {
	requireBytes(bytes, DX10_AT, DX10_HEADER_BYTES, 'the end of its DX10 header');
	const format = view.getUint32(DX10_AT, true);
	const dimension = view.getUint32(DX10_AT + 4, true);
	const miscFlags2 = view.getUint32(DX10_AT + 16, true);

	// A cube map is six 2D textures and reports itself as one, so it arrives
	// here as a 2D texture and needs nothing special. A 1D or 3D resource is a
	// different thing from a picture, and the DX10 header is explicit enough
	// about which it is that guessing at a slice would be a decision rather
	// than a reading.
	if (dimension !== DIMENSION_TEXTURE_2D) {
		if (dimension === DIMENSION_TEXTURE_1D) {
			fail('it is a 1D texture, and this reader only reads 2D textures.');
		}
		if (dimension === DIMENSION_TEXTURE_3D) {
			fail('it is a 3D volume texture, and this reader only reads 2D textures.');
		}
		fail(`its DX10 header gives resource dimension ${dimension}, which is not a 2D texture.`);
	}

	return dxgiLayout(format, (miscFlags2 & ALPHA_MODE_MASK) === ALPHA_MODE_PREMULTIPLIED);
}

/** An uncompressed surface, described by a bit count and a mask per channel. */
function readMasked(view: DataView, flags: number): Layout {
	const bitCount = view.getUint32(BIT_COUNT_AT, true);
	if (bitCount !== 8 && bitCount !== 16 && bitCount !== 24 && bitCount !== 32) {
		fail(`it is ${bitCount} bits per pixel, which is not a depth this reader knows.`);
	}

	const alphaMask = view.getUint32(ALPHA_MASK_AT, true);
	let red = EMPTY_CHANNEL;
	let green = EMPTY_CHANNEL;
	let blue = EMPTY_CHANNEL;
	let alpha = EMPTY_CHANNEL;

	if ((flags & DDPF_RGB) !== 0) {
		red = channelOf(view.getUint32(RED_MASK_AT, true));
		green = channelOf(view.getUint32(GREEN_MASK_AT, true));
		blue = channelOf(view.getUint32(BLUE_MASK_AT, true));
		if (red.max === 0 && green.max === 0 && blue.max === 0) {
			fail('it claims uncompressed colour but leaves every channel mask empty.');
		}
		// X8R8G8B8 and A8R8G8B8 differ only in this flag, and the fourth byte of
		// the first one holds whatever the writer left there, so the mask is only
		// read once the file has said the byte means coverage.
		if ((flags & DDPF_ALPHAPIXELS) !== 0) alpha = channelOf(alphaMask);
	} else if ((flags & DDPF_LUMINANCE) !== 0) {
		// One stored channel shown as grey. Pointing all three at the same run
		// means the pixel loop below needs no branch for it.
		red = channelOf(view.getUint32(RED_MASK_AT, true));
		green = red;
		blue = red;
		if (red.max === 0) {
			fail('it claims a luminance surface but leaves its channel mask empty.');
		}
		if ((flags & DDPF_ALPHAPIXELS) !== 0) alpha = channelOf(alphaMask);
	} else if ((flags & DDPF_ALPHA) !== 0) {
		// Alpha and nothing else, and the mask is in the alpha field whether or
		// not DDPF_ALPHAPIXELS is set beside it. The colour stays at zero rather
		// than being invented: the file carries none, and white would look like a
		// decision somebody made about the picture.
		alpha = channelOf(alphaMask);
		if (alpha.max === 0) {
			fail('it claims an alpha only surface but leaves its alpha mask empty.');
		}
	} else {
		fail(
			`its pixel format flags are 0x${flags.toString(16)}, which name neither a fourCC nor a channel layout this reader knows.`,
		);
	}

	return {
		surface: {
			kind: 'plain',
			plain: { bytesPerPixel: bitCount / 8, red, green, blue, alpha },
		},
		dataAt: LEGACY_DATA_AT,
		premultiplied: false,
	};
}

function readLayout(bytes: Uint8Array, view: DataView): Layout {
	const flags = view.getUint32(PIXEL_FLAGS_AT, true);

	if ((flags & DDPF_FOURCC) !== 0) {
		const tag = fourCcOf(bytes, FOUR_CC_AT);
		if (tag === undefined) {
			fail(
				`its pixel format names D3D format code ${view.getUint32(FOUR_CC_AT, true)}, which this reader does not implement.`,
			);
		}
		if (tag === 'DX10') return readDx10(bytes, view);
		return legacyFourCc(tag);
	}
	if ((flags & DDPF_YUV) !== 0) {
		fail('it stores YUV samples, which this reader does not implement.');
	}
	if ((flags & DDPF_BUMPDUDV) !== 0) {
		fail('it stores a signed bump map (DDPF_BUMPDUDV), which this reader does not implement.');
	}
	return readMasked(view, flags);
}

/* ── Pixels ───────────────────────────────────────────────────────────── */

function readPlainSurface(
	bytes: Uint8Array,
	view: DataView,
	at: number,
	image: RasterImage,
	plain: Plain,
): void {
	const { width, height, data } = image;
	const { bytesPerPixel, red, green, blue, alpha } = plain;
	// The row length is computed rather than taken from dwPitchOrLinearSize.
	// Writers disagree about that field: some put the whole surface size in it,
	// some leave it at zero, and some describe a mip level other than the first.
	// A DDS surface is tightly packed, so the width and the depth are enough.
	const pitch = width * bytesPerPixel;

	for (let y = 0; y < height; y += 1) {
		const row = at + y * pitch;
		const to = y * width * 4;
		for (let x = 0; x < width; x += 1) {
			const from = row + x * bytesPerPixel;
			let raw: number;
			if (bytesPerPixel === 1) {
				raw = bytes[from] as number;
			} else if (bytesPerPixel === 2) {
				raw = view.getUint16(from, true);
			} else if (bytesPerPixel === 3) {
				raw =
					(bytes[from] as number) |
					((bytes[from + 1] as number) << 8) |
					((bytes[from + 2] as number) << 16);
			} else {
				raw = view.getUint32(from, true);
			}
			const target = to + x * 4;
			data[target] = sample(raw, red);
			data[target + 1] = sample(raw, green);
			data[target + 2] = sample(raw, blue);
			// A surface with no alpha mask is opaque. Unlike BMP there is nothing
			// to guess at here: the flag and the mask both have to be present
			// before any bits are read as coverage, so a file that says every
			// texel is transparent means it.
			data[target + 3] = alpha.max === 0 ? 255 : sample(raw, alpha);
		}
	}
}

/**
 * Undo the multiplication DXT2, DXT4 and the premultiplied DX10 alpha mode
 * apply to their colour channels.
 *
 * Done in place, because the raster was built here and nothing else has seen
 * it yet.
 */
function unpremultiply(image: RasterImage): void {
	const { data } = image;
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3] as number;
		if (alpha === 255) continue;
		if (alpha === 0) {
			// Nothing survives division by zero coverage, and the colour under it
			// carries no information at all, so it goes to black rather than to
			// whatever the encoder happened to leave in the block.
			data[i] = 0;
			data[i + 1] = 0;
			data[i + 2] = 0;
			continue;
		}
		// A premultiplied file whose colour exceeds its coverage is not valid and
		// does exist. The clamped array caps the result at 255 instead of
		// wrapping it round to something dark.
		data[i] = Math.round(((data[i] as number) * 255) / alpha);
		data[i + 1] = Math.round(((data[i + 1] as number) * 255) / alpha);
		data[i + 2] = Math.round(((data[i + 2] as number) * 255) / alpha);
	}
}

/* ── Entry point ──────────────────────────────────────────────────────── */

/**
 * Read the largest surface of the first face of a DirectDraw Surface.
 *
 * The result is always straight (non-premultiplied) RGBA in sRGB. DDS has no
 * way to name a colour space: the DX10 header distinguishes an sRGB texture
 * from a linear one, but only to tell a shader how to read it, and the numbers
 * on disk are the same either way. Nothing here can widen the gamut claim.
 */
export function decodeDds(bytes: Uint8Array): RasterImage {
	requireBytes(bytes, 0, MAGIC_BYTES, 'the four byte signature every DDS begins with');
	if (bytes[0] !== 0x44 || bytes[1] !== 0x44 || bytes[2] !== 0x53 || bytes[3] !== 0x20) {
		fail('it does not start with the four byte "DDS " signature every DirectDraw Surface has.');
	}
	requireBytes(bytes, MAGIC_BYTES, HEADER_BYTES, 'the end of its header');

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Both size fields are checked rather than assumed. The layout below is a
	// run of fixed offsets, so a header that is not the size it says it is
	// would be read as though every field after the first were somewhere else,
	// and the result would be an image rather than an error.
	const headerSize = view.getUint32(HEADER_SIZE_AT, true);
	if (headerSize !== HEADER_BYTES) {
		fail(`its header declares a size of ${headerSize} bytes, and a DDS header is always 124.`);
	}
	const pixelFormatSize = view.getUint32(PIXEL_FORMAT_AT, true);
	if (pixelFormatSize !== PIXEL_FORMAT_BYTES) {
		fail(
			`its pixel format declares a size of ${pixelFormatSize} bytes, and a DDS pixel format is always 32.`,
		);
	}

	const width = view.getUint32(WIDTH_AT, true);
	const height = view.getUint32(HEIGHT_AT, true);
	if (width < 1 || height < 1) {
		fail('it declares a width or a height of zero.');
	}
	if (width * height > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}

	const layout = readLayout(bytes, view);
	const { surface, dataAt } = layout;

	// Length is proved before the raster is allocated, so a header claiming
	// 60000 by 60000 with a kilobyte behind it costs nothing.
	const needed =
		surface.kind === 'block'
			? blockSurfaceBytes(width, height, surface.block)
			: width * height * surface.plain.bytesPerPixel;
	requireBytes(bytes, dataAt, needed, 'the end of its first surface');

	const image = createRaster(width, height, 'srgb', false);
	if (surface.kind === 'block') {
		decodeBlockSurface(bytes, dataAt, image, surface.block);
	} else {
		readPlainSurface(bytes, view, dataAt, image, surface.plain);
	}
	if (layout.premultiplied) unpremultiply(image);

	return { ...image, hasAlpha: detectAlpha(image) };
}
