/**
 * A ZSoft PCX reader.
 *
 * PCX is one of the oldest formats anything still writes, and every one of its
 * three peculiarities is a way to produce an image that is almost right. The
 * dimensions are a window given as inclusive corners, so the width is a
 * subtraction plus one and an off-by-one loses the last column. The pixels of a
 * row are spread across separate planes rather than interleaved. And each plane
 * of each row is padded out to `bytesPerLine` bytes, a number only the header
 * knows, so treating that padding as pixels shears the whole picture diagonally
 * by a growing amount, which is the classic way to get this format wrong.
 *
 * What it reads: encoding 0 (raw) and encoding 1 (run length), at 1 bit on one
 * plane, 1 bit on four planes, 4 bits on one plane, 8 bits on one plane, and 8
 * bits on three or four planes, where a fourth plane is the alpha channel
 * ImageMagick adds. Colours come from the 256 entry table at the tail of a
 * version 5 file, from the 16 entry table in the header, or from a grey ramp
 * when the file carries neither. What it refuses by name: every other depth and
 * plane combination, an encoding the format does not define, a version ZSoft
 * never shipped, and a window that is inside out.
 *
 * Every read is bounds checked, because these bytes came from a file somebody
 * else made. A truncated PCX must produce a sentence naming what it stopped
 * inside, not an undefined that becomes a black row further down.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'pcx-pure';

/** Fixed at 128 bytes. Pixel data begins immediately after it, always. */
const HEADER_BYTES = 128;

/** ZSoft's manufacturer byte, and the whole of the format's signature. */
const MANUFACTURER = 0x0a;

const ENCODING_NONE = 0;
const ENCODING_RLE = 1;

/**
 * The versions ZSoft shipped: 2.5, 2.8 with a palette, 2.8 without one, PC
 * Paintbrush for Windows, and 3.0. There has never been a version 1.
 */
const KNOWN_VERSIONS = [0, 2, 3, 4, 5];

/** The version that added the 256 colour table at the tail of the file. */
const VGA_PALETTE_VERSION = 5;

/** The trailing colour table: a marker byte and then 256 RGB triples. */
const VGA_PALETTE_BYTES = 769;
const VGA_PALETTE_MARKER = 0x0c;

/** PaletteInfo 1 means colour or black and white, 2 means a grey ramp. */
const PALETTE_INFO_GREYSCALE = 2;

/** The header's own colour table: 16 RGB triples at offset 16. */
const EGA_PALETTE_AT = 16;
const EGA_PALETTE_ENTRIES = 16;

/**
 * The largest image this decoder will allocate for.
 *
 * The same ceiling the QOI, TGA and PNM readers use. The window is four 16 bit
 * fields with nothing to corroborate them, so a 128 byte file can honestly
 * describe four billion pixels and ask for sixteen gigabytes of raster. The
 * converter applies its own `maxPixels` on top of this; this one exists so the
 * decoder is safe to call on its own.
 */
const MAX_PIXELS = 400_000_000;

/**
 * The IBM EGA palette, for a 16 colour file that left its own table blank.
 *
 * Writers that only ever expected to be read back on the machine that made
 * them left the header table at zero and relied on the display adapter's
 * registers, which are long gone. Mapping every index to black would hand back
 * a black rectangle, and this is the table those files were looking at.
 */
const DEFAULT_EGA_PALETTE = Uint8Array.from([
	0, 0, 0, 0, 0, 170, 0, 170, 0, 0, 170, 170, 170, 0, 0, 170, 0, 170, 170, 85, 0, 170, 170, 170, 85,
	85, 85, 85, 85, 255, 85, 255, 85, 85, 255, 255, 255, 85, 85, 255, 85, 255, 255, 255, 85, 255, 255,
	255,
]);

function fail(detail: string): never {
	throw new DecodeFailedError('pcx', DECODER_ID, detail);
}

/** PCX is little endian throughout. */
function readU16(bytes: Uint8Array, at: number): number {
	return (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
}

/** What the depth and plane count together say the pixels are. */
type Shape = 'indexed' | 'ega-planes' | 'truecolour';

interface PcxHeader {
	readonly version: number;
	readonly encoding: number;
	readonly bitsPerPixel: number;
	readonly planes: number;
	readonly width: number;
	readonly height: number;
	/**
	 * Bytes each plane of a row occupies in the file.
	 *
	 * Per plane, not per row, and free to be larger than the pixels need. Using
	 * it as the stride and reading only `width` pixels out of it is the whole
	 * of the padding rule.
	 */
	readonly bytesPerLine: number;
	readonly paletteInfo: number;
	readonly shape: Shape;
}

/**
 * Refuse a depth and plane combination this reader does not implement.
 *
 * Named individually rather than reported as a pair of numbers, because each of
 * these is a real thing some writer produces and somebody holding one is better
 * served by being told what they have than by being told two integers.
 */
function refuseShape(bitsPerPixel: number, planes: number): never {
	if (bitsPerPixel === 2 && planes === 1) {
		fail('it is a four colour CGA image, which this reader does not implement.');
	}
	if (bitsPerPixel === 1 && (planes === 2 || planes === 3)) {
		fail(
			`it stores one bit across ${planes} planes, a reduced EGA mode which this reader does not implement.`,
		);
	}
	fail(
		`it is ${bitsPerPixel} bits per pixel across ${planes} planes, which is not a combination this reader implements.`,
	);
}

function readHeader(bytes: Uint8Array): PcxHeader {
	if (bytes.length < HEADER_BYTES) {
		fail('it is too short to hold the 128 byte header every PCX begins with.');
	}
	if ((bytes[0] as number) !== MANUFACTURER) {
		fail('it does not begin with the ZSoft manufacturer byte every PCX begins with.');
	}

	const version = bytes[1] as number;
	if (!KNOWN_VERSIONS.includes(version)) {
		fail(`it declares version ${version}, which is not a PCX version ZSoft ever shipped.`);
	}

	const encoding = bytes[2] as number;
	if (encoding !== ENCODING_NONE && encoding !== ENCODING_RLE) {
		fail(`it declares encoding ${encoding}, and PCX defines only 0 and 1.`);
	}

	const bitsPerPixel = bytes[3] as number;
	if (![1, 2, 4, 8].includes(bitsPerPixel)) {
		fail(`it declares ${bitsPerPixel} bits per pixel, which the format does not define.`);
	}

	const planes = bytes[65] as number;
	if (planes < 1 || planes > 4) {
		fail(`it declares ${planes} colour planes, and PCX allows one to four.`);
	}

	// The window is inclusive at both ends, so a one pixel image has xMax equal
	// to xMin. Forgetting the plus one loses the last column and the last row,
	// which on a photograph is invisible and on a sprite sheet is not.
	const xMin = readU16(bytes, 4);
	const yMin = readU16(bytes, 6);
	const xMax = readU16(bytes, 8);
	const yMax = readU16(bytes, 10);
	if (xMax < xMin || yMax < yMin) {
		fail('its window is inside out: the far corner is above or to the left of the near one.');
	}
	const width = xMax - xMin + 1;
	const height = yMax - yMin + 1;
	if (width * height > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}

	let shape: Shape;
	if (bitsPerPixel === 8 && (planes === 3 || planes === 4)) {
		shape = 'truecolour';
	} else if (bitsPerPixel === 1 && planes === 4) {
		shape = 'ega-planes';
	} else if (planes === 1 && (bitsPerPixel === 1 || bitsPerPixel === 4 || bitsPerPixel === 8)) {
		shape = 'indexed';
	} else {
		refuseShape(bitsPerPixel, planes);
	}

	const bytesPerLine = readU16(bytes, 66);
	// The specification says this is always even, and every writer obeys. An odd
	// value is still honoured rather than refused: it is the stride, so taking
	// the file at its word reads the image correctly, where rounding it up would
	// shear every row by one byte more than the last.
	const needed = Math.ceil((width * bitsPerPixel) / 8);
	if (bytesPerLine < needed) {
		fail(
			`its header gives ${bytesPerLine} bytes per plane for a row ${width} pixels wide, which is not enough to hold one.`,
		);
	}

	return {
		version,
		encoding,
		bitsPerPixel,
		planes,
		width,
		height,
		bytesPerLine,
		paletteInfo: readU16(bytes, 68),
		shape,
	};
}

/**
 * Where the 256 colour table starts, or -1 when there is not one.
 *
 * It lives at the very end of the file rather than at a recorded offset, so it
 * is found by measuring backwards and checking the marker byte. A file whose
 * last 769 bytes happen to begin with 0x0C and which is not carrying a palette
 * would be misread, which is why this is only consulted for the one shape that
 * can have one.
 */
function findVgaPalette(bytes: Uint8Array): number {
	if (bytes.length < HEADER_BYTES + VGA_PALETTE_BYTES) return -1;
	const at = bytes.length - VGA_PALETTE_BYTES;
	return (bytes[at] as number) === VGA_PALETTE_MARKER ? at : -1;
}

function allZero(bytes: Uint8Array, at: number, count: number): boolean {
	for (let i = 0; i < count; i += 1) {
		if ((bytes[at + i] as number) !== 0) return false;
	}
	return true;
}

/** A colour table as RGB triples, which is the layout both tables already use. */
function copyTriples(bytes: Uint8Array, at: number, entries: number): Uint8Array {
	return bytes.slice(at, at + entries * 3);
}

/**
 * The two colours of a monochrome file.
 *
 * Taken from the header, which is where the format puts them, so a bit that is
 * set means whatever entry 1 says it means. Not every reader agrees: ImageMagick
 * ignores the table at this depth and hardcodes a set bit to black, so its own
 * monochrome files read back inverted here and in Pillow, both of which follow
 * the table. Following the file is the only one of the three positions that can
 * be defended from the specification.
 *
 * A file whose two entries are the same colour is describing an image nobody
 * can see, and that is exactly what a writer which left the table blank
 * produced. Black and white is what those files meant.
 */
function monoPalette(bytes: Uint8Array): Uint8Array {
	const table = copyTriples(bytes, EGA_PALETTE_AT, 2);
	const same = table[0] === table[3] && table[1] === table[4] && table[2] === table[5];
	if (!same) return table;
	return Uint8Array.from([0, 0, 0, 255, 255, 255]);
}

/** The header's 16 entries, or the EGA default when it left them all at zero. */
function egaPalette(bytes: Uint8Array): Uint8Array {
	if (allZero(bytes, EGA_PALETTE_AT, EGA_PALETTE_ENTRIES * 3)) return DEFAULT_EGA_PALETTE;
	return copyTriples(bytes, EGA_PALETTE_AT, EGA_PALETTE_ENTRIES);
}

/**
 * The 256 entry table for an 8 bit file that has no trailing one.
 *
 * A grey ramp underneath, with the header's 16 colours laid over the bottom of
 * it where the file has any and has not said it is greyscale. The ramp is not a
 * guess about what those upper 240 indices meant: nothing in the file says, and
 * a ramp keeps the shape of the picture visible where filling them with black
 * would erase most of it.
 */
function fallback256(bytes: Uint8Array, paletteInfo: number): Uint8Array {
	const table = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i += 1) {
		table[i * 3] = i;
		table[i * 3 + 1] = i;
		table[i * 3 + 2] = i;
	}
	if (
		paletteInfo !== PALETTE_INFO_GREYSCALE &&
		!allZero(bytes, EGA_PALETTE_AT, EGA_PALETTE_ENTRIES * 3)
	) {
		table.set(bytes.subarray(EGA_PALETTE_AT, EGA_PALETTE_AT + EGA_PALETTE_ENTRIES * 3), 0);
	}
	return table;
}

/** The colour table for a single plane file, whichever of the three it has. */
function indexedPalette(bytes: Uint8Array, header: PcxHeader, vgaAt: number): Uint8Array {
	if (header.bitsPerPixel === 1) return monoPalette(bytes);
	if (header.bitsPerPixel === 4) return egaPalette(bytes);
	if (vgaAt >= 0) return copyTriples(bytes, vgaAt + 1, 256);
	return fallback256(bytes, header.paletteInfo);
}

/**
 * Expand run length encoded pixel data.
 *
 * A byte with its top two bits set is a tag: the low six bits are a count and
 * the byte after it is the value. Anything else is one literal byte, which is
 * why a literal in the range 0xC0 to 0xFF has to be written as a run of one and
 * why the encoding can grow a file rather than shrink it.
 *
 * The specification says a run never crosses a scan line, and every writer
 * obeys, but the stream is expanded continuously here rather than a row at a
 * time. That reads a conforming file identically and also reads the occasional
 * file that does cross, where stopping at the row boundary would drop bytes and
 * shift everything after them.
 */
function expandRle(bytes: Uint8Array, from: number, end: number, total: number): Uint8Array {
	// The densest a run gets is two input bytes standing for 63 output bytes, so
	// this is the most the remaining bytes could possibly expand to. Checking it
	// first is the difference between refusing a 200 byte file and allocating
	// the gigabyte its header asked for.
	const available = end - from;
	const ceiling = Math.floor(available / 2) * 63 + (available % 2);
	if (total > ceiling) {
		fail('its compressed pixel data is too short to describe an image of that size.');
	}

	const out = new Uint8Array(total);
	let written = 0;
	let at = from;

	while (written < total) {
		if (at >= end) fail('its pixel data ends before every row has been filled in.');
		const tag = bytes[at] as number;
		at += 1;
		if ((tag & 0xc0) !== 0xc0) {
			out[written] = tag;
			written += 1;
			continue;
		}
		if (at >= end) fail('a run at the end of its pixel data is missing the byte it repeats.');
		const value = bytes[at] as number;
		at += 1;
		// A count of zero is legal to write and means nothing, so it is filled as
		// the empty run it is. The loop still consumes two bytes, so a file made
		// entirely of them runs out of input and is refused rather than spinning.
		const count = tag & 0x3f;
		if (written + count > total) fail('a run reaches past the end of its last row.');
		out.fill(value, written, written + count);
		written += count;
	}

	return out;
}

/** Encoding 0: the rows are simply there, padding and all. */
function readRaw(bytes: Uint8Array, from: number, end: number, total: number): Uint8Array {
	if (end - from < total) {
		fail('its uncompressed pixel data ends before every row has been filled in.');
	}
	return bytes.subarray(from, from + total);
}

/**
 * One row of an indexed image, at 1, 4 or 8 bits in a single plane.
 *
 * Only the first `width` pixels of the plane are read. Everything after them is
 * the padding that makes `bytesPerLine` come out even, and reading it as pixels
 * is what shears the picture.
 */
function readIndexedRow(
	data: Uint8Array,
	at: number,
	width: number,
	bitsPerPixel: number,
	palette: Uint8Array,
	target: Uint8ClampedArray,
	to: number,
): void {
	const perByte = 8 / bitsPerPixel;
	const valueMask = (1 << bitsPerPixel) - 1;
	for (let x = 0; x < width; x += 1) {
		let index: number;
		if (bitsPerPixel === 8) {
			index = data[at + x] as number;
		} else {
			// The leftmost pixel of a byte lives in its high bits.
			const byte = data[at + Math.floor(x / perByte)] as number;
			index = (byte >> (8 - bitsPerPixel - (x % perByte) * bitsPerPixel)) & valueMask;
		}
		const from = index * 3;
		const put = to + x * 4;
		target[put] = palette[from] as number;
		target[put + 1] = palette[from + 1] as number;
		target[put + 2] = palette[from + 2] as number;
		target[put + 3] = 255;
	}
}

/**
 * One row of a four plane EGA image.
 *
 * Each plane carries one bit of the index for every pixel of the row, and plane
 * 0 carries the least significant of them. Reading the planes the other way
 * round produces an image that is still an image, in the wrong sixteen colours,
 * which is why the order is stated here rather than left to the loop.
 */
function readPlanarRow(
	data: Uint8Array,
	at: number,
	bytesPerLine: number,
	width: number,
	palette: Uint8Array,
	target: Uint8ClampedArray,
	to: number,
): void {
	for (let x = 0; x < width; x += 1) {
		const byte = x >> 3;
		const shift = 7 - (x & 7);
		let index = 0;
		for (let plane = 0; plane < 4; plane += 1) {
			index |= (((data[at + plane * bytesPerLine + byte] as number) >> shift) & 1) << plane;
		}
		const from = index * 3;
		const put = to + x * 4;
		target[put] = palette[from] as number;
		target[put + 1] = palette[from + 1] as number;
		target[put + 2] = palette[from + 2] as number;
		target[put + 3] = 255;
	}
}

/**
 * One row of a truecolour image, plane by plane: red, then green, then blue.
 *
 * A fourth plane is alpha. That is not in ZSoft's specification, which stopped
 * at three, but it is what ImageMagick writes whenever the source has an alpha
 * channel, so `magick logo.png logo.pcx` produces one and refusing it would
 * mean refusing most of the PCX files anybody makes today. A file with three
 * planes is opaque, which is the only thing three planes can mean.
 */
function readTruecolourRow(
	data: Uint8Array,
	at: number,
	bytesPerLine: number,
	width: number,
	planes: number,
	target: Uint8ClampedArray,
	to: number,
): void {
	const alphaAt = at + bytesPerLine * 3;
	for (let x = 0; x < width; x += 1) {
		const put = to + x * 4;
		target[put] = data[at + x] as number;
		target[put + 1] = data[at + bytesPerLine + x] as number;
		target[put + 2] = data[at + bytesPerLine * 2 + x] as number;
		target[put + 3] = planes === 4 ? (data[alphaAt + x] as number) : 255;
	}
}

/**
 * Read a PCX into straight RGBA.
 *
 * Always sRGB: PCX has no way to record a colour space, so it is stated rather
 * than inferred. Opaque too, unless the file carries the fourth plane some
 * writers use for alpha. Rows are stored top first, so the result is already
 * upright with nothing to undo.
 */
export function decodePcx(bytes: Uint8Array): RasterImage {
	const header = readHeader(bytes);
	const { width, height, bitsPerPixel, planes, bytesPerLine, shape } = header;

	// Only an 8 bit single plane file can carry the trailing table, and only from
	// version 5 on. A version 2 or 3 file at that depth has nothing at the tail
	// and takes its colours from the header, which is the case the fallback
	// below exists for.
	const vgaAt =
		shape === 'indexed' && bitsPerPixel === 8 && header.version >= VGA_PALETTE_VERSION
			? findVgaPalette(bytes)
			: -1;

	// The trailing table is not pixel data, so a run is not allowed to reach into
	// it. Bounding the stream here rather than trusting it to stop on its own is
	// what keeps a corrupt file from painting its own palette across the picture.
	const dataEnd = vgaAt >= 0 ? vgaAt : bytes.length;
	const rowBytes = bytesPerLine * planes;
	const total = rowBytes * height;
	const data =
		header.encoding === ENCODING_RLE
			? expandRle(bytes, HEADER_BYTES, dataEnd, total)
			: readRaw(bytes, HEADER_BYTES, dataEnd, total);

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;

	// Three loops rather than one loop and a branch, so each shape's colour table
	// is chosen once beside the only reader that uses it.
	if (shape === 'truecolour') {
		for (let y = 0; y < height; y += 1) {
			readTruecolourRow(data, y * rowBytes, bytesPerLine, width, planes, target, y * width * 4);
		}
	} else if (shape === 'ega-planes') {
		const palette = egaPalette(bytes);
		for (let y = 0; y < height; y += 1) {
			readPlanarRow(data, y * rowBytes, bytesPerLine, width, palette, target, y * width * 4);
		}
	} else {
		const palette = indexedPalette(bytes, header, vgaAt);
		for (let y = 0; y < height; y += 1) {
			readIndexedRow(data, y * rowBytes, width, bitsPerPixel, palette, target, y * width * 4);
		}
	}

	// Only the four plane form can produce anything but 255, and even then a
	// writer that added the plane without using it is common, so this is
	// measured rather than assumed.
	return planes === 4 ? { ...image, hasAlpha: detectAlpha(image) } : image;
}
