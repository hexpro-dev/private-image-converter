/**
 * Format identification: from the bytes, and from the two pieces of hearsay a
 * browser hands over beside them.
 *
 * Every buffer here is spelled out from the specification rather than captured
 * from a real file, so the suite runs on a clean checkout and so a wrong
 * expectation shows up in the diff instead of hiding inside a fixture. The
 * cases that matter most are the ones where two formats share a prefix: an
 * AVIF and a HEIC are the same container with a different payload, and a TGA
 * has no signature at all.
 */

import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES, requireFormat, sniffFormat } from '../../src/detect/sniff.js';
import {
	FORMATS,
	FORMAT_IDS,
	formatForExtension,
	formatForMime,
	formatInfo,
} from '../../src/formats.js';
import { EmptyInputError, UnknownFormatError } from '../../src/errors.js';
import type { FormatId } from '../../src/types.js';

/* ── Builders ─────────────────────────────────────────────────────────── */

function ascii(text: string): Uint8Array {
	return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function u32(value: number): Uint8Array {
	return Uint8Array.from([
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	]);
}

/**
 * The other byte order, for the formats that use it.
 *
 * RIFF and BMP write their lengths little endian, and a TIFF writes everything
 * in the order its magic declares. None of it is read by the sniffer, but a
 * buffer here is meant to be a real file of its format, so a later test that
 * does read one of these fields inherits something true.
 */
function u32le(value: number): Uint8Array {
	return u32(value).reverse();
}

interface FtypOptions {
	readonly major: string;
	readonly minor?: number;
	readonly compatible?: readonly string[];
	/** Override the declared box size, to pin that the brand list is bounded by it. */
	readonly declaredSize?: number;
	/** Whatever follows the box, as the next box's header would. */
	readonly trailing?: Uint8Array;
}

/** An ISOBMFF `ftyp` box: size, type, major brand, minor version, compatible list. */
function ftyp(options: FtypOptions): Uint8Array {
	const { major, minor = 0, compatible = [], declaredSize, trailing } = options;
	const body = concat(ascii(major), u32(minor), ...compatible.map(ascii));
	return concat(
		u32(declaredSize ?? body.length + 8),
		ascii('ftyp'),
		body,
		trailing ?? new Uint8Array(0),
	);
}

interface TgaOptions {
	readonly idLength?: number;
	readonly colourMapType?: number;
	readonly imageType?: number;
	readonly depth?: number;
	/** Append the 26 byte version 2 footer. */
	readonly footer?: boolean;
	/** Junk after the footer, which stops it being the last 18 bytes. */
	readonly trailingBytes?: number;
}

function tgaFile(options: TgaOptions = {}): Uint8Array {
	const header = new Uint8Array(18);
	header[0] = options.idLength ?? 0;
	header[1] = options.colourMapType ?? 0;
	header[2] = options.imageType ?? 10;
	header[12] = 4; // width, little endian
	header[14] = 4; // height
	header[16] = options.depth ?? 24;
	const footer = options.footer
		? concat(u32(0), u32(0), ascii('TRUEVISION-XFILE.'), Uint8Array.from([0]))
		: new Uint8Array(0);
	return concat(header, new Uint8Array(48), footer, new Uint8Array(options.trailingBytes ?? 0));
}

/* ── Signatures ───────────────────────────────────────────────────────── */

const PNG = concat(
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	u32(13),
	ascii('IHDR'),
	new Uint8Array(20),
);
const JPEG = concat(
	Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
	ascii('JFIF\0'),
	new Uint8Array(16),
);
const GIF87A = concat(ascii('GIF87a'), new Uint8Array(20));
const GIF89A = concat(ascii('GIF89a'), new Uint8Array(20));
const WEBP = concat(ascii('RIFF'), u32le(0x24), ascii('WEBP'), ascii('VP8L'), new Uint8Array(16));
const QOI = concat(ascii('qoif'), u32(2), u32(2), Uint8Array.from([4, 0]), new Uint8Array(16));
const FARBFELD = concat(ascii('farbfeld'), u32(2), u32(2), new Uint8Array(16));
const BMP = concat(ascii('BM'), u32le(0x46), new Uint8Array(20));
const ICO = concat(Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), new Uint8Array(20));
const CUR = concat(Uint8Array.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00]), new Uint8Array(20));
const TIFF_LE = concat(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), u32le(8), new Uint8Array(20));
const TIFF_BE = concat(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a]), u32(8), new Uint8Array(20));

/**
 * How many bytes each signature is, from the format's own specification.
 *
 * Every one of these is the published length: eight for the PNG signature, six
 * for a GIF version block, twelve for a RIFF header plus the form type that
 * says which RIFF this is. A reader that matches on fewer is matching on a
 * prefix, which is how a truncated download becomes a decode failure with the
 * wrong name on it.
 */
const SIGNATURES = [
	['PNG', PNG, 8, 'png'],
	// SOI is two bytes, and the third is the 0xff that opens whatever marker
	// comes next. Two bytes on their own are not enough to call a file a JPEG.
	['JPEG', JPEG, 3, 'jpeg'],
	['GIF87a', GIF87A, 6, 'gif'],
	['GIF89a', GIF89A, 6, 'gif'],
	['WebP', WEBP, 12, 'webp'],
	['QOI', QOI, 4, 'qoi'],
	['farbfeld', FARBFELD, 8, 'farbfeld'],
	['BMP', BMP, 2, 'bmp'],
	// Six, not four. The four byte directory header is shared with the most
	// common TGA there is, so the image count that follows it is part of what
	// identifies the format rather than part of its payload. See looksLikeIco.
	['ICO', ICO, 6, 'ico'],
	['TIFF little endian', TIFF_LE, 4, 'tiff'],
	['TIFF big endian', TIFF_BE, 4, 'tiff'],
] as const;

describe('sniffing a format from its signature', () => {
	it.each([
		['PNG', PNG, 'png'],
		['JPEG', JPEG, 'jpeg'],
		['GIF87a', GIF87A, 'gif'],
		['GIF89a', GIF89A, 'gif'],
		['WebP', WEBP, 'webp'],
		['QOI', QOI, 'qoi'],
		['farbfeld', FARBFELD, 'farbfeld'],
		['BMP', BMP, 'bmp'],
		['ICO', ICO, 'ico'],
		['TIFF little endian', TIFF_LE, 'tiff'],
		['TIFF big endian', TIFF_BE, 'tiff'],
	] as const)('recognises %s', (_label, bytes, expected) => {
		expect(sniffFormat(bytes)).toBe(expected);
	});

	it('reports a cursor as ICO, because it is the same container', () => {
		// A .cur differs from a .ico only in the type field, and the ICO decoder
		// reads both. Reporting a second format id for it would double every
		// switch over FormatId for no gain.
		expect(sniffFormat(CUR)).toBe('ico');
	});

	it('leaves a RIFF container that is not WebP alone', () => {
		// The RIFF magic covers WAV, AVI and a dozen others, so the form type at
		// byte eight is the part that decides.
		const wave = concat(ascii('RIFF'), u32(0x24), ascii('WAVEfmt '), new Uint8Array(16));
		expect(sniffFormat(wave)).toBeUndefined();
	});

	it('refuses a signature cut short rather than matching on a prefix', () => {
		// Seven of the eight PNG bytes. The eighth is the one that catches a
		// transfer that mangled line endings, so matching without it would let
		// exactly the corruption the signature exists to detect through.
		expect(sniffFormat(PNG.subarray(0, 7))).toBeUndefined();
	});

	it.each(SIGNATURES)(
		'needs every byte of the %s signature, and needs no more than those',
		(_label, bytes, length, expected) => {
			// Both halves matter. Stopping short means a truncated file gets
			// claimed and then fails inside a decoder, and needing more than the
			// signature means a caller that read only the documented head cannot
			// use the answer.
			expect(sniffFormat(bytes.subarray(0, length)), 'the whole signature').toBe(expected);
			for (let n = 1; n < length; n += 1) {
				expect(sniffFormat(bytes.subarray(0, n)), `${n} of ${length} bytes`).toBeUndefined();
			}
		},
	);

	it.each([
		['a JFIF APP0 segment', 0xe0],
		['an Exif APP1 segment, which is what a phone writes', 0xe1],
		['an Adobe APP14 segment', 0xee],
		['a quantisation table, with no application segment at all', 0xdb],
		['a comment', 0xfe],
	] as const)('recognises a JPEG whose first segment after SOI is %s', (_label, marker) => {
		// The signature is SOI and the 0xff that opens the next marker, and it
		// has to stay that loose. Requiring JFIF at byte six would refuse every
		// photograph an iPhone has taken, because those carry Exif in APP1 and
		// no JFIF segment at all.
		const bytes = concat(Uint8Array.from([0xff, 0xd8, 0xff, marker]), new Uint8Array(28));
		expect(sniffFormat(bytes)).toBe('jpeg');
	});

	it.each(['VP8 ', 'VP8L', 'VP8X'])('recognises a WebP whose first chunk is %s', (chunk) => {
		// Lossy, lossless and extended. The form type at byte eight is the whole
		// of the decision, so all three are the same file to a sniffer, and a
		// check narrowed to one of them would drop animated and alpha WebPs.
		const bytes = concat(
			ascii('RIFF'),
			u32le(0x24),
			ascii('WEBP'),
			ascii(chunk),
			new Uint8Array(16),
		);
		expect(sniffFormat(bytes)).toBe('webp');
	});

	it('identifies a file from its head alone', () => {
		// The documented contract: a caller may read the first SNIFF_BYTES and
		// hand over only those.
		expect(sniffFormat(PNG.subarray(0, SNIFF_BYTES))).toBe('png');
	});

	it('reads only the head, so a signature further in is not found', () => {
		const buried = concat(new Uint8Array(SNIFF_BYTES).fill(0x7f), PNG);
		expect(sniffFormat(buried)).toBeUndefined();
	});

	it('reads a file that sits inside a larger buffer', () => {
		const padded = new Uint8Array(PNG.length + 32);
		padded.set(PNG, 7);
		expect(sniffFormat(padded.subarray(7, 7 + PNG.length))).toBe('png');
	});
});

/* ── ISOBMFF brands ───────────────────────────────────────────────────── */

describe('sniffing an ISOBMFF brand list', () => {
	it('reads an Apple HEIC from its major brand and compatible list', () => {
		expect(sniffFormat(ftyp({ major: 'heic', compatible: ['mif1', 'heic'] }))).toBe('heic');
	});

	it('never reports an AVIF as HEIC, though both are mif1 compatible', () => {
		// The whole reason the AVIF test runs first. Both files are HEIF still
		// images by brand, so a reader that checks mif1 before avif hands an AV1
		// bitstream to the HEVC decoder and reports the file as corrupt.
		expect(sniffFormat(ftyp({ major: 'avif', compatible: ['avif', 'mif1', 'miaf'] }))).toBe('avif');
	});

	it('finds the AVIF brand when only the compatible list carries it', () => {
		// The major brand here is one this reader treats as HEIF, and miaf is
		// another. Ruling AVIF out has to look at every brand, not just the
		// first one that matches something.
		expect(sniffFormat(ftyp({ major: 'mif1', compatible: ['mif1', 'miaf', 'avif'] }))).toBe('avif');
	});

	it.each(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'miaf'])(
		'treats the %s brand as HEIC',
		(brand) => {
			expect(sniffFormat(ftyp({ major: brand }))).toBe('heic');
		},
	);

	it.each(['avif', 'avis', 'av01'])('treats the %s brand as AVIF', (brand) => {
		expect(sniffFormat(ftyp({ major: brand }))).toBe('avif');
	});

	it('leaves a plain MP4 alone', () => {
		const mp4 = ftyp({ major: 'isom', minor: 512, compatible: ['isom', 'iso2', 'avc1', 'mp41'] });
		expect(sniffFormat(mp4)).toBeUndefined();
	});

	it('reads the major brand out of a box with no compatible list', () => {
		expect(sniffFormat(concat(u32(12), ascii('ftyp'), ascii('heic')))).toBe('heic');
	});

	it('ignores an ftyp box too short to carry a brand at all', () => {
		expect(sniffFormat(concat(u32(8), ascii('ftyp')))).toBeUndefined();
	});

	it('stops the brand list at the declared box size', () => {
		// What follows an ftyp box is the next box, and its bytes are not
		// brands. A reader that walks to the end of the buffer instead of to
		// the end of the box would read four characters of whatever came next.
		const bytes = ftyp({ major: 'mif1', declaredSize: 16, trailing: ascii('avif') });
		expect(sniffFormat(bytes)).toBe('heic');
	});

	it('reads a brand that ends exactly at the last byte of the head', () => {
		// The compatible list starts at byte sixteen, so the head has room for
		// this many brands and the last of them ends on the final byte. An
		// off-by-one in the bound would drop it and call this file HEIC.
		//
		// Counted from SNIFF_BYTES rather than written out, so this stays the
		// boundary case if the window is ever resized. None of the filler brands
		// means anything to either list.
		const room = Math.floor((SNIFF_BYTES - 16) / 4);
		const filler = Array.from(
			{ length: room - 1 },
			(_unused, i) => `zz${String(i).padStart(2, '0')}`,
		);
		const bytes = ftyp({ major: 'mif1', compatible: [...filler, 'avif'] });
		expect(bytes.length).toBeGreaterThan(SNIFF_BYTES - 4);
		expect(bytes.length).toBeLessThanOrEqual(SNIFF_BYTES);
		expect([...bytes.subarray(bytes.length - 4)]).toEqual([...ascii('avif')]);
		expect(sniffFormat(bytes)).toBe('avif');
	});

	it('finds the box in a buffer it does not start', () => {
		// The box size is read through a DataView. Built without the view's own
		// byte offset it would read the padding instead and bound the brand
		// list at some unrelated number.
		const bytes = ftyp({ major: 'mif1', compatible: ['miaf', 'avif'] });
		const padded = new Uint8Array(bytes.length + 16);
		padded.set(bytes, 9);
		expect(sniffFormat(padded.subarray(9, 9 + bytes.length))).toBe('avif');
	});
});

/* ── PNM ──────────────────────────────────────────────────────────────── */

describe('sniffing PNM', () => {
	it.each(['1', '2', '3', '4', '5', '6', '7'])('recognises the P%s magic', (digit) => {
		expect(sniffFormat(ascii(`P${digit}\n2 2\n255\n`))).toBe('pnm');
	});

	it.each([
		['a space', ' '],
		['a tab', '\t'],
		['a newline', '\n'],
		['a carriage return', '\r'],
		['a comment', '#'],
	] as const)('accepts %s straight after the magic', (_label, separator) => {
		expect(sniffFormat(ascii(`P6${separator}2 2\n255\n`))).toBe('pnm');
	});

	it('recognises a file whose comment is longer than the head', () => {
		// Only the magic and the byte after it decide, so a comment that fills
		// the whole sniff window and then some changes nothing. Padded out from
		// SNIFF_BYTES so it stays longer than the head if the window is resized,
		// rather than quietly becoming a test of a comment that fits.
		const comment = '# written by somebody with a great deal to say about it'.padEnd(
			SNIFF_BYTES,
			'.',
		);
		const bytes = ascii(`P3${comment}\n2 2\n255\n`);
		expect(bytes.length).toBeGreaterThan(SNIFF_BYTES);
		expect(sniffFormat(bytes)).toBe('pnm');
	});

	it('requires a separator, so a word beginning with P6 is not an image', () => {
		expect(sniffFormat(ascii('P6ROTECTED archive follows here, at some length'))).toBeUndefined();
	});

	it.each(['P0', 'P8', 'P9', 'PA'])('refuses the %s magic', (magic) => {
		expect(sniffFormat(ascii(`${magic}\n2 2\n255\n`))).toBeUndefined();
	});

	it('is not fooled by a zip archive', () => {
		// A zip starts PK, which is one byte away from a PNM magic and is by far
		// the most common thing people drop on an image converter by mistake.
		const zip = concat(ascii('PK'), Uint8Array.from([0x03, 0x04, 0x14, 0x00]), new Uint8Array(24));
		expect(sniffFormat(zip)).toBeUndefined();
	});
});

/* ── SVG ──────────────────────────────────────────────────────────────── */

describe('sniffing SVG', () => {
	it('recognises a bare root element', () => {
		expect(sniffFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
	});

	it('recognises an uppercase root element', () => {
		expect(sniffFormat(ascii('<SVG XMLNS="http://www.w3.org/2000/svg"/>'))).toBe('svg');
	});

	it('skips leading whitespace', () => {
		expect(sniffFormat(ascii('\n\r\t   <svg width="8" height="8"/>'))).toBe('svg');
	});

	it('skips a UTF-8 BOM, and whitespace after it', () => {
		// Editors on Windows write the BOM, and a reader that only skips
		// whitespace sees three bytes of nothing it knows and gives up.
		const bytes = concat(Uint8Array.from([0xef, 0xbb, 0xbf]), ascii('\n  <svg width="8"/>'));
		expect(sniffFormat(bytes)).toBe('svg');
	});

	it('recognises an XML declaration before the root element', () => {
		expect(sniffFormat(ascii('<?xml version="1.0" encoding="UTF-8"?>\n<svg/>'))).toBe('svg');
	});

	it('recognises a doctype before the root element', () => {
		const bytes = ascii('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<svg/>');
		expect(sniffFormat(bytes)).toBe('svg');
	});

	it('claims any XML declaration, because the root element can sit past the head', () => {
		// An SVG may carry a declaration and a doctype long enough to push <svg
		// beyond the bytes this reads, so a declaration has to be enough on its
		// own. The cost is that a non-SVG XML file is claimed here and refused
		// by the decoder instead, which is the cheaper of the two mistakes.
		expect(sniffFormat(ascii('<?xml version="1.0"?>\n<rss version="2.0"></rss>'))).toBe('svg');
	});

	it('refuses an HTML doctype', () => {
		// This one is worth being exact about: the doctype check would match on
		// any doctype if it did not spell out svg, and a saved web page is a
		// common thing to hand a converter.
		expect(sniffFormat(ascii('<!DOCTYPE html>\n<html><body>a page</body></html>'))).toBeUndefined();
	});

	it('refuses an element that is not svg', () => {
		expect(
			sniffFormat(ascii('<html lang="en"><head><title>x</title></head></html>')),
		).toBeUndefined();
	});
});

/* ── TGA ──────────────────────────────────────────────────────────────── */

describe('sniffing TGA', () => {
	it('accepts the version 2 footer even when the header reads as nonsense', () => {
		// TRUEVISION-XFILE sits sixteen bytes before the last two of the file
		// and is conclusive, so the header heuristic never has to run.
		const bytes = tgaFile({ colourMapType: 9, imageType: 4, depth: 12, footer: true });
		expect(sniffFormat(bytes)).toBe('tga');
	});

	it('ignores a footer that is not the last eighteen bytes', () => {
		// Anything appended after the footer means this is no longer a TGA, and
		// scanning for the string anywhere would claim any file that happened
		// to contain it.
		const bytes = tgaFile({
			colourMapType: 9,
			imageType: 4,
			depth: 12,
			footer: true,
			trailingBytes: 1,
		});
		expect(sniffFormat(bytes)).toBeUndefined();
	});

	it.each([
		['uncompressed truecolour', { imageType: 2, idLength: 12 }],
		['run length encoded truecolour', { imageType: 10, depth: 32 }],
		['uncompressed greyscale', { imageType: 3, depth: 8 }],
		['run length encoded greyscale', { imageType: 11, depth: 8 }],
		['uncompressed colour mapped', { imageType: 1, colourMapType: 1, depth: 8 }],
		['run length encoded colour mapped', { imageType: 9, colourMapType: 1, depth: 8 }],
	] as const)('accepts a version 1 %s header', (_label, options) => {
		// The uncompressed truecolour case carries an image id on purpose: with
		// no image id its first four bytes are 00 00 02 00, which is also the
		// cursor signature, and that check runs earlier.
		expect(sniffFormat(tgaFile(options))).toBe('tga');
	});

	it('refuses a colour mapped image with no colour map', () => {
		expect(sniffFormat(tgaFile({ imageType: 1, colourMapType: 0, idLength: 12 }))).toBeUndefined();
	});

	it('refuses a truecolour image that carries a colour map', () => {
		expect(sniffFormat(tgaFile({ imageType: 10, colourMapType: 1 }))).toBeUndefined();
	});

	it('refuses an image type nobody defined', () => {
		expect(sniffFormat(tgaFile({ imageType: 4, idLength: 12 }))).toBeUndefined();
	});

	it.each([8, 15, 16, 24, 32])('accepts a pixel depth of %d bits', (depth) => {
		// The five depths TGA defines. Fifteen and sixteen are the pair that gets
		// left out of a list written from memory, and sixteen bit is what the
		// paint programs of the era wrote by default, so dropping either turns a
		// whole era of files into unknown input.
		expect(sniffFormat(tgaFile({ depth }))).toBe('tga');
	});

	it.each([0, 1, 4, 12, 48, 64])('refuses a pixel depth of %d bits', (depth) => {
		expect(sniffFormat(tgaFile({ depth }))).toBeUndefined();
	});

	it('refuses a colour map type outside zero and one', () => {
		expect(sniffFormat(tgaFile({ colourMapType: 2, idLength: 12 }))).toBeUndefined();
	});

	it('refuses a file too short to hold a header', () => {
		expect(sniffFormat(tgaFile().subarray(0, 17))).toBeUndefined();
	});

	it('does not claim random bytes as TGA', () => {
		// TGA is the only format here recognised by plausibility rather than by
		// a signature, so it is the one that can swallow a file that is not an
		// image at all. A fixed seed keeps this deterministic on every machine.
		let state = 0x9e3779b9;
		const claimed: (FormatId | undefined)[] = [];
		for (let run = 0; run < 2000; run += 1) {
			const buffer = new Uint8Array(64);
			for (let i = 0; i < buffer.length; i += 1) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				state >>>= 0;
				buffer[i] = state & 0xff;
			}
			claimed.push(sniffFormat(buffer));
		}
		expect(claimed.filter((format) => format === 'tga')).toEqual([]);
	});

	it('does not claim a text file as TGA', () => {
		const note = ascii('Dear whoever, the photographs are in the other folder. Sorry about that.');
		expect(sniffFormat(note)).toBeUndefined();
	});
});

/* ── Every id in the union ────────────────────────────────────────────── */

describe('every format the package names', () => {
	/**
	 * Bytes that have to produce each format id.
	 *
	 * Typed as a record over `FormatId` for the same reason the format table's
	 * list is: a format added to the union without a way to recognise it fails
	 * to compile here, instead of shipping as something the converter offers by
	 * name and then cannot identify from a file.
	 */
	const SAMPLE: { readonly [K in FormatId]: Uint8Array } = {
		png: PNG,
		jpeg: JPEG,
		gif: GIF89A,
		webp: WEBP,
		qoi: QOI,
		farbfeld: FARBFELD,
		bmp: BMP,
		ico: ICO,
		tiff: TIFF_LE,
		heic: ftyp({ major: 'heic', compatible: ['mif1', 'heic'] }),
		avif: ftyp({ major: 'avif', compatible: ['avif', 'mif1', 'miaf'] }),
		pnm: ascii('P6\n2 2\n255\n'),
		svg: ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		// The image id length is deliberate. See the TGA section above.
		tga: tgaFile({ imageType: 2, idLength: 12 }),
	};

	it.each(Object.keys(SAMPLE) as FormatId[])('is recognised from bytes: %s', (id) => {
		expect(sniffFormat(SAMPLE[id])).toBe(id);
		expect(requireFormat(SAMPLE[id])).toBe(id);
	});
});

/* ── Empty and unrecognised input ─────────────────────────────────────── */

describe('input nothing recognises', () => {
	it('returns undefined from sniffFormat for an empty buffer', () => {
		expect(sniffFormat(new Uint8Array(0))).toBeUndefined();
	});

	it('throws EmptyInputError rather than an unknown format', () => {
		// Different problems and different sentences: an empty file is almost
		// always a download that failed, not a format this tool cannot read.
		let thrown: unknown;
		try {
			requireFormat(new Uint8Array(0));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EmptyInputError);
		expect((thrown as EmptyInputError).code).toBe('input/empty');
	});

	it('throws UnknownFormatError with the first sixteen bytes attached', () => {
		const junk = concat(ascii('nothing here that is an image'), new Uint8Array(40));
		let thrown: unknown;
		try {
			requireFormat(junk);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(UnknownFormatError);
		const error = thrown as UnknownFormatError;
		expect(error.code).toBe('input/unknown-format');
		expect([...error.head]).toEqual([...junk.subarray(0, 16)]);
	});

	it('attaches only the bytes there were, for input shorter than sixteen', () => {
		let thrown: unknown;
		try {
			requireFormat(ascii('nope'));
		} catch (error) {
			thrown = error;
		}
		expect([...(thrown as UnknownFormatError).head]).toEqual([...ascii('nope')]);
	});

	it('returns the format from requireFormat when there is one', () => {
		expect(requireFormat(PNG)).toBe('png');
		expect(requireFormat(ftyp({ major: 'heic' }))).toBe('heic');
	});
});

/* ── MIME and extension lookup ────────────────────────────────────────── */

describe('looking a format up by MIME type', () => {
	it('resolves every type in the table back to its own format', () => {
		for (const id of FORMAT_IDS) {
			for (const mime of FORMATS[id].mimes) {
				expect(formatForMime(mime), mime).toBe(id);
			}
		}
	});

	it('ignores case, because operating systems disagree about it', () => {
		expect(formatForMime('IMAGE/PNG')).toBe('png');
		expect(formatForMime('Image/Heif')).toBe('heic');
	});

	it('drops parameters after the type', () => {
		expect(formatForMime('image/jpeg; charset=binary')).toBe('jpeg');
		expect(formatForMime('image/svg+xml;charset=utf-8')).toBe('svg');
	});

	it('trims whitespace around the type', () => {
		expect(formatForMime('  image/webp  ')).toBe('webp');
	});

	it('returns undefined for the empty type some file managers report', () => {
		expect(formatForMime('')).toBeUndefined();
		expect(formatForMime('   ')).toBeUndefined();
	});

	it('returns undefined for a type this package does not know', () => {
		expect(formatForMime('application/octet-stream')).toBeUndefined();
		expect(formatForMime('image/jxl')).toBeUndefined();
	});

	it('resolves an alias to the same format as the canonical type', () => {
		expect(formatForMime('image/heif')).toBe('heic');
		expect(formatForMime('image/jpg')).toBe('jpeg');
		expect(formatForMime('image/x-ms-bmp')).toBe('bmp');
		expect(formatForMime('image/vnd.microsoft.icon')).toBe('ico');
	});
});

describe('looking a format up by file name', () => {
	it('resolves every extension in the table back to its own format', () => {
		for (const id of FORMAT_IDS) {
			for (const extension of FORMATS[id].extensions) {
				expect(formatForExtension(`photo.${extension}`), extension).toBe(id);
			}
		}
	});

	it('ignores case, because a phone writes them in capitals', () => {
		expect(formatForExtension('IMG_2059.HEIC')).toBe('heic');
		expect(formatForExtension('Scan.TifF')).toBe('tiff');
	});

	it('uses the last dot, not the first', () => {
		expect(formatForExtension('holiday.2024.avif')).toBe('avif');
		expect(formatForExtension('backup.tar.gz')).toBeUndefined();
	});

	it('reads an extension out of a path', () => {
		expect(formatForExtension('/home/somebody/pictures/a.tga')).toBe('tga');
		expect(formatForExtension('C:\\Users\\somebody\\a.qoi')).toBe('qoi');
	});

	it('handles a name that is nothing but an extension', () => {
		expect(formatForExtension('.heic')).toBe('heic');
	});

	it.each([
		['photo.jpeg', 'jpeg'],
		['photo.jfif', 'jpeg'],
		['drawing.dib', 'bmp'],
		['pointer.cur', 'ico'],
		['scan.tiff', 'tiff'],
		['loop.avifs', 'avif'],
		['from-a-canon.hif', 'heic'],
		['mask.pbm', 'pnm'],
		['frame.apng', 'png'],
	] as const)('resolves %s, which is the same format under another name', (name, expected) => {
		// Written out because the loop above reads the same table the lookup
		// does: it passes whether or not any of these are in it. Each of these
		// extensions is one somebody's files are actually named with.
		expect(formatForExtension(name)).toBe(expected);
	});

	it('returns undefined when there is nothing to read', () => {
		expect(formatForExtension('screenshot')).toBeUndefined();
		expect(formatForExtension('screenshot.')).toBeUndefined();
		expect(formatForExtension('')).toBeUndefined();
	});
});

/* ── The table itself ─────────────────────────────────────────────────── */

describe('the format table', () => {
	/**
	 * Every format id, written out.
	 *
	 * Typed as a record over `FormatId`, so adding a format to the union
	 * without adding it here fails to compile rather than quietly going
	 * untested.
	 */
	const EVERY_FORMAT: { readonly [K in FormatId]: true } = {
		heic: true,
		png: true,
		jpeg: true,
		webp: true,
		avif: true,
		gif: true,
		bmp: true,
		ico: true,
		tiff: true,
		qoi: true,
		tga: true,
		pnm: true,
		farbfeld: true,
		svg: true,
	};

	const ids = Object.keys(EVERY_FORMAT) as FormatId[];

	interface FormatFacts {
		readonly mime: string;
		readonly extension: string;
		readonly alpha: boolean;
		readonly lossy: boolean;
		readonly animated: boolean;
	}

	/**
	 * What each format is, said from outside this package.
	 *
	 * The media types are the registered ones where a registration exists and
	 * the conventional ones where none does, which is the case for TGA, QOI,
	 * farbfeld, PNM and the icon type browsers actually send. The extension is
	 * the one written on a converted file, so it is what somebody sees.
	 *
	 * The rest of the table is checked only against itself: every MIME type in
	 * it resolves to its own format because the lookup reads the same table,
	 * and that stays true if a type is misspelled. This is the part that has to
	 * come from somewhere else, so it is written out by hand.
	 */
	const FACTS: { readonly [K in FormatId]: FormatFacts } = {
		// Still images. Sequences share the container and are not read here.
		heic: { mime: 'image/heic', extension: 'heic', alpha: true, lossy: true, animated: false },
		png: { mime: 'image/png', extension: 'png', alpha: true, lossy: false, animated: false },
		// No alpha channel exists in JPEG at all, which is why converting a
		// translucent image to it has to flatten first.
		jpeg: { mime: 'image/jpeg', extension: 'jpg', alpha: false, lossy: true, animated: false },
		webp: { mime: 'image/webp', extension: 'webp', alpha: true, lossy: true, animated: true },
		avif: { mime: 'image/avif', extension: 'avif', alpha: true, lossy: true, animated: true },
		// One palette entry can be transparent, and LZW itself loses nothing:
		// the loss in a GIF happened when the palette was chosen.
		gif: { mime: 'image/gif', extension: 'gif', alpha: true, lossy: false, animated: true },
		bmp: { mime: 'image/bmp', extension: 'bmp', alpha: true, lossy: false, animated: false },
		// image/vnd.microsoft.icon is the registered type and image/x-icon is
		// what every browser sends. Both are in the table; this is the one
		// written onto a converted file.
		ico: { mime: 'image/x-icon', extension: 'ico', alpha: true, lossy: false, animated: false },
		// A TIFF may hold JPEG compressed strips. Nothing here writes one.
		tiff: { mime: 'image/tiff', extension: 'tif', alpha: true, lossy: false, animated: false },
		qoi: { mime: 'image/qoi', extension: 'qoi', alpha: true, lossy: false, animated: false },
		tga: { mime: 'image/x-tga', extension: 'tga', alpha: true, lossy: false, animated: false },
		// PAM can carry an alpha channel; the reader refuses PAM by name and
		// none of the Netpbm formats it does read have one.
		pnm: {
			mime: 'image/x-portable-anymap',
			extension: 'ppm',
			alpha: false,
			lossy: false,
			animated: false,
		},
		farbfeld: {
			mime: 'image/x-farbfeld',
			extension: 'ff',
			alpha: true,
			lossy: false,
			animated: false,
		},
		// SVG can carry SMIL animation. Nothing here renders it.
		svg: { mime: 'image/svg+xml', extension: 'svg', alpha: true, lossy: false, animated: false },
	};

	it.each(ids)('describes %s the way the format is defined elsewhere', (id) => {
		const info = FORMATS[id];
		const fact = FACTS[id];
		expect(info.mime, `${id} canonical type`).toBe(fact.mime);
		expect(info.mimes, `${id} offers its canonical type`).toContain(fact.mime);
		expect(info.extension, `${id} canonical extension`).toBe(fact.extension);
		// `lossy` decides whether the offline application shows a quality
		// control and whether a quality is passed to the encoder, so a wrong
		// one is visible to somebody using it rather than only to a reader.
		expect(info.lossy, `${id} lossy`).toBe(fact.lossy);
		expect(info.alpha, `${id} alpha`).toBe(fact.alpha);
		expect(info.animated, `${id} animated`).toBe(fact.animated);
	});

	it('has an entry for every format id and no others', () => {
		expect([...FORMAT_IDS].sort()).toEqual([...ids].sort());
	});

	it('keys every entry by its own id', () => {
		for (const id of ids) {
			expect(FORMATS[id].id, id).toBe(id);
		}
	});

	it('lists the canonical MIME type first', () => {
		// formatForMime walks the list in order, so a canonical type that is not
		// the first entry would still resolve while a blob written from mimes[0]
		// would carry the wrong one.
		for (const id of ids) {
			expect(FORMATS[id].mimes[0], id).toBe(FORMATS[id].mime);
		}
	});

	it('includes the canonical extension among the extensions', () => {
		for (const id of ids) {
			expect(FORMATS[id].extensions, id).toContain(FORMATS[id].extension);
		}
	});

	it('never claims a MIME type for two formats', () => {
		// A type claimed twice makes formatForMime depend on key order, which is
		// not something a table of static facts should decide.
		const seen = new Map<string, FormatId>();
		for (const id of ids) {
			for (const mime of FORMATS[id].mimes) {
				expect(seen.get(mime), `${mime} is already claimed`).toBeUndefined();
				seen.set(mime, id);
			}
		}
	});

	it('never claims an extension for two formats', () => {
		const seen = new Map<string, FormatId>();
		for (const id of ids) {
			for (const extension of FORMATS[id].extensions) {
				expect(seen.get(extension), `${extension} is already claimed`).toBeUndefined();
				seen.set(extension, id);
			}
		}
	});

	it('writes every MIME type as a lowercase type and subtype', () => {
		for (const id of ids) {
			for (const mime of FORMATS[id].mimes) {
				expect(mime).toBe(mime.toLowerCase());
				expect(mime, id).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
			}
		}
	});

	it('writes every extension lowercase and without its dot', () => {
		for (const id of ids) {
			for (const extension of FORMATS[id].extensions) {
				expect(extension, id).toMatch(/^[a-z0-9]+$/);
			}
		}
	});

	it('gives every format a label', () => {
		for (const id of ids) {
			expect(FORMATS[id].label.length, id).toBeGreaterThan(0);
		}
	});

	it('hands back the same entry through formatInfo', () => {
		for (const id of ids) {
			expect(formatInfo(id)).toBe(FORMATS[id]);
		}
	});
});

describe('signatures that overlap between formats', () => {
	it('does not call an uncompressed TGA a cursor', () => {
		// A TGA with no identification field, no colour map and image type 2
		// begins 00 00 02 00, which is byte for byte the start of a CUR
		// directory. This is the most common TGA there is, so getting it wrong
		// is not an edge case: every one of them was reported as an icon.
		const tga = new Uint8Array(18 + 4);
		tga[2] = 2; // truecolour, uncompressed
		tga[12] = 1; // width 1
		tga[14] = 1; // height 1
		tga[16] = 32; // 32 bits per pixel
		expect(sniffFormat(tga)).toBe('tga');
	});

	it('still recognises a real cursor, which declares at least one image', () => {
		// The image count is what separates the two. An ICO directory must
		// describe at least one image; a truecolour TGA has a colour map length
		// of zero sitting in the same place.
		const cur = new Uint8Array(6 + 16);
		cur[2] = 2; // CUR
		cur[4] = 1; // one image
		expect(sniffFormat(cur)).toBe('ico');
	});

	it('reads the whole compatible brand list, not just the first few', () => {
		// Apple writes several brands and the list can run past the sniffing
		// window. The brand that decides between AVIF and HEIC is not
		// guaranteed to be an early one, and truncating the list handed an AV1
		// bitstream to the HEVC decoder, which then reported a corrupt file.
		const filler = Array.from({ length: 13 }, (_, i) => `xx${String(i).padStart(2, '0')}`);
		const late = ftyp({ major: 'mif1', compatible: [...filler, 'avif'] });
		expect(late.length).toBeGreaterThan(SNIFF_BYTES);
		expect(sniffFormat(late)).toBe('avif');
	});

	it('prefers AVIF over HEIC when a file is compatible with both', () => {
		// Both are mif1 compatible. Testing HEIF first would claim every AVIF.
		expect(sniffFormat(ftyp({ major: 'mif1', compatible: ['mif1', 'avif'] }))).toBe('avif');
	});
});
