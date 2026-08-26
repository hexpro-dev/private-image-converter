/**
 * Header measurement, and the ceilings behind it.
 *
 * The thing under test is an ordering rather than a calculation: a size has to
 * be known before anything is allocated for it, not after. Four of these
 * formats put a decompressor between the header and the pixels, so a file of a
 * hundred bytes can honestly describe three hundred million of them, and every
 * check that runs after the decode is a check that runs after the allocation
 * it was supposed to prevent. The other two are here to prove the opposite
 * case, because a defence added where it is not needed is code that has to be
 * kept correct forever for nothing.
 *
 * Every fixture below is assembled from the format specification, byte by
 * byte, and none of it goes near this package's own encoders. That matters
 * more here than in an ordinary codec test: the whole point of a measurement
 * is that it agrees with what a stranger's file declares, and a fixture
 * produced by the encoder next door would only ever prove that this repository
 * agrees with itself. The CRC-32 and Adler-32 helpers are transcriptions of
 * the sample implementations in the PNG specification and RFC 1950
 * respectively, and the deflate streams are stored blocks written out by hand,
 * so nothing in `src/` chose any of these bytes.
 *
 * The sizes are chosen deliberately. Twenty thousand by fifteen thousand is
 * three hundred million pixels, which is over the eighty million default
 * budget in every case and over the reader's own ceiling in some of them, so
 * the class of the error says which defence ran: `ImageTooLargeError` is the
 * measurement, in front of the codec, and `DecodeFailedError` is the codec,
 * which means it was handed the bytes first.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { decodeDds } from '../../src/codecs/dds/decode.js';
import { decodeGif, decodeGifAnimation, measureGif } from '../../src/codecs/gif/decode.js';
import { decodeIcns } from '../../src/codecs/icns/decode.js';
import { decodePcx, measurePcx } from '../../src/codecs/pcx/decode.js';
import { decodePng, measurePng } from '../../src/codecs/png/decode.js';
import { decodePsd, measurePsd } from '../../src/codecs/psd/decode.js';
import { DEFAULT_MAX_PIXELS } from '../../src/convert.js';
import { installDefaultCodecs, resetDefaultCodecs } from '../../src/defaults.js';
import { emptyCapabilities } from '../../src/detect/capabilities.js';
import { DecodeFailedError, ImageTooLargeError } from '../../src/errors.js';
import { clearRegistry, decodersFor } from '../../src/registry.js';
import type { DecodeContext, FormatId, RasterImage } from '../../src/types.js';

/* ── Byte helpers ─────────────────────────────────────────────────────── */

function bytes(...parts: readonly (number | readonly number[] | Uint8Array)[]): Uint8Array {
	const flat: number[] = [];
	for (const part of parts) {
		if (typeof part === 'number') flat.push(part);
		else for (const byte of part) flat.push(byte);
	}
	return Uint8Array.from(flat);
}

function u16be(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function ascii(text: string): number[] {
	return [...text].map((character) => character.charCodeAt(0));
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32, transcribed from the sample implementation in the PNG specification. */
function crc32(data: readonly number[]): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32, transcribed from the definition in RFC 1950. */
function adler32(data: readonly number[]): number {
	let low = 1;
	let high = 0;
	for (const byte of data) {
		low = (low + byte) % 65521;
		high = (high + low) % 65521;
	}
	return ((high << 16) | low) >>> 0;
}

function pngChunk(type: string, body: readonly number[]): number[] {
	const payload = [...ascii(type), ...body];
	return [...u32be(body.length), ...payload, ...u32be(crc32(payload))];
}

/**
 * A zlib stream holding one stored deflate block.
 *
 * Stored rather than compressed on purpose: the bytes are then fixed by this
 * file rather than by whichever version of zlib the platform happens to carry,
 * and the reader is being handed a stream nothing in this repository produced.
 */
function zlibStored(raw: readonly number[]): number[] {
	const length = raw.length;
	return [
		0x78,
		0x01,
		0x01,
		...u16le(length),
		...u16le(~length & 0xffff),
		...raw,
		...u32be(adler32(raw)),
	];
}

function ihdr(width: number, height: number): number[] {
	// Eight bit truecolour, no interlace, which is the shape the scanlines below
	// are written for.
	return pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]);
}

/** A two by one truecolour PNG. One filter byte and two RGB triples. */
const SMALL_PNG_SCANLINES = [0x00, 0x0a, 0x14, 0x1e, 0x28, 0x32, 0x3c];

function png(width: number, height: number): Uint8Array {
	return bytes(
		PNG_SIGNATURE,
		ihdr(width, height),
		pngChunk('IDAT', zlibStored(SMALL_PNG_SCANLINES)),
		pngChunk('IEND', []),
	);
}

const SMALL_PNG = png(2, 1);
const HUGE_PNG = png(20_000, 15_000);

/* ── GIF ──────────────────────────────────────────────────────────────── */

/**
 * The LZW body of a one pixel frame, written out by hand.
 *
 * A minimum code size of two makes the clear code 4, the end code 5 and the
 * first code width three bits. The stream is clear, index 0, end: 100, 000,
 * 101 read least significant bit first, which packs to 0x44 0x01.
 */
const ONE_PIXEL_LZW = [0x02, 0x02, 0x44, 0x01, 0x00];

function gifHeader(width: number, height: number, globalTable: boolean): number[] {
	// The packed byte carries the global colour table flag in bit 7 and the
	// table size, as a power of two less one, in bits 0 to 2. Zero there means
	// two entries, which is the smallest table GIF can hold.
	return [...ascii('GIF89a'), ...u16le(width), ...u16le(height), globalTable ? 0x80 : 0x00, 0, 0];
}

const SMALL_GIF = bytes(
	gifHeader(1, 1, true),
	[0xff, 0x00, 0x00, 0x00, 0x00, 0xff],
	0x2c,
	u16le(0),
	u16le(0),
	u16le(1),
	u16le(1),
	0x00,
	ONE_PIXEL_LZW,
	0x3b,
);

/**
 * A screen descriptor claiming three hundred million pixels, and then nothing.
 *
 * Thirteen bytes and a trailer, and the missing image descriptor is deliberate
 * rather than lazy. The canvas is allocated from the screen descriptor at the
 * first image descriptor, before a single LZW code has been read, so adding
 * one here would make the fixture itself ask for one and a bit gigabytes on
 * every run where the measurement is not in front of it. That is the failure
 * being guarded against, not something a test should perform to prove it
 * exists.
 */
const HUGE_GIF = bytes(gifHeader(20_000, 15_000, false), 0x3b);

/* ── PSD ──────────────────────────────────────────────────────────────── */

interface PsdSpec {
	readonly width: number;
	readonly height: number;
	readonly version?: number;
	readonly channels?: number;
	readonly depth?: number;
	readonly mode?: number;
	/** The image data section's payload, after the two byte compression word. */
	readonly body?: readonly number[];
}

/**
 * A Photoshop file: the 26 byte header, three empty sections, then the picture.
 *
 * Height before width, which is the field order the format actually uses and
 * the one thing about this header that is easy to get wrong in a fixture as
 * well as in a reader.
 */
function psd(spec: PsdSpec): Uint8Array {
	const version = spec.version ?? 1;
	return bytes(
		ascii('8BPS'),
		u16be(version),
		[0, 0, 0, 0, 0, 0],
		u16be(spec.channels ?? 1),
		u32be(spec.height),
		u32be(spec.width),
		u16be(spec.depth ?? 8),
		u16be(spec.mode ?? 1),
		u32be(0),
		u32be(0),
		version === 2 ? [...u32be(0), ...u32be(0)] : u32be(0),
		u16be(0),
		spec.body ?? [],
	);
}

/** Two greyscale pixels, uncompressed. */
const SMALL_PSD = psd({ width: 2, height: 1, body: [0x10, 0xf0] });
const HUGE_PSD = psd({ width: 20_000, height: 15_000 });

/* ── PCX ──────────────────────────────────────────────────────────────── */

interface PcxSpec {
	readonly width: number;
	readonly height: number;
	readonly manufacturer?: number;
	readonly data?: readonly number[];
}

/**
 * A PCX: a fixed 128 byte header and then the rows.
 *
 * Version 3 at eight bits on one plane with the greyscale palette flag, so the
 * colours come from the ramp the reader falls back to and no trailing colour
 * table has to be written. The window is inclusive at both ends, so the far
 * corner is one less than the size.
 */
function pcx(spec: PcxSpec): Uint8Array {
	const header = new Uint8Array(128);
	header[0] = spec.manufacturer ?? 0x0a;
	header[1] = 3;
	header[2] = 0;
	header[3] = 8;
	header.set(u16le(0), 4);
	header.set(u16le(0), 6);
	header.set(u16le(spec.width - 1), 8);
	header.set(u16le(spec.height - 1), 10);
	header[65] = 1;
	header.set(u16le(spec.width), 66);
	header.set(u16le(2), 68);
	return bytes(header, spec.data ?? []);
}

const SMALL_PCX = pcx({ width: 2, height: 1, data: [10, 200] });
const HUGE_PCX = pcx({ width: 20_000, height: 15_000 });

/* ── DDS ──────────────────────────────────────────────────────────────── */

interface DdsSpec {
	readonly width: number;
	readonly height: number;
	readonly data?: readonly number[];
}

/**
 * A DirectDraw Surface holding an uncompressed A8R8G8B8 texture.
 *
 * Four bytes of signature, a 124 byte header with a 32 byte pixel format
 * nested at offset 76, and then the surface. The masks are Direct3D's
 * canonical 32 bit layout: blue lowest, then green, red, alpha.
 */
function dds(spec: DdsSpec): Uint8Array {
	const header = new Uint8Array(124);
	header.set(u32le(124), 0);
	// DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT.
	header.set(u32le(0x1007), 4);
	header.set(u32le(spec.height), 8);
	header.set(u32le(spec.width), 12);
	header.set(u32le(32), 72);
	// DDPF_ALPHAPIXELS | DDPF_RGB.
	header.set(u32le(0x41), 76);
	header.set(u32le(32), 84);
	header.set(u32le(0x00ff0000), 88);
	header.set(u32le(0x0000ff00), 92);
	header.set(u32le(0x000000ff), 96);
	header.set(u32le(0xff000000), 100);
	// DDSCAPS_TEXTURE.
	header.set(u32le(0x1000), 104);
	return bytes(ascii('DDS '), header, spec.data ?? []);
}

/** Two pixels, stored blue first as the masks say. */
const SMALL_DDS = dds({
	width: 2,
	height: 1,
	data: [0x1e, 0x14, 0x0a, 0xff, 0x3c, 0x32, 0x28, 0xff],
});

/* ── ICNS ─────────────────────────────────────────────────────────────── */

/** An icon suite holding one entry: a type, a length counting its own eight bytes, a payload. */
function icns(type: string, payload: Uint8Array): Uint8Array {
	const total = 8 + 8 + payload.length;
	return bytes(ascii('icns'), u32be(total), ascii(type), u32be(8 + payload.length), payload);
}

const SMALL_ICNS = icns('ic08', SMALL_PNG);
const HUGE_ICNS = icns('ic08', HUGE_PNG);

/* ── The ladder ───────────────────────────────────────────────────────── */

const CONTEXT: DecodeContext = {
	capabilities: emptyCapabilities({ compressionStream: true }),
	maxPixels: DEFAULT_MAX_PIXELS,
};

beforeAll(() => {
	clearRegistry();
	resetDefaultCodecs();
	installDefaultCodecs();
});

/** The pure decoder the package registers for a format, which is the one under test. */
async function pureDecoderFor(format: FormatId) {
	const decoders = await decodersFor(format, CONTEXT.capabilities);
	const decoder = decoders.find((candidate) => candidate.path === 'pure');
	if (!decoder) throw new Error(`no pure decoder is registered for ${format}`);
	return decoder;
}

/* ── Tests ────────────────────────────────────────────────────────────── */

interface Measured {
	readonly format: FormatId;
	readonly measure: (
		input: Uint8Array,
	) => { readonly width: number; readonly height: number } | undefined;
	readonly huge: Uint8Array;
	readonly small: Uint8Array;
	readonly smallSize: readonly [number, number];
}

/**
 * The four formats where a header can outrun its own file.
 *
 * PNG and PSD sit behind a deflate stream, GIF behind LZW and PCX behind a run
 * length coder. None of them can be caught by comparing the declared size
 * against what is left of the file, which is what the Netpbm and QOI readers
 * do and why neither of those is in this list.
 */
const MEASURED: readonly Measured[] = [
	{
		format: 'png',
		measure: measurePng,
		huge: HUGE_PNG,
		small: SMALL_PNG,
		smallSize: [2, 1],
	},
	{
		format: 'gif',
		measure: measureGif,
		huge: HUGE_GIF,
		small: SMALL_GIF,
		smallSize: [1, 1],
	},
	{
		format: 'psd',
		measure: measurePsd,
		huge: HUGE_PSD,
		small: SMALL_PSD,
		smallSize: [2, 1],
	},
	{
		format: 'pcx',
		measure: measurePcx,
		huge: HUGE_PCX,
		small: SMALL_PCX,
		smallSize: [2, 1],
	},
];

describe('measuring a header before decoding it', () => {
	it.each(MEASURED)('$format reports the size its header declares', ({ measure, huge }) => {
		expect(measure(huge)).toEqual({ width: 20_000, height: 15_000 });
	});

	it.each(MEASURED)(
		'$format measures a real file as the size it decodes to',
		({ measure, small, smallSize }) => {
			expect(measure(small)).toEqual({ width: smallSize[0], height: smallSize[1] });
		},
	);

	it.each(MEASURED)(
		'$format says nothing about a buffer too short to hold a header',
		({ measure, small }) => {
			expect(measure(small.subarray(0, 4))).toBeUndefined();
			expect(measure(new Uint8Array(0))).toBeUndefined();
		},
	);

	it.each(MEASURED)('$format says nothing about a file of another format', ({ measure, small }) => {
		// Long enough to reach every field, and wrong in the signature, which is
		// the only thing that should decide it.
		const rubbish = new Uint8Array(small.length).fill(0x5a);
		expect(measure(rubbish)).toBeUndefined();
	});

	/**
	 * A measurement that refused would be worse than none at all.
	 *
	 * The guard above the codecs only ever compares this number against a
	 * budget, so a reader that reported nothing would lose the defence quietly
	 * and one that reported something too large would refuse files that work.
	 * Both failures look the same from outside, which is why the small fixtures
	 * are decoded here as well as measured.
	 */
	it.each(MEASURED)(
		'$format still decodes an ordinary small file',
		async ({ format, small, smallSize }) => {
			const decoder = await pureDecoderFor(format);
			const { image } = await decoder.decode(small, CONTEXT);
			expect([image.width, image.height]).toEqual([smallSize[0], smallSize[1]]);
		},
	);
});

describe('refusing an oversized header before anything allocates', () => {
	/**
	 * The measurement has to win the race against the decode.
	 *
	 * Both defences would refuse these files: the codec's own ceiling is the
	 * same eighty million the caller is carrying, so the header is over both.
	 * The class of the error is what says which one ran. `ImageTooLargeError`
	 * is the guard above the codec, which never called it; `DecodeFailedError`
	 * is the codec, which means the bytes were handed over first and the whole
	 * exercise achieved nothing.
	 */
	it.each(MEASURED)(
		'$format is refused by the caller budget, not by the decode',
		async ({ format, huge }) => {
			const decoder = await pureDecoderFor(format);
			expect(
				decoder.measure,
				`the ${format} decoder was registered without its measure function, so nothing reads the header before the decode. Pass measure${format[0]?.toUpperCase()}${format.slice(1)} at the registration in src/defaults.ts.`,
			).toBeTypeOf('function');
			await expect(decoder.decode(huge, CONTEXT)).rejects.toBeInstanceOf(ImageTooLargeError);
		},
	);

	/**
	 * Fast, because the alternative is a gigabyte of allocation.
	 *
	 * Timing is a blunt instrument and it is used bluntly: a second is orders
	 * of magnitude longer than reading twenty six bytes and orders of magnitude
	 * shorter than filling one and a bit gigabytes, so nothing between the two
	 * readings can make this flap. What it catches is the regression where the
	 * measurement is dropped and the decode is reached, which is slow whether
	 * or not it eventually refuses.
	 */
	it.each(MEASURED)('$format refuses without doing the work', async ({ format, huge }) => {
		const decoder = await pureDecoderFor(format);
		const started = performance.now();
		await expect(decoder.decode(huge, CONTEXT)).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(1000);
	});

	/**
	 * The reported size is the file's claim, not the budget it broke.
	 *
	 * Somebody holding a photo editor's export needs to be told how big their
	 * picture is before they can decide what to do about it, and a message that
	 * only repeated the limit would tell them nothing they did not set.
	 */
	it('carries the declared size, not the budget it broke', async () => {
		const decoder = await pureDecoderFor('png');
		const error = await decoder.decode(HUGE_PNG, CONTEXT).catch((refusal: unknown) => refusal);
		expect(error).toBeInstanceOf(ImageTooLargeError);
		expect((error as ImageTooLargeError).pixels).toBe(300_000_000);
		expect((error as ImageTooLargeError).maxPixels).toBe(DEFAULT_MAX_PIXELS);
	});
});

describe('the private ceiling each reader carries on its own', () => {
	/**
	 * A codec called directly still refuses, and at the same number.
	 *
	 * `measure` defends a caller that has a budget. Nothing in this package
	 * stops somebody importing `decodePng` on its own, and the ceiling in each
	 * reader is what answers for that. It used to be four hundred million
	 * against a default budget of eighty, which is a range where a file was
	 * accepted by one defence and refused by the other for no stated reason.
	 */
	it('refuses an oversized PNG called directly', async () => {
		await expect(decodePng(HUGE_PNG)).rejects.toBeInstanceOf(DecodeFailedError);
		await expect(decodePng(HUGE_PNG)).rejects.toThrow(/more pixels than this reader/);
	});

	it('refuses an oversized PCX called directly', () => {
		expect(() => decodePcx(HUGE_PCX)).toThrow(/far larger than anything/);
	});

	/**
	 * PSD is the one whose ceiling did not move, and this records what that
	 * leaves behind.
	 *
	 * Three hundred million pixels is under this reader's own ceiling, so
	 * nothing in its header check has an opinion about the size at all. What
	 * refuses this file is the image data section running out, which happens to
	 * be enough here because the fixture carries no pixels. A file that carried
	 * a few hundred kilobytes of ZIP would reach the raster instead, and
	 * `measurePsd` is the only thing standing in front of that. If this ever
	 * starts refusing on size, the ceiling has come down and this test should
	 * say so rather than be edited to match.
	 */
	it('does not refuse an oversized PSD on size alone', async () => {
		await expect(decodePsd(HUGE_PSD)).rejects.toThrow(
			/ends before the end of its uncompressed image data/,
		);
		expect(measurePsd(HUGE_PSD)).toEqual({ width: 20_000, height: 15_000 });
	});

	/**
	 * A hundred and twenty million pixels is over the budget and under the old
	 * ceiling, which is exactly the range the lowering closed. Twelve thousand
	 * by ten thousand is a legal PCX window and a legal PNG header, so nothing
	 * else in either reader has an opinion about it.
	 */
	it.each([
		['png', () => decodePng(png(12_000, 10_000))],
		['pcx', () => decodePcx(pcx({ width: 12_000, height: 10_000 }))],
	] as const)('%s refuses a header between the old ceiling and the budget', async (_name, run) => {
		await expect(async () => run()).rejects.toThrow(/allocate for/);
	});

	/**
	 * The GIF animation budget, which came down where the still ceiling could
	 * not.
	 *
	 * A screen of just over forty million pixels leaves room for exactly one
	 * frame inside eighty million, and for nine inside the four hundred million
	 * this reader used to allow. So a two frame file of this size is the
	 * smallest thing that tells the two settings apart, and it is refused after
	 * one frame rather than after nine: four hundred megabytes of raster
	 * instead of three and a half gigabytes.
	 *
	 * The fixture is deliberately at the cheap end of that trade. Both frames
	 * are a single pixel, so nothing here decompresses anything worth
	 * mentioning, and the cost is the canvas and the one snapshot taken before
	 * the refusal.
	 */
	it('refuses a second frame the animation budget has no room for', () => {
		const screen = { width: 8000, height: 5001 };
		const frame = bytes(0x2c, u16le(0), u16le(0), u16le(1), u16le(1), 0x00, ONE_PIXEL_LZW);
		const file = bytes(
			gifHeader(screen.width, screen.height, true),
			[0xff, 0x00, 0x00, 0x00, 0x00, 0xff],
			frame,
			frame,
			0x3b,
		);
		expect(() => decodeGifAnimation(file)).toThrow(/more than the 1 frames/);
	});

	it('refuses an oversized GIF called directly, still and animated', () => {
		// The still ceiling is the one number in this file that has not moved.
		// A GIF screen is two sixteen bit fields, so the most one can claim is
		// four thousand million pixels, and the ceiling is what stops the
		// canvas being asked for at all.
		const enormous = bytes(gifHeader(65_535, 65_535, false), 0x3b);
		expect(() => decodeGif(enormous)).toThrow(/far larger than anything/);
		expect(() => decodeGifAnimation(enormous)).toThrow(/far larger than anything/);
	});
});

/**
 * The two formats that need no measurement, and why.
 *
 * Recorded as tests rather than only as comments, because the reason each of
 * them is safe is a property of the reader that a later change could remove
 * without anybody noticing. If either of these starts failing, that format
 * needs a `measure` of its own.
 */
describe('formats whose own structure already bounds them', () => {
	it('proves a DDS is at least as long as the surface it declares', () => {
		// Sixty four million pixels is under every ceiling here, so nothing
		// refuses this on size. What refuses it is the length proof, which runs
		// before the raster is allocated: an uncompressed 32 bit surface that
		// size is 256 megabytes, and this file carries none of it. Every layout
		// this reader implements costs at least half a byte a pixel, so a DDS
		// cannot declare an image its own length does not back up.
		expect(() => decodeDds(dds({ width: 8000, height: 8000 }))).toThrow(
			/ends before the end of its first surface/,
		);
	});

	it('still decodes an ordinary small DDS', () => {
		const image = decodeDds(SMALL_DDS);
		expect([image.width, image.height]).toEqual([2, 1]);
		expect(pixelsOf(image)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
	});

	it('bounds an icon suite by the largest side an icon may claim', async () => {
		// The only payload inside an ICNS that carries its own dimensions is a
		// PNG, and this refuses one over 4096 a side before handing it to the
		// PNG reader. Sixteen million pixels is the most an icon suite can ever
		// ask for, which is a fifth of the default budget, so there is nothing
		// left for a measurement to defend.
		await expect(decodeIcns(HUGE_ICNS)).rejects.toThrow(/far larger than any icon/);
	});

	it('still decodes an ordinary small icon suite', async () => {
		const image = await decodeIcns(SMALL_ICNS);
		expect([image.width, image.height]).toEqual([2, 1]);
	});
});

/* ── The edges of each measurement ────────────────────────────────────── */

describe('what a measurement declines to answer', () => {
	it('reads a PNG size only from a well formed IHDR chunk header', () => {
		// The right signature with the wrong chunk in front of the numbers. The
		// two dimensions would still be at offsets 16 and 20, and reading them
		// anyway would report a size for a file whose real header is somewhere
		// else entirely.
		const wrongChunk = bytes(
			PNG_SIGNATURE,
			pngChunk('IDAT', [...u32be(64), ...u32be(64), 8, 2, 0, 0, 0]),
		);
		expect(measurePng(wrongChunk)).toBeUndefined();

		const wrongLength = bytes(PNG_SIGNATURE, u32be(12), ascii('IHDR'), new Uint8Array(12));
		expect(measurePng(wrongLength)).toBeUndefined();
	});

	it('reads a PNG size unsigned', () => {
		// A width of 0x80000000 read through a signed shift comes out negative,
		// and a negative multiplied by a height is under every ceiling it is
		// compared against.
		expect(measurePng(png(0x80000000, 1))).toEqual({ width: 0x80000000, height: 1 });
	});

	it('says nothing about a PNG declaring a zero side', () => {
		expect(measurePng(png(0, 4))).toBeUndefined();
		expect(measurePng(png(4, 0))).toBeUndefined();
	});

	it('says nothing about a GIF declaring a zero side', () => {
		expect(measureGif(bytes(gifHeader(0, 4, false), 0x3b))).toBeUndefined();
		expect(measureGif(bytes(gifHeader(4, 0, false), 0x3b))).toBeUndefined();
	});

	it('measures a GIF written to the older signature', () => {
		const older = bytes(ascii('GIF87a'), u16le(9), u16le(7), 0x00, 0, 0, 0x3b);
		expect(measureGif(older)).toEqual({ width: 9, height: 7 });
	});

	it('measures a PSB, which puts its dimensions where a PSD does', () => {
		expect(measurePsd(psd({ version: 2, width: 40, height: 30 }))).toEqual({
			width: 40,
			height: 30,
		});
	});

	it('says nothing about a version no Photoshop file carries', () => {
		expect(measurePsd(psd({ version: 3, width: 40, height: 30 }))).toBeUndefined();
	});

	it('says nothing about a PSD declaring a zero side', () => {
		expect(measurePsd(psd({ width: 0, height: 4 }))).toBeUndefined();
		expect(measurePsd(psd({ width: 4, height: 0 }))).toBeUndefined();
	});

	it('reads a PSD size unsigned, and height first', () => {
		// The two fields are four bytes each and adjacent, so reading them the
		// usual way round gives a plausible transposed answer rather than an
		// error. A rectangle is the only fixture that can tell the two apart.
		expect(measurePsd(psd({ width: 300, height: 7 }))).toEqual({ width: 300, height: 7 });
		expect(measurePsd(psd({ width: 0x80000000, height: 1 }))).toEqual({
			width: 0x80000000,
			height: 1,
		});
	});

	it('says nothing about a PCX whose window is inside out', () => {
		const backwards = pcx({ width: 4, height: 4 });
		backwards.set(u16le(9), 4);
		expect(measurePcx(backwards)).toBeUndefined();

		const upsideDown = pcx({ width: 4, height: 4 });
		upsideDown.set(u16le(9), 6);
		expect(measurePcx(upsideDown)).toBeUndefined();
	});

	it('says nothing about a file that is not ZSoft', () => {
		expect(measurePcx(pcx({ width: 4, height: 4, manufacturer: 0x0b }))).toBeUndefined();
	});

	it('adds the one back on for the inclusive PCX window', () => {
		// The window is a pair of corners, both included, so a four pixel wide
		// image runs from 0 to 3. Dropping the plus one loses the last column
		// and the last row, which is invisible on a photograph.
		expect(measurePcx(pcx({ width: 4, height: 9 }))).toEqual({ width: 4, height: 9 });
	});
});
