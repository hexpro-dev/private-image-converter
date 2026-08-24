/**
 * A Truevision TGA reader.
 *
 * What it reads: image types 2 and 10 (truecolour, uncompressed and run length
 * encoded) at 15, 16, 24 and 32 bits, and types 3 and 11 (greyscale, likewise)
 * at 8 bits, in either row order. What it refuses by name: the colour mapped
 * types 1 and 9, the two Huffman variants that only ever appeared in
 * Truevision's own tooling, and 16 bit greyscale.
 *
 * Strict about lengths, faithful about layout. Every read is bounds checked,
 * because the header's width and height are numbers a stranger's file claims
 * rather than facts: a header saying 40000 by 40000 with two hundred bytes
 * behind it is the ordinary shape of a truncated download, and it has to
 * produce a sentence instead of a buffer full of undefined. Layout is taken
 * exactly as the descriptor gives it, including the bottom up default and the
 * rare right to left bit, because guessing there means silently handing back
 * somebody's image flipped.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'tga-pure';

/** Fixed at 18 bytes, ahead of the image id and the colour map. */
const HEADER_BYTES = 18;

const IMAGE_TYPE_COLOUR_MAPPED = 1;
const IMAGE_TYPE_TRUECOLOUR = 2;
const IMAGE_TYPE_GREYSCALE = 3;
const IMAGE_TYPE_RLE_COLOUR_MAPPED = 9;
const IMAGE_TYPE_RLE_TRUECOLOUR = 10;
const IMAGE_TYPE_RLE_GREYSCALE = 11;
const IMAGE_TYPE_HUFFMAN_COLOUR_MAPPED = 32;
const IMAGE_TYPE_HUFFMAN_QUADTREE = 33;

const DESCRIPTOR_ALPHA_BITS = 0x0f;
const DESCRIPTOR_RIGHT_TO_LEFT = 0x10;
const DESCRIPTOR_TOP_DOWN = 0x20;

/** One packet stands for at most 128 pixels, which bounds how short a real file can be. */
const MAX_PACKET = 128;

/**
 * The largest image this decoder will allocate for.
 *
 * The same ceiling the QOI reader uses, for the same reason. Width and height
 * are two 16 bit fields with nothing to corroborate them, so an 18 byte file
 * can ask for a seventeen gigabyte buffer. The converter applies its own
 * `maxPixels` on top of this; this one exists so the decoder is safe to call
 * on its own.
 */
const MAX_PIXELS = 400_000_000;

/** TGA is little endian throughout. */
function readU16(bytes: Uint8Array, at: number): number {
	return (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
}

function fail(detail: string): never {
	throw new DecodeFailedError('tga', DECODER_ID, detail);
}

/**
 * Widen a five bit sample to eight.
 *
 * Repeating the top bits rather than shifting alone is what keeps white white:
 * a plain shift maps 31 to 248, so a 16 bit image full of maximum values would
 * come back a flat light grey that nothing in the file asked for.
 */
function widen5(value: number): number {
	return (value << 3) | (value >> 2);
}

/**
 * Expand run length encoded pixel data.
 *
 * Packets are not required here to stop at a row boundary, though a well formed
 * file's do. Encoders have shipped files that run a packet across the join, and
 * refusing those would reject an image every other reader displays correctly,
 * which is the worse outcome of the two.
 */
function expandRle(
	bytes: Uint8Array,
	from: number,
	pixels: number,
	sampleBytes: number,
): Uint8Array {
	// The densest a packet gets is one header byte plus one pixel standing for
	// 128, so this is the most the remaining bytes could possibly expand to.
	// Checking it first is the difference between refusing a 30 byte file and
	// allocating the gigabyte its header asked for.
	const ceiling = Math.floor((bytes.length - from) / (1 + sampleBytes)) * MAX_PACKET;
	if (pixels > ceiling) {
		fail('the compressed data is too short to describe an image of that size.');
	}

	const out = new Uint8Array(pixels * sampleBytes);
	let written = 0;
	let at = from;

	while (written < pixels) {
		if (at >= bytes.length) {
			fail('the compressed data ends before every row has been filled in.');
		}
		const header = bytes[at] as number;
		at += 1;
		const count = (header & 0x7f) + 1;
		if (written + count > pixels) {
			fail('a packet claims more pixels than the image has room for.');
		}

		if ((header & 0x80) !== 0) {
			if (at + sampleBytes > bytes.length) {
				fail('a repeated packet is missing the pixel it repeats.');
			}
			for (let i = 0; i < count; i += 1) {
				const to = (written + i) * sampleBytes;
				for (let b = 0; b < sampleBytes; b += 1) {
					out[to + b] = bytes[at + b] as number;
				}
			}
			at += sampleBytes;
		} else {
			const span = count * sampleBytes;
			if (at + span > bytes.length) {
				fail('a literal packet is missing some of its pixels.');
			}
			out.set(bytes.subarray(at, at + span), written * sampleBytes);
			at += span;
		}
		written += count;
	}

	return out;
}

/**
 * Decode a TGA into straight RGBA.
 *
 * The result is always tagged sRGB. TGA has no way to carry a colour space: the
 * version 2 extension area holds a gamma ratio and nothing else, and no profile
 * at all, so an image written as a TGA has already lost any record of what its
 * numbers meant.
 */
export function decodeTga(bytes: Uint8Array): RasterImage {
	if (bytes.length < HEADER_BYTES) {
		fail('it is too short to hold the 18 byte header.');
	}

	const idLength = bytes[0] as number;
	const colourMapType = bytes[1] as number;
	const imageType = bytes[2] as number;
	const colourMapLength = readU16(bytes, 5);
	const colourMapEntryBits = bytes[7] as number;
	const width = readU16(bytes, 12);
	const height = readU16(bytes, 14);
	const depth = bytes[16] as number;
	const descriptor = bytes[17] as number;

	if (width === 0 || height === 0) {
		fail('the header gives it a width or a height of zero.');
	}

	const pixels = width * height;
	if (pixels > MAX_PIXELS) {
		fail('the header describes an image far larger than anything this tool will allocate for.');
	}

	switch (imageType) {
		case IMAGE_TYPE_TRUECOLOUR:
		case IMAGE_TYPE_GREYSCALE:
		case IMAGE_TYPE_RLE_TRUECOLOUR:
		case IMAGE_TYPE_RLE_GREYSCALE:
			break;
		case IMAGE_TYPE_COLOUR_MAPPED:
		case IMAGE_TYPE_RLE_COLOUR_MAPPED:
			fail(
				'it stores its pixels as indexes into a colour table, which this reader does not implement.',
			);
			break;
		case IMAGE_TYPE_HUFFMAN_COLOUR_MAPPED:
		case IMAGE_TYPE_HUFFMAN_QUADTREE:
			fail('it uses one of the Huffman compressed types, which this reader does not implement.');
			break;
		default:
			fail(`the header gives an image type of ${imageType}, which the format does not define.`);
	}

	const greyscale = imageType === IMAGE_TYPE_GREYSCALE || imageType === IMAGE_TYPE_RLE_GREYSCALE;
	const compressed =
		imageType === IMAGE_TYPE_RLE_TRUECOLOUR || imageType === IMAGE_TYPE_RLE_GREYSCALE;

	if (greyscale && depth !== 8) {
		// Sixteen bit greyscale, eight bits of grey and eight of alpha, is legal
		// and vanishingly rare. Named rather than guessed at, so the handful of
		// people who own one are told what they have instead of shown a wrong
		// picture.
		fail(`it is ${depth} bit greyscale, and this reader implements only the 8 bit kind.`);
	}
	if (!greyscale && depth !== 15 && depth !== 16 && depth !== 24 && depth !== 32) {
		fail(`the header gives a pixel depth of ${depth} bits, which the format does not define.`);
	}

	// A truecolour image may still carry a colour map it never reads from, so
	// the map is measured and stepped over rather than assumed absent.
	const entryBytes = Math.ceil(colourMapEntryBits / 8);
	const colourMapBytes = colourMapType === 1 ? colourMapLength * entryBytes : 0;
	const from = HEADER_BYTES + idLength + colourMapBytes;
	if (from > bytes.length) {
		fail('the image id and colour table run past the end of the file.');
	}

	const sampleBytes = depth === 8 ? 1 : depth <= 16 ? 2 : depth === 24 ? 3 : 4;
	let samples: Uint8Array;
	if (compressed) {
		samples = expandRle(bytes, from, pixels, sampleBytes);
	} else {
		const span = pixels * sampleBytes;
		if (from + span > bytes.length) {
			fail(
				`the pixel data stops ${from + span - bytes.length} bytes short of the ${width} by ${height} the header claims.`,
			);
		}
		samples = bytes.subarray(from, from + span);
	}

	// Bit 15 of a 16 bit pixel is an attribute bit rather than a channel, and it
	// only means anything when the descriptor says one bit of alpha is present.
	// At 15 bits the format defines it as unused.
	const alphaBits = descriptor & DESCRIPTOR_ALPHA_BITS;
	const carriesAlpha = depth === 32 || (depth === 16 && alphaBits === 1);
	const topDown = (descriptor & DESCRIPTOR_TOP_DOWN) !== 0;
	const rightToLeft = (descriptor & DESCRIPTOR_RIGHT_TO_LEFT) !== 0;

	const out = createRaster(width, height, 'srgb', carriesAlpha);
	const target = out.data;

	for (let y = 0; y < height; y += 1) {
		// Bottom row first is the format's default, so the descriptor bit marks
		// the exception rather than the rule.
		const sourceRow = topDown ? y : height - 1 - y;
		for (let x = 0; x < width; x += 1) {
			const sourceColumn = rightToLeft ? width - 1 - x : x;
			const at = (sourceRow * width + sourceColumn) * sampleBytes;
			const to = (y * width + x) * 4;

			switch (sampleBytes) {
				case 1: {
					const grey = samples[at] as number;
					target[to] = grey;
					target[to + 1] = grey;
					target[to + 2] = grey;
					target[to + 3] = 255;
					break;
				}
				case 2: {
					const packed = (samples[at] as number) | ((samples[at + 1] as number) << 8);
					target[to] = widen5((packed >> 10) & 0x1f);
					target[to + 1] = widen5((packed >> 5) & 0x1f);
					target[to + 2] = widen5(packed & 0x1f);
					target[to + 3] = carriesAlpha && (packed & 0x8000) === 0 ? 0 : 255;
					break;
				}
				case 3: {
					// Blue first: the header has no field for channel order because
					// there is only one, and it is the reverse of the obvious one.
					target[to] = samples[at + 2] as number;
					target[to + 1] = samples[at + 1] as number;
					target[to + 2] = samples[at] as number;
					target[to + 3] = 255;
					break;
				}
				default: {
					target[to] = samples[at + 2] as number;
					target[to + 1] = samples[at + 1] as number;
					target[to + 2] = samples[at] as number;
					target[to + 3] = samples[at + 3] as number;
					break;
				}
			}
		}
	}

	if (carriesAlpha) {
		// A file whose alpha is zero in every pixel is not a picture of nothing,
		// it is a writer that never touched the attribute bytes. Plenty did, and
		// honouring them literally turns a perfectly good texture invisible, so
		// the channel is treated as absent instead.
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

	// A file that can carry alpha only counts as having it once a pixel actually
	// uses it, because that is what the flag means downstream: an image full of
	// 255s should not push the next encoder into a heavier representation.
	return { ...out, hasAlpha: carriesAlpha && detectAlpha(out) };
}
