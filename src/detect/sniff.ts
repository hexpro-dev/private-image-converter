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
 * A PCX sets the number: it has one magic byte and is otherwise identified by
 * fields spread across a 128 byte header, so anything shorter would have to
 * accept it on the strength of a single 0x0A. The ISOBMFF brand list is longer
 * still and is read from the whole buffer instead, for the reason on
 * `isobmffBrands`.
 */
export const SNIFF_BYTES = 128;

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
 * Whether a PNG carries an animation control chunk before its first frame.
 *
 * An APNG is a PNG. There is no separate signature, no distinguishing brand
 * and nothing in the header to read: the only difference is an `acTL` chunk,
 * and the specification requires it to appear before the first `IDAT`. So the
 * chunk list is walked until one or the other turns up, which for a still PNG
 * is two or three chunks and never the whole file.
 *
 * Told apart at all because the two decode to different things. A still reader
 * handed an APNG returns the default image, which is often a deliberately
 * chosen poster frame that looks nothing like the animation, and the person
 * who dropped in a moving picture gets a still one with no explanation.
 */
function looksLikeApng(bytes: Uint8Array): boolean {
	let at = 8;
	// A PNG has no chunk count, so the only bound is the buffer. The cap is a
	// guard against a crafted file whose chunk lengths walk a few bytes at a
	// time forever; no real PNG has anything like this many chunks before its
	// first IDAT.
	for (let seen = 0; seen < 256 && at + 8 <= bytes.length; seen += 1) {
		const length =
			((bytes[at] as number) << 24) |
			((bytes[at + 1] as number) << 16) |
			((bytes[at + 2] as number) << 8) |
			(bytes[at + 3] as number);
		// Read unsigned. A length with the top bit set is invalid per the
		// specification, and reading it as negative would walk backwards.
		if (length < 0) return false;
		const type = ascii(bytes, at + 4, 4);
		if (type === 'acTL') return true;
		if (type === 'IDAT' || type === 'IEND') return false;
		at += 12 + length;
	}
	return false;
}

/**
 * A Radiance picture, which announces itself in a comment.
 *
 * `#?` alone is too little to go on, so the format name on the first line has
 * to be there as well. Files in the wild say `RADIANCE` or, from older tools,
 * `RGBE`.
 */
function looksLikeHdr(bytes: Uint8Array): boolean {
	if (bytes[0] !== 0x23 || bytes[1] !== 0x3f) return false; // '#?'
	const line = ascii(bytes, 2, Math.min(30, Math.max(0, bytes.length - 2)));
	const end = line.indexOf('\n');
	const first = (end < 0 ? line : line.slice(0, end)).toUpperCase();
	return first.includes('RADIANCE') || first.includes('RGBE');
}

/**
 * An X BitMap, which is a fragment of C rather than a binary file.
 *
 * The two `#define` lines that give the width and height are the whole header,
 * so the signature is `#define` followed by an identifier ending in `_width`.
 * Anything else beginning with `#define` is a C file, and this is the one
 * check that keeps those out.
 */
function looksLikeXbm(bytes: Uint8Array): boolean {
	if (ascii(bytes, 0, 7) !== '#define') return false;
	const head = ascii(bytes, 0, Math.min(256, bytes.length));
	return head.includes('_width');
}

/**
 * A PCX, which has one magic byte and then only plausibility.
 *
 * 0x0A is also a perfectly ordinary first byte, so every remaining field has
 * to agree: a version ZSoft actually shipped, one of the two encodings, a
 * depth that exists, and a window that is not inside out. Runs after every
 * format with a real signature and before TGA, which is the other one held
 * together by plausibility alone. The version field is what separates them: an
 * RLE PCX and a colour-mapped TGA agree on the first three bytes, and no PCX
 * has ever had version 1.
 */
function looksLikePcx(bytes: Uint8Array): boolean {
	if (bytes.length < 128 || bytes[0] !== 0x0a) return false;
	const version = bytes[1] as number;
	if (![0, 2, 3, 4, 5].includes(version)) return false;
	const encoding = bytes[2] as number;
	if (encoding !== 0 && encoding !== 1) return false;
	if (![1, 2, 4, 8].includes(bytes[3] as number)) return false;
	const planes = bytes[65] as number;
	if (planes < 1 || planes > 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const xMin = view.getUint16(4, true);
	const yMin = view.getUint16(6, true);
	const xMax = view.getUint16(8, true);
	const yMax = view.getUint16(10, true);
	return xMax >= xMin && yMax >= yMin;
}

/**
 * Whether a TIFF is really a camera's raw file.
 *
 * Every raw format worth converting except Fujifilm's is a TIFF with vendor
 * tags, so the signature says TIFF and nothing else does. Two markers settle
 * it without a full parse: a DNG version tag, or an IFD0 that describes itself
 * as a reduced-resolution image and points at sub-directories. That second
 * shape is exactly how Nikon, Sony, Pentax and Samsung lay out a raw, and it
 * is not how anything writes an ordinary TIFF.
 *
 * Worth telling apart because the conversion is different in kind. A TIFF is
 * decoded; a raw file has its embedded preview extracted, which is the JPEG
 * the camera itself rendered rather than a development of the sensor data, and
 * saying "TIFF" would promise the wrong thing.
 */
function looksLikeTiffRaw(bytes: Uint8Array): boolean {
	if (bytes.length < 16) return false;
	const little = bytes[0] === 0x49;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ifd = view.getUint32(4, little);
	if (ifd < 8 || ifd + 2 > bytes.length) return false;
	const count = view.getUint16(ifd, little);
	if (count === 0 || count > 512) return false;
	if (ifd + 2 + count * 12 > bytes.length) return false;

	let reduced = false;
	let subIfds = false;
	for (let i = 0; i < count; i += 1) {
		const at = ifd + 2 + i * 12;
		const tag = view.getUint16(at, little);
		// DNGVersion. Present in every DNG, including one converted from a
		// vendor format, and present in nothing else.
		if (tag === 0xc612) return true;
		// NewSubfileType, with bit 0 set: this directory is a reduced-size
		// version of another image in the file.
		if (tag === 0x00fe && view.getUint16(at + 2, little) === 4) {
			if ((view.getUint32(at + 8, little) & 1) === 1) reduced = true;
		}
		if (tag === 0x014a) subIfds = true;
	}
	return reduced && subIfds;
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

	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return looksLikeApng(bytes) ? 'apng' : 'png';
	}
	if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
	// A bare JPEG XL codestream. The other spelling is a box container, and it
	// is handled with the rest of the ISOBMFF family below.
	if (startsWith(head, [0xff, 0x0a])) return 'jxl';
	if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
	if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
	if (ascii(head, 0, 4) === 'qoif') return 'qoi';
	if (ascii(head, 0, 8) === 'farbfeld') return 'farbfeld';
	if (startsWith(head, [0x42, 0x4d])) return 'bmp';
	if (ascii(head, 0, 4) === '8BPS') return 'psd';
	if (ascii(head, 0, 4) === 'DDS ') return 'dds';
	if (ascii(head, 0, 4) === 'icns') return 'icns';
	if (startsWith(head, [0x76, 0x2f, 0x31, 0x01])) return 'exr';
	if (startsWith(head, [0x59, 0xa6, 0x6a, 0x95])) return 'ras';
	if (ascii(head, 0, 15) === 'FUJIFILMCCD-RAW') return 'raw';
	if (startsWith(head, [0x00, 0x00, 0x01, 0x00]) && looksLikeIco(head)) return 'ico';
	// .cur, the same container with a different type field.
	if (startsWith(head, [0x00, 0x00, 0x02, 0x00]) && looksLikeIco(head)) return 'ico';

	// Olympus and Panasonic write a TIFF with their own two byte version in
	// place of the usual 42, so the ordinary check below would miss them.
	if (
		ascii(head, 0, 4) === 'IIRO' ||
		ascii(head, 0, 4) === 'IIRS' ||
		ascii(head, 0, 4) === 'MMOR' ||
		startsWith(head, [0x49, 0x49, 0x55, 0x00])
	) {
		return 'raw';
	}
	// Compared byte by byte rather than as a string, because the fourth byte of
	// the little endian signature is a NUL and `ascii` pads a short buffer with
	// those: read as text, a three byte file containing `II*` matched.
	if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
		// Canon writes its own marker straight after the header. Everything
		// else that is really a raw file has to be recognised from its tags.
		if (ascii(head, 8, 2) === 'CR') return 'raw';
		return looksLikeTiffRaw(bytes) ? 'raw' : 'tiff';
	}
	// BigTIFF, version 43. Recognised so it can be refused by name rather than
	// reported as an unknown file, which sends somebody looking for the wrong
	// problem.
	if (startsWith(head, [0x49, 0x49, 0x2b, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2b])) {
		return 'tiff';
	}

	if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
		const brands = isobmffBrands(bytes);
		// AVIF first. An AVIF is also mif1-compatible, so testing HEIF first
		// would hand an AV1 bitstream to the HEVC decoder.
		if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
		if (brands.includes('crx ')) return 'raw';
		if (brands.includes('jxl ')) return 'jxl';
		if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heic';
	}
	// The JPEG XL box container, whose first box is a signature rather than an
	// `ftyp`. The `ftyp` follows it, which is why this is a separate test.
	if (startsWith(head, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return 'jxl';

	if (looksLikePnm(head)) return 'pnm';
	if (looksLikeHdr(head)) return 'hdr';
	if (ascii(head, 0, 9) === '/* XPM */') return 'xpm';
	if (looksLikeXbm(head)) return 'xbm';
	if (looksLikeSvg(head)) return 'svg';
	// Both of the formats below are recognised by plausibility rather than by a
	// signature, so they run last and in this order. See `looksLikePcx`.
	if (looksLikePcx(bytes)) return 'pcx';
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
