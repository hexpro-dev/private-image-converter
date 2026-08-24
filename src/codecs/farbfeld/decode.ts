/**
 * A farbfeld reader.
 *
 * The whole format is a sixteen byte header and then width by height pixels of
 * big endian 16 bit RGBA, in row order, with nothing between them. There is no
 * length field to trust, no offset table to follow and no compressed stream to
 * unpack, so the only thing that can go wrong is a file that promises more
 * pixels than it carries. That single check is the one this reader spends its
 * care on: the header can claim four billion pixels a side, and a hostile
 * sixteen byte file must be refused with a sentence rather than by asking the
 * runtime for the 148 exabytes it comes to.
 *
 * Samples are narrowed to 8 bits by rounding a divide by 257, which is the
 * exact inverse of the encoder's widening and leaves a file this package wrote
 * byte for byte unchanged.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'farbfeld-pure';

/** 'farbfeld', the eight magic bytes the file opens with. */
const MAGIC = [0x66, 0x61, 0x72, 0x62, 0x66, 0x65, 0x6c, 0x64];

/** The magic, then width and height as big endian u32. */
const HEADER_BYTES = 16;

/** Four channels of two bytes. Fixed by the format: there are no variants. */
const BYTES_PER_PIXEL = 8;

function fail(detail: string): never {
	throw new DecodeFailedError('farbfeld', DECODER_ID, detail);
}

/**
 * One 16 bit sample narrowed to the 8 bits a `RasterImage` carries.
 *
 * The encoder widens by multiplying by 257, so 257 is what has to come back
 * out, rounded rather than truncated. Both of the tempting shortcuts are wrong
 * by up to a whole level. Taking the high byte is a divide by 256, which is the
 * same mistake `encode.ts` refuses in the other direction: it reads every
 * sample about half a level bright, and it sends 0x00ff, a real if faint grey,
 * to nothing at all. Dividing by 257 and dropping the remainder, which is what
 * the suckless converters do, lands a level low on half of all values.
 *
 * Rounding was checked against ImageMagick's farbfeld reader over all 65536
 * sample values and agrees on every one of them. A file this package wrote is
 * unaffected either way, because every sample in one is already a multiple of
 * 257.
 */
function narrow(high: number, low: number): number {
	return Math.round((high * 256 + low) / 257);
}

export function decodeFarbfeld(bytes: Uint8Array): RasterImage {
	if (bytes.length < HEADER_BYTES) {
		fail(`it stops after ${bytes.length} bytes and the header alone is ${HEADER_BYTES}.`);
	}
	for (let i = 0; i < MAGIC.length; i += 1) {
		if (bytes[i] !== MAGIC[i]) fail('it does not start with the farbfeld magic bytes.');
	}

	// The byte offset is passed on purpose: these bytes are often a subarray of
	// a larger buffer read from a file or a stream, and a view over the whole
	// buffer would read the wrong four bytes and report somebody else's
	// dimensions.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(8);
	const height = view.getUint32(12);

	if (width === 0 || height === 0) {
		fail('the header describes an image with no width or no height.');
	}

	// Proved before anything is allocated. Both dimensions are u32, so the
	// product can reach 1.8e19 and overflow the range where integers are exact;
	// that is harmless here because such a claim loses this comparison by
	// eleven orders of magnitude, and the only number that survives it is one
	// the file has already backed with real bytes.
	const available = bytes.length - HEADER_BYTES;
	const needed = width * height * BYTES_PER_PIXEL;
	if (needed > available) {
		fail(
			`it declares ${width} by ${height} pixels, which needs ${needed} bytes of image data, ` +
				`and only ${available} follow the header.`,
		);
	}

	// Half the size of the pixel data that was just proved present, so this
	// cannot ask for memory the file has not already accounted for.
	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;
	const pixels = width * height;
	let hasAlpha = false;

	let source = HEADER_BYTES;
	for (let i = 0; i < pixels; i += 1) {
		const at = i * 4;
		target[at] = narrow(bytes[source] as number, bytes[source + 1] as number);
		target[at + 1] = narrow(bytes[source + 2] as number, bytes[source + 3] as number);
		target[at + 2] = narrow(bytes[source + 4] as number, bytes[source + 5] as number);
		// Read from the narrowed value rather than the raw high byte, so that
		// what this reports and what it wrote into the buffer cannot disagree.
		const alpha = narrow(bytes[source + 6] as number, bytes[source + 7] as number);
		target[at + 3] = alpha;
		if (alpha !== 255) hasAlpha = true;
		source += BYTES_PER_PIXEL;
	}

	// Anything past the last pixel is left alone rather than treated as damage.
	// farbfeld files are normally piped through a compressor and back, and the
	// reference tools stop reading once they have their pixels, so a reader that
	// refused a trailing byte would refuse files the format's own tools accept.

	// sRGB is an assumption, not a reading: the format has no colour space tag
	// and no metadata area to put one in. A Display P3 image written as farbfeld
	// keeps its numbers and loses the record of what they meant, which is why
	// `encodeFarbfeld` is not the place to send a wide gamut photograph.
	return { ...image, hasAlpha };
}
