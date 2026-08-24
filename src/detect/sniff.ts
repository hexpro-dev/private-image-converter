/**
 * Identify a format from its bytes.
 *
 * The extension and the MIME type a file picker reports are both hearsay. An
 * iPhone photo shared through a chat app arrives as `image.jpg` containing
 * HEIC often enough that trusting the name is a guaranteed support ticket, and
 * some Android file managers report no type at all. So the bytes decide, and
 * the name is only ever used to label the output.
 */

import { EmptyInputError, UnknownFormatError } from '../errors.js';
import type { FormatId } from '../types.js';

/**
 * Bytes needed to identify every format here.
 *
 * The ISOBMFF check is the demanding one: the brand list lives after the box
 * header and can hold a dozen four-character codes, and Apple writes several.
 */
export const SNIFF_BYTES = 64;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let out = '';
	for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
	return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	if (bytes.length < signature.length) return false;
	for (let i = 0; i < signature.length; i += 1) {
		if (bytes[i] !== signature[i]) return false;
	}
	return true;
}

/**
 * Brands that mean "this ISOBMFF file is a HEIF still image".
 *
 * `mif1` is the generic HEIF brand and appears on Apple's files alongside
 * `heic`, so it counts, but only after AVIF has been ruled out: an AVIF is
 * also `mif1`-compatible and would otherwise be claimed by the HEIC decoder,
 * which would then fail on an AV1 bitstream it cannot read.
 */
const HEIF_BRANDS = new Set([
	'heic',
	'heix',
	'heim',
	'heis',
	'hevc',
	'hevx',
	'hevm',
	'hevs',
	'mif1',
	'msf1',
	'miaf',
]);

const AVIF_BRANDS = new Set(['avif', 'avis', 'av01']);

/** Read the major brand and the compatible-brand list out of an `ftyp` box. */
function isobmffBrands(bytes: Uint8Array): string[] {
	const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	const brands: string[] = [ascii(bytes, 8, 4)];
	// major brand, then a four byte minor version, then the compatible list.
	//
	// Read from the whole buffer rather than from the sniffing window. Apple
	// writes several brands and the list can run past 64 bytes, and the brand
	// that decides between AVIF and HEIC is not guaranteed to be an early one.
	// Truncating the list there made a thirteen brand AVIF read as HEIC, which
	// then handed an AV1 bitstream to an HEVC decoder.
	const end = Math.min(size, bytes.length);
	for (let offset = 16; offset + 4 <= end; offset += 4) {
		brands.push(ascii(bytes, offset, 4));
	}
	return brands;
}

/**
 * Whether an ICO or CUR directory header is real.
 *
 * `00 00 02 00` is a valid CUR header and also the first four bytes of the most
 * common TGA there is: no identification field, no colour map, image type 2.
 * The two are told apart by the image count, which an ICO directory requires to
 * be at least one and which lands on a TGA's colour map length, zero for any
 * truecolour file. Without this check every uncompressed TGA was reported as a
 * cursor.
 */
function looksLikeIco(bytes: Uint8Array): boolean {
	if (bytes.length < 6) return false;
	const count = (bytes[4] as number) | ((bytes[5] as number) << 8);
	return count >= 1;
}

/**
 * A TGA has no signature at the front.
 *
 * Version 2 files carry `TRUEVISION-XFILE` in an 18 byte footer, which is
 * conclusive. Everything older has to be recognised from a header whose fields
 * are merely plausible, so this runs last and only accepts combinations that
 * no other format here would produce.
 */
function looksLikeTga(bytes: Uint8Array, full?: Uint8Array): boolean {
	if (full && full.length >= 18) {
		const footer = ascii(full, full.length - 18, 16);
		if (footer === 'TRUEVISION-XFILE') return true;
	}
	if (bytes.length < 18) return false;
	const colourMapType = bytes[1];
	const imageType = bytes[2];
	const depth = bytes[16];
	if (colourMapType !== 0 && colourMapType !== 1) return false;
	if (![1, 2, 3, 9, 10, 11].includes(imageType ?? -1)) return false;
	if (![8, 15, 16, 24, 32].includes(depth ?? -1)) return false;
	// A colour-mapped type must have a map, and a truecolour one must not.
	const mapped = imageType === 1 || imageType === 9;
	return mapped === (colourMapType === 1);
}

function looksLikePnm(bytes: Uint8Array): boolean {
	if (bytes[0] !== 0x50) return false; // 'P'
	const kind = bytes[1] ?? 0;
	if (kind < 0x31 || kind > 0x37) return false; // '1'..'7'
	const next = bytes[2] ?? 0;
	return next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x23;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
	// Skip a UTF-8 BOM and any leading whitespace, then look for the opening
	// of an XML document or an svg element. Anything else that starts with '<'
	// is not our problem.
	let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
	while (
		i < bytes.length &&
		(bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
	) {
		i += 1;
	}
	const head = ascii(bytes, i, Math.min(14, bytes.length - i)).toLowerCase();
	return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg');
}

/**
 * Identify the format of `bytes`, or return undefined.
 *
 * `bytes` may be just the head of the file. Pass the whole thing when you have
 * it, because the TGA footer check needs the end.
 */
export function sniffFormat(bytes: Uint8Array): FormatId | undefined {
	if (bytes.length === 0) return undefined;
	const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;

	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
	if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
	if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
	if (ascii(head, 0, 4) === 'qoif') return 'qoi';
	if (ascii(head, 0, 8) === 'farbfeld') return 'farbfeld';
	if (startsWith(head, [0x42, 0x4d])) return 'bmp';
	if (startsWith(head, [0x00, 0x00, 0x01, 0x00]) && looksLikeIco(head)) return 'ico';
	// .cur, the same container with a different type field.
	if (startsWith(head, [0x00, 0x00, 0x02, 0x00]) && looksLikeIco(head)) return 'ico';
	// Compared byte by byte rather than as a string, because the fourth byte of
	// the little endian signature is a NUL and `ascii` pads a short buffer with
	// those: read as text, a three byte file containing `II*` matched.
	if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]))
		return 'tiff';

	if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
		const brands = isobmffBrands(bytes);
		// AVIF first. An AVIF is also mif1-compatible, so testing HEIF first
		// would hand an AV1 bitstream to the HEVC decoder.
		if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
		if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heic';
	}

	if (looksLikePnm(head)) return 'pnm';
	if (looksLikeSvg(head)) return 'svg';
	if (looksLikeTga(head, bytes)) return 'tga';
	return undefined;
}

/** As `sniffFormat`, but throws the error the caller would have had to write. */
export function requireFormat(bytes: Uint8Array): FormatId {
	if (bytes.length === 0) throw new EmptyInputError();
	const format = sniffFormat(bytes);
	if (format === undefined) {
		throw new UnknownFormatError(bytes.subarray(0, Math.min(16, bytes.length)));
	}
	return format;
}
