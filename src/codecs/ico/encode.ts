/**
 * A Windows ICO writer.
 *
 * ICO is not an image format, it is a directory of images. Each entry's
 * payload is either a whole PNG file or a headerless BMP, and the container
 * itself compresses nothing. So this module writes the directory and copies
 * payloads in, and never encodes an image: the caller hands it PNG bytes that
 * were produced somewhere else.
 *
 * Keeping the split there is what makes an icon set cheap to assemble. A
 * favicon holds the same picture at four or five sizes, each of which wants
 * its own downscale and its own filter choices, and none of those decisions
 * belong to a container writer.
 */

import { EncodeFailedError } from '../../errors.js';

/** One size in the icon. `png` is a complete PNG file, signature included. */
export interface IcoEntry {
	readonly width: number;
	readonly height: number;
	readonly png: Uint8Array;
}

const ENCODER_ID = 'ico-container';

const DIRECTORY_HEADER_BYTES = 6;
const DIRECTORY_ENTRY_BYTES = 16;

/**
 * The largest side the directory can express.
 *
 * Each side is one byte, and 256 is written as zero. There is no escape for
 * anything above that, which is why a larger size is refused here rather than
 * silently truncated to its low byte: 512 would be written as 0 and read back
 * as 256, and the icon would look correct in the file listing and wrong
 * everywhere it was drawn.
 */
const MAX_SIDE = 256;

/** The count field is sixteen bits. */
const MAX_ENTRIES = 0xffff;

/** Offsets and sizes are unsigned 32 bit. */
const MAX_FILE_BYTES = 0xffffffff;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function checkSide(value: number, side: string, index: number): void {
	if (!Number.isInteger(value) || value < 1 || value > MAX_SIDE) {
		throw new EncodeFailedError(
			'ico',
			ENCODER_ID,
			`image ${index + 1} has a ${side} of ${value}, and an icon image is between 1 and 256 pixels on a side. The directory records each side in a single byte, so there is nowhere to put a larger number.`,
		);
	}
}

function checkPng(png: Uint8Array, index: number): void {
	if (png.length < PNG_SIGNATURE.length) {
		throw new EncodeFailedError(
			'ico',
			ENCODER_ID,
			`the payload for image ${index + 1} is too short to be a PNG file.`,
		);
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (png[i] !== PNG_SIGNATURE[i]) {
			throw new EncodeFailedError(
				'ico',
				ENCODER_ID,
				`the payload for image ${index + 1} does not start with a PNG signature. This writer copies whole PNG files into the container rather than encoding them, so the bytes have to be a PNG already.`,
			);
		}
	}
}

/**
 * Write an ICO holding `entries`, in the order given.
 *
 * The order is preserved rather than sorted. Windows picks a size by looking
 * at the directory rather than by position, and a caller that wants
 * largest-first (which is what most icon tooling writes) can say so by passing
 * them that way.
 */
export function encodeIco(entries: readonly IcoEntry[]): Uint8Array {
	if (entries.length === 0) {
		throw new EncodeFailedError(
			'ico',
			ENCODER_ID,
			'an icon has to contain at least one image, and none were given.',
		);
	}
	if (entries.length > MAX_ENTRIES) {
		throw new EncodeFailedError(
			'ico',
			ENCODER_ID,
			`the directory counts its images in sixteen bits, so it cannot hold ${entries.length} of them.`,
		);
	}

	let payloadBytes = 0;
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i] as IcoEntry;
		checkSide(entry.width, 'width', i);
		checkSide(entry.height, 'height', i);
		checkPng(entry.png, i);
		payloadBytes += entry.png.length;
	}

	const directoryBytes = DIRECTORY_HEADER_BYTES + entries.length * DIRECTORY_ENTRY_BYTES;
	const total = directoryBytes + payloadBytes;
	if (total > MAX_FILE_BYTES) {
		throw new EncodeFailedError(
			'ico',
			ENCODER_ID,
			'the images add up to more than four gigabytes, which the directory cannot address.',
		);
	}

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	// Every multi-byte field in an ICO is little endian.
	view.setUint16(0, 0, true); // reserved
	view.setUint16(2, 1, true); // 1 is an icon, 2 would be a cursor
	view.setUint16(4, entries.length, true);

	let offset = directoryBytes;
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i] as IcoEntry;
		const at = DIRECTORY_HEADER_BYTES + i * DIRECTORY_ENTRY_BYTES;
		out[at] = entry.width === MAX_SIDE ? 0 : entry.width;
		out[at + 1] = entry.height === MAX_SIDE ? 0 : entry.height;
		out[at + 2] = 0; // palette size, zero for anything that is not palettised
		out[at + 3] = 0; // reserved
		view.setUint16(at + 4, 1, true); // colour planes
		// Bits per pixel is a hint that readers use to choose between two
		// entries of the same size, and nothing reads pixels through it. A PNG
		// payload may or may not carry alpha, and finding out would mean
		// parsing the IHDR, so this claims the wider of the two. Claiming 32
		// where the payload is 24 bit costs nothing; claiming 24 where it is 32
		// would lose the entry to a lower quality sibling.
		view.setUint16(at + 6, 32, true);
		view.setUint32(at + 8, entry.png.length, true);
		view.setUint32(at + 12, offset, true);
		out.set(entry.png, offset);
		offset += entry.png.length;
	}

	return out;
}
