/**
 * An OpenEXR writer.
 *
 * The one output here that keeps the light rather than a picture of it. An
 * eight bit file has already had somebody's display transform baked into it and
 * clipped everything above white; an EXR carries the sun and the shadow under
 * the table in the same frame, which is why a renderer, a compositor and a
 * colourist all read this format and why converting into it is worth doing even
 * when the source cannot fill the range.
 *
 * Samples go out as HALF, sixteen bits, which is what every compositor expects
 * and what libOpenEXR's own RGBA interface writes. FLOAT would double the file
 * for precision nothing downstream of a render needs, and UINT is for object
 * identifiers rather than for light. The channel list is alphabetical, A then B
 * then G then R, because that is the order the pixels are stored in and a
 * writer that lists them in the order a person thinks about them produces a
 * file every reader opens with its red and blue swapped.
 *
 * Two other things here look right when they are wrong. The data window is
 * inclusive at both ends, so a four by three image ends at 3 and 2 rather than
 * at 4 and 3, and a window one too large is a legal header describing a picture
 * with a row and a column of whatever followed the pixels along two of its
 * edges. And a ZIP block is the reader's two steps in reverse: the bytes are
 * interleaved first, then differenced against their neighbour, then deflated.
 * The reader undoes the difference before the interleave, so an encoder that
 * differences first writes a file that still decodes, just to noise.
 *
 * `encodeExr` undoes the sRGB transfer curve on the way in, through
 * `floatFromRaster`, and that is not optional. Skipping it does not look like a
 * mistake: the file opens, the colours are recognisable, and every midtone in
 * it is about a stop out.
 *
 * Nothing here needs anything from the platform. ZIP wants a `CompressionStream`
 * and falls back to NO_COMPRESSION when there is not one, because an
 * uncompressed EXR is always legal and always readable, which makes this the
 * one format in this package that can be written anywhere at all.
 */

import { ByteWriter } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';
import { floatFromRaster } from '../../raster/float.js';
import type { EncodeOptions, FloatImage, RasterImage } from '../../types.js';

const ENCODER_ID = 'exr-pure';

/** 20000630 written as a little endian int32, which is what these four bytes spell. */
const MAGIC = Uint8Array.from([0x76, 0x2f, 0x31, 0x01]);

/** Version 2 with no flags: scan lines, short names, one part, no deep pixels. */
const VERSION = 2;

/** Pixel type 1 of the three the format defines. */
const HALF = 1;

const NO_COMPRESSION = 0;
const ZIP = 3;

/** What ZIP means, and the only difference between it and ZIPS. */
const LINES_PER_ZIP_BLOCK = 16;

/** Rows from the top down, which is what everything writes and everything reads. */
const INCREASING_Y = 0;

/**
 * The largest image this writer will allocate for.
 *
 * The same ceiling the reader applies, so the two agree about what this package
 * will handle. Eight bytes a pixel go out and sixteen come back in, and neither
 * number is the point: a caller that hands over a width and a height in the
 * billions gets a sentence rather than a `RangeError` out of the allocator.
 */
const MAX_PIXELS = 100_000_000;

/** Display P3's primaries and white point, in the order the attribute wants. */
const DISPLAY_P3 = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329];

function fail(detail: string): never {
	throw new EncodeFailedError('exr', ENCODER_ID, detail);
}

/**
 * One float, and the bits it is made of.
 *
 * Shared by the half conversion and the float attributes below. Both write the
 * value and read the bits back on the next line, so there is nothing to hold
 * between them and one buffer is enough.
 */
const SINGLE = new Float32Array(1);
const SINGLE_BITS = new Uint32Array(SINGLE.buffer);

/**
 * Encode a float as the sixteen bits OpenEXR stores, the inverse of
 * `halfToFloat`.
 *
 * Every case below is one a render produces. A subnormal is the darkest part of
 * a frame, and rounding it to zero is the difference between a shadow with
 * detail in it and a black hole. Anything past 65504 has to become an infinity
 * rather than wrapping to a small number, which is what a naive exponent shift
 * does and which puts a black pixel where a light source was. A NaN stays a
 * NaN, because it is usually a division somebody wants to find rather than
 * something to quietly paper over. And a negative sample is legal in an EXR and
 * ordinary in one: a colour outside the destination gamut is stored as a
 * negative and every reader expects it back.
 *
 * Rounding is to nearest, ties to even, which is what the reference
 * implementation's table does. Truncating instead would bias every picture dark
 * by half a step of whatever exponent it happens to sit in.
 */
export function floatToHalf(value: number): number {
	SINGLE[0] = value;
	const bits = SINGLE_BITS[0] as number;
	const sign = (bits >>> 16) & 0x8000;
	const exponent = ((bits >>> 23) & 0xff) - 127;
	const mantissa = bits & 0x7fffff;

	// An exponent field of all ones: infinity when the mantissa is empty and a
	// NaN when it is not. The quiet bit is set rather than the mantissa copied,
	// because the low thirteen bits are about to be dropped and a signalling
	// pattern whose payload lived down there would come out as an infinity.
	if (exponent === 128) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
	// Past the largest half, which is 65504. The carry below can arrive here
	// too, from a value that rounds up out of the top of the range.
	if (exponent > 15) return sign | 0x7c00;

	if (exponent >= -14) {
		const half = sign | ((exponent + 15) << 10) | (mantissa >>> 13);
		const dropped = mantissa & 0x1fff;
		// Rounding up carries into the exponent field of its own accord, because
		// the mantissa sits immediately below it, and an exponent of 30 carrying
		// out of the top gives exactly the infinity the value has become.
		if (dropped > 0x1000 || (dropped === 0x1000 && (half & 1) === 1)) return half + 1;
		return half;
	}

	// Below 2 to the minus 25 there is nothing left to round to: the smallest
	// subnormal is 2 to the minus 24, and half of that ties to even, which is
	// zero. This is also where a float that was itself subnormal lands, since
	// those are all far below anything a half can hold.
	if (exponent < -25) return sign;

	// A subnormal half is m times 2 to the minus 24, so m is the value scaled by
	// 2 to the 24 and the implicit bit has to be put back first.
	const full = mantissa | 0x800000;
	const shift = -exponent - 1;
	const m = full >>> shift;
	const dropped = full & ((1 << shift) - 1);
	const halfway = 1 << (shift - 1);
	// Rounding up out of the largest subnormal gives 0x400, which is the
	// smallest normal, and that is the right answer rather than an overflow.
	if (dropped > halfway || (dropped === halfway && (m & 1) === 1)) return sign | (m + 1);
	return sign | m;
}

/* ── The header ───────────────────────────────────────────────────────── */

function attribute(out: ByteWriter, name: string, type: string, value: Uint8Array): void {
	out.ascii(name);
	out.u8(0);
	out.ascii(type);
	out.u8(0);
	out.u32le(value.length);
	out.bytesOf(value);
}

function f32(out: ByteWriter, value: number): void {
	SINGLE[0] = value;
	out.u32le(SINGLE_BITS[0] as number);
}

function floats(values: readonly number[]): Uint8Array {
	const out = new ByteWriter(values.length * 4);
	for (const value of values) f32(out, value);
	return out.finish();
}

/**
 * The channel list.
 *
 * Sixteen bytes follow each name, not fifteen: the pixel type, one byte of
 * pLinear and then three of padding, because the C++ writer pads its bool out
 * to the next int, and then the two sampling rates. A reader that allows only
 * two of the padding bytes reads every sampling rate a byte low and decides the
 * file is subsampled.
 */
function channelList(names: readonly string[]): Uint8Array {
	const out = new ByteWriter(64);
	for (const name of names) {
		out.ascii(name);
		out.u8(0);
		out.u32le(HALF);
		out.u8(0);
		out.u8(0);
		out.u8(0);
		out.u8(0);
		out.u32le(1);
		out.u32le(1);
	}
	// The empty name that ends the list, which is what makes a channel list
	// self-delimiting rather than counted.
	out.u8(0);
	return out.finish();
}

/** A box2i, inclusive at both ends. The origin and the last pixel, not the size. */
function box2i(xMin: number, yMin: number, xMax: number, yMax: number): Uint8Array {
	const out = new ByteWriter(16);
	out.u32le(xMin);
	out.u32le(yMin);
	out.u32le(xMax);
	out.u32le(yMax);
	return out.finish();
}

/**
 * Write the header, up to and including the byte that ends the attribute list.
 *
 * Every attribute the specification calls required is here, including the three
 * this package's own reader does not look at, because plenty of other readers
 * do and a file missing `screenWindowWidth` is refused by libOpenEXR outright.
 * They go out in name order, which is the order the reference writer produces
 * from the map it keeps them in.
 */
function writeHeader(
	out: ByteWriter,
	image: FloatImage,
	names: readonly string[],
	compression: number,
): void {
	out.bytesOf(MAGIC);
	out.u32le(VERSION);

	attribute(out, 'channels', 'chlist', channelList(names));
	if (image.colourSpace === 'display-p3') {
		// Absent, the attribute means Rec. 709, whose primaries are sRGB's. A P3
		// picture written without it is a picture every reader desaturates, with
		// nothing anywhere to say why.
		attribute(out, 'chromaticities', 'chromaticities', floats(DISPLAY_P3));
	}
	attribute(out, 'compression', 'compression', Uint8Array.from([compression]));
	attribute(out, 'dataWindow', 'box2i', box2i(0, 0, image.width - 1, image.height - 1));
	attribute(out, 'displayWindow', 'box2i', box2i(0, 0, image.width - 1, image.height - 1));
	attribute(out, 'lineOrder', 'lineOrder', Uint8Array.from([INCREASING_Y]));
	attribute(out, 'pixelAspectRatio', 'float', floats([1]));
	attribute(out, 'screenWindowCenter', 'v2f', floats([0, 0]));
	attribute(out, 'screenWindowWidth', 'float', floats([1]));

	out.u8(0);
}

/* ── Compression ──────────────────────────────────────────────────────── */

/**
 * Split the block into its even and its odd bytes.
 *
 * This is what puts the high byte of every half next to the high byte of its
 * neighbour, and it is most of the reason deflate can do anything at all with
 * floating point pixels: the exponents end up in one run and the noisy low bits
 * in another. The length is always even here, two bytes a sample, so the split
 * falls exactly in the middle.
 */
function interleave(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.length);
	const half = source.length / 2;
	for (let i = 0; i < half; i += 1) {
		out[i] = source[i * 2] as number;
		out[half + i] = source[i * 2 + 1] as number;
	}
	return out;
}

/**
 * Store each byte as its difference from the one before it, offset by 128.
 *
 * Applied after the interleave rather than before it, which is the order the
 * reader undoes and the order the reference implementation uses. Wrapped rather
 * than clamped: the reader adds the differences back in the same modular
 * arithmetic, so an overflow here has to be an overflow there.
 */
function predict(buffer: Uint8Array): Uint8Array {
	for (let i = buffer.length - 1; i > 0; i -= 1) {
		buffer[i] = ((buffer[i] as number) - (buffer[i - 1] as number) + 128) & 0xff;
	}
	return buffer;
}

/**
 * Deflate one block with the platform's own compressor.
 *
 * zlib wrapped, which is what a ZIP block holds and what `CompressionStream`
 * calls `deflate`.
 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream('deflate');
	const writer = stream.writable.getWriter();
	// Neither awaited nor left bare. Awaiting the write deadlocks on any block
	// larger than the stream's internal queue, because the loop below is what
	// drains it; leaving the two promises unclaimed turns a stream failure into
	// a pair of unhandled rejections, since both reject alongside the read that
	// is the only one anybody is holding.
	//
	// `BufferSource` requires an `ArrayBuffer` backed view, while a plain
	// `Uint8Array` is declared over `ArrayBufferLike`. These bytes are never
	// shared, so the cast states what is already true.
	void Promise.allSettled([writer.write(bytes as unknown as BufferSource), writer.close()]);

	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}

	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * Compress one scanline block, or decline to.
 *
 * A block whose compressed form came out no smaller than the pixels is written
 * as it is, and its stored size is the only record of that. This is the format
 * rather than an optimisation, and real files hit it constantly: a row of a
 * render with any grain in it does not compress, and a reader that always
 * inflates would be reading noise.
 */
async function compressBlock(raw: Uint8Array): Promise<Uint8Array> {
	const packed = await deflate(predict(interleave(raw)));
	return packed.length < raw.length ? packed : raw;
}

/* ── Pixels ───────────────────────────────────────────────────────────── */

/**
 * One block of scanlines, as the bytes the format stores.
 *
 * Planar and in channel order within each row: all of a row's A, then all of
 * its B, and so on. Interleaved samples would compress to almost nothing, which
 * is the same reason the byte split above exists.
 */
function packBlock(
	image: FloatImage,
	sources: readonly number[],
	from: number,
	lines: number,
): Uint8Array {
	const { width, data } = image;
	const raw = new Uint8Array(lines * width * sources.length * 2);
	let at = 0;
	for (let line = 0; line < lines; line += 1) {
		const row = (from + line) * width * 4;
		for (const source of sources) {
			for (let x = 0; x < width; x += 1) {
				const bits = floatToHalf(data[row + x * 4 + source] as number);
				raw[at] = bits & 0xff;
				raw[at + 1] = bits >>> 8;
				at += 2;
			}
		}
	}
	return raw;
}

/* ── Entry points ─────────────────────────────────────────────────────── */

/**
 * Turn away what cannot be written, before anything is allocated for it.
 *
 * The buffer check is the one that catches a caller who resized an image by
 * changing its width, and it is the same check for a raster and for light,
 * because both are four samples a pixel.
 */
function refuseUnwritable(width: number, height: number, samples: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		fail('the image has no width or no height, so there is nothing to write.');
	}
	if (width * height > MAX_PIXELS) {
		fail('the image has more pixels than this writer will allocate for.');
	}
	if (samples < width * height * 4) {
		fail('the pixel buffer is smaller than the width and height say it should be.');
	}
}

/**
 * Write linear light as an OpenEXR file.
 *
 * `options` is accepted for one signature across every encoder and then
 * ignored: the only loss here is half precision, which the format fixes, so
 * quality steers nothing; the file carries its own alpha, so there is no
 * background to composite onto; and there is no room in the container for an
 * ICC profile or a colour table. What the colour space does steer is the
 * chromaticities attribute, and that is taken from the image rather than from
 * the options, because it is a fact about the samples.
 */
export async function encodeExrFloat(
	image: FloatImage,
	_options: EncodeOptions = {},
): Promise<Uint8Array> {
	const { width, height } = image;
	refuseUnwritable(width, height, image.data.length);

	// The whole platform requirement, and it is not one: without a compressor
	// the pixels go out as they are, which is a larger file and an equally legal
	// one that every reader opens.
	const zip = typeof CompressionStream === 'function';
	const linesPerBlock = zip ? LINES_PER_ZIP_BLOCK : 1;

	// Alphabetical, which is the order the samples are stored in. The offsets
	// are into RGBA, so they run backwards.
	const names = image.hasAlpha ? ['A', 'B', 'G', 'R'] : ['B', 'G', 'R'];
	const sources = image.hasAlpha ? [3, 2, 1, 0] : [2, 1, 0];

	const header = new ByteWriter(256);
	writeHeader(header, image, names, zip ? ZIP : NO_COMPRESSION);
	const head = header.finish();

	const count = Math.ceil(height / linesPerBlock);
	const blocks: Uint8Array[] = [];
	let total = 0;
	for (let block = 0; block < count; block += 1) {
		const from = block * linesPerBlock;
		const raw = packBlock(image, sources, from, Math.min(linesPerBlock, height - from));
		const stored = zip ? await compressBlock(raw) : raw;
		blocks.push(stored);
		total += 8 + stored.length;
	}

	const out = new ByteWriter(head.length + count * 8 + total);
	out.bytesOf(head);

	// The offset table, which is why the blocks are all built before any of them
	// is written: every entry is a position in the finished file, and none of
	// them is known until the last block has been compressed.
	let at = head.length + count * 8;
	for (const block of blocks) {
		out.u32le(at % 0x100000000);
		out.u32le(Math.floor(at / 0x100000000));
		at += 8 + block.length;
	}

	for (let block = 0; block < count; block += 1) {
		const stored = blocks[block] as Uint8Array;
		// The y of the first scanline the block holds. It is what places the
		// block, rather than its position in the file, which is what lets a
		// reader honour any line order without a second code path.
		out.u32le(block * linesPerBlock);
		out.u32le(stored.length);
		out.bytesOf(stored);
	}

	return out.finish();
}

/**
 * Write an eight bit picture as an OpenEXR file.
 *
 * The curve is undone first, by `floatFromRaster`, and that is the whole
 * difference between this and a file that looks right and measures wrong. What
 * it cannot do is invent range that was never there: the result tops out at a
 * diffuse white surface, so the file is a linear record of an ordinary picture
 * rather than a high dynamic range one.
 */
export async function encodeExr(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	// Checked here as well as inside, because the conversion allocates four
	// floats a pixel from the width and height it is handed and would ask the
	// allocator for the absurd amount before anything had refused it. Declared
	// async rather than returning the inner promise, so a refusal reaches a
	// caller holding a promise as a rejection rather than as a throw from the
	// call itself.
	refuseUnwritable(image.width, image.height, image.data.length);
	return encodeExrFloat(floatFromRaster(image), options);
}
