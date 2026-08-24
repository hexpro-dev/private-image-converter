/**
 * A ZSoft PCX writer.
 *
 * PCX is worth writing for the places that still speak it: DOS-era art tools,
 * sign cutting and embroidery software, and a long tail of Windows imaging
 * utilities that read it when they read nothing else. Nothing here needs a
 * compressor, so the whole encoder is a header and one pass of run length
 * encoding.
 *
 * Two shapes come out of it, both version 5. An image with 256 colours or fewer
 * is written as 8 bits on one plane with the 256 entry table at the tail, which
 * is much the smaller of the two and is what the format was built around. An
 * image with more is written as 8 bits on three planes, which is the only way
 * PCX carries full colour. There is no third choice to make: PCX has no alpha
 * channel anywhere, so translucent pixels are composited before anything is
 * written, and once that is done the colour count settles the rest.
 */

import { ByteWriter } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';
import { exactPalette, quantise } from '../../raster/quantise.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'pcx-pure';

const HEADER_BYTES = 128;
const MANUFACTURER = 0x0a;

/** Version 5, the only one with a 256 colour table, and what everything reads. */
const VERSION = 5;

const ENCODING_RLE = 1;

/** A run tag carries its count in six bits, so 63 bytes is the longest one. */
const MAX_RUN = 63;

/** PaletteInfo 1: the colour table is colour rather than a grey ramp. */
const PALETTE_INFO_COLOUR = 1;

const VGA_PALETTE_MARKER = 0x0c;
const VGA_PALETTE_ENTRIES = 256;

/**
 * 72 dots per inch both ways.
 *
 * Zero is legal and common, but a reader that scales by print density treats
 * zero as "no information" and picks its own number, so writing a defensible
 * one costs four bytes and removes a guess.
 */
const DPI = 72;

/**
 * The window fields and the stride field are all 16 bit.
 *
 * A wider image cannot be described at all, so it is refused here rather than
 * written with a truncated width, which produces a file that opens and is the
 * wrong picture.
 */
const MAX_DIMENSION = 0xffff;

/**
 * Run length encode one plane of one row.
 *
 * A byte with its top two bits set is a tag rather than a value, so a literal
 * in the range 0xC0 to 0xFF has to be written as a run of one and costs two
 * bytes instead of one. That is the whole reason this encoding can grow a file,
 * and it is not optional: writing such a byte plainly produces a stream that
 * every reader misparses from that point to the end of the image.
 *
 * Runs stop at the end of the plane, which is what the specification requires
 * and what keeps a strict reader that decodes a row at a time in agreement with
 * a tolerant one that decodes the stream straight through.
 */
function writeRuns(out: ByteWriter, line: Uint8Array): void {
	let at = 0;
	while (at < line.length) {
		const value = line[at] as number;
		let run = 1;
		while (run < MAX_RUN && at + run < line.length && line[at + run] === value) run += 1;
		if (run > 1 || (value & 0xc0) === 0xc0) {
			out.u8(0xc0 | run);
			out.u8(value);
		} else {
			out.u8(value);
		}
		at += run;
	}
}

function writeHeader(
	out: ByteWriter,
	width: number,
	height: number,
	planes: number,
	stride: number,
): void {
	out.u8(MANUFACTURER);
	out.u8(VERSION);
	out.u8(ENCODING_RLE);
	// Bits per pixel is per plane, so both shapes this writer produces say 8 and
	// differ only in the plane count further down.
	out.u8(8);
	// The window is inclusive at both ends and starts at the origin, so the far
	// corner is one less than the size rather than equal to it.
	out.u16le(0);
	out.u16le(0);
	out.u16le(width - 1);
	out.u16le(height - 1);
	out.u16le(DPI);
	out.u16le(DPI);
	// The 16 colour header table, left at zero. It has no meaning for a version 5
	// file at this depth, and filling it with the first 16 entries of a 256
	// colour palette would hand a reader that used it a picture in the wrong
	// colours rather than an obviously missing one.
	for (let i = 0; i < 48; i += 1) out.u8(0);
	out.u8(0); // reserved
	out.u8(planes);
	out.u16le(stride);
	out.u16le(PALETTE_INFO_COLOUR);
	out.u16le(width);
	out.u16le(height);
	for (let i = 0; i < 54; i += 1) out.u8(0); // filler, to 128 bytes
}

/**
 * Write the 256 entry table that closes an indexed file.
 *
 * Always 256 entries even when the palette holds fewer, because the table is
 * found by measuring 769 bytes back from the end of the file. A short one would
 * be looked for in the middle of the pixel data.
 */
function writeVgaPalette(out: ByteWriter, colours: Uint8Array): void {
	out.u8(VGA_PALETTE_MARKER);
	const entries = colours.length / 4;
	for (let i = 0; i < VGA_PALETTE_ENTRIES; i += 1) {
		if (i >= entries) {
			out.u8(0);
			out.u8(0);
			out.u8(0);
			continue;
		}
		out.u8(colours[i * 4] as number);
		out.u8(colours[i * 4 + 1] as number);
		out.u8(colours[i * 4 + 2] as number);
	}
}

/**
 * Write `image` as a PCX.
 *
 * `options.quality` is ignored: nothing in PCX is lossy. `options.background` is
 * what translucent pixels are composited onto, because the format has no alpha
 * channel and the choice has to be made here while the original pixels still
 * exist. `options.palette` asks for quantisation to at most that many colours;
 * left unset, an image that already has 256 or fewer gets its exact palette,
 * which is lossless and roughly a third of the size of the 24 bit form.
 */
export function encodePcx(image: RasterImage, options: EncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new EncodeFailedError('pcx', ENCODER_ID, 'the image has no pixels to write.');
	}
	if (image.data.length < width * height * 4) {
		throw new EncodeFailedError(
			'pcx',
			ENCODER_ID,
			'the pixel buffer is shorter than the width and height say it should be.',
		);
	}
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		throw new EncodeFailedError(
			'pcx',
			ENCODER_ID,
			'the image is larger than the two byte window fields in a PCX header can describe.',
		);
	}

	// Every plane of every row occupies an even number of bytes. This is the field
	// a reader uses as its stride, so getting it wrong shears the picture.
	const stride = width + (width % 2);
	if (stride > MAX_DIMENSION) {
		throw new EncodeFailedError(
			'pcx',
			ENCODER_ID,
			'a row of that image is longer than the two byte stride field in a PCX header can describe.',
		);
	}

	// A no-op when the raster is already opaque, so this is safe on both paths.
	const source = flatten(image, options.background);

	// `exactPalette` gives up the moment the count passes 256, so a photograph
	// costs a few hundred pixels of work here rather than a pass over the whole
	// image. Asking for a palette explicitly means quantising, which always
	// produces one and is not lossless.
	//
	// The alpha threshold is zero on both calls because there is no alpha left to
	// represent. Without it a raster that declares itself opaque but still has
	// the zeroed alpha bytes `createRaster` hands out would be read as entirely
	// transparent, and the whole image would come out as one palette entry.
	const indexed =
		options.palette === undefined
			? exactPalette(source, VGA_PALETTE_ENTRIES, 0)
			: quantise(source, { maxColours: options.palette, alphaThreshold: 0 });

	const planes = indexed ? 1 : 3;
	const out = new ByteWriter(HEADER_BYTES + width * height * planes);
	writeHeader(out, width, height, planes, stride);

	const line = new Uint8Array(stride);
	// Zero or one, since the stride is only ever rounded up to the next even
	// number. Repeating the last pixel into it rather than writing zero lets the
	// padding join the run in front of it, which costs nothing and saves a byte a
	// row on anything with a flat edge.
	const pad = stride - width;

	for (let y = 0; y < height; y += 1) {
		if (indexed) {
			const row = y * width;
			for (let x = 0; x < width; x += 1) line[x] = indexed.indices[row + x] as number;
			if (pad > 0) line[width] = line[width - 1] as number;
			writeRuns(out, line);
			continue;
		}
		// Three planes, one per channel, one after another inside the row. Not
		// interleaved: a writer that emitted red, green, blue per pixel produces a
		// file that decodes to three narrow stripes of the wrong colour.
		const row = y * width * 4;
		for (let channel = 0; channel < 3; channel += 1) {
			for (let x = 0; x < width; x += 1) line[x] = source.data[row + x * 4 + channel] as number;
			if (pad > 0) line[width] = line[width - 1] as number;
			writeRuns(out, line);
		}
	}

	if (indexed) writeVgaPalette(out, indexed.palette.colours);

	return out.finish();
}
