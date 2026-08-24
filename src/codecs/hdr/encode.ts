/**
 * A Radiance HDR writer.
 *
 * The picture arriving here is eight bits a channel and display referred: it
 * has already been through the sRGB transfer function, which is a curve, and a
 * Radiance file holds linear light. So the curve is undone first. Skipping
 * that step is the mistake this format invites, and it does not look like a
 * mistake: the file opens, the colours are recognisable, and every midtone in
 * it is about twice as bright as it should be.
 *
 * Each pixel then becomes four bytes, three mantissas and the exponent they
 * share, chosen from the largest of the three channels the way `setcolr` in
 * the Radiance sources does. Scanlines go out in the new run length encoding,
 * which is what everything written since 1991 uses, except at the widths where
 * that encoding is not legal.
 *
 * Writing this format is worth doing even though the source is only eight bits
 * deep, because it is what a renderer, a compositor and every panorama tool
 * reads, and because the file is a plain record of linear light rather than
 * another guess at a display curve.
 */

import { ByteWriter } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'hdr-pure';

/** The widths the new run length encoding is legal for. Outside them, flat. */
const MIN_RLE_WIDTH = 8;
const MAX_RLE_WIDTH = 0x7fff;

/**
 * The shortest repeat worth encoding as one.
 *
 * A run costs two bytes and the literal it displaces costs one byte a sample,
 * so a run of two or three saves nothing and can cost a byte by splitting the
 * literal around it. Radiance uses the same four.
 */
const MIN_RUN = 4;

/** A run's count lives in seven bits, and the code is 128 plus the count. */
const MAX_RUN = 127;

/** A literal's count is the code itself, and 128 is the largest one that is not a run. */
const MAX_LITERAL = 128;

/** Below this the pixel is written as black, which is what the exponent byte 0 means. */
const BLACK_THRESHOLD = 1e-32;

/**
 * The sRGB transfer function, undone, for all 256 byte values.
 *
 * Display P3 shares this curve exactly and differs only in its primaries, so a
 * wide gamut raster takes the same table and says what its numbers mean in the
 * header instead.
 */
const LINEAR = new Float64Array(256);
for (let value = 0; value < 256; value += 1) {
	const level = value / 255;
	LINEAR[value] = level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4;
}

function fail(detail: string, options?: ErrorOptions): never {
	throw new EncodeFailedError('hdr', ENCODER_ID, detail, options);
}

/**
 * The exponent of `value` as `frexp` defines it: the e for which the value
 * sits in [2^(e-1), 2^e).
 *
 * `Math.log2` alone is not enough. It is correctly rounded for exact powers of
 * two but not for everything else, so a value a hair under 8 can report 3
 * rather than 3 minus a fraction, and the mantissa then comes out at 256,
 * which does not fit in the byte it is about to be written into. The two
 * corrections put it back, and between them they are exact for every input.
 */
function exponentOf(value: number): number {
	let exponent = Math.ceil(Math.log2(value));
	if (2 ** exponent <= value) exponent += 1;
	if (2 ** (exponent - 1) > value) exponent -= 1;
	return exponent;
}

/**
 * Convert one row to RGBE, channel by channel rather than pixel by pixel.
 *
 * Planar because that is how the new encoding stores it: all the reds, then
 * all the greens, and so on. Interleaved RGBE compresses to nothing, since the
 * exponent breaks every run, and that is exactly what the older encoding got
 * wrong.
 */
function rowToRgbe(data: Uint8ClampedArray, from: number, width: number, planes: Uint8Array): void {
	for (let x = 0; x < width; x += 1) {
		const at = from + x * 4;
		const r = LINEAR[data[at] as number] as number;
		const g = LINEAR[data[at + 1] as number] as number;
		const b = LINEAR[data[at + 2] as number] as number;
		const max = r > g ? (r > b ? r : b) : g > b ? g : b;

		if (max < BLACK_THRESHOLD) {
			// Four zero bytes. A zero exponent is the format's reserved spelling
			// of black, and it is the only pixel value that carries no mantissa.
			planes[x] = 0;
			planes[width + x] = 0;
			planes[width * 2 + x] = 0;
			planes[width * 3 + x] = 0;
			continue;
		}

		const exponent = exponentOf(max);
		// The mantissa of the largest channel lands between 128 and 255, because
		// the exponent was chosen to put the value in [0.5, 1) once scaled. The
		// other two are the same fraction of the same power of two, which is what
		// makes them comparable without a division.
		const scale = 256 / 2 ** exponent;
		// Truncated rather than rounded, and that is deliberate: the reader adds
		// a half back on, so cutting the fraction off here leaves the error
		// centred on nothing rather than biased half a step high.
		planes[x] = Math.floor(r * scale);
		planes[width + x] = Math.floor(g * scale);
		planes[width * 2 + x] = Math.floor(b * scale);
		// The input is eight bit sRGB, so the light is in [0, 1] and the exponent
		// lands between -11 and 1. The range check the Radiance sources carry for
		// exponents outside a byte cannot be reached from here.
		planes[width * 3 + x] = exponent + 128;
	}
}

/** Write one channel of a scanline as runs and literals. */
function writeChannel(out: ByteWriter, plane: Uint8Array, from: number, width: number): void {
	let x = 0;
	while (x < width) {
		// Find where the next run of at least MIN_RUN begins. Everything between
		// here and there has to go out as literals first.
		let runAt = x;
		let runLength = 0;
		while (runAt < width) {
			const value = plane[from + runAt] as number;
			runLength = 1;
			while (
				runAt + runLength < width &&
				runLength < MAX_RUN &&
				plane[from + runAt + runLength] === value
			) {
				runLength += 1;
			}
			if (runLength >= MIN_RUN) break;
			runAt += runLength;
		}

		while (x < runAt) {
			const count = Math.min(MAX_LITERAL, runAt - x);
			out.u8(count);
			out.bytesOf(plane.subarray(from + x, from + x + count));
			x += count;
		}

		// `runAt` reaching the end of the row means there was no run left to
		// write and the literals above finished the channel.
		if (runAt < width) {
			out.u8(128 + runLength);
			out.u8(plane[from + runAt] as number);
			x = runAt + runLength;
		}
	}
}

/**
 * Write one scanline with no compression at all.
 *
 * The only option below eight pixels wide and above 32767, where the new
 * encoding's four byte header would be read as a pixel or its length would not
 * fit in the two bytes it has. A reader handed one of these falls back to the
 * original encoding, which is where the fix-up below comes from.
 */
function writeFlat(out: ByteWriter, planes: Uint8Array, width: number): void {
	for (let x = 0; x < width; x += 1) {
		let r = planes[x] as number;
		let g = planes[width + x] as number;
		let b = planes[width * 2 + x] as number;
		// 255, 255, 255 is not a pixel in the original encoding: it is the marker
		// that says "repeat the pixel before this one". Any reader taking this
		// scanline at face value would stop reading pixels there and start
		// reading a repeat count out of the exponent, so the one pixel value that
		// cannot be written is moved one step down. It costs 0.4% of the
		// brightness of a pixel already within 0.4% of a power of two, and it is
		// the difference between a narrow picture reading back correctly and
		// reading back as a smear. Wider pictures go out compressed, where the
		// marker does not exist and the pixel is written as it is.
		if (r === 255 && g === 255 && b === 255) {
			r = 254;
			g = 254;
			b = 254;
		}
		out.u8(r);
		out.u8(g);
		out.u8(b);
		out.u8(planes[width * 3 + x] as number);
	}
}

/**
 * Encode a raster as a Radiance picture.
 *
 * `options.quality` is ignored: the only loss here is the mantissa's eight
 * bits, which the format fixes, so there is no knob to turn. `options.palette`
 * and `options.iccProfile` are ignored as well, the format having neither a
 * colour table nor room for a profile. `options.background` is used, because
 * the format has no alpha channel and a translucent pixel has to be composited
 * onto something before its light can be written down.
 */
export function encodeHdr(image: RasterImage, options: EncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		fail('the image has no width or no height, so there is nothing to write.');
	}
	if (image.data.length < width * height * 4) {
		fail('the pixel buffer is smaller than the width and height say it should be.');
	}

	const opaque = flatten(image, options.background);
	const data = opaque.data;

	let out: ByteWriter;
	try {
		// A pixel costs four bytes before compression, plus a byte of literal
		// overhead per 128 of them and four for each scanline's header. Asking
		// for that up front saves the writer doubling its way there, and a
		// picture too large to hold arrives as a sentence rather than as a
		// RangeError out of the allocator.
		out = new ByteWriter(128 + height * (4 + width * 4 + Math.ceil(width / MAX_LITERAL) * 4));
	} catch (cause) {
		fail('there is not enough memory here to build a file that size.', { cause });
	}

	out.ascii('#?RADIANCE\n');
	out.ascii('FORMAT=32-bit_rle_rgbe\n');
	if (image.colourSpace === 'display-p3') {
		// Display P3's primaries and white point, in the order Radiance writes
		// them: red, green, blue, white. Without this line a reader has to assume
		// the samples are in Radiance's own primaries, and a P3 picture read that
		// way comes back undersaturated with nothing to say why.
		out.ascii('PRIMARIES=0.680 0.320 0.265 0.690 0.150 0.060 0.3127 0.3290\n');
	}
	// The blank line ends the header. Then the size, in the one orientation
	// everything writes: rows from the top down, pixels from the left.
	out.ascii('\n');
	out.ascii(`-Y ${height} +X ${width}\n`);

	const compressed = width >= MIN_RLE_WIDTH && width <= MAX_RLE_WIDTH;
	const planes = new Uint8Array(width * 4);

	for (let y = 0; y < height; y += 1) {
		rowToRgbe(data, y * width * 4, width, planes);

		if (!compressed) {
			writeFlat(out, planes, width);
			continue;
		}

		out.u8(2);
		out.u8(2);
		out.u8((width >> 8) & 0xff);
		out.u8(width & 0xff);
		for (let channel = 0; channel < 4; channel += 1) {
			writeChannel(out, planes, channel * width, width);
		}
	}

	return out.finish();
}
