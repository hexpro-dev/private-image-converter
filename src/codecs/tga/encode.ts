/**
 * A Truevision TGA encoder.
 *
 * TGA is the format the older parts of a graphics pipeline still speak: game
 * engine tooling, 3D texture importers and a long tail of Windows imaging
 * software read it when they read nothing else modern. It is worth writing
 * because no browser can produce one from a canvas, and because it carries an
 * alpha channel losslessly for a fraction of the code a PNG encoder needs.
 *
 * What gets written is deliberately the narrowest useful subset: image type 10
 * (run length encoded truecolour), top down, with the version 2 footer. Run
 * length encoding is always on because it never loses information and, on the
 * flat colour TGA is usually asked to carry (masks, sprite sheets, UI atlases),
 * it costs one pass and saves most of the file. On photographic content it can
 * add at most one byte per 128 pixels, which is under a thousandth.
 *
 * The footer is what makes the result identifiable. A TGA has no magic number
 * at the front, so a version 1 file can only be recognised by guessing from
 * plausible header fields. Writing the version 2 footer means anything reading
 * this file back, including this package's own format sniffer, can be certain.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { EncodeFailedError } from '../../errors.js';
import { flatten } from '../../raster/image.js';

const ENCODER_ID = 'tga-pure';

/** Literal and run packets both hold their count in seven bits, plus one. */
const MAX_PACKET = 128;

/** Image type 10: run length encoded truecolour. */
const IMAGE_TYPE_RLE_TRUECOLOUR = 10;

/** Image descriptor bit 5: rows are stored top row first. */
const DESCRIPTOR_TOP_DOWN = 0x20;

const FOOTER_SIGNATURE = 'TRUEVISION-XFILE.';

export interface TgaEncodeOptions extends EncodeOptions {
	/**
	 * Write 32 bit BGRA with a real alpha channel.
	 *
	 * Defaults to whatever the raster carries. Setting it to false asks for the
	 * plainer 24 bit file: translucent pixels are composited onto `background`
	 * first, because once the channel is gone no reader can work out what was
	 * underneath, so the choice has to be made here while the original pixels
	 * are still available.
	 */
	readonly alpha?: boolean;
}

/**
 * How each pixel is laid down.
 *
 * `carryAlpha` is separate from the byte count on purpose. A raster whose
 * `hasAlpha` is false is saying its alpha bytes mean nothing, and they are
 * frequently zero rather than 255, so copying them into a 32 bit file that
 * somebody explicitly asked for would produce an image that is entirely
 * invisible and looks like a corrupt file rather than a mistake.
 */
interface PixelLayout {
	readonly channels: 3 | 4;
	readonly carryAlpha: boolean;
}

/**
 * A growable output buffer.
 *
 * The compressed size is not known before compressing, and the true worst case
 * (every packet a single literal pixel) is five times the raster for a 32 bit
 * image. Allocating for that would mean asking for 960 MB to write a 48
 * megapixel texture that will land near 200 MB, so the buffer starts at a
 * realistic estimate and doubles on the rare occasion that estimate is wrong.
 */
interface Sink {
	bytes: Uint8Array;
	length: number;
}

function reserve(sink: Sink, extra: number): void {
	const needed = sink.length + extra;
	if (needed <= sink.bytes.length) return;
	let capacity = sink.bytes.length * 2;
	while (capacity < needed) capacity *= 2;
	const grown = new Uint8Array(capacity);
	grown.set(sink.bytes.subarray(0, sink.length));
	sink.bytes = grown;
}

function writeByte(sink: Sink, value: number): void {
	reserve(sink, 1);
	sink.bytes[sink.length] = value;
	sink.length += 1;
}

/** Little endian, which is the byte order every multi-byte TGA field uses. */
function writeU16(sink: Sink, value: number): void {
	reserve(sink, 2);
	sink.bytes[sink.length] = value & 0xff;
	sink.bytes[sink.length + 1] = (value >> 8) & 0xff;
	sink.length += 2;
}

function writeU32(sink: Sink, value: number): void {
	writeU16(sink, value & 0xffff);
	writeU16(sink, (value >>> 16) & 0xffff);
}

function writeAscii(sink: Sink, text: string): void {
	reserve(sink, text.length);
	for (let i = 0; i < text.length; i += 1) {
		sink.bytes[sink.length + i] = text.charCodeAt(i);
	}
	sink.length += text.length;
}

/**
 * Copy one RGBA pixel out as TGA stores it, which is blue first.
 *
 * The channel order is the one surprise in the format: the header calls the
 * samples truecolour and gives no way to say what order they are in, because
 * there is only one, and it is the reverse of the obvious one.
 */
function writePixel(sink: Sink, data: Uint8ClampedArray, at: number, layout: PixelLayout): void {
	reserve(sink, layout.channels);
	const to = sink.length;
	sink.bytes[to] = data[at + 2] as number;
	sink.bytes[to + 1] = data[at + 1] as number;
	sink.bytes[to + 2] = data[at] as number;
	if (layout.channels === 4) {
		sink.bytes[to + 3] = layout.carryAlpha ? (data[at + 3] as number) : 255;
	}
	sink.length += layout.channels;
}

/** Whether two RGBA pixels are the same across the channels being written. */
function samePixel(data: Uint8ClampedArray, a: number, b: number, layout: PixelLayout): boolean {
	if (data[a] !== data[b] || data[a + 1] !== data[b + 1] || data[a + 2] !== data[b + 2]) {
		return false;
	}
	// Alpha only counts when it is going to be written. Two pixels that differ
	// solely in an alpha nobody will read are the same pixel to this file.
	return !layout.carryAlpha || data[a + 3] === data[b + 3];
}

/**
 * Run length encode one scanline.
 *
 * Packets are not allowed to cross a row boundary. The specification is
 * explicit about it and readers rely on it to decode rows independently, so the
 * packet state resets here rather than running the length of the image.
 *
 * A run is emitted from a length of two upwards. Two identical pixels cost
 * 1 + n bytes as a run against 2n inside a literal packet, and breaking a
 * literal packet to emit one costs a further header byte for the packet that
 * follows, so at three or four bytes per pixel the run still wins.
 */
function encodeRow(
	sink: Sink,
	data: Uint8ClampedArray,
	rowStart: number,
	width: number,
	layout: PixelLayout,
): void {
	let x = 0;
	while (x < width) {
		const at = rowStart + x * 4;
		let run = 1;
		while (
			run < MAX_PACKET &&
			x + run < width &&
			samePixel(data, at, rowStart + (x + run) * 4, layout)
		) {
			run += 1;
		}

		if (run >= 2) {
			writeByte(sink, 0x80 | (run - 1));
			writePixel(sink, data, at, layout);
			x += run;
			continue;
		}

		// No run here, so gather literals until one starts. Stopping a pixel
		// early is the point: the first pixel of a coming run belongs to that
		// run's packet, not to this one.
		let raw = 1;
		while (raw < MAX_PACKET && x + raw < width) {
			const here = rowStart + (x + raw) * 4;
			if (x + raw + 1 < width && samePixel(data, here, here + 4, layout)) break;
			raw += 1;
		}
		writeByte(sink, raw - 1);
		for (let i = 0; i < raw; i += 1) {
			writePixel(sink, data, rowStart + (x + i) * 4, layout);
		}
		x += raw;
	}
}

/**
 * Encode `image` as a TGA.
 *
 * `options.quality` is ignored: the format is lossless and has no quality
 * setting to spend. `options.iccProfile` is ignored too, because TGA has
 * nowhere to put one. Both are accepted rather than refused so a caller can
 * hand the same options to every encoder.
 */
export function encodeTga(image: RasterImage, options: TgaEncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	// Checked before anything reads the buffer. Flattening allocates from the
	// width and height rather than from the buffer it was handed, so a short
	// raster that got past here would come back padded with transparent black
	// and be written out as if that were the picture.
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new EncodeFailedError('tga', ENCODER_ID, 'the image has no pixels to write.');
	}
	if (width > 0xffff || height > 0xffff) {
		throw new EncodeFailedError(
			'tga',
			ENCODER_ID,
			'TGA keeps its width and height in 16 bits, so neither side can be more than 65535 pixels.',
		);
	}
	if (image.data.length < width * height * 4) {
		throw new EncodeFailedError(
			'tga',
			ENCODER_ID,
			'the pixel buffer is shorter than the width and height say it should be.',
		);
	}

	const withAlpha = options.alpha ?? image.hasAlpha;
	// A no-op when the raster is already opaque, so this is safe on both paths.
	const source = withAlpha ? image : flatten(image, options.background);
	const data = source.data;

	const layout: PixelLayout = {
		channels: withAlpha ? 4 : 3,
		carryAlpha: withAlpha && source.hasAlpha,
	};
	const pixels = width * height;
	// Header, an uncompressed body, one packet byte per 128 pixels per row, and
	// the footer. Compression usually beats this, and the sink grows if it does
	// not.
	const estimate = 18 + pixels * layout.channels + height * Math.ceil(width / MAX_PACKET) + 26;
	const sink: Sink = { bytes: new Uint8Array(estimate), length: 0 };

	writeByte(sink, 0); // image id length: nothing to say
	writeByte(sink, 0); // colour map type: none
	writeByte(sink, IMAGE_TYPE_RLE_TRUECOLOUR);
	writeU16(sink, 0); // colour map first entry index
	writeU16(sink, 0); // colour map length
	writeByte(sink, 0); // colour map entry size
	writeU16(sink, 0); // x origin
	writeU16(sink, 0); // y origin
	writeU16(sink, width);
	writeU16(sink, height);
	writeByte(sink, layout.channels * 8);
	// Low four bits are the alpha channel depth, bit 5 says the first row in the
	// file is the top row. Bottom up is the format's default and the commonest
	// reason a TGA turns up upside down in a reader, so it is worth one bit to
	// be explicit about it.
	writeByte(sink, (withAlpha ? 8 : 0) | DESCRIPTOR_TOP_DOWN);

	for (let y = 0; y < height; y += 1) {
		encodeRow(sink, data, y * width * 4, width, layout);
	}

	// Version 2 footer: no extension area, no developer directory, then the
	// signature and a terminating zero. The two offsets are zero because
	// neither section is written, which is how a reader is told they are absent.
	writeU32(sink, 0);
	writeU32(sink, 0);
	writeAscii(sink, FOOTER_SIGNATURE);
	writeByte(sink, 0);

	// A view while the buffer is nearly full, a copy once it is not: handing
	// back a view would keep the unused tail of the allocation alive for as long
	// as the caller holds the result, and compression makes that tail large.
	return sink.length * 8 >= sink.bytes.length * 7
		? sink.bytes.subarray(0, sink.length)
		: sink.bytes.slice(0, sink.length);
}
