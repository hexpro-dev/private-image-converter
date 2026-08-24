/**
 * A BMP reader.
 *
 * BMP is a family rather than a format: five header versions, six declared
 * compression methods and six pixel depths, most combinations of which do not
 * occur. This reads the ones that do, and refuses the rest by name.
 *
 * What it reads: BITMAPCOREHEADER and everything from BITMAPINFOHEADER up,
 * BI_RGB at 1, 4, 8, 16, 24 and 32 bits, BI_BITFIELDS and BI_ALPHABITFIELDS at
 * 16 and 32, palettes with either three or four byte entries, and both row
 * orders. What it refuses: the two run length encodings, the two container
 * escapes (BI_JPEG and BI_PNG), and anything else the compression field claims.
 *
 * Every read is bounds checked, because these bytes came from a file somebody
 * else made. A truncated BMP must produce a sentence, not an undefined that
 * turns into a black row a hundred lines later.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'bmp';

const FILE_HEADER_BYTES = 14;
const CORE_HEADER_BYTES = 12;
const INFO_HEADER_BYTES = 40;
/** BITMAPV2INFOHEADER, the first version to carry the masks inside the header. */
const V2_HEADER_BYTES = 52;
/** BITMAPV3INFOHEADER, the first to carry an alpha mask inside the header. */
const V3_HEADER_BYTES = 56;
/** BITMAPCOREHEADER2, the OS/2 2.x header. Windows never defined one this size. */
const OS2_HEADER_BYTES = 64;

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_JPEG = 4;
const BI_PNG = 5;
const BI_ALPHABITFIELDS = 6;

function fail(detail: string): never {
	throw new DecodeFailedError('bmp', DECODER_ID, detail);
}

/**
 * The one place a length is compared against the buffer.
 *
 * Funnelling every read through this is what keeps the failure mode honest:
 * a short file names the structure it stopped inside instead of reading
 * undefined and carrying on.
 */
function requireBytes(bytes: Uint8Array, at: number, count: number, what: string): void {
	if (at < 0 || count < 0 || at + count > bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

/** One channel of a BI_BITFIELDS pixel, reduced to the arithmetic that extracts it. */
interface Channel {
	/**
	 * The run of bits this channel actually reads.
	 *
	 * Not the mask as the file wrote it: see `channelOf`. Keeping the reduced
	 * form here is what makes `sample` a plain shift, and it is the difference
	 * between a scattered mask producing a small number and producing one far
	 * larger than `max`, which clamps every pixel to 255.
	 */
	readonly mask: number;
	readonly shift: number;
	/** The largest value the mask can hold, which is what scales it to 0 to 255. */
	readonly max: number;
}

const EMPTY_CHANNEL: Channel = { mask: 0, shift: 0, max: 0 };

/**
 * Turn a channel mask into a shift and a range.
 *
 * Only the lowest contiguous run of set bits is used. Masks in real files are
 * always contiguous, and a reader that tried to honour a scattered one would
 * have to invent a bit order to gather it into.
 */
function channelOf(mask: number): Channel {
	if (mask === 0) return EMPTY_CHANNEL;
	let shift = 0;
	while (((mask >>> shift) & 1) === 0) shift += 1;
	let bits = 0;
	// The bound matters: `x >>> 32` is `x >>> 0` in JavaScript, so a mask of all
	// ones would spin here forever without it.
	while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits += 1;
	const max = 2 ** bits - 1;
	// The reduced mask, not the declared one. Extracting through the declared
	// mask would carry any bits above the run into the result, and a value
	// larger than `max` scales past 255 and clamps, so a pixel whose channel is
	// actually zero would come out fully lit.
	return { mask: (max << shift) >>> 0, shift, max };
}

function sample(raw: number, channel: Channel): number {
	if (channel.max === 0) return 0;
	if (channel.max === 255) return (raw & channel.mask) >>> channel.shift;
	// Five bits of red are 0 to 31, and 31 has to land on 255 rather than 248,
	// or every white pixel in a 16 bit file comes out slightly grey.
	return Math.round((((raw & channel.mask) >>> channel.shift) * 255) / channel.max);
}

interface BmpHeader {
	readonly headerSize: number;
	readonly width: number;
	readonly height: number;
	readonly bitCount: number;
	/** A negative height in the file, meaning the first row stored is the top one. */
	readonly topDown: boolean;
	readonly coloursUsed: number;
	/** Three for BITMAPCOREHEADER's RGBTRIPLE, four for everything since. */
	readonly paletteEntryBytes: number;
	readonly stride: number;
	readonly pixelOffset: number;
	readonly red: Channel;
	readonly green: Channel;
	readonly blue: Channel;
	readonly alpha: Channel;
	/**
	 * Whether the file named an alpha mask, rather than the reader assuming one.
	 *
	 * A 32 bit BI_RGB file has a fourth byte the specification calls reserved,
	 * so reading it as alpha is a guess that has to be taken back when it turns
	 * out to be zero everywhere. A header that carries an alpha mask is not
	 * guessing, and a file that says every pixel is transparent means it.
	 */
	readonly alphaDeclared: boolean;
}

function refuseCompression(compression: number): never {
	switch (compression) {
		case BI_RLE8:
			fail('it uses BI_RLE8 run length compression, which this reader does not implement.');
			break;
		case BI_RLE4:
			fail('it uses BI_RLE4 run length compression, which this reader does not implement.');
			break;
		case BI_JPEG:
			fail('it wraps a JPEG (BI_JPEG), which this reader does not unpack.');
			break;
		case BI_PNG:
			fail('it wraps a PNG (BI_PNG), which this reader does not unpack.');
			break;
		default:
			fail(`it declares compression method ${compression}, which this reader does not know.`);
	}
}

function readHeader(bytes: Uint8Array, view: DataView): BmpHeader {
	requireBytes(bytes, 0, FILE_HEADER_BYTES, 'the end of its file header');
	if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
		fail('it does not start with the two byte "BM" signature every BMP begins with.');
	}
	// The file size at offset 2 is deliberately not trusted. Plenty of writers
	// leave it stale, and the buffer we were handed is the authority on length.
	const pixelOffset = view.getUint32(10, true);

	requireBytes(bytes, FILE_HEADER_BYTES, 4, 'the size of its information header');
	const headerSize = view.getUint32(FILE_HEADER_BYTES, true);
	requireBytes(bytes, FILE_HEADER_BYTES, headerSize, 'the end of its information header');

	let width: number;
	let rawHeight: number;
	let planes: number;
	let bitCount: number;
	let compression = BI_RGB;
	let coloursUsed = 0;
	let paletteEntryBytes = 4;

	if (headerSize === CORE_HEADER_BYTES) {
		// OS/2 1.x. Unsigned 16 bit dimensions, no compression field, and a
		// colour table of three byte entries.
		width = view.getUint16(18, true);
		rawHeight = view.getUint16(20, true);
		planes = view.getUint16(22, true);
		bitCount = view.getUint16(24, true);
		paletteEntryBytes = 3;
	} else if (headerSize >= INFO_HEADER_BYTES) {
		width = view.getInt32(18, true);
		rawHeight = view.getInt32(22, true);
		planes = view.getUint16(26, true);
		bitCount = view.getUint16(28, true);
		compression = view.getUint32(30, true);
		coloursUsed = view.getUint32(46, true);
	} else {
		fail(`its information header is ${headerSize} bytes, which is not a size this reader knows.`);
	}

	if (planes !== 1) {
		fail(`it declares ${planes} colour planes, and a BMP always has exactly one.`);
	}
	if (width < 1) {
		fail('it declares a width of zero or less.');
	}
	// The most negative int32 has no positive counterpart, so guard before the
	// negation rather than after it.
	if (rawHeight === 0 || rawHeight === -0x80000000) {
		fail('it declares a height no image can have.');
	}
	const topDown = rawHeight < 0;
	const height = Math.abs(rawHeight);

	// An OS/2 2.x header numbers the compression field its own way: 3 is Huffman
	// 1D and 4 is 24 bit run length, where Windows means BI_BITFIELDS and
	// BI_JPEG. Its first 40 bytes are laid out identically, so everything else
	// about it reads correctly, but taking 3 at Windows' meaning would go
	// looking for masks in a header that has none and paint the result.
	if (headerSize === OS2_HEADER_BYTES && compression !== BI_RGB) {
		fail(
			`it is an OS/2 bitmap using compression method ${compression}, which this reader does not implement.`,
		);
	}

	const bitfields = compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS;
	if (compression !== BI_RGB && !bitfields) {
		refuseCompression(compression);
	}
	if (![1, 4, 8, 16, 24, 32].includes(bitCount)) {
		fail(`it is ${bitCount} bits per pixel, which is not a depth this reader knows.`);
	}
	if (bitfields && bitCount !== 16 && bitCount !== 32) {
		fail(`it claims BI_BITFIELDS at ${bitCount} bits per pixel, where masks have no meaning.`);
	}

	let red = EMPTY_CHANNEL;
	let green = EMPTY_CHANNEL;
	let blue = EMPTY_CHANNEL;
	let alpha = EMPTY_CHANNEL;
	let alphaDeclared = false;

	if (bitfields) {
		// From BITMAPV2INFOHEADER on the masks are fields of the header itself.
		// Before that they sit immediately after it, in the space a palette
		// would otherwise occupy, which for a 40 byte header is the same offset.
		const inHeader = headerSize >= V2_HEADER_BYTES;
		const masksAt = FILE_HEADER_BYTES + (inHeader ? INFO_HEADER_BYTES : headerSize);
		requireBytes(bytes, masksAt, 12, 'the three channel masks its header promises');
		red = channelOf(view.getUint32(masksAt, true));
		green = channelOf(view.getUint32(masksAt + 4, true));
		blue = channelOf(view.getUint32(masksAt + 8, true));

		const hasAlphaMask = inHeader
			? headerSize >= V3_HEADER_BYTES
			: compression === BI_ALPHABITFIELDS;
		if (hasAlphaMask) {
			requireBytes(bytes, masksAt + 12, 4, 'the alpha mask its header promises');
			alpha = channelOf(view.getUint32(masksAt + 12, true));
			alphaDeclared = alpha.max !== 0;
		}
		if (red.max === 0 && green.max === 0 && blue.max === 0) {
			fail('it claims BI_BITFIELDS but leaves every colour mask empty.');
		}
	} else if (bitCount === 16) {
		// BI_RGB at 16 bits has one fixed meaning: X1R5G5B5.
		red = channelOf(0x7c00);
		green = channelOf(0x03e0);
		blue = channelOf(0x001f);
	} else if (bitCount === 32) {
		red = channelOf(0x00ff0000);
		green = channelOf(0x0000ff00);
		blue = channelOf(0x000000ff);
		// The top byte is reserved under BI_RGB, but writers use it for alpha
		// far more often than they announce it. Read it, then undo that below
		// if the file turns out to have left it at zero everywhere.
		alpha = channelOf(0xff000000);
	}

	const stride = Math.ceil((width * bitCount) / 32) * 4;
	if (pixelOffset < FILE_HEADER_BYTES + headerSize) {
		fail('its pixel data offset points back inside its own header.');
	}
	requireBytes(bytes, pixelOffset, stride * height, 'the end of its pixel data');

	// A raster is one typed array of four bytes a pixel, so an image that cannot
	// be addressed as one is refused here rather than surfacing as a RangeError
	// out of the allocator. Only a genuinely enormous file reaches this: the
	// check above already proved every one of those rows is present.
	if (width * height * 4 > 0xffffffff) {
		fail('it is larger than this reader can hold in one buffer.');
	}

	return {
		headerSize,
		width,
		height,
		bitCount,
		topDown,
		coloursUsed,
		paletteEntryBytes,
		stride,
		pixelOffset,
		red,
		green,
		blue,
		alpha,
		alphaDeclared,
	};
}

/** The colour table, expanded to opaque RGBA so the pixel loop is a straight copy. */
function readPalette(bytes: Uint8Array, header: BmpHeader): Uint8Array {
	const maximum = 1 << header.bitCount;
	const at = FILE_HEADER_BYTES + header.headerSize;
	// The table ends where the pixels begin. BITMAPCOREHEADER has no count
	// field at all, and writers that only emit the colours they used often
	// leave the count at zero, so the gap is the more reliable of the two.
	const room = Math.floor((header.pixelOffset - at) / header.paletteEntryBytes);
	const count = header.coloursUsed === 0 ? Math.min(maximum, room) : header.coloursUsed;

	if (count < 1) {
		fail('it is palettised but carries no colour table.');
	}
	if (count > maximum) {
		fail(
			`its colour table declares ${count} entries, more than the ${maximum} a ${header.bitCount} bit image can index.`,
		);
	}
	if (count > room) {
		fail('its colour table would run past the start of its own pixel data.');
	}
	requireBytes(bytes, at, count * header.paletteEntryBytes, 'the end of its colour table');

	const palette = new Uint8Array(count * 4);
	for (let i = 0; i < count; i += 1) {
		const from = at + i * header.paletteEntryBytes;
		palette[i * 4] = bytes[from + 2] as number;
		palette[i * 4 + 1] = bytes[from + 1] as number;
		palette[i * 4 + 2] = bytes[from] as number;
		// The fourth byte of an RGBQUAD is reserved and is zero in practice, so
		// a palettised BMP is always opaque.
		palette[i * 4 + 3] = 255;
	}
	return palette;
}

function readIndexedRow(
	bytes: Uint8Array,
	rowAt: number,
	width: number,
	bitCount: number,
	palette: Uint8Array,
	target: Uint8ClampedArray,
	to: number,
): void {
	const entries = palette.length / 4;
	const perByte = 8 / bitCount;
	const valueMask = (1 << bitCount) - 1;
	for (let x = 0; x < width; x += 1) {
		let index: number;
		if (bitCount === 8) {
			index = bytes[rowAt + x] as number;
		} else {
			// The first pixel of a byte lives in its high bits.
			const byte = bytes[rowAt + Math.floor(x / perByte)] as number;
			index = (byte >> (8 - bitCount - (x % perByte) * bitCount)) & valueMask;
		}
		if (index >= entries) {
			fail('it refers to a colour its own colour table does not contain.');
		}
		const from = index * 4;
		const at = to + x * 4;
		target[at] = palette[from] as number;
		target[at + 1] = palette[from + 1] as number;
		target[at + 2] = palette[from + 2] as number;
		target[at + 3] = palette[from + 3] as number;
	}
}

export function decodeBmp(bytes: Uint8Array): RasterImage {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = readHeader(bytes, view);
	const { width, height, bitCount, topDown, stride, pixelOffset, red, green, blue, alpha } = header;
	const { alphaDeclared } = header;

	const palette = bitCount <= 8 ? readPalette(bytes, header) : undefined;
	const out = createRaster(width, height, 'srgb', false);
	const target = out.data;

	for (let y = 0; y < height; y += 1) {
		// A positive height in the file means the rows were stored bottom first,
		// so the last row read is the top row of the image.
		const rowAt = pixelOffset + (topDown ? y : height - 1 - y) * stride;
		const to = y * width * 4;

		if (palette) {
			readIndexedRow(bytes, rowAt, width, bitCount, palette, target, to);
			continue;
		}

		if (bitCount === 24) {
			for (let x = 0; x < width; x += 1) {
				const from = rowAt + x * 3;
				const at = to + x * 4;
				target[at] = bytes[from + 2] as number;
				target[at + 1] = bytes[from + 1] as number;
				target[at + 2] = bytes[from] as number;
				target[at + 3] = 255;
			}
			continue;
		}

		for (let x = 0; x < width; x += 1) {
			const from = rowAt + x * (bitCount / 8);
			const raw = bitCount === 16 ? view.getUint16(from, true) : view.getUint32(from, true);
			const at = to + x * 4;
			target[at] = sample(raw, red);
			target[at + 1] = sample(raw, green);
			target[at + 2] = sample(raw, blue);
			target[at + 3] = alpha.max === 0 ? 255 : sample(raw, alpha);
		}
	}

	if (alpha.max !== 0 && !alphaDeclared) {
		// The alpha here was a guess: a 32 bit BI_RGB file whose fourth byte the
		// specification calls reserved. Zero in every pixel means the writer left
		// that byte alone far more often than it means an image nobody can see,
		// so the guess is taken back. A header that names an alpha mask is not
		// guessing, and its zeroes are honoured, or a fully transparent image
		// could not survive being written and read back.
		let anyOpacity = false;
		for (let i = 3; i < target.length; i += 4) {
			if (target[i] !== 0) {
				anyOpacity = true;
				break;
			}
		}
		if (!anyOpacity) {
			for (let i = 3; i < target.length; i += 4) target[i] = 255;
		}
	}

	// BMP can name sRGB and it can embed a profile in a BITMAPV5HEADER, but it
	// has no way to say Display P3, so nothing here can widen the gamut claim.
	return { ...out, hasAlpha: detectAlpha(out) };
}
