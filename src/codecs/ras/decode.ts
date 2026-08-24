/**
 * A Sun raster reader.
 *
 * Eight big endian 32 bit fields and then the pixels. It is the simplest header
 * in this package, and almost everything that can go wrong with it is a
 * disagreement about ordering rather than about structure.
 *
 * What it reads: depths 1, 8, 24 and 32, types 0 (old), 1 (standard), 2 (byte
 * encoded) and 3 (RGB rather than BGR), with an equal-RGB colour map, a raw
 * colour map it steps over, or none at all. What it refuses by name: types 4 and
 * 5, which are a TIFF and an IFF wearing a Sun header, and the experimental
 * type.
 *
 * Four things about the format are counterintuitive, and every one of them
 * returns a picture rather than an error when it is got wrong.
 *
 * Channels are stored blue first, except in type 3, which exists only to say
 * they are not. Getting that backwards swaps red and blue in the output, which
 * on a photograph of a sunset looks like a photograph of the sea.
 *
 * The colour map is not a list of triples. It is every red, then every green,
 * then every blue, so a reader that steps through it three bytes at a time
 * builds a palette out of the reds of three different entries.
 *
 * Rows are padded to a 16 bit boundary rather than to a byte, so a three pixel
 * wide 8 bit image spends four bytes on each row. Miss it and every row after
 * the first slides one pixel further left.
 *
 * And a 32 bit pixel's first byte is padding rather than alpha, in a format
 * defined before anybody stored alpha. Reading it as alpha turns an image whose
 * writer zero filled the padding into an invisible one, so it is read and then
 * given back if it turns out to be zero everywhere.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'ras-pure';

/** Eight 32 bit fields, always present, always big endian. */
const HEADER_BYTES = 32;

const MAGIC = 0x59a66a95;

/** Same as standard, except that older writers left the length field at zero. */
const TYPE_OLD = 0;
const TYPE_STANDARD = 1;
const TYPE_BYTE_ENCODED = 2;
const TYPE_RGB = 3;
const TYPE_TIFF = 4;
const TYPE_IFF = 5;
const TYPE_EXPERIMENTAL = 0xffff;

const MAP_NONE = 0;
const MAP_EQUAL_RGB = 1;
const MAP_RAW = 2;

/** The escape byte of the run length encoding. */
const RLE_ESCAPE = 0x80;

/**
 * The largest image this reader will allocate for.
 *
 * The same ceiling the QOI, TGA and PNM readers use. Width, height and depth
 * are three unsigned 32 bit fields with nothing to corroborate them, so a
 * thirty-two byte file can honestly ask for a sixteen gigabyte buffer. The
 * converter applies its own `maxPixels` on top of this; this one exists so the
 * decoder is safe to call on its own.
 */
const MAX_PIXELS = 400_000_000;

function fail(detail: string): never {
	throw new DecodeFailedError('ras', DECODER_ID, detail);
}

/**
 * The one place a length is compared against the buffer.
 *
 * Funnelling every read through this is what keeps the failure mode honest: a
 * short file names the structure it stopped inside instead of reading undefined
 * and carrying on.
 */
function requireBytes(bytes: Uint8Array, at: number, count: number, what: string): void {
	if (at < 0 || count < 0 || at + count > bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

function refuseType(type: number): never {
	switch (type) {
		case TYPE_TIFF:
			fail('it is type 4, a TIFF file inside a Sun header, which this reader does not unpack.');
			break;
		case TYPE_IFF:
			fail('it is type 5, an IFF file inside a Sun header, which this reader does not unpack.');
			break;
		case TYPE_EXPERIMENTAL:
			fail('it is the experimental type 65535, whose contents nothing defines.');
			break;
		default:
			fail(`it declares image type ${type}, which the format does not define.`);
	}
}

interface RasHeader {
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	readonly length: number;
	readonly type: number;
	readonly mapType: number;
	readonly mapLength: number;
	/** Where the colour map ends and the pixels begin. */
	readonly dataAt: number;
	/** Bytes in one stored row, padding included. */
	readonly rowBytes: number;
}

function readHeader(bytes: Uint8Array, view: DataView): RasHeader {
	requireBytes(bytes, 0, HEADER_BYTES, 'the end of its header');
	if (view.getUint32(0) !== MAGIC) {
		fail('it does not start with the four byte signature every Sun raster begins with.');
	}

	const width = view.getUint32(4);
	const height = view.getUint32(8);
	const depth = view.getUint32(12);
	const length = view.getUint32(16);
	const type = view.getUint32(20);
	const mapType = view.getUint32(24);
	const mapLength = view.getUint32(28);

	if (width < 1 || height < 1) {
		fail(`it declares an image ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('it declares an image far larger than anything this reader will allocate for.');
	}
	if (
		type !== TYPE_OLD &&
		type !== TYPE_STANDARD &&
		type !== TYPE_BYTE_ENCODED &&
		type !== TYPE_RGB
	) {
		refuseType(type);
	}
	if (depth !== 1 && depth !== 8 && depth !== 24 && depth !== 32) {
		fail(`it is ${depth} bits per pixel, and a Sun raster is 1, 8, 24 or 32.`);
	}
	if (mapType !== MAP_NONE && mapType !== MAP_EQUAL_RGB && mapType !== MAP_RAW) {
		fail(`it declares colour map type ${mapType}, which the format does not define.`);
	}
	if (mapType === MAP_NONE && mapLength !== 0) {
		fail('it says it has no colour map and then gives one a length.');
	}
	requireBytes(bytes, HEADER_BYTES, mapLength, 'the end of its colour map');

	// Every row is padded out to a whole number of 16 bit words, which is where
	// a hand written reader loses a pixel a row on any odd width.
	const rowBytes = Math.ceil(Math.ceil((width * depth) / 8) / 2) * 2;

	return {
		width,
		height,
		depth,
		length,
		type,
		mapType,
		mapLength,
		dataAt: HEADER_BYTES + mapLength,
		rowBytes,
	};
}

/**
 * The colour map, expanded to opaque RGBA so the pixel loop is a straight copy.
 *
 * Returns undefined when there is nothing to index with, which is both the
 * no-map case and the raw one. A raw map is a device dependent blob whose layout
 * the file does not describe, so the bytes are stepped over and the image is
 * read as if there were no map at all. That is what every other reader of the
 * format does with one, and it is better than refusing a file whose pixels are
 * perfectly readable.
 */
function readColourMap(bytes: Uint8Array, header: RasHeader): Uint8Array | undefined {
	// A map on a 24 or 32 bit file is ignored rather than refused. The pixels
	// carry their own colour there and there is nothing to index, but writers
	// have shipped one anyway, and the header already accounts for its bytes.
	if (header.mapType !== MAP_EQUAL_RGB || header.depth > 8) return undefined;
	if (header.mapLength % 3 !== 0) {
		fail(
			`its colour map is ${header.mapLength} bytes, which is not three equal runs of red, green and blue.`,
		);
	}
	const count = header.mapLength / 3;
	if (count < 1) fail('it declares an equal-RGB colour map with no entries in it.');
	const maximum = 1 << header.depth;
	if (count > maximum) {
		fail(
			`its colour map holds ${count} entries, more than the ${maximum} a ${header.depth} bit image can index.`,
		);
	}

	const map = new Uint8Array(count * 4);
	for (let i = 0; i < count; i += 1) {
		// All the reds, then all the greens, then all the blues. Reading this as
		// triples is the single most common way to get the format wrong, and it
		// produces a picture rather than an error.
		map[i * 4] = bytes[HEADER_BYTES + i] as number;
		map[i * 4 + 1] = bytes[HEADER_BYTES + count + i] as number;
		map[i * 4 + 2] = bytes[HEADER_BYTES + count * 2 + i] as number;
		map[i * 4 + 3] = 255;
	}
	return map;
}

/**
 * Undo the byte encoding of a type 2 file.
 *
 * One escape byte, and the awkward part is that it stands for itself: 0x80
 * followed by a zero count is a literal 0x80 and consumes two bytes rather than
 * three. A reader that treats every 0x80 as the start of a three byte run walks
 * one byte out of step for the rest of the file.
 *
 * The output is exactly the size the header describes. Stopping there rather
 * than at the end of the stream is what stops a file whose last run is enormous
 * from allocating on a number it chose.
 */
function expandRle(bytes: Uint8Array, header: RasHeader, size: number): Uint8Array {
	// The length field bounds the compressed stream, but only when it is
	// believable: a type 2 file that inherited a zero length from the old
	// convention would otherwise decode to nothing at all.
	const end =
		header.length > 0 ? Math.min(header.dataAt + header.length, bytes.length) : bytes.length;

	// One run costs three bytes and stands for at most 256, so a stream too
	// short to reach `size` is refused before anything is allocated. A forty
	// byte file claiming a hundred megapixels is the ordinary shape of a
	// truncated download, and the buffer for it is asked for long before the
	// read runs out of bytes and notices.
	const smallest = Math.ceil(size / 256) * 3;
	if (smallest > end - header.dataAt) {
		fail(
			`its compressed pixel data is too short to hold the ${size} bytes a ${header.width} by ${header.height} image needs.`,
		);
	}

	const out = new Uint8Array(size);
	let at = header.dataAt;
	let to = 0;

	while (to < size) {
		if (at >= end) {
			fail(`its compressed pixel data ends after ${to} of the ${size} bytes it describes.`);
		}
		const byte = bytes[at] as number;
		at += 1;
		if (byte !== RLE_ESCAPE) {
			out[to] = byte;
			to += 1;
			continue;
		}
		if (at >= end) fail('its compressed pixel data ends inside a run.');
		const count = bytes[at] as number;
		at += 1;
		if (count === 0) {
			// The escape standing for itself, in two bytes rather than three.
			out[to] = RLE_ESCAPE;
			to += 1;
			continue;
		}
		if (at >= end) fail('its compressed pixel data ends inside a run.');
		const value = bytes[at] as number;
		at += 1;
		// The count is one less than the number of repeats, so a run always
		// stands for at least two bytes and there is no way to spell zero.
		const run = Math.min(count + 1, size - to);
		out.fill(value, to, to + run);
		to += run;
	}
	return out;
}

export function decodeRas(bytes: Uint8Array): RasterImage {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = readHeader(bytes, view);
	const { width, height, depth, type, rowBytes } = header;

	const map = readColourMap(bytes, header);
	const size = rowBytes * height;

	let samples: Uint8Array;
	if (type === TYPE_BYTE_ENCODED) {
		samples = expandRle(bytes, header, size);
	} else {
		// The length field is not trusted for an uncompressed file. The old type
		// leaves it at zero by convention, and plenty of writers of the standard
		// type copy that, so the dimensions are the authority and the buffer is
		// the check.
		requireBytes(bytes, header.dataAt, size, 'the end of its pixel data');
		samples = bytes.subarray(header.dataAt, header.dataAt + size);
	}

	const image = createRaster(width, height, 'srgb', depth === 32);
	const target = image.data;
	// Blue first, except in the one type that exists to say otherwise.
	const rgbOrder = type === TYPE_RGB;

	for (let y = 0; y < height; y += 1) {
		const row = y * rowBytes;
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;

			if (depth === 24 || depth === 32) {
				// A 32 bit pixel is padding, then the same three channels. The
				// padding is at the front, not the back, which is the opposite of
				// every other four byte pixel format here.
				const from = row + x * (depth === 24 ? 3 : 4);
				const first = depth === 32 ? from + 1 : from;
				target[at] = samples[rgbOrder ? first : first + 2] as number;
				target[at + 1] = samples[first + 1] as number;
				target[at + 2] = samples[rgbOrder ? first + 2 : first] as number;
				target[at + 3] = depth === 32 ? (samples[from] as number) : 255;
				continue;
			}

			let index: number;
			if (depth === 8) {
				index = samples[row + x] as number;
			} else {
				// Most significant bit first, which is the opposite of XBM and the
				// same as everything else that packs a bit per pixel.
				index = ((samples[row + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
			}

			if (map) {
				if (index * 4 >= map.length) {
					fail('it refers to a colour its own colour map does not contain.');
				}
				target[at] = map[index * 4] as number;
				target[at + 1] = map[index * 4 + 1] as number;
				target[at + 2] = map[index * 4 + 2] as number;
				target[at + 3] = 255;
				continue;
			}

			// With no map, 8 bits is a grey level and one bit is ink: a set bit is
			// black, which is the reverse of the greyscale ramp above it and is
			// the convention every writer of a one bit Sun raster follows.
			const level = depth === 8 ? index : index === 1 ? 0 : 255;
			target[at] = level;
			target[at + 1] = level;
			target[at + 2] = level;
			target[at + 3] = 255;
		}
	}

	if (depth === 32) {
		// The alpha here was a guess: the specification calls that byte padding,
		// and a writer that zero filled it did not mean an image nobody can see.
		// Zero in every pixel takes the guess back, exactly as the BMP reader
		// does with the reserved byte of a 32 bit BI_RGB file. A file that put
		// real alpha there keeps it, which is what makes this reader's own 32 bit
		// output survive a round trip.
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

	// The format has no way to record a colour space, so the numbers are sRGB by
	// the same convention every reader of it applies.
	return { ...image, hasAlpha: detectAlpha(image) };
}
