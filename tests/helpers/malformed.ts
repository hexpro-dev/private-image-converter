/**
 * A corpus of broken files, built by mutating a valid one.
 *
 * The per-codec test files already refuse malformed input case by case, and
 * they do it better than anything generated: a hand written refusal test says
 * which field is wrong and what the reader is supposed to say about it. What
 * they cannot do is cover a codec that does not exist yet. Every one of those
 * lists was written by somebody who had that format's specification open, so a
 * format added next year arrives with its own list and none of the cross
 * cutting ones, and nothing anywhere asserts a property over the whole set.
 *
 * This is the other half. It knows almost nothing about any format and asserts
 * only what is true of all of them: a reader handed rubbish refuses it, in
 * bounded time, without allocating for a size the file cannot possibly hold.
 *
 * Determinism is the whole design constraint. A corpus reseeded per run finds
 * a crash on somebody's branch at two in the morning, cannot be reproduced,
 * and teaches the team that the fuzz suite is flaky rather than that the codec
 * is wrong, which is worse than not having one. So the generator is seeded
 * with a constant, every strategy walks its inputs in a fixed order, and the
 * label on each input is enough to rebuild that exact buffer by hand.
 *
 * The valid seeds come from this package's own encoders where there is one.
 * That would be circular if the property under test were "decodes correctly",
 * because the encoder and the decoder could agree on the same wrong format.
 * The property here is "does not crash", and a file that this package's writer
 * produced is a perfectly good starting point for breaking. PSD and DDS have
 * no writer here, so those two are assembled from their specifications, the
 * same way `tests/codecs/psd.test.ts` and `tests/codecs/dds.test.ts` do it.
 */

import { createRaster } from '../../src/raster/image.js';
import { encodeApng } from '../../src/codecs/png/apngEncode.js';
import { encodeBmp } from '../../src/codecs/bmp/encode.js';
import { encodeExr } from '../../src/codecs/exr/encode.js';
import { encodeFarbfeld } from '../../src/codecs/farbfeld/encode.js';
import { encodeGif } from '../../src/codecs/gif/encode.js';
import { encodeHdr } from '../../src/codecs/hdr/encode.js';
import { encodeIcns } from '../../src/codecs/icns/encode.js';
import { encodeIco } from '../../src/codecs/ico/encode.js';
import { encodePcx } from '../../src/codecs/pcx/encode.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import { encodePnm } from '../../src/codecs/pnm/encode.js';
import { encodeQoi } from '../../src/codecs/qoi/encode.js';
import { encodeRas } from '../../src/codecs/ras/encode.js';
import { encodeTga } from '../../src/codecs/tga/encode.js';
import { encodeTiff } from '../../src/codecs/tiff/encode.js';
import { encodeXbm } from '../../src/codecs/xbm/encode.js';
import { encodeXpm } from '../../src/codecs/xpm/encode.js';
import type { FormatId, RasterImage } from '../../src/types.js';

/* ── The random part, which is not random ─────────────────────────────── */

/**
 * The seed, written down rather than taken from the clock.
 *
 * Any constant would do. This one is here so that changing it is a visible
 * decision in a diff: a new value is a new corpus, and a new corpus that turns
 * green where the old one was red has not fixed anything.
 */
const SEED = 0x5f3a91c7;

/** Mulberry32. Small, fast, and identical on every engine, which is the point. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* ── Shapes ───────────────────────────────────────────────────────────── */

/** A numeric field in a binary header, as its specification lays it out. */
export interface Field {
	readonly offset: number;
	readonly size: 2 | 4;
	readonly endian: 'be' | 'le';
}

export interface Seed {
	readonly format: FormatId;
	readonly bytes: Uint8Array;
	/**
	 * Length and dimension fields, from the specification.
	 *
	 * Only the ones worth driving to an edge. A generator that walked every
	 * four byte window of the header would spend most of its corpus rewriting
	 * padding, and the interesting mutations would fall off the far side of
	 * the cap.
	 */
	readonly fields: readonly Field[];
	/**
	 * Files whose header declares an image far larger than the file can hold.
	 *
	 * Kept apart from the general corpus because they are asserted differently:
	 * these have to be refused rather than merely not crash. Built by the
	 * format's own builder, because "the dimensions" is the one thing a
	 * format-blind mutator cannot find.
	 */
	readonly enormous: readonly Uint8Array[];
	/** The format's own record boundaries, for the formats that have records. */
	readonly records?: (bytes: Uint8Array) => readonly (readonly [number, number])[];
	/** True when the header is text, so its numbers are digit runs, not fields. */
	readonly text?: boolean;
}

export interface MalformedInput {
	readonly format: FormatId;
	/** Enough to rebuild this exact buffer by hand. Printed on a failure. */
	readonly label: string;
	readonly bytes: Uint8Array;
}

/* ── Byte handling ────────────────────────────────────────────────────── */

function put(bytes: Uint8Array, field: Field, value: number): Uint8Array {
	const out = bytes.slice();
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const little = field.endian === 'le';
	if (field.size === 2) view.setUint16(field.offset, value & 0xffff, little);
	else view.setUint32(field.offset, value >>> 0, little);
	return out;
}

function putAll(bytes: Uint8Array, pairs: readonly (readonly [Field, number])[]): Uint8Array {
	let out = bytes;
	for (const [field, value] of pairs) out = put(out, field, value);
	return out;
}

function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
	return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
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

/** Where `needle` first appears in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	outer: for (let at = from; at + needle.length <= haystack.length; at += 1) {
		for (let i = 0; i < needle.length; i += 1) {
			if (haystack[at + i] !== needle[i]) continue outer;
		}
		return at;
	}
	return -1;
}

/* ── Record boundaries ────────────────────────────────────────────────── */

/**
 * PNG chunks, including an APNG's.
 *
 * Eight bytes of signature, then length, type, payload and CRC. Returned as
 * spans so a mutation can duplicate, drop or reorder one without knowing what
 * any of them mean, which is the point: `acTL` before `IHDR`, two `IHDR`s, or
 * an `fcTL` with no frame after it are all files somebody will hand this
 * package one day.
 */
function pngChunkSpans(bytes: Uint8Array): readonly (readonly [number, number])[] {
	const spans: (readonly [number, number])[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at, false);
		const end = at + 12 + length;
		if (end > bytes.length) break;
		spans.push([at, end]);
		at = end;
	}
	return spans;
}

/** An Apple icon suite: eight bytes of header, then typed records. */
function icnsRecordSpans(bytes: Uint8Array): readonly (readonly [number, number])[] {
	const spans: (readonly [number, number])[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 8;
	while (at + 8 <= bytes.length) {
		const size = view.getUint32(at + 4, false);
		if (size < 8 || at + size > bytes.length) break;
		spans.push([at, at + size]);
		at += size;
	}
	return spans;
}

/* ── Finding the dimensions in a container ────────────────────────────── */

/**
 * The width and height fields of every PNG inside `bytes`.
 *
 * Every one of them, not the first. An icon container holds a picture at each
 * size it could fill, and both readers here pick the entry that best suits
 * what was asked for rather than the entry that happens to come first. A test
 * that made only the first entry absurd would be answered with the second one,
 * decoded perfectly, and would read as a decoder that has no size ceiling
 * rather than as a fixture that patched the wrong bytes. That is exactly what
 * happened while this file was being written, on a seed large enough to fill
 * two slots.
 */
function pngSizeFields(bytes: Uint8Array): readonly (readonly [Field, Field])[] {
	const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const out: (readonly [Field, Field])[] = [];
	for (let at = 0; at >= 0;) {
		at = indexOfBytes(bytes, signature, at);
		if (at < 0) break;
		out.push([
			{ offset: at + 16, size: 4, endian: 'be' },
			{ offset: at + 20, size: 4, endian: 'be' },
		]);
		at += signature.length;
	}
	if (out.length === 0) throw new Error('the seed was expected to carry a PNG and does not');
	return out;
}

/**
 * The ImageWidth and ImageLength entries of a little endian TIFF's first IFD.
 *
 * Both are written as SHORT by this package's writer for a small picture, and
 * a reader is required to accept either SHORT or LONG, so the field width is
 * read off the entry rather than assumed. Driving a SHORT to 0xffff is a
 * different claim from driving a LONG to 0xffffffff and both are worth making.
 */
function tiffSizeFields(bytes: Uint8Array): readonly [Field, Field] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ifd = view.getUint32(4, true);
	const count = view.getUint16(ifd, true);
	let width: Field | undefined;
	let height: Field | undefined;
	for (let i = 0; i < count; i += 1) {
		const entry = ifd + 2 + i * 12;
		const tag = view.getUint16(entry, true);
		const type = view.getUint16(entry + 2, true);
		const field: Field = { offset: entry + 8, size: type === 3 ? 2 : 4, endian: 'le' };
		if (tag === 256) width = field;
		if (tag === 257) height = field;
	}
	if (!width || !height) throw new Error('the TIFF seed has no dimension tags');
	return [width, height];
}

/**
 * The far corner of an OpenEXR data window.
 *
 * A window is inclusive at both ends, so the size is `xMax - xMin + 1`, and
 * moving the maximum is how you ask for an absurd picture without touching
 * anything else in the header.
 */
function exrWindowFields(bytes: Uint8Array): readonly [Field, Field] {
	const at = indexOfBytes(bytes, ascii('dataWindow\0box2i\0'));
	if (at < 0) throw new Error('the EXR seed has no dataWindow attribute');
	// name and type, then a four byte attribute size, then xMin, yMin, xMax, yMax.
	const box = at + 'dataWindow\0box2i\0'.length + 4;
	return [
		{ offset: box + 8, size: 4, endian: 'le' },
		{ offset: box + 12, size: 4, endian: 'le' },
	];
}

/* ── The picture every seed is made from ──────────────────────────────── */

/**
 * How big the picture every seed is built from is.
 *
 * Thirty-two rather than sixteen so that an Apple icon suite comes out with
 * more than one record in it. A container holding a single record has no order
 * to get wrong, so the duplicate, drop and reorder mutations produce nothing
 * for it, and a size refusal has only one picture to be answered by. Large
 * enough to have structure, small enough that thousands of copies of it decode
 * inside a second.
 */
const SIDE = 32;

/** A pattern with enough variety that a compressor has work to do. */
function samplePicture(shift = 0): RasterImage {
	const image = createRaster(SIDE, SIDE, 'srgb', true);
	let state = (0x2545f491 + shift * 0x9e3779b9) >>> 0;
	for (let i = 0; i < SIDE * SIDE; i += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		const at = i * 4;
		image.data[at] = state & 0xff;
		image.data[at + 1] = (i * 11) & 0xff;
		image.data[at + 2] = (state >>> 16) & 0xff;
		// Mostly opaque, with a few translucent pixels so an encoder that has a
		// separate path for alpha takes it.
		image.data[at + 3] = i % 23 === 0 ? 128 : 255;
	}
	return image;
}

/* ── Seeds built by hand from the specification ───────────────────────── */

function u16be(out: number[], value: number): void {
	out.push((value >>> 8) & 0xff, value & 0xff);
}

function u32be(out: number[], value: number): void {
	out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

/**
 * A flattened square RGB Photoshop file, uncompressed.
 *
 * Nothing in this package writes a PSD, so the bytes come straight from the
 * format's own layout: a 26 byte header, then three length-prefixed sections
 * this file leaves empty, then a two byte compression word and the three
 * channel planes end to end. Height is written before width, which is the one
 * thing about this header that catches everybody.
 */
function psdSeed(): Uint8Array {
	const out: number[] = [0x38, 0x42, 0x50, 0x53];
	u16be(out, 1);
	out.push(0, 0, 0, 0, 0, 0);
	u16be(out, 3);
	u32be(out, SIDE);
	u32be(out, SIDE);
	u16be(out, 8);
	u16be(out, 3);
	u32be(out, 0);
	u32be(out, 0);
	u32be(out, 0);
	u16be(out, 0);
	for (let channel = 0; channel < 3; channel += 1) {
		for (let i = 0; i < SIDE * SIDE; i += 1) out.push((i * (channel + 3)) & 0xff);
	}
	return Uint8Array.from(out);
}

/** A square uncompressed A8R8G8B8 DDS, the plainest one the format defines. */
function ddsSeed(): Uint8Array {
	const out = new Uint8Array(128 + SIDE * SIDE * 4);
	const view = new DataView(out.buffer);
	out.set(ascii('DDS '), 0);
	view.setUint32(4, 124, true);
	// DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT.
	view.setUint32(8, 0x1007, true);
	view.setUint32(12, SIDE, true);
	view.setUint32(16, SIDE, true);
	view.setUint32(28, 1, true);
	view.setUint32(76, 32, true);
	// DDPF_RGB | DDPF_ALPHAPIXELS.
	view.setUint32(80, 0x41, true);
	view.setUint32(88, 32, true);
	view.setUint32(92, 0x00ff0000, true);
	view.setUint32(96, 0x0000ff00, true);
	view.setUint32(100, 0x000000ff, true);
	view.setUint32(104, 0xff000000, true);
	// DDSCAPS_TEXTURE.
	view.setUint32(108, 0x1000, true);
	for (let i = 0; i < SIDE * SIDE; i += 1) {
		out[128 + i * 4] = (i * 5) & 0xff;
		out[128 + i * 4 + 1] = (i * 7) & 0xff;
		out[128 + i * 4 + 2] = (i * 11) & 0xff;
		out[128 + i * 4 + 3] = 0xff;
	}
	return out;
}

/* ── Every seed ───────────────────────────────────────────────────────── */

/** The two values a length or dimension field is driven to for the size checks. */
const ENORMOUS_32 = [0x7fffffff, 0xffffffff] as const;
const ENORMOUS_16 = [0x7fff, 0xffff] as const;

function enormousFrom(
	bytes: Uint8Array,
	sizes: readonly (readonly [Field, Field])[],
): readonly Uint8Array[] {
	const values = (sizes[0] as readonly [Field, Field])[0].size === 2 ? ENORMOUS_16 : ENORMOUS_32;
	return values.map((value) =>
		putAll(
			bytes,
			sizes.flatMap(([width, height]) => [[width, value] as const, [height, value] as const]),
		),
	);
}

/**
 * A seed whose dimensions are ordinary fields.
 *
 * A pair per picture the file holds, which is one for everything except the
 * two icon containers. Both fields of a pair are driven at once so the product
 * is astronomical rather than merely large. A single 0xffffffff beside a
 * height of 16 asks for sixty-eight gigabytes, which this platform hands out
 * lazily and only notices when something writes to it: the test would then
 * either pass or take the machine down, depending on where the reader gave up.
 * Both fields at once asks for more than any allocator will pretend to give,
 * so the answer comes back immediately either way.
 */
function binarySeed(
	format: FormatId,
	bytes: Uint8Array,
	sizes: readonly (readonly [Field, Field])[],
	extra: readonly Field[] = [],
	records?: (bytes: Uint8Array) => readonly (readonly [number, number])[],
): Seed {
	return {
		format,
		bytes,
		fields: [...sizes.flat(), ...extra],
		enormous: enormousFrom(bytes, sizes),
		...(records ? { records } : {}),
	};
}

/** A seed whose header is text, where the enormous variants are simply written out. */
function textSeed(format: FormatId, bytes: Uint8Array, enormous: readonly string[]): Seed {
	return {
		format,
		bytes,
		fields: [],
		text: true,
		enormous: enormous.map((text) => ascii(text)),
	};
}

export async function buildSeeds(): Promise<readonly Seed[]> {
	const picture = samplePicture();
	const png = await encodePng(picture);
	const apng = await encodeApng(picture, {
		animation: {
			frames: [
				{ image: picture, delayMs: 40 },
				{ image: samplePicture(1), delayMs: 60 },
				{ image: samplePicture(2), delayMs: 80 },
			],
			loopCount: 0,
		},
	});
	const ico = encodeIco([{ width: SIDE, height: SIDE, png }]);
	const icns = await encodeIcns(picture);
	const tiff = await encodeTiff(picture);
	const exr = await encodeExr(picture);
	// Animated on purpose. A GIF's frame loop, its per-frame descriptors and its
	// disposal rules are the part of that reader with the most to get wrong, and
	// a single frame file never reaches any of it.
	const gif = encodeGif(picture, {
		animation: {
			frames: [
				{ image: picture, delayMs: 40 },
				{ image: samplePicture(1), delayMs: 60 },
				{ image: samplePicture(2), delayMs: 80 },
			],
			loopCount: 0,
		},
	});
	const bmp = encodeBmp(picture);
	const tga = encodeTga(picture);
	const qoi = encodeQoi(picture);
	const pcx = encodePcx(picture);
	const ras = encodeRas(picture);
	const farbfeld = encodeFarbfeld(picture);
	const psd = psdSeed();
	const dds = ddsSeed();

	return [
		binarySeed(
			'png',
			png,
			[
				[
					{ offset: 16, size: 4, endian: 'be' },
					{ offset: 20, size: 4, endian: 'be' },
				],
			],
			// The IHDR chunk's own length, which decides where every later chunk
			// is looked for.
			[{ offset: 8, size: 4, endian: 'be' }],
			pngChunkSpans,
		),
		binarySeed(
			'apng',
			apng,
			[
				[
					{ offset: 16, size: 4, endian: 'be' },
					{ offset: 20, size: 4, endian: 'be' },
				],
			],
			[{ offset: 8, size: 4, endian: 'be' }],
			pngChunkSpans,
		),
		binarySeed('gif', gif, [
			[
				{ offset: 6, size: 2, endian: 'le' },
				{ offset: 8, size: 2, endian: 'le' },
			],
		]),
		binarySeed('qoi', qoi, [
			[
				{ offset: 4, size: 4, endian: 'be' },
				{ offset: 8, size: 4, endian: 'be' },
			],
		]),
		binarySeed(
			'bmp',
			bmp,
			[
				[
					{ offset: 18, size: 4, endian: 'le' },
					{ offset: 22, size: 4, endian: 'le' },
				],
			],
			// The file size, the offset to the pixels and the DIB header size.
			// All three are read before anything is measured.
			[
				{ offset: 2, size: 4, endian: 'le' },
				{ offset: 10, size: 4, endian: 'le' },
				{ offset: 14, size: 4, endian: 'le' },
			],
		),
		binarySeed(
			'tga',
			tga,
			[
				[
					{ offset: 12, size: 2, endian: 'le' },
					{ offset: 14, size: 2, endian: 'le' },
				],
			],
			// The colour map length, which decides how far past the header the
			// pixels start.
			[{ offset: 5, size: 2, endian: 'le' }],
		),
		binarySeed('farbfeld', farbfeld, [
			[
				{ offset: 8, size: 4, endian: 'be' },
				{ offset: 12, size: 4, endian: 'be' },
			],
		]),
		binarySeed(
			'ico',
			ico,
			pngSizeFields(ico),
			// The image count, and the size and offset of the first entry's
			// payload, which is where an ICO reader is most easily walked off
			// the end of the buffer.
			[
				{ offset: 4, size: 2, endian: 'le' },
				{ offset: 14, size: 4, endian: 'le' },
				{ offset: 18, size: 4, endian: 'le' },
			],
		),
		binarySeed(
			'icns',
			icns,
			pngSizeFields(icns),
			// The suite's own total length, then the first record's.
			[
				{ offset: 4, size: 4, endian: 'be' },
				{ offset: 12, size: 4, endian: 'be' },
			],
			icnsRecordSpans,
		),
		binarySeed(
			'tiff',
			tiff,
			[tiffSizeFields(tiff)],
			// The offset of the first directory. A reader that trusts it reads
			// its entry count from wherever this points.
			[{ offset: 4, size: 4, endian: 'le' }],
		),
		binarySeed('psd', psd, [
			[
				// Height, then width. That order is the format's, not a mistake.
				{ offset: 14, size: 4, endian: 'be' },
				{ offset: 18, size: 4, endian: 'be' },
			],
		]),
		binarySeed(
			'dds',
			dds,
			[
				[
					{ offset: 12, size: 4, endian: 'le' },
					{ offset: 16, size: 4, endian: 'le' },
				],
			],
			// The pitch and the mip map count, both of which a reader multiplies
			// by something.
			[
				{ offset: 20, size: 4, endian: 'le' },
				{ offset: 28, size: 4, endian: 'le' },
			],
		),
		binarySeed(
			'pcx',
			pcx,
			// A PCX has no width or height. It has a window, and the size is the
			// difference, so the two maxima are what there is to drive.
			[
				[
					{ offset: 8, size: 2, endian: 'le' },
					{ offset: 10, size: 2, endian: 'le' },
				],
			],
			// Bytes per line, which is the stride the reader allocates rows from.
			[{ offset: 66, size: 2, endian: 'le' }],
		),
		binarySeed(
			'ras',
			ras,
			[
				[
					{ offset: 4, size: 4, endian: 'be' },
					{ offset: 8, size: 4, endian: 'be' },
				],
			],
			// The declared length of the pixel data and of the colour map.
			[
				{ offset: 16, size: 4, endian: 'be' },
				{ offset: 28, size: 4, endian: 'be' },
			],
		),
		binarySeed('exr', exr, [exrWindowFields(exr)]),
		textSeed('pnm', encodePnm(picture), [
			'P6\n2147483647 2147483647\n255\n\x00\x00\x00',
			'P6\n4294967295 4294967295\n255\n\x00\x00\x00',
		]),
		textSeed('hdr', encodeHdr(picture), [
			'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2147483647 +X 2147483647\n\x00\x00\x00',
			'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4294967295 +X 4294967295\n\x00\x00\x00',
		]),
		textSeed('xbm', encodeXbm(picture), [
			'#define huge_width 2147483647\n#define huge_height 2147483647\n' +
				'static unsigned char huge_bits[] = {\n0x00, 0x01 };\n',
			'#define huge_width 4294967295\n#define huge_height 4294967295\n' +
				'static unsigned char huge_bits[] = {\n0x00, 0x01 };\n',
		]),
		textSeed('xpm', encodeXpm(picture), [
			'/* XPM */\nstatic char * huge[] = {\n"2147483647 2147483647 1 1",\n" \tc #000000",\n" "};\n',
			'/* XPM */\nstatic char * huge[] = {\n"4294967295 4294967295 1 1",\n" \tc #000000",\n" "};\n',
		]),
	];
}

/* ── Mutation ─────────────────────────────────────────────────────────── */

/**
 * How far into a file the concentrated mutations reach.
 *
 * Past every fixed header here and short of the pixel data in all of these
 * seeds, which is the point of having a second strategy that ignores it.
 * Damage inside a header exercises the bounds checks a reader takes before it
 * starts work, and there are only a few dozen bytes of it, so hitting them
 * needs the effort spent there rather than spread evenly over a file that is
 * mostly compressed pixels. `deepFlips` covers the rest, on purpose.
 */
const HEADER_REGION = 96;

/**
 * The four values a length or a dimension is driven to.
 *
 * Zero and one because they are the counts a loop bound is most often not
 * checked against. The signed maximum because a reader that took the field as
 * an `int32` sees the largest positive number there is, and the unsigned one
 * because the same reader sees minus one, and those two produce completely
 * different bugs out of the same four bytes.
 */
const EDGES_32 = [0, 1, 0x7fffffff, 0xffffffff] as const;
const EDGES_16 = [0, 1, 0x7fff, 0xffff] as const;

function truncations(seed: Seed): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	const lengths = new Set<number>([0]);
	for (let at = 1; at < seed.bytes.length; at *= 2) lengths.add(at);
	// Sixteenths as well as powers of two. Powers of two crowd the front of a
	// file and then leave one enormous gap: on a three kilobyte seed they are
	// 1024, 2048 and nothing at all after that, so a reader counting rows
	// against a length is only ever cut at the same two places. Sixteenths
	// spread the rest of the cuts across the pixel data evenly.
	for (let i = 1; i < 16; i += 1) lengths.add(Math.floor((seed.bytes.length * i) / 16));
	// One byte short of whole, which is the truncation a real interrupted
	// download most often produces and the one a length check off by one misses.
	lengths.add(seed.bytes.length - 1);
	for (const length of [...lengths].sort((a, b) => a - b)) {
		out.push({
			format: seed.format,
			label: `truncate@${length}`,
			bytes: seed.bytes.slice(0, length),
		});
	}
	return out;
}

function flips(seed: Seed, next: () => number): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	const reach = Math.min(seed.bytes.length, HEADER_REGION);
	for (let i = 0; i < 64 && reach > 0; i += 1) {
		const offset = Math.floor(next() * reach);
		const bit = 1 << Math.floor(next() * 8);
		const bytes = seed.bytes.slice();
		bytes[offset] = (bytes[offset] as number) ^ bit;
		out.push({ format: seed.format, label: `flip@${offset}^0x${bit.toString(16)}`, bytes });
	}
	return out;
}

/**
 * Bits flipped anywhere in the file, not only in the header.
 *
 * Deliberately including the compressed body, which the header strategies
 * never reach. A damaged deflate stream is where the failure this whole suite
 * was written around actually lived: `pump` in `src/codecs/png/deflate.ts`
 * holds three promises and awaits one, a corrupt stream rejects all three, and
 * the two nobody was holding used to take the tab down. A corpus that only
 * ever damaged headers would never have produced one, because a header refusal
 * happens before the inflater is asked for anything.
 *
 * It also reaches the structures that live at the far end of a file: a TIFF's
 * image file directory, an OpenEXR's chunk offset table, a TGA's footer.
 */
function deepFlips(seed: Seed, next: () => number): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	for (let i = 0; i < 64 && seed.bytes.length > 0; i += 1) {
		const offset = Math.floor(next() * seed.bytes.length);
		const bit = 1 << Math.floor(next() * 8);
		const bytes = seed.bytes.slice();
		bytes[offset] = (bytes[offset] as number) ^ bit;
		out.push({ format: seed.format, label: `deep-flip@${offset}^0x${bit.toString(16)}`, bytes });
	}
	return out;
}

/**
 * A header byte replaced outright rather than nudged.
 *
 * A flipped bit moves a byte by a power of two and mostly produces a number
 * that is merely wrong. Writing 0x00 or 0xff writes the two values that a
 * count, an offset or an enumeration is most often not checked against, and
 * doing it a byte at a time reaches the high byte of a length that a flip in
 * the low byte never disturbs.
 */
function smears(seed: Seed): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	const reach = Math.min(seed.bytes.length, HEADER_REGION);
	for (let offset = 0; offset < reach; offset += 3) {
		for (const value of [0x00, 0xff]) {
			if (seed.bytes[offset] === value) continue;
			const bytes = seed.bytes.slice();
			bytes[offset] = value;
			out.push({
				format: seed.format,
				label: `smear@${offset}=0x${value.toString(16).padStart(2, '0')}`,
				bytes,
			});
		}
	}
	return out;
}

function edges(seed: Seed): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	for (const field of seed.fields) {
		for (const value of field.size === 2 ? EDGES_16 : EDGES_32) {
			out.push({
				format: seed.format,
				label: `field@${field.offset}:${field.endian}${field.size * 8}=0x${value.toString(16)}`,
				bytes: put(seed.bytes, field, value),
			});
		}
	}
	return out;
}

/**
 * Text headers, where a number is a run of digits rather than a field.
 *
 * The same four edges as a binary field, written where the digits were. The
 * run is found rather than counted from a fixed offset, because a Netpbm
 * header can carry a comment and a Radiance one carries as many lines as the
 * writer felt like.
 */
function digitEdges(seed: Seed): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	const reach = Math.min(seed.bytes.length, HEADER_REGION);
	const runs: (readonly [number, number])[] = [];
	let at = 0;
	while (at < reach) {
		const digit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
		if (!digit(seed.bytes[at])) {
			at += 1;
			continue;
		}
		const start = at;
		while (at < reach && digit(seed.bytes[at])) at += 1;
		runs.push([start, at]);
	}
	for (const [start, end] of runs.slice(0, 4)) {
		for (const value of EDGES_32) {
			out.push({
				format: seed.format,
				label: `digits@${start}=${value}`,
				bytes: join([
					seed.bytes.subarray(0, start),
					ascii(String(value)),
					seed.bytes.subarray(end),
				]),
			});
		}
	}
	return out;
}

/**
 * Duplicated, dropped and reordered records.
 *
 * Only for the formats that have records, which here is PNG (so APNG too) and
 * the Apple icon suite. A second `IHDR`, an `IEND` in the middle, or a frame
 * control chunk with nothing following it are all files a reader has to have
 * an answer for, and none of them is reachable by flipping a byte.
 */
function shuffles(seed: Seed): readonly MalformedInput[] {
	if (!seed.records) return [];
	const spans = seed.records(seed.bytes);
	if (spans.length < 2) return [];
	const head = seed.bytes.subarray(0, (spans[0] as readonly [number, number])[0]);
	const tail = seed.bytes.subarray((spans[spans.length - 1] as readonly [number, number])[1]);
	const parts = spans.map(([from, to]) => seed.bytes.subarray(from, to));
	const out: MalformedInput[] = [];

	for (const index of [0, 1]) {
		if (index >= parts.length) continue;
		const duplicated = [...parts];
		duplicated.splice(index, 0, parts[index] as Uint8Array);
		out.push({
			format: seed.format,
			label: `record-duplicate@${index}`,
			bytes: join([head, ...duplicated, tail]),
		});

		const dropped = [...parts];
		dropped.splice(index, 1);
		out.push({
			format: seed.format,
			label: `record-drop@${index}`,
			bytes: join([head, ...dropped, tail]),
		});
	}

	const swapped = [...parts];
	swapped[0] = parts[1] as Uint8Array;
	swapped[1] = parts[0] as Uint8Array;
	out.push({
		format: seed.format,
		label: 'record-swap@0,1',
		bytes: join([head, ...swapped, tail]),
	});

	const reversed = [...parts].reverse();
	out.push({
		format: seed.format,
		label: 'record-reverse',
		bytes: join([head, ...reversed, tail]),
	});
	return out;
}

/**
 * How many inputs each seed contributes.
 *
 * This is a cap and it bites. The strategies together offer between about 230
 * and 270 inputs per seed, so roughly a fifth of what is generated is thrown
 * away, and the corpus is a sample rather than an enumeration. Saying that out
 * loud matters: a ceiling nobody mentions reads as full coverage. What gets
 * dropped is the tail of whichever strategies run longest for that format,
 * mostly the single byte smears at the far end of the header region, because
 * the strategies are interleaved before the cap applies rather than
 * concatenated.
 *
 * The number is the time budget rather than a theory about how many inputs are
 * enough. At 220 the whole file runs in about a third of a second, which keeps
 * `vitest run` where people will run it before pushing rather than after.
 * There is nothing magic about it: the same corpus was run once at five
 * thousand per seed, about eighty-five thousand inputs, and found nothing that
 * the shipped size does not. Raise it while hunting something, and put it back.
 */
export const INPUTS_PER_SEED = 220;

/** Take one from each strategy in turn, so the cap does not favour any of them. */
function interleave(groups: readonly (readonly MalformedInput[])[]): readonly MalformedInput[] {
	const out: MalformedInput[] = [];
	const longest = Math.max(0, ...groups.map((group) => group.length));
	for (let i = 0; i < longest; i += 1) {
		for (const group of groups) {
			const item = group[i];
			if (item) out.push(item);
		}
	}
	return out;
}

export function corpusFor(seed: Seed): readonly MalformedInput[] {
	const next = prng(SEED);
	const groups = [
		truncations(seed),
		flips(seed, next),
		deepFlips(seed, next),
		smears(seed),
		seed.text ? digitEdges(seed) : edges(seed),
		shuffles(seed),
	];
	return interleave(groups).slice(0, INPUTS_PER_SEED);
}

/** The size-refusal inputs, which are asserted separately. See `Seed.enormous`. */
export function enormousFor(seed: Seed): readonly MalformedInput[] {
	return seed.enormous.map((bytes, index) => ({
		format: seed.format,
		label: `enormous#${index}`,
		bytes,
	}));
}
