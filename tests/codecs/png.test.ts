/**
 * PNG codec tests.
 *
 * The checksums are pinned to values published outside this repository: the
 * CRC-32 check vector for the string `123456789`, the CRC of the four bytes
 * `IEND` that every PNG in the world ends with, and the Adler-32 of
 * `Wikipedia` from the article that defines it. Checking a checksum against
 * itself proves only that it is deterministic.
 *
 * The hand built files below carry their image data as stored deflate blocks
 * written byte by byte, with the Adler-32 trailer computed by a naive loop in
 * this file. That keeps a fixture a fixed sequence of bytes rather than
 * whatever the platform's compressor happened to emit, and it means the
 * decoder is being handed a stream that nothing in `src/` produced.
 *
 * `THIRD_PARTY_PNG` goes one step further: it is a file written by Apple's
 * ImageIO, byte for byte, with real Huffman coded deflate and two ancillary
 * chunks this reader has to step over. Nothing in this repository chose any
 * of those bytes.
 *
 * `unfilterRows` is a second transcription of the filter definitions, used to
 * check the encoder without asking the decoder whether the encoder was right.
 * A round trip through both halves of this package passes just as happily
 * when the two agree on something the specification does not say.
 */

import { describe, expect, it } from 'vitest';
import { adler32, crc32 } from '../../src/codecs/png/crc.js';
import { decodePng } from '../../src/codecs/png/decode.js';
import { deflate, inflate } from '../../src/codecs/png/deflate.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import { DecodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(text: string): Uint8Array {
	return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
}

function fromHex(text: string): Uint8Array {
	const out = new Uint8Array(text.length / 2);
	for (let i = 0; i < out.length; i += 1)
		out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

/** Adler-32 the slow, obvious way, so a fixture never depends on the fast one. */
function adlerOf(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of bytes) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

/**
 * A zlib stream carrying `data` in stored (uncompressed) deflate blocks.
 *
 * 0x78 0x01 is the only two byte header whose value is a multiple of 31 at the
 * lowest compression setting, which is what the FCHECK field requires. The
 * trailing Adler-32 is real, so `DecompressionStream` rejects this if the byte
 * layout is wrong rather than quietly handing back short data.
 */
function zlibStored(data: Uint8Array): Uint8Array {
	const out: number[] = [0x78, 0x01];
	let at = 0;
	do {
		const length = Math.min(0xffff, data.length - at);
		const final = at + length >= data.length ? 1 : 0;
		out.push(final, length & 0xff, (length >>> 8) & 0xff, ~length & 0xff, (~length >>> 8) & 0xff);
		for (let i = 0; i < length; i += 1) out.push(data[at + i] as number);
		at += length;
	} while (at < data.length);
	const sum = adlerOf(data);
	out.push((sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff);
	return Uint8Array.from(out);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(ascii(type), 4);
	out.set(data, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

interface PngPlan {
	readonly width: number;
	readonly height: number;
	readonly bitDepth: number;
	readonly colourType: number;
	/** Packed scanline bytes per row, without the leading filter byte. */
	readonly rows: readonly (readonly number[])[];
	/** Filter type per row. Defaults to 0, meaning the row is stored as it is. */
	readonly filters?: readonly number[];
	readonly palette?: readonly number[];
	readonly transparency?: readonly number[];
	readonly interlace?: number;
	readonly colourTag?: readonly number[];
	/** Leave the header out, for the tests that want a file with no IHDR. */
	readonly omitHeader?: boolean;
	readonly omitData?: boolean;
}

function buildPng(plan: PngPlan): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, plan.width);
	view.setUint32(4, plan.height);
	header[8] = plan.bitDepth;
	header[9] = plan.colourType;
	header[12] = plan.interlace ?? 0;

	const raw: number[] = [];
	plan.rows.forEach((row, y) => {
		raw.push(plan.filters?.[y] ?? 0, ...row);
	});

	const pieces: Uint8Array[] = [Uint8Array.from(SIGNATURE)];
	if (!plan.omitHeader) pieces.push(pngChunk('IHDR', header));
	if (plan.palette) pieces.push(pngChunk('PLTE', Uint8Array.from(plan.palette)));
	if (plan.transparency) pieces.push(pngChunk('tRNS', Uint8Array.from(plan.transparency)));
	if (plan.colourTag) pieces.push(pngChunk('cICP', Uint8Array.from(plan.colourTag)));
	if (!plan.omitData) pieces.push(pngChunk('IDAT', zlibStored(Uint8Array.from(raw))));
	pieces.push(pngChunk('IEND', new Uint8Array(0)));
	return concat(pieces);
}

interface Chunk {
	readonly type: string;
	readonly data: Uint8Array;
	/** The CRC as written in the file. */
	readonly crc: number;
	/** The CRC a reader recomputes over the type and the data. */
	readonly recomputed: number;
}

function readChunks(bytes: Uint8Array): Chunk[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: Chunk[] = [];
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at);
		chunks.push({
			type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
			data: bytes.subarray(at + 8, at + 8 + length),
			crc: view.getUint32(at + 8 + length),
			recomputed: crc32(bytes.subarray(at + 4, at + 8 + length)),
		});
		at += 12 + length;
	}
	return chunks;
}

function chunkNamed(bytes: Uint8Array, type: string): Chunk {
	const found = readChunks(bytes).find((chunk) => chunk.type === type);
	if (!found) throw new Error(`the encoded file has no ${type} chunk`);
	return found;
}

function hasChunk(bytes: Uint8Array, type: string): boolean {
	return readChunks(bytes).some((chunk) => chunk.type === type);
}

function readHeader(bytes: Uint8Array): number[] {
	const { data } = chunkNamed(bytes, 'IHDR');
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return [
		view.getUint32(0),
		view.getUint32(4),
		data[8] as number,
		data[9] as number,
		data[10] as number,
		data[11] as number,
		data[12] as number,
	];
}

/** A deterministic pattern, so the same pixels appear on every machine. */
function noise(width: number, height: number, hasAlpha: boolean): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	let state = 0x2545f491;
	for (let i = 0; i < width * height; i += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		const at = i * 4;
		image.data[at] = state & 0xff;
		image.data[at + 1] = (state >>> 8) & 0xff;
		image.data[at + 2] = (state >>> 16) & 0xff;
		// Cycled rather than taken from the noise, so every alpha value from
		// fully clear to fully opaque appears whatever the dimensions are.
		image.data[at + 3] = hasAlpha ? (i * 37) & 0xff : 255;
	}
	return image;
}

/**
 * Compare two rasters and, when they differ, name the first pixel that does.
 *
 * `expect([...a]).toEqual([...b])` over the 640 by 480 case builds a diff of
 * 1.2 million entries the moment it fails. That takes long enough that a
 * regression reads as a hung run rather than a failed one, and a test suite
 * that hangs on failure gets turned off. Finding the first difference first
 * costs one pass and turns the same regression into one readable line.
 */
function expectSamePixels(actual: RasterImage, expected: RasterImage): void {
	expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
	expect(actual.data.length).toBe(expected.data.length);

	let first = -1;
	let differing = 0;
	for (let i = 0; i < expected.data.length; i += 1) {
		if (actual.data[i] !== expected.data[i]) {
			if (first === -1) first = i;
			differing += 1;
		}
	}
	if (first === -1) return;

	const pixel = Math.floor(first / 4);
	const at = pixel * 4;
	expect(
		[...actual.data.subarray(at, at + 4)],
		`the pixel at ${pixel % expected.width}, ${Math.floor(pixel / expected.width)}, the first of ${differing} bytes that differ`,
	).toEqual([...expected.data.subarray(at, at + 4)]);
}

function paethOf(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const dl = Math.abs(p - left);
	const du = Math.abs(p - up);
	const dul = Math.abs(p - upLeft);
	if (dl <= du && dl <= dul) return left;
	return du <= dul ? up : upLeft;
}

/**
 * Undo the scanline filters, written out from the specification rather than
 * shared with `src/`. This is what lets the encoder be checked on its own.
 */
function unfilterRows(raw: Uint8Array, stride: number, bpp: number, height: number): number[][] {
	const rows: number[][] = [];
	let previous: number[] = new Array<number>(stride).fill(0);
	for (let y = 0; y < height; y += 1) {
		const start = y * (stride + 1);
		const type = raw[start] as number;
		expect(type, `the filter type on row ${y}`).toBeLessThan(5);
		const row = new Array<number>(stride).fill(0);
		for (let i = 0; i < stride; i += 1) {
			const value = raw[start + 1 + i] as number;
			const left = i >= bpp ? (row[i - bpp] as number) : 0;
			const up = previous[i] as number;
			const upLeft = i >= bpp ? (previous[i - bpp] as number) : 0;
			const predictor =
				type === 0
					? 0
					: type === 1
						? left
						: type === 2
							? up
							: type === 3
								? (left + up) >> 1
								: paethOf(left, up, upLeft);
			row[i] = (value + predictor) & 0xff;
		}
		rows.push(row);
		previous = row;
	}
	return rows;
}

/**
 * A 4 by 2 PNG written by Apple's ImageIO, kept byte for byte.
 *
 * Every other fixture here is assembled by this file, so all of them share
 * whatever this file believes about the format. This one does not: a separate
 * encoder chose the filters, a real Huffman coded deflate stream carries the
 * pixels rather than the stored blocks `zlibStored` writes, and an `sRGB` and
 * an `eXIf` chunk sit between the header and the data for the reader to step
 * over. The pixels below were read back with an independent unfilter before
 * the bytes were pasted in.
 *
 * The source image is synthetic, so the EXIF holds only a colour space and
 * the two dimensions. Nothing here came from a camera.
 */
const THIRD_PARTY_PNG = fromHex(
	'89504e470d0a1a0a0000000d4948445200000004000000020802000000f0ca' +
		'ea34000000017352474200aece1ce900000044655849664d4d002a00000008' +
		'000187690004000000010000001a000000000003a001000300000001000100' +
		'00a00200040000000100000004a00300040000000100000002000000004a2c' +
		'0ba20000001c49444154081d63f8cfc0c000c6ff412403434343c3ffffff19' +
		'99980178b7097fbc31d8470000000049454e44ae426082',
);

/* ── Checksums ────────────────────────────────────────────────────────── */

describe('the PNG checksums', () => {
	it('matches the published CRC-32 check value for 123456789', () => {
		// 0xcbf43926 is the check value listed for CRC-32/ISO-HDLC, the variant
		// PNG uses. A table built with the bits in the wrong order still
		// produces stable output, so only an outside value catches it.
		expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
	});

	it('matches the CRC every PNG in the world carries after IHDR and IEND', () => {
		expect(crc32(ascii('IHDR'))).toBe(0xa8a1ae0a);
		expect(crc32(ascii('IEND'))).toBe(0xae426082);
	});

	it('matches a known CRC over a run of every byte value', () => {
		const run = Uint8Array.from({ length: 256 }, (_, i) => i);
		expect(crc32(run)).toBe(0x29058c73);
	});

	it('returns zero for no bytes at all', () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	it('continues a running CRC when handed the previous result as the seed', () => {
		// Nothing in the encoder splits a chunk yet, but the seed parameter is
		// part of the signature and a wrong final xor would make it silently
		// useless rather than obviously broken.
		// Checked against the published value rather than against a single call
		// on the same input, which would hold just as well if both halves were
		// wrong in the same way.
		const whole = ascii('123456789');
		expect(crc32(whole.subarray(4), crc32(whole.subarray(0, 4)))).toBe(0xcbf43926);
	});

	it('matches the published Adler-32 of the string Wikipedia', () => {
		expect(adler32(ascii('Wikipedia'))).toBe(0x11e60398);
		expect(adler32(ascii('123456789'))).toBe(0x091e01de);
	});

	it('agrees with the naive loop the fixtures are built with', () => {
		// `adlerOf` seals every hand built file in this suite. Pinning it to the
		// same published value keeps a wrong fixture from looking like a wrong
		// decoder.
		expect(adlerOf(ascii('Wikipedia'))).toBe(0x11e60398);
		expect(adlerOf(new Uint8Array(0))).toBe(1);
	});

	it('returns one for no bytes, because the low half starts at one', () => {
		expect(adler32(new Uint8Array(0))).toBe(1);
	});

	it('carries the modulo across a run longer than one accumulator block', () => {
		// The loop only reduces every 5552 bytes. A run longer than that is the
		// only input that can catch a block boundary handled wrongly.
		const long = Uint8Array.from({ length: 20000 }, (_, i) => (i * 31) & 0xff);
		// The literal is what zlib reports for this run. Comparing the fast path
		// against the naive one as well says the two agree, which is worth
		// knowing but is not the same as either being right.
		expect(adler32(long)).toBe(0xfc26ea4b);
		expect(adlerOf(long)).toBe(0xfc26ea4b);
	});
});

/* ── Deflate ──────────────────────────────────────────────────────────── */

describe('the deflate wrapper', () => {
	it('writes a zlib header, which is what an IDAT and an iCCP both hold', async () => {
		// A raw deflate stream would look almost right and inflate correctly in
		// this package's own decoder, then be rejected by every real PNG reader.
		const out = await deflate(ascii('the quick brown fox'));
		expect(out[0]).toBe(0x78);
		expect((out[0] as number) & 0x0f).toBe(8);
		expect((((out[0] as number) << 8) | (out[1] as number)) % 31).toBe(0);
	});

	it('round trips a buffer of every byte value', async () => {
		const original = Uint8Array.from({ length: 256 }, (_, i) => i);
		expect([...(await inflate(await deflate(original)))]).toEqual([...original]);
	});

	it('round trips a buffer larger than one stream chunk', async () => {
		// Writing and closing without awaiting the write is what makes this
		// work. A buffer this size deadlocks a naive implementation.
		const original = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) & 0xff);
		const restored = await inflate(await deflate(original));
		expect(restored.length).toBe(original.length);
		expect(restored[299_999]).toBe(original[299_999]);
	});

	it('round trips an empty buffer', async () => {
		expect((await inflate(await deflate(new Uint8Array(0)))).length).toBe(0);
	});

	it('actually compresses a repetitive buffer', async () => {
		const flat = new Uint8Array(50_000);
		expect((await deflate(flat)).length).toBeLessThan(1000);
	});
});

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('the PNG the encoder writes', () => {
	it('starts with the eight byte signature', async () => {
		const bytes = await encodePng(noise(4, 3, false));
		expect([...bytes.subarray(0, 8)]).toEqual(SIGNATURE);
	});

	it('writes an IHDR with the dimensions big endian, depth 8 and no interlacing', async () => {
		const bytes = await encodePng(noise(37, 23, false));
		// Width, height, bit depth, colour type, compression, filter, interlace.
		expect(readHeader(bytes)).toEqual([37, 23, 8, 2, 0, 0, 0]);
	});

	it('writes a dimension above 65535 across all four bytes', async () => {
		const bytes = await encodePng(createRaster(66_000, 1));
		expect([...chunkNamed(bytes, 'IHDR').data.subarray(0, 8)]).toEqual([
			0, 1, 0x01, 0xd0, 0, 0, 0, 1,
		]);
	});

	it('writes colour type 2 for an opaque raster and 6 for one carrying alpha', async () => {
		// Getting this backwards costs a third of the file on every photograph,
		// or throws away the alpha channel on every logo, depending which way.
		expect(readHeader(await encodePng(noise(5, 5, false)))[3]).toBe(2);
		expect(readHeader(await encodePng(noise(5, 5, true)))[3]).toBe(6);
	});

	it('ends with an empty IEND chunk carrying the CRC that constant always has', async () => {
		const bytes = await encodePng(noise(4, 4, true));
		const chunks = readChunks(bytes);
		const last = chunks[chunks.length - 1] as Chunk;
		expect(last.type).toBe('IEND');
		expect(last.data.length).toBe(0);
		expect(last.crc).toBe(0xae426082);
	});

	it('writes the chunks in the order a reader expects', async () => {
		const bytes = await encodePng(noise(4, 4, false));
		expect(readChunks(bytes).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
	});

	it('gives every chunk a CRC that validates when recomputed', async () => {
		// The CRC covers the type and the data but not the length field. Writing
		// it over the wrong span produces a file this package still reads, since
		// the decoder never checks, and that every other reader refuses.
		const bytes = await encodePng(noise(9, 7, true), {
			iccProfile: Uint8Array.from({ length: 64 }, (_, i) => i),
		});
		const chunks = readChunks(bytes);
		expect(chunks.length).toBeGreaterThan(3);
		for (const chunk of chunks) {
			expect(chunk.recomputed, `CRC of the ${chunk.type} chunk`).toBe(chunk.crc);
		}
	});

	it('writes RGB scanlines that unfilter back to the pixels it was handed', async () => {
		// Checked without the decoder. A round trip only says the two halves
		// agree, and they agree just as well when both use the wrong filter
		// stride, which is a file every other reader gets wrong.
		const image = noise(9, 5, false);
		const raw = await inflate(chunkNamed(await encodePng(image), 'IDAT').data);
		expect(raw.length).toBe((9 * 3 + 1) * 5);
		const rows = unfilterRows(raw, 9 * 3, 3, 5);
		for (let y = 0; y < 5; y += 1) {
			const expected: number[] = [];
			for (let x = 0; x < 9; x += 1) {
				const at = (y * 9 + x) * 4;
				expected.push(
					image.data[at] as number,
					image.data[at + 1] as number,
					image.data[at + 2] as number,
				);
			}
			expect(rows[y], `row ${y}`).toEqual(expected);
		}
	});

	it('writes RGBA scanlines that unfilter back to the pixels it was handed', async () => {
		// Same again at four bytes per pixel, because the stride the filters
		// look back by is the channel count and not a constant.
		const image = noise(7, 4, true);
		const raw = await inflate(chunkNamed(await encodePng(image), 'IDAT').data);
		const rows = unfilterRows(raw, 7 * 4, 4, 4);
		for (let y = 0; y < 4; y += 1) {
			expect(rows[y], `row ${y}`).toEqual([...image.data.subarray(y * 7 * 4, (y + 1) * 7 * 4)]);
		}
	});

	it('costs nothing per row on a flat image, which is what the filters are for', async () => {
		// The file being small does not prove the filters are chosen well:
		// deflate alone squashes a repeated row. A row that predicts perfectly
		// from the one above it is the thing that has to come out as zeroes, and
		// an encoder that always wrote filter 0 would still pass a size check.
		const image = createRaster(16, 4, 'srgb', false);
		for (let i = 0; i < 16 * 4; i += 1) image.data.set([30, 144, 255, 255], i * 4);
		const raw = await inflate(chunkNamed(await encodePng(image), 'IDAT').data);
		const stride = 16 * 3;
		for (let y = 1; y < 4; y += 1) {
			const start = y * (stride + 1);
			expect(raw[start], `the filter type on row ${y}`).not.toBe(0);
			expect([...raw.subarray(start + 1, start + 1 + stride)], `row ${y}`).toEqual(
				new Array<number>(stride).fill(0),
			);
		}
	});
});

describe('the PNG colour tagging', () => {
	/** Not a real profile. The encoder never parses one, it only carries it. */
	const PROFILE = Uint8Array.from({ length: 512 }, (_, i) => (i * 13) & 0xff);

	it('writes an iCCP whose payload inflates back to the profile it was given', async () => {
		const bytes = await encodePng(noise(6, 6, false), { iccProfile: PROFILE });
		const { data } = chunkNamed(bytes, 'iCCP');
		const terminator = data.indexOf(0);
		expect(String.fromCharCode(...data.subarray(0, terminator))).toBe('ICC profile');
		// Compression method 0 is the only one PNG defines for iCCP.
		expect(data[terminator + 1]).toBe(0);
		expect([...(await inflate(data.subarray(terminator + 2)))]).toEqual([...PROFILE]);
	});

	it('writes no iCCP for an empty profile, rather than an empty one', async () => {
		expect(
			hasChunk(await encodePng(noise(3, 3, false), { iccProfile: new Uint8Array(0) }), 'iCCP'),
		).toBe(false);
	});

	it('writes a cICP naming Display P3 when asked to tag and given no profile', async () => {
		const image = createRaster(3, 2, 'display-p3');
		const bytes = await encodePng(image, { writeColourTag: true });
		// Primaries 12 is SMPTE EG 432-1, transfer 13 is sRGB, matrix 0 means
		// the samples are already RGB, and the last byte is the full range flag.
		expect([...chunkNamed(bytes, 'cICP').data]).toEqual([12, 13, 0, 1]);
	});

	it('writes a cICP naming sRGB for an sRGB raster', async () => {
		const bytes = await encodePng(createRaster(3, 2, 'srgb'), { writeColourTag: true });
		expect([...chunkNamed(bytes, 'cICP').data]).toEqual([1, 13, 0, 1]);
	});

	it('carries the profile rather than the tag when both are asked for', async () => {
		// The profile is what the camera meant and every reader understands it.
		// Writing both would let the two disagree with nothing to resolve them.
		const bytes = await encodePng(createRaster(2, 2, 'display-p3'), {
			iccProfile: PROFILE,
			writeColourTag: true,
		});
		expect(hasChunk(bytes, 'iCCP')).toBe(true);
		expect(hasChunk(bytes, 'cICP')).toBe(false);
	});

	it('writes no colour chunk at all when nothing asks for one', async () => {
		const bytes = await encodePng(createRaster(2, 2, 'display-p3'));
		expect(hasChunk(bytes, 'cICP')).toBe(false);
		expect(hasChunk(bytes, 'iCCP')).toBe(false);
	});

	it('brings Display P3 back through a round trip when the tag was written', async () => {
		const image = createRaster(4, 4, 'display-p3');
		expect((await decodePng(await encodePng(image, { writeColourTag: true }))).colourSpace).toBe(
			'display-p3',
		);
		expect((await decodePng(await encodePng(image))).colourSpace).toBe('srgb');
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('PNG round trips', () => {
	it('is pixel identical at 37 by 23, where a stride bug cannot hide', async () => {
		// An odd width means the row is not a multiple of anything convenient,
		// so an off by one in the filter stride shifts every row after the
		// first. Even dimensions absorb that and pass.
		const image = noise(37, 23, false);
		const decoded = await decodePng(await encodePng(image));
		expect(decoded.hasAlpha).toBe(false);
		expectSamePixels(decoded, image);
	});

	it('is pixel identical at 37 by 23 with alpha', async () => {
		const image = noise(37, 23, true);
		const decoded = await decodePng(await encodePng(image));
		expect(decoded.hasAlpha).toBe(true);
		expectSamePixels(decoded, image);
	});

	it('keeps a single pixel exactly', async () => {
		const image = createRaster(1, 1, 'srgb', true);
		image.data.set([12, 34, 56, 78]);
		expect([...(await decodePng(await encodePng(image))).data]).toEqual([12, 34, 56, 78]);
	});

	it('keeps a single opaque pixel exactly', async () => {
		const image = createRaster(1, 1);
		image.data.set([9, 8, 7, 255]);
		const decoded = await decodePng(await encodePng(image));
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([9, 8, 7, 255]);
	});

	it('keeps fully clear, partly clear and fully opaque pixels apart', async () => {
		const image = createRaster(4, 1, 'srgb', true);
		image.data.set([10, 20, 30, 0, 40, 50, 60, 1, 70, 80, 90, 128, 100, 110, 120, 255]);
		const decoded = await decodePng(await encodePng(image));
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual([
			10, 20, 30, 0, 40, 50, 60, 1, 70, 80, 90, 128, 100, 110, 120, 255,
		]);
	});

	it('reports no alpha for a file with an alpha channel that turns out opaque', async () => {
		const image = createRaster(3, 2, 'srgb', true);
		for (let i = 0; i < 6; i += 1) {
			image.data[i * 4] = i * 40;
			image.data[i * 4 + 3] = 255;
		}
		const encoded = await encodePng(image);
		expect(readHeader(encoded)[3]).toBe(6);
		const decoded = await decodePng(encoded);
		expect(decoded.hasAlpha).toBe(false);
		expectSamePixels(decoded, image);
	});

	it.each([
		[1, 9],
		[9, 1],
		[2, 2],
		[13, 17],
		[64, 65],
	])('is pixel identical at %i by %i', async (width, height) => {
		const image = noise(width, height, true);
		expectSamePixels(await decodePng(await encodePng(image)), image);
	});

	it('is pixel identical with a profile chunk sitting in front of the data', async () => {
		// An iCCP is several hundred bytes of something the reader has no use
		// for, between the header it needs and the data it needs. A reader that
		// mislays its place in the chunk walk stops at exactly this file.
		const image = noise(11, 6, true);
		const encoded = await encodePng(image, {
			iccProfile: Uint8Array.from({ length: 400 }, (_, i) => (i * 7) & 0xff),
		});
		expect(hasChunk(encoded, 'iCCP')).toBe(true);
		expectSamePixels(await decodePng(encoded), image);
	});

	it('is pixel identical over a large flat image', async () => {
		// Flat is the case where the filters all score the same and the
		// deflate output is one long run, which is a different code path
		// through both halves than noise is.
		const image = createRaster(640, 480, 'srgb', false);
		for (let i = 0; i < 640 * 480; i += 1) {
			image.data.set([30, 144, 255, 255], i * 4);
		}
		const encoded = await encodePng(image);
		// A flat megapixel of RGB has to compress to a small fraction of its
		// raw size. If it does not, the filter choice is producing noise.
		expect(encoded.length).toBeLessThan(50_000);
		expectSamePixels(await decodePng(encoded), image);
	});

	it('keeps every step of a full 256 value gradient', async () => {
		const image = createRaster(256, 2);
		for (let y = 0; y < 2; y += 1) {
			for (let x = 0; x < 256; x += 1) {
				image.data.set([x, (x * 3) & 0xff, 255 - x, 255], (y * 256 + x) * 4);
			}
		}
		expectSamePixels(await decodePng(await encodePng(image)), image);
	});
});

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('the PNG decoder over a file written elsewhere', () => {
	it('reads a PNG this repository did not write a single byte of', async () => {
		const decoded = await decodePng(THIRD_PARTY_PNG);
		expect([decoded.width, decoded.height]).toEqual([4, 2]);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 0, 0, 255, 128, 128, 128,
			255, 255, 255, 255, 255, 1, 2, 3, 255,
		]);
	});

	it('steps over the ancillary chunks that file carries', async () => {
		// Named so the fixture cannot quietly lose the property it is here for.
		// Every other file in this suite is assembled a few lines above the test
		// that reads it, so all of them agree with this file about the format.
		expect(readChunks(THIRD_PARTY_PNG).map((chunk) => chunk.type)).toEqual([
			'IHDR',
			'sRGB',
			'eXIf',
			'IDAT',
			'IEND',
		]);
		// 0x08 0x1d, not the 0x78 0x01 the fixtures here write, so the reader
		// cannot be matching a particular zlib header.
		expect([...chunkNamed(THIRD_PARTY_PNG, 'IDAT').data.subarray(0, 2)]).toEqual([0x08, 0x1d]);
	});
});

describe('the PNG decoder over hand written files', () => {
	it('reads greyscale at 8 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 2,
				bitDepth: 8,
				colourType: 0,
				rows: [
					[0, 128],
					[255, 64],
				],
			}),
		);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([
			0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 64, 64, 64, 255,
		]);
	});

	it('reads greyscale at 1 bit, unpacking eight pixels from one byte', async () => {
		// The samples run most significant bit first. Reading them the other way
		// mirrors every row, which looks like a plausible image.
		const decoded = await decodePng(
			buildPng({ width: 8, height: 1, bitDepth: 1, colourType: 0, rows: [[0b10110010]] }),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([
			255, 0, 255, 255, 0, 0, 255, 0,
		]);
	});

	it('reads greyscale at 2 bits, scaling the range to 0 through 255', async () => {
		// 1 of a possible 3 has to become 85, not 1. A decoder that forgets to
		// scale produces an image that is almost entirely black.
		const decoded = await decodePng(
			buildPng({ width: 4, height: 1, bitDepth: 2, colourType: 0, rows: [[0b00011011]] }),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([0, 85, 170, 255]);
	});

	it('reads greyscale at 4 bits', async () => {
		const decoded = await decodePng(
			buildPng({ width: 4, height: 1, bitDepth: 4, colourType: 0, rows: [[0x05, 0xaf]] }),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([0, 85, 170, 255]);
	});

	it.each([
		[1, [[0b10100000], [0b01100000]], [255, 0, 255, 0, 255, 255]],
		[2, [[0b00011000], [0b11100100]], [0, 85, 170, 255, 170, 85]],
		[
			4,
			[
				[0x0f, 0x00],
				[0x50, 0xa0],
			],
			[0, 255, 0, 85, 0, 170],
		],
	])('starts each packed row on a byte boundary at %i bits', async (depth, rows, expected) => {
		// Three pixels do not fill a byte at any of these depths, so the row is
		// padded out and the next one starts clean. A decoder that treats the
		// image as one continuous run of bits reads row two shifted by the
		// padding, which shows as a picture that skews further over on every
		// row and is easy to mistake for a stride bug somewhere else.
		const decoded = await decodePng(
			buildPng({ width: 3, height: 2, bitDepth: depth, colourType: 0, rows }),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual(expected);
	});

	it('scales a 16 bit sample rather than keeping its high byte', async () => {
		// 0x00ff is the smallest sample above zero that survives rounding, and
		// 0xff00 is the largest below full. Taking the high byte gives 0 and 255
		// for these two, which is right for most of the range and wrong at both
		// ends, so it passes every test built from round numbers.
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 1,
				bitDepth: 16,
				colourType: 0,
				rows: [[0x00, 0xff, 0xff, 0x00]],
			}),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([1, 254]);
	});

	it('reads greyscale at 16 bits, taking the high byte first', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 3,
				height: 1,
				bitDepth: 16,
				colourType: 0,
				rows: [[0x00, 0x00, 0x80, 0x00, 0xff, 0xff]],
			}),
		);
		expect([...decoded.data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
	});

	it('reads truecolour at 8 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 1,
				bitDepth: 8,
				colourType: 2,
				rows: [[255, 0, 0, 0, 255, 0]],
			}),
		);
		expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('reads truecolour at 16 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 1,
				height: 1,
				bitDepth: 16,
				colourType: 2,
				rows: [[0xff, 0xff, 0x00, 0x00, 0x80, 0x00]],
			}),
		);
		expect([...decoded.data]).toEqual([255, 0, 128, 255]);
	});

	it('reads a palette at 8 bits with a tRNS table', async () => {
		// tRNS is shorter than the palette on purpose. Every entry it does not
		// reach is opaque, and a decoder that reads past its end makes the tail
		// of the palette transparent.
		const decoded = await decodePng(
			buildPng({
				width: 3,
				height: 1,
				bitDepth: 8,
				colourType: 3,
				palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
				transparency: [0, 128],
				rows: [[0, 1, 2]],
			}),
		);
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
	});

	it('reads a palette at 4 bits without scaling the index', async () => {
		// A palette index is a lookup, not a sample. Scaling it the way a
		// greyscale sample is scaled turns index 1 into index 85.
		const decoded = await decodePng(
			buildPng({
				width: 3,
				height: 1,
				bitDepth: 4,
				colourType: 3,
				palette: [10, 20, 30, 40, 50, 60, 70, 80, 90],
				rows: [[0x01, 0x20]],
			}),
		);
		expect(decoded.hasAlpha).toBe(false);
		expect([...decoded.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
	});

	it('reads greyscale with alpha at 8 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 1,
				bitDepth: 8,
				colourType: 4,
				rows: [[10, 0, 200, 255]],
			}),
		);
		expect(decoded.hasAlpha).toBe(true);
		expect([...decoded.data]).toEqual([10, 10, 10, 0, 200, 200, 200, 255]);
	});

	it('reads greyscale with alpha at 16 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 1,
				height: 1,
				bitDepth: 16,
				colourType: 4,
				rows: [[0xff, 0xff, 0x80, 0x00]],
			}),
		);
		expect([...decoded.data]).toEqual([255, 255, 255, 128]);
	});

	it('reads truecolour with alpha at 8 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 1,
				bitDepth: 8,
				colourType: 6,
				rows: [[1, 2, 3, 4, 250, 251, 252, 253]],
			}),
		);
		expect([...decoded.data]).toEqual([1, 2, 3, 4, 250, 251, 252, 253]);
	});

	it('reads truecolour with alpha at 16 bits', async () => {
		const decoded = await decodePng(
			buildPng({
				width: 1,
				height: 1,
				bitDepth: 16,
				colourType: 6,
				rows: [[0xff, 0xff, 0x00, 0x00, 0x80, 0x00, 0x40, 0x00]],
			}),
		);
		expect([...decoded.data]).toEqual([255, 0, 128, 64]);
	});

	it('reads a cICP tag as Display P3 and anything else as sRGB', async () => {
		const plan = { width: 1, height: 1, bitDepth: 8, colourType: 0, rows: [[128]] } as const;
		expect((await decodePng(buildPng({ ...plan, colourTag: [12, 13, 0, 1] }))).colourSpace).toBe(
			'display-p3',
		);
		expect((await decodePng(buildPng({ ...plan, colourTag: [1, 13, 0, 1] }))).colourSpace).toBe(
			'srgb',
		);
	});

	it('reads a file sitting inside a larger buffer', async () => {
		// The decoder builds its DataView from the buffer, so a view with a
		// non-zero byte offset reads the padding as a signature unless the
		// offset is carried through.
		const file = buildPng({ width: 2, height: 1, bitDepth: 8, colourType: 0, rows: [[7, 9]] });
		const padded = new Uint8Array(file.length + 48);
		padded.set(file, 16);
		const decoded = await decodePng(padded.subarray(16, 16 + file.length));
		expect([...decoded.data]).toEqual([7, 7, 7, 255, 9, 9, 9, 255]);
	});

	it('applies all five scanline filters', async () => {
		// Every value below was worked out by hand from the filter definitions
		// in the specification, not captured from a run. Average and Paeth are
		// the two that go wrong quietly: both reduce to something plausible when
		// the neighbours above and to the left are confused with each other.
		const decoded = await decodePng(
			buildPng({
				width: 3,
				height: 5,
				bitDepth: 8,
				colourType: 0,
				filters: [0, 1, 2, 3, 4],
				rows: [
					[10, 20, 30],
					[5, 5, 5],
					[1, 2, 3],
					[0, 0, 0],
					[0, 0, 0],
				],
			}),
		);
		expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([
			10, 20, 30, 5, 10, 15, 6, 12, 18, 3, 7, 12, 3, 7, 12,
		]);
	});

	it('filters truecolour against the pixel to the left, not the byte', async () => {
		// The five filter test above is greyscale, where a pixel is one byte and
		// "the sample to the left" and "the byte to the left" are the same
		// thing. Every wrong stride passes it. Here they are three bytes apart,
		// so a reader looking back one byte returns [5,11,18] for the second
		// row instead of [5,6,7], and a round trip through an encoder making the
		// matching mistake still agrees with itself.
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 4,
				bitDepth: 8,
				colourType: 2,
				filters: [0, 1, 3, 4],
				rows: [
					[10, 20, 30, 40, 50, 60],
					[5, 6, 7, 8, 9, 10],
					[1, 2, 3, 4, 5, 6],
					[2, 2, 2, 2, 2, 2],
				],
			}),
		);
		expect([...decoded.data]).toEqual([
			10, 20, 30, 255, 40, 50, 60, 255, 5, 6, 7, 255, 13, 15, 17, 255, 3, 5, 6, 255, 12, 15, 17,
			255, 5, 7, 8, 255, 14, 17, 19, 255,
		]);
	});

	it('filters truecolour with alpha four bytes back', async () => {
		// The same again where the stride is four, so a reader that hard coded
		// three for RGB is caught as well as one that hard coded one.
		const decoded = await decodePng(
			buildPng({
				width: 2,
				height: 1,
				bitDepth: 8,
				colourType: 6,
				filters: [1],
				rows: [[1, 2, 3, 4, 10, 20, 30, 40]],
			}),
		);
		expect([...decoded.data]).toEqual([1, 2, 3, 4, 11, 22, 33, 44]);
	});

	it('joins image data split across several IDAT chunks', async () => {
		// A real encoder splits IDAT at some chunk size, so a decoder that only
		// reads the first one works on everything this package writes and fails
		// on most files it is handed.
		const whole = buildPng({
			width: 4,
			height: 2,
			bitDepth: 8,
			colourType: 0,
			rows: [
				[1, 2, 3, 4],
				[5, 6, 7, 8],
			],
		});
		const data = chunkNamed(whole, 'IDAT').data;
		const split = concat([
			// The signature and the IHDR, which is always the first chunk.
			whole.subarray(0, 8 + 25),
			pngChunk('IDAT', data.subarray(0, 3)),
			pngChunk('IDAT', data.subarray(3)),
			pngChunk('IEND', new Uint8Array(0)),
		]);
		expect([...(await decodePng(split)).data].filter((_, i) => i % 4 === 0)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		]);
	});

	it('stops at IEND rather than reading whatever follows it', async () => {
		// Files arrive with things appended: a second image, a signature block,
		// the tail of whatever the file used to be. IEND is the end of the PNG
		// and the rest is not a chunk, so a reader that keeps walking treats
		// four bytes of somebody else's data as a length.
		const whole = buildPng({ width: 2, height: 1, bitDepth: 8, colourType: 0, rows: [[7, 9]] });
		const withTail = concat([whole, ascii('and then something else entirely')]);
		expect([...(await decodePng(withTail)).data].filter((_, i) => i % 4 === 0)).toEqual([7, 9]);
	});

	it('ignores a chunk it has no use for', async () => {
		const whole = buildPng({ width: 1, height: 1, bitDepth: 8, colourType: 0, rows: [[42]] });
		const withText = concat([
			whole.subarray(0, 8 + 25),
			pngChunk('tEXt', ascii('Comment\0nothing to see')),
			whole.subarray(8 + 25),
		]);
		expect([...(await decodePng(withText)).data]).toEqual([42, 42, 42, 255]);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('the PNG decoder over damaged files', () => {
	async function expectRefusal(bytes: Uint8Array): Promise<DecodeFailedError> {
		let thrown: unknown;
		try {
			await decodePng(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('png');
		expect(error.decoderId).toBe('png-pure');
		expect(error.message.length).toBeGreaterThan(20);
		return error;
	}

	const valid = buildPng({
		width: 4,
		height: 2,
		bitDepth: 8,
		colourType: 2,
		rows: [
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			[13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
		],
	});

	it('refuses a file that does not start with the PNG signature', async () => {
		const bytes = Uint8Array.from(valid);
		bytes[1] = 0x51;
		expect((await expectRefusal(bytes)).message).toContain('signature');
	});

	it('refuses an empty file', async () => {
		expect((await expectRefusal(new Uint8Array(0))).message).toContain('signature');
	});

	it('refuses a file truncated part way through a chunk', async () => {
		expect((await expectRefusal(valid.subarray(0, valid.length - 20))).message).toContain(
			'past the end',
		);
	});

	it('refuses a chunk whose declared length runs past the end of the file', async () => {
		// Trusting the length would allocate or read from whatever follows the
		// buffer, which is the classic way a decoder becomes a security problem.
		const bytes = Uint8Array.from(valid);
		const view = new DataView(bytes.buffer);
		view.setUint32(8 + 25, 0x00ff_ffff);
		expect((await expectRefusal(bytes)).message).toContain('past the end');
	});

	it('refuses a file with no IHDR', async () => {
		// Without a header there are no dimensions, so a decoder that carries on
		// works from whatever its defaults happen to be rather than saying so.
		const bytes = buildPng({
			width: 1,
			height: 1,
			bitDepth: 8,
			colourType: 0,
			rows: [[1]],
			omitHeader: true,
		});
		expect((await expectRefusal(bytes)).message).toContain('header');
	});

	it('refuses a file that is the signature and nothing else', async () => {
		// Eight bytes is what a truncated download leaves. The chunk walk has
		// nothing to iterate, so this reaches the header check by a different
		// route than the file that has chunks but no IHDR among them.
		expect((await expectRefusal(Uint8Array.from(SIGNATURE))).message).toContain('header');
	});

	it('refuses a file with no image data', async () => {
		const bytes = buildPng({
			width: 1,
			height: 1,
			bitDepth: 8,
			colourType: 0,
			rows: [[1]],
			omitData: true,
		});
		expect((await expectRefusal(bytes)).message).toContain('image data');
	});

	it('refuses an interlaced PNG by name rather than scrambling it', async () => {
		// Adam7 lays the pixels out in seven passes. A decoder that reads them
		// as one raster produces an image that is recognisably the right colours
		// in the wrong places, which reads as a corrupt file rather than as a
		// feature this reader does not implement.
		const bytes = buildPng({
			width: 2,
			height: 1,
			bitDepth: 8,
			colourType: 0,
			rows: [[10, 20]],
			interlace: 1,
		});
		expect((await expectRefusal(bytes)).message).toContain('interlaced');
	});

	it('refuses a colour type that does not exist', async () => {
		for (const colourType of [1, 5, 7, 200]) {
			const bytes = buildPng({ width: 1, height: 1, bitDepth: 8, colourType, rows: [[1]] });
			expect((await expectRefusal(bytes)).message).toContain('colour type');
		}
	});

	it('refuses a palettised file carrying no palette', async () => {
		const bytes = buildPng({ width: 1, height: 1, bitDepth: 8, colourType: 3, rows: [[0]] });
		expect((await expectRefusal(bytes)).message).toContain('palette');
	});

	it('refuses a scanline filter type that does not exist', async () => {
		const bytes = buildPng({
			width: 2,
			height: 1,
			bitDepth: 8,
			colourType: 0,
			filters: [9],
			rows: [[1, 2]],
		});
		expect((await expectRefusal(bytes)).message).toContain('filter type 9');
	});

	it('refuses image data shorter than the header says it should be', async () => {
		// The header claims four rows and the stream holds one. Padding the rest
		// with zeroes would hand back an image three quarters black.
		const bytes = buildPng({
			width: 4,
			height: 4,
			bitDepth: 8,
			colourType: 0,
			rows: [[1, 2, 3, 4]],
		});
		expect((await expectRefusal(bytes)).message).toContain('shorter');
	});
});
