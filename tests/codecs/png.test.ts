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
 *
 * `PINNED` is the other kind of check, and it answers a different question.
 * Everything else here asks whether the file is correct; `PINNED` asks whether
 * it is the same file. The digests were taken before the filter pass was
 * rewritten to score five candidates in one go and before the image data
 * started reaching the compressor a batch at a time, and neither change is
 * allowed to move a byte. A faster encoder that quietly picks a different
 * filter on ties, or drops a row on a batch boundary, passes every other test
 * in this file.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adler32, crc32 } from '../../src/codecs/png/crc.js';
import { decodePng } from '../../src/codecs/png/decode.js';
import { deflate, inflate } from '../../src/codecs/png/deflate.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import { DecodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { EncodeOptions, RasterImage } from '../../src/types.js';

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

/** A smooth ramp in all three channels, which is what a photograph looks like to a filter. */
function gradient(width: number, height: number): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			image.data[at] = (x * 255) / width;
			image.data[at + 1] = (y * 255) / height;
			image.data[at + 2] = ((x + y) * 255) / (width + height);
			image.data[at + 3] = 255;
		}
	}
	return image;
}

/** Two colours, every other pixel, which no filter predicts and every filter scores close on. */
function alternating(width: number, height: number): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	for (let i = 0; i < width * height; i += 1) {
		const at = i * 4;
		const on = i % 2 === 0;
		image.data[at] = on ? 250 : 5;
		image.data[at + 1] = on ? 10 : 200;
		image.data[at + 2] = on ? 128 : 129;
		image.data[at + 3] = 255;
	}
	return image;
}

/** Few enough colours that the encoder writes a palette without being asked. */
function fewColours(width: number, height: number, hasAlpha: boolean): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	const table = [
		[255, 0, 0, 255],
		[0, 255, 0, 255],
		[0, 0, 255, 255],
		[9, 9, 9, hasAlpha ? 0 : 255],
	];
	for (let i = 0; i < width * height; i += 1) {
		image.data.set(table[(i * 7 + Math.floor(i / width)) % table.length] as number[], i * 4);
	}
	return image;
}

/**
 * A profile, so an image small enough to fit a palette is written truecolour.
 *
 * `paletteFor` leaves a wide gamut picture with a profile attached alone,
 * which is the only lever here that does not also change the pixels. Without
 * it a five row grey image comes back as an indexed file with no filtering in
 * it at all, and a test about filters has nothing to look at.
 */
const KEEP_TRUECOLOUR: EncodeOptions = { iccProfile: Uint8Array.from([0, 1, 2, 3]) };

/**
 * Five grey scanlines, one per filter, worked out from the definitions.
 *
 * Every pixel is grey, so each of the three bytes of a pixel carries the row's
 * value and the arithmetic below is per value rather than per byte. Bytes
 * before the start of a row count as zero, and so does the row above the top.
 *
 * Row 0, all zeroes: every filter scores 0. A five way tie, which must go to
 * None.
 * Row 1, all 200 over a row of zeroes: Sub leaves 200 in the leading pixel and
 * 0 after it, and Paeth leaves exactly the same, because with `left` and
 * `up-left` both zero the Paeth predictor is whatever is above. A two way tie
 * at 168, which must go to Sub.
 * Row 2, all 200 over all 200: Up leaves nothing at all.
 * Row 3, 200 201 202 203 over all 200: Paeth predicts the pixel to the left
 * once the row above is flat, so it leaves 1 per pixel against Up's 0 1 2 3.
 * Row 4, each value the average of its left neighbour and the one above:
 * Average leaves nothing, and it is the only filter that does.
 */
function filterLadder(): RasterImage {
	const image = createRaster(4, 5, 'display-p3', false);
	const rows = [
		[0, 0, 0, 0],
		[200, 200, 200, 200],
		[200, 200, 200, 200],
		[200, 201, 202, 203],
		[100, 150, 176, 189],
	];
	rows.forEach((row, y) => {
		row.forEach((value, x) => {
			const at = (y * 4 + x) * 4;
			image.data[at] = value;
			image.data[at + 1] = value;
			image.data[at + 2] = value;
			image.data[at + 3] = 255;
		});
	});
	return image;
}

/** Every IDAT in the file, joined, which is the stream the filters wrote. */
function idatOf(bytes: Uint8Array): Uint8Array {
	const parts = readChunks(bytes)
		.filter((chunk) => chunk.type === 'IDAT')
		.map((chunk) => chunk.data);
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

/**
 * Half a SHA-256, which is 128 bits and far past the point where two different
 * scanline streams could land on the same value by accident.
 */
function digestOf(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
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

	it('picks each of the five filters, and breaks a tie towards the lower one', async () => {
		// The ties are the point. Two of these five rows are decided by the
		// rule rather than by the scores, and a scoring loop that compares with
		// `<=` somewhere gets a file that is exactly the same size and a
		// different sequence of bytes, which nothing else here would notice.
		const bytes = await encodePng(filterLadder(), KEEP_TRUECOLOUR);
		const raw = await inflate(chunkNamed(bytes, 'IDAT').data);
		const stride = 4 * 3;
		const filters: number[] = [];
		const rows: number[][] = [];
		for (let y = 0; y < 5; y += 1) {
			const start = y * (stride + 1);
			filters.push(raw[start] as number);
			rows.push([...raw.subarray(start + 1, start + 1 + stride)]);
		}

		// None, Sub, Up, Paeth, Average.
		expect(filters).toEqual([0, 1, 2, 4, 3]);
		// The residue each of them leaves, which is what says the winning
		// filter was applied and not merely named in the leading byte.
		expect(rows[0], 'None over a row of zeroes').toEqual(new Array<number>(stride).fill(0));
		expect(rows[1], 'Sub, which only pays for the leading pixel').toEqual([
			200, 200, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		]);
		expect(rows[2], 'Up over an identical row').toEqual(new Array<number>(stride).fill(0));
		expect(rows[3], 'Paeth over a flat row above').toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(rows[4], 'Average, predicting each value exactly').toEqual(
			new Array<number>(stride).fill(0),
		);
	});
});

/* ── Byte for byte ────────────────────────────────────────────────────── */

/**
 * What this encoder writes, recorded before it was made faster.
 *
 * The digest is over the inflated image data rather than over the file,
 * because the file also carries whatever the platform's zlib decided, and that
 * is not this package's output to pin. The scanline stream underneath it is
 * entirely ours: the filter chosen for every row and the bytes that filter
 * left. `rawLength` sits beside it so a stream that changed length reads as a
 * stride bug rather than as an opaque digest mismatch.
 *
 * The list covers the shapes where the two rewrites could go wrong: one pixel,
 * a row with no row above it, a column that is nothing but leading pixels, an
 * image tall enough to cross several compressor batches in both the filtered
 * and the unfiltered path, and the palette decision, which reads compressed
 * lengths and so has to still pick the same file.
 */
const PINNED: readonly {
	readonly name: string;
	readonly build: () => RasterImage;
	readonly options: EncodeOptions;
	readonly chunks: readonly string[];
	readonly rawLength: number;
	readonly digest: string;
}[] = [
	{
		name: 'a single opaque pixel',
		build: () => noise(1, 1, false),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 4,
		digest: 'c9b0339b3c56913c5d75bcc4fe09e821',
	},
	{
		name: 'a single pixel carrying alpha',
		build: () => noise(1, 1, true),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 5,
		digest: '13ba2a85e0805c92c90b6aa8a669be89',
	},
	{
		name: 'one very wide row',
		build: () => noise(517, 1, false),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 1552,
		digest: '38456f0a8fede75375a524d1b098f032',
	},
	{
		name: 'one very tall column',
		build: () => noise(1, 517, true),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 2585,
		digest: '3ecb8c5f3a3d72780dba775b086a41c3',
	},
	{
		name: 'RGB noise at 37 by 23',
		build: () => noise(37, 23, false),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 2576,
		digest: '23d498dc0b9bbba666121fd28d386567',
	},
	{
		name: 'RGBA noise at 37 by 23',
		build: () => noise(37, 23, true),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 3427,
		digest: 'a34dd19789a92c7d7b232e28f0ea4780',
	},
	{
		name: 'a smooth gradient',
		build: () => gradient(64, 64),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 12352,
		digest: '461b995ca186c0d6cf83533a373eca69',
	},
	{
		name: 'a row of alternating colours',
		build: () => alternating(63, 9),
		options: {},
		chunks: ['IHDR', 'PLTE', 'IDAT', 'IEND'],
		rawLength: 81,
		digest: '108517096e4648500c3427b9a685c5b8',
	},
	{
		name: 'a picture with four colours in it',
		build: () => fewColours(40, 40, false),
		options: {},
		chunks: ['IHDR', 'PLTE', 'IDAT', 'IEND'],
		rawLength: 440,
		digest: '82ffee1b45ad5dfe9b29e4dbd9327d05',
	},
	{
		name: 'four colours, one of them clear',
		build: () => fewColours(40, 40, true),
		options: {},
		chunks: ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'],
		rawLength: 440,
		digest: '09a99c4e8734db220f630722d0ebbb54',
	},
	{
		name: 'a quantised palette',
		build: () => noise(33, 17, false),
		options: { palette: 16 },
		chunks: ['IHDR', 'PLTE', 'IDAT', 'IEND'],
		rawLength: 306,
		digest: 'd337108d9f3650227fd96aadf5b37b8f',
	},
	{
		name: 'a photograph sized gradient',
		build: () => gradient(300, 200),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 180200,
		digest: 'da447dcc9b8c1b5f140576e121186ba6',
	},
	{
		name: 'enough filtered rows to cross several batches',
		build: () => noise(40, 400, true),
		options: {},
		chunks: ['IHDR', 'IDAT', 'IEND'],
		rawLength: 64400,
		digest: '2df676504702f0d514f4e065daf79085',
	},
	{
		name: 'enough unfiltered rows to cross several batches',
		build: () => noise(20, 300, false),
		options: { palette: 8 },
		chunks: ['IHDR', 'PLTE', 'IDAT', 'IEND'],
		rawLength: 3300,
		digest: 'a61e083e852058896bf522b8e7dee09e',
	},
	{
		name: 'a profile in front of the data',
		build: () => noise(8, 8, false),
		options: { iccProfile: Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xff) },
		chunks: ['IHDR', 'iCCP', 'IDAT', 'IEND'],
		rawLength: 200,
		digest: '060fc2f2fcb735d7f8630bbb892eca6d',
	},
];

describe('the PNG the encoder has always written', () => {
	for (const pin of PINNED) {
		it(`writes the same scanlines for ${pin.name}`, async () => {
			const bytes = await encodePng(pin.build(), pin.options);
			expect(readChunks(bytes).map((chunk) => chunk.type)).toEqual([...pin.chunks]);
			const raw = await inflate(idatOf(bytes));
			expect(raw.length, 'the length of the filtered stream').toBe(pin.rawLength);
			expect(digestOf(raw)).toBe(pin.digest);
		});
	}
});

/* ── EXIF ─────────────────────────────────────────────────────────────── */

describe('the PNG eXIf chunk', () => {
	/**
	 * A real EXIF payload, from its TIFF header onwards.
	 *
	 * `II` for little endian, 42 as the answer the format checks itself with,
	 * then the offset of the first IFD. That IFD holds one entry, Orientation
	 * (tag 0x0112) as a SHORT of value 1, and then a next-IFD offset of zero.
	 * Written out here rather than taken from `src/metadata/`, so a reader that
	 * changed what it produces cannot change what this expects.
	 */
	const EXIF = Uint8Array.from([
		0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	]);

	it('carries the payload byte for byte', async () => {
		const bytes = await encodePng(noise(6, 4, false), { exif: EXIF });
		expect([...chunkNamed(bytes, 'eXIf').data]).toEqual([...EXIF]);
	});

	it('starts the payload at the TIFF header, with no Exif prefix in front of it', async () => {
		// `Exif\0\0` belongs to JPEG's APP1 segment. A reader handed it here
		// takes `Ex` for the byte order mark, finds it is neither `II` nor
		// `MM`, and drops the whole chunk.
		const { data } = chunkNamed(await encodePng(noise(6, 4, false), { exif: EXIF }), 'eXIf');
		expect([...data.subarray(0, 2)]).toEqual([0x49, 0x49]);
		expect(String.fromCharCode(...data.subarray(0, 4))).not.toBe('Exif');
	});

	it('spells the type with the case each bit of the name stands for', async () => {
		// Bit 5 of each letter is a flag, and lowercase means it is set:
		// ancillary, public, the reserved bit clear, and safe to copy.
		const { type } = chunkNamed(await encodePng(noise(4, 4, false), { exif: EXIF }), 'eXIf');
		expect([...type].map((letter) => (letter.charCodeAt(0) >> 5) & 1)).toEqual([1, 0, 0, 1]);
	});

	it('places it after the header and before the image data', async () => {
		// The specification allows it anywhere between IHDR and IEND except
		// between IDAT chunks, and asks for it before the first one.
		const bytes = await encodePng(noise(6, 4, false), { exif: EXIF });
		expect(readChunks(bytes).map((chunk) => chunk.type)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND']);
	});

	it('places it in front of the palette in an indexed file', async () => {
		const bytes = await encodePng(fewColours(40, 40, false), { exif: EXIF });
		expect(readChunks(bytes).map((chunk) => chunk.type)).toEqual([
			'IHDR',
			'eXIf',
			'PLTE',
			'IDAT',
			'IEND',
		]);
	});

	it('sits beside a profile rather than replacing it', async () => {
		const bytes = await encodePng(noise(6, 4, false), {
			exif: EXIF,
			iccProfile: Uint8Array.from({ length: 64 }, (_, i) => i),
		});
		expect(readChunks(bytes).map((chunk) => chunk.type)).toEqual([
			'IHDR',
			'iCCP',
			'eXIf',
			'IDAT',
			'IEND',
		]);
	});

	it('gives it a CRC that validates when recomputed', async () => {
		const chunk = chunkNamed(await encodePng(noise(6, 4, false), { exif: EXIF }), 'eXIf');
		expect(chunk.recomputed).toBe(chunk.crc);
	});

	it('writes no chunk at all when the caller supplied no payload', async () => {
		expect(hasChunk(await encodePng(noise(6, 4, false)), 'eXIf')).toBe(false);
	});

	it('writes no chunk for an empty payload, rather than an empty one', async () => {
		// An ancillary chunk with nothing in it is something every reader has
		// to step over and none of them can use.
		const bytes = await encodePng(noise(6, 4, false), { exif: new Uint8Array(0) });
		expect(hasChunk(bytes, 'eXIf')).toBe(false);
	});

	it('leaves the pixels alone', async () => {
		const image = noise(9, 7, true);
		expectSamePixels(await decodePng(await encodePng(image, { exif: EXIF })), image);
	});

	it('does not change the image data it was written beside', async () => {
		// The chunk goes in front of IDAT, so a mistake in its length field
		// would move the data rather than corrupt it, and a decoder that
		// happened to resynchronise would hide that.
		const plain = await encodePng(noise(37, 23, false));
		const tagged = await encodePng(noise(37, 23, false), { exif: EXIF });
		expect([...idatOf(tagged)]).toEqual([...idatOf(plain)]);
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
