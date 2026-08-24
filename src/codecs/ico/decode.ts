/**
 * A Windows ICO reader.
 *
 * Two jobs, kept apart on purpose. `readIcoDirectory` parses the container and
 * hands back the payloads without interpreting them, which is all a caller
 * needs to pick a size or to pull the embedded PNG out of a modern favicon.
 * `decodeIco` goes one step further and unpacks the icon's own bitmap form,
 * which is a BMP with its file header removed and its height doubled to make
 * room for a one bit transparency mask underneath the pixels.
 *
 * An entry whose payload is a PNG is refused rather than decoded here. A codec
 * in this package is a leaf and may not call another codec, and inflating a
 * PNG is asynchronous besides, so the honest answer is to name the situation
 * and let the caller hand those bytes to the PNG decoder.
 */

import { DecodeFailedError, ImageTooLargeError, UnsupportedHereError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';

const DECODER_ID = 'ico-pure';

const DIRECTORY_HEADER_BYTES = 6;
const DIRECTORY_ENTRY_BYTES = 16;
const BITMAPINFOHEADER_BYTES = 40;

/** Zero in a directory's side byte means 256, which is a byte too wide. */
const SIDE_ZERO_MEANS = 256;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The only uncompressed bitmap code. Everything else here is run-length coded. */
const BI_RGB = 0;

/** The depths Windows defines an icon at. Nothing else is guessed at. */
const SUPPORTED_DEPTHS = [1, 4, 8, 24, 32];

/**
 * An upper bound on the pixels one entry may claim.
 *
 * A one bit bitmap expands thirty-two fold on the way to RGBA, so a payload
 * that has already been bounds-checked against the file can still ask for an
 * allocation far larger than the file itself. Icons are 256 pixels a side by
 * definition; this leaves room for the oversized ones some tools write while
 * still refusing a header whose only purpose is to ask for a gigabyte.
 */
const MAX_IMAGE_PIXELS = 4096 * 4096;

function fail(detail: string): never {
	throw new DecodeFailedError('ico', DECODER_ID, detail);
}

/** Which of the two payload forms an entry holds. Decided from the bytes. */
export type IcoPayloadKind = 'png' | 'dib';

export interface IcoDirectoryEntry {
	/** Pixels across, as the directory records it. 256 where the byte was zero. */
	readonly width: number;
	readonly height: number;
	/** Palette size, or zero for anything that is not palettised. */
	readonly colourCount: number;
	/** Colour planes, always 1 in practice. A cursor stores its hotspot x here. */
	readonly planes: number;
	/** Bits per pixel, as a hint for choosing between entries. A cursor stores its hotspot y here. */
	readonly bitCount: number;
	readonly payloadKind: IcoPayloadKind;
	/** A view into the input, not a copy. */
	readonly payload: Uint8Array;
}

export interface IcoDirectory {
	readonly kind: 'icon' | 'cursor';
	readonly entries: readonly IcoDirectoryEntry[];
}

function looksLikePng(payload: Uint8Array): boolean {
	if (payload.length < PNG_SIGNATURE.length) return false;
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (payload[i] !== PNG_SIGNATURE[i]) return false;
	}
	return true;
}

/**
 * Parse the container and return every entry, in file order.
 *
 * Nothing here interprets a payload beyond looking at its first eight bytes to
 * see which of the two forms it is.
 */
export function readIcoDirectory(bytes: Uint8Array): IcoDirectory {
	if (bytes.length < DIRECTORY_HEADER_BYTES) {
		fail('the file ends before its six byte directory header.');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Every multi-byte field in an ICO is little endian.
	const reserved = view.getUint16(0, true);
	const type = view.getUint16(2, true);
	const count = view.getUint16(4, true);

	if (reserved !== 0) {
		fail('the first two bytes are reserved and are not zero, so this is not an icon.');
	}
	if (type !== 1 && type !== 2) {
		fail(`the directory declares type ${type}, and only 1 (icon) and 2 (cursor) exist.`);
	}
	if (count === 0) {
		fail('the directory says it holds no images at all.');
	}

	const directoryBytes = DIRECTORY_HEADER_BYTES + count * DIRECTORY_ENTRY_BYTES;
	if (bytes.length < directoryBytes) {
		fail(
			`the directory claims ${count} images, which needs ${directoryBytes} bytes, and the file is ${bytes.length} bytes long.`,
		);
	}

	const entries: IcoDirectoryEntry[] = [];
	for (let i = 0; i < count; i += 1) {
		const at = DIRECTORY_HEADER_BYTES + i * DIRECTORY_ENTRY_BYTES;
		const size = view.getUint32(at + 8, true);
		const offset = view.getUint32(at + 12, true);
		if (size === 0) {
			fail(`image ${i + 1} declares a length of zero bytes.`);
		}
		// Payloads sit after the directory. A file that points one back into the
		// directory, or past the end, is either damaged or trying something.
		if (offset < directoryBytes || offset + size > bytes.length) {
			fail(
				`image ${i + 1} claims ${size} bytes at offset ${offset}, which is not inside a file of ${bytes.length} bytes.`,
			);
		}
		const width = bytes[at] as number;
		const height = bytes[at + 1] as number;
		const payload = bytes.subarray(offset, offset + size);
		entries.push({
			width: width === 0 ? SIDE_ZERO_MEANS : width,
			height: height === 0 ? SIDE_ZERO_MEANS : height,
			colourCount: bytes[at + 2] as number,
			planes: view.getUint16(at + 4, true),
			bitCount: view.getUint16(at + 6, true),
			payloadKind: looksLikePng(payload) ? 'png' : 'dib',
			payload,
		});
	}

	return { kind: type === 1 ? 'icon' : 'cursor', entries };
}

function paletteIndex(payload: Uint8Array, rowStart: number, x: number, bitCount: number): number {
	if (bitCount === 8) return payload[rowStart + x] as number;
	if (bitCount === 4) {
		const byte = payload[rowStart + (x >> 1)] as number;
		// The high nibble is the left hand pixel.
		return (x & 1) === 0 ? byte >> 4 : byte & 0x0f;
	}
	const byte = payload[rowStart + (x >> 3)] as number;
	return (byte >> (7 - (x & 7))) & 1;
}

/** A set bit in the AND mask means the pixel is transparent. */
function maskedOut(payload: Uint8Array, rowStart: number, x: number): boolean {
	const byte = payload[rowStart + (x >> 3)] as number;
	return ((byte >> (7 - (x & 7))) & 1) === 1;
}

/** How the pixels and the optional mask are laid out inside one payload. */
interface DibLayout {
	readonly height: number;
	readonly hasMask: boolean;
	readonly requiredBytes: number;
}

/**
 * Unpack one headerless BMP payload.
 *
 * `declaredHeight` is what the directory said, used only to settle the height
 * ambiguity below. The bitmap header is thirty-two bits wide and the directory
 * is eight, so the header wins everywhere else.
 */
function decodeDib(payload: Uint8Array, declaredHeight: number): RasterImage {
	if (payload.length < BITMAPINFOHEADER_BYTES) {
		fail(
			`a bitmap needs a ${BITMAPINFOHEADER_BYTES} byte header and this one has ${payload.length} bytes.`,
		);
	}
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const headerBytes = view.getUint32(0, true);
	const width = view.getInt32(4, true);
	const storedHeight = view.getInt32(8, true);
	const bitCount = view.getUint16(14, true);
	const compression = view.getUint32(16, true);
	const colourCount = view.getUint32(32, true);

	// A BITMAPCOREHEADER is 12 bytes and has a different shape entirely. The V4
	// and V5 headers are longer than 40 and are read as their first 40 bytes,
	// which is what the extra fields extend rather than replace.
	if (headerBytes < BITMAPINFOHEADER_BYTES || headerBytes > payload.length) {
		fail(`the bitmap header declares a length of ${headerBytes} bytes, which cannot be right.`);
	}
	if (compression !== BI_RGB) {
		throw new UnsupportedHereError(
			'ico',
			['pure'],
			'This icon holds a run-length compressed bitmap, which this reader does not unpack.',
		);
	}
	if (bitCount === 0) {
		fail('the bitmap declares zero bits per pixel.');
	}
	if (!SUPPORTED_DEPTHS.includes(bitCount)) {
		throw new UnsupportedHereError(
			'ico',
			['pure'],
			`This icon stores ${bitCount} bits per pixel. Icons are defined at 1, 4, 8, 24 and 32 bits, and this reader will not guess at anything else.`,
		);
	}
	if (width <= 0 || storedHeight === 0) {
		fail(`the bitmap declares a size of ${width} by ${storedHeight}, which has no pixels in it.`);
	}

	const paletteCount = bitCount <= 8 ? (colourCount > 0 ? colourCount : 1 << bitCount) : 0;
	if (bitCount <= 8 && paletteCount > 1 << bitCount) {
		fail(
			`the bitmap declares ${paletteCount} palette colours, which ${bitCount} bits per pixel cannot index.`,
		);
	}
	const paletteStart = headerBytes;
	const pixelStart = headerBytes + paletteCount * 4;
	if (pixelStart > payload.length) {
		fail('the palette runs past the end of the image data.');
	}

	// Rows of both the pixels and the mask are padded out to four bytes.
	// Computed in floating point rather than with shifts, because a hostile
	// width times 32 bits overflows a 32 bit shift and wraps to a small number.
	const stride = Math.ceil((width * bitCount) / 32) * 4;
	const maskStride = Math.ceil(width / 32) * 4;

	// A negative height is a top-down bitmap, which cannot have a mask beneath
	// it. Otherwise the height is doubled to cover the mask, so the real height
	// is half of it. Some writers omit both the mask and the doubling, so both
	// readings are offered and the one the file can actually hold wins, with
	// the directory's own height breaking a tie.
	const topDown = storedHeight < 0;
	const magnitude = Math.abs(storedHeight);
	const candidates: DibLayout[] = [];
	if (!topDown && magnitude % 2 === 0) {
		const height = magnitude / 2;
		candidates.push({
			height,
			hasMask: true,
			requiredBytes: pixelStart + (stride + maskStride) * height,
		});
	}
	candidates.push({
		height: magnitude,
		hasMask: false,
		requiredBytes: pixelStart + stride * magnitude,
	});

	const usable = candidates.filter((candidate) => payload.length >= candidate.requiredBytes);
	if (usable.length === 0) {
		const needed = Math.min(...candidates.map((candidate) => candidate.requiredBytes));
		fail(
			`the pixels stop short: a ${width} by ${magnitude} bitmap at ${bitCount} bits per pixel needs at least ${needed} bytes and this one has ${payload.length}.`,
		);
	}
	const layout =
		usable.find((candidate) => candidate.height === declaredHeight) ?? (usable[0] as DibLayout);
	const height = layout.height;

	const pixels = width * height;
	if (pixels > MAX_IMAGE_PIXELS) {
		throw new ImageTooLargeError(pixels, MAX_IMAGE_PIXELS);
	}

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;
	const maskStart = pixelStart + stride * height;
	let alphaChannelUsed = false;

	for (let y = 0; y < height; y += 1) {
		const sourceRow = topDown ? y : height - 1 - y;
		const rowStart = pixelStart + sourceRow * stride;
		let to = y * width * 4;
		for (let x = 0; x < width; x += 1) {
			let red: number;
			let green: number;
			let blue: number;
			let alpha = 255;
			switch (bitCount) {
				case 32: {
					const at = rowStart + x * 4;
					blue = payload[at] as number;
					green = payload[at + 1] as number;
					red = payload[at + 2] as number;
					alpha = payload[at + 3] as number;
					if (alpha !== 0) alphaChannelUsed = true;
					break;
				}
				case 24: {
					const at = rowStart + x * 3;
					blue = payload[at] as number;
					green = payload[at + 1] as number;
					red = payload[at + 2] as number;
					break;
				}
				default: {
					const index = paletteIndex(payload, rowStart, x, bitCount);
					if (index >= paletteCount) {
						fail(`a pixel asks for palette colour ${index} of ${paletteCount}.`);
					}
					const at = paletteStart + index * 4;
					blue = payload[at] as number;
					green = payload[at + 1] as number;
					red = payload[at + 2] as number;
					break;
				}
			}
			target[to] = red;
			target[to + 1] = green;
			target[to + 2] = blue;
			target[to + 3] = alpha;
			to += 4;
		}
	}

	// Icons written before Windows XP left the fourth byte at zero and put
	// transparency in the mask instead. Honouring that zero would make the
	// whole picture invisible, so the mask wins wherever the alpha channel
	// carries nothing at all, and an icon with neither is simply opaque.
	if (layout.hasMask && (bitCount !== 32 || !alphaChannelUsed)) {
		for (let y = 0; y < height; y += 1) {
			const rowStart = maskStart + (height - 1 - y) * maskStride;
			let to = y * width * 4 + 3;
			for (let x = 0; x < width; x += 1) {
				target[to] = maskedOut(payload, rowStart, x) ? 0 : 255;
				to += 4;
			}
		}
	} else if (bitCount === 32 && !alphaChannelUsed) {
		for (let i = 3; i < target.length; i += 4) target[i] = 255;
	}

	return { ...image, hasAlpha: detectAlpha(image) };
}

/**
 * Decode the largest image in an icon.
 *
 * Largest rather than first, because the order in a real icon file is whatever
 * the tool that wrote it felt like, and because the caller who wants a
 * specific size can read the directory and pick one.
 */
export function decodeIco(bytes: Uint8Array): RasterImage {
	const directory = readIcoDirectory(bytes);
	const entries = directory.entries;
	let best = entries[0] as IcoDirectoryEntry;
	for (let i = 1; i < entries.length; i += 1) {
		const entry = entries[i] as IcoDirectoryEntry;
		const area = entry.width * entry.height;
		const bestArea = best.width * best.height;
		// Depth only breaks a tie for an icon: in a cursor those two bytes are
		// the hotspot, and comparing hotspots would be meaningless.
		const deeper = directory.kind === 'icon' && entry.bitCount > best.bitCount;
		if (area > bestArea || (area === bestArea && deeper)) best = entry;
	}

	if (best.payloadKind === 'png') {
		throw new UnsupportedHereError(
			'ico',
			['pure'],
			'This icon stores its largest image as an embedded PNG. This reader unpacks only the bitmap form of an icon, so that image has to be read as a PNG on its own.',
		);
	}
	return decodeDib(best.payload, best.height);
}
