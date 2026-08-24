/**
 * The conversion pipeline, end to end.
 *
 * Most of this runs on fake codecs. What the dispatcher does is choose a rung
 * of the ladder, correct the raster and report what it did, and every one of
 * those decisions is invisible when a real codec is doing the work: a wrong
 * colour conversion still produces a picture, a report naming the wrong
 * decoder still converts, and a profile dropped on the way to the encoder only
 * shows up on somebody else's screen. Fakes make the decisions themselves the
 * thing under test, and they also mean this suite needs no browser.
 *
 * The last block does the opposite, on the codecs the package ships. A suite
 * where both sides of every comparison come from `src/` can only prove the
 * code agrees with itself, so the source there is a QOI file written by hand
 * from that format's specification, and the PNG that comes out is checked
 * against the PNG specification and inflated with Node's own zlib. The
 * numbers the colour tests assert are worked out from the published
 * chromaticities of the two colour spaces, not read off this package's
 * matrix.
 */

import { inflateSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PIXELS, convert } from '../src/convert.js';
import { installDefaultCodecs, resetDefaultCodecs } from '../src/defaults.js';
import { emptyCapabilities } from '../src/detect/capabilities.js';
import {
	DecodeFailedError,
	EncodeFailedError,
	ImageTooLargeError,
	UnknownFormatError,
	isConverterError,
} from '../src/errors.js';
import { clearRegistry, registerDecoder, registerEncoder } from '../src/registry.js';
import { createRaster } from '../src/raster/image.js';
import { buildHeif } from './helpers/heif.js';
import type { ConverterError } from '../src/errors.js';
import type {
	Capabilities,
	ColourSpace,
	ConvertOptions,
	DecodeContext,
	DecodePath,
	Decoder,
	EncodeContext,
	EncodeOptions,
	EncodePath,
	Encoder,
	FormatId,
	Orientation,
	RasterImage,
} from '../src/types.js';

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/** Nothing is available here, so a registered fake is the only thing that can run. */
const CAPABILITIES = emptyCapabilities();

const UPRIGHT: Orientation = { rotation: 0, mirror: 'none', source: 'none' };

/**
 * A saturated red, deliberately close to the edge of Display P3.
 *
 * A colour near the edge of the wider space moves a long way when it is
 * converted to sRGB, so a conversion that was skipped and replaced with a
 * relabel shows up in the bytes rather than only in the label.
 */
const RED = [220, 40, 40, 255] as const;

/**
 * `RED` after a Display P3 to sRGB conversion, computed outside this package.
 *
 * Derived from the published chromaticities rather than from anything in
 * `src/`: Display P3's primaries from SMPTE EG 432-1, sRGB's from ITU-R
 * BT.709, both on the D65 white point the two spaces share, linearised and
 * re-encoded with the transfer function of IEC 61966-2-1. Green lands below
 * zero and clamps, because this red sits outside the sRGB gamut, which is the
 * point of choosing it.
 *
 * Asserting the exact triple rather than "the red went up" is what makes this
 * a check on the conversion instead of a check on its direction: a matrix
 * scaled wrong, or one built on the wrong white point, still moves red the
 * right way.
 */
const RED_IN_SRGB = [240, 0, 21] as const;

/** Stands in for a source ICC profile. Never parsed, only carried. */
const SOURCE_PROFILE = Uint8Array.from([1, 2, 3, 4]);

/** Stands in for a profile the caller supplied rather than the file. */
const CALLER_PROFILE = Uint8Array.from([9, 9, 9, 9]);

/**
 * A minimal EXIF payload, big endian, starting at the TIFF header.
 *
 * Two entries: an orientation of 6, whose two byte value lives inside the
 * entry rather than at an offset, and a GPS directory pointer at offset 0x26.
 * The GPS directory itself is empty, which is enough for `hasLocation`: what
 * matters to somebody deciding whether to keep their metadata is that the
 * file carried a location at all.
 */
const SAMPLE_EXIF = Uint8Array.from([
	0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x02, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00,
	0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
	0x00, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * The eight byte PNG signature, from clause 5.2 of the specification.
 *
 * Written out here rather than imported from `src/`. A test that took the
 * magic number from the encoder it is checking would pass just as happily if
 * both were wrong.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * The CRC-32 of the four bytes `IEND`.
 *
 * The same value in every PNG ever written, because the chunk carries no
 * payload, and quoted as 0xae426082 in the specification itself.
 */
const IEND_CRC = 0xae426082;

/** A PNG signature, padded out so the head the sniffer reads is a whole one. */
function pngInput(length = 64): Uint8Array {
	const bytes = new Uint8Array(length);
	bytes.set(PNG_SIGNATURE);
	return bytes;
}

/**
 * Six pixels: the corners of the RGB cube and one dark mixed colour.
 *
 * Laid out three across and two down, so a stride taken from the wrong
 * dimension shuffles the picture rather than crashing.
 */
const QOI_PIXELS: readonly (readonly number[])[] = [
	[255, 0, 0],
	[0, 255, 0],
	[0, 0, 255],
	[255, 255, 0],
	[0, 255, 255],
	[16, 32, 48],
];

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * A QOI file assembled by hand from the published version 1.0 specification.
 *
 * Deliberately not produced by this package's own encoder, which would make
 * the end to end test below a round trip through two halves of the same
 * assumption. Fourteen byte header: the magic `qoif`, width and height as big
 * endian 32 bit values, a channel count and a colour space byte. Then one
 * QOI_OP_RGB chunk per pixel, which is the tag byte 0xfe and three channels,
 * and finally the end marker of seven zero bytes and a one.
 */
function qoiInput(
	width: number,
	height: number,
	pixels: readonly (readonly number[])[],
): Uint8Array {
	const bytes: number[] = [0x71, 0x6f, 0x69, 0x66, ...u32(width), ...u32(height), 3, 0];
	for (const [red, green, blue] of pixels) {
		bytes.push(0xfe, red as number, green as number, blue as number);
	}
	bytes.push(0, 0, 0, 0, 0, 0, 0, 1);
	return Uint8Array.from(bytes);
}

interface PngChunk {
	readonly type: string;
	readonly data: Uint8Array;
	/** The CRC the file claims, for a caller that wants to recompute it. */
	readonly crc: number;
}

/** Walk a PNG's chunks the way clause 5.3 of the specification lays them out. */
function pngChunks(bytes: Uint8Array): PngChunk[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: PngChunk[] = [];
	let at = PNG_SIGNATURE.length;
	while (at + 12 <= bytes.length) {
		const length = view.getUint32(at);
		chunks.push({
			type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
			data: bytes.subarray(at + 8, at + 8 + length),
			crc: view.getUint32(at + 8 + length),
		});
		at += length + 12;
	}
	return chunks;
}

/** The Paeth predictor, exactly as clause 9.4 of the specification defines it. */
function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/**
 * The pixels of a PNG, recovered without this package's decoder.
 *
 * Node's zlib does the inflating and the scanline filters are undone here
 * against clause 9 of the specification, so nothing from `src/` stands on both
 * sides of the comparison. Handles truecolour at eight bits, with or without
 * alpha, which is all this package's encoder writes.
 */
function pngPixels(bytes: Uint8Array): number[][] {
	const chunks = pngChunks(bytes);
	const header = chunks.find((chunk) => chunk.type === 'IHDR');
	if (!header) throw new Error('that PNG carries no IHDR');
	const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
	const width = view.getUint32(0);
	const height = view.getUint32(4);
	const channels = header.data[9] === 6 ? 4 : 3;

	const raw = new Uint8Array(
		inflateSync(concatBytes(chunks.filter((chunk) => chunk.type === 'IDAT').map((c) => c.data))),
	);

	const stride = width * channels;
	const previous = new Uint8Array(stride);
	const out: number[][] = [];
	for (let row = 0; row < height; row += 1) {
		const at = row * (stride + 1);
		const filter = raw[at] as number;
		const line = new Uint8Array(raw.subarray(at + 1, at + 1 + stride));
		for (let i = 0; i < stride; i += 1) {
			const a = i >= channels ? (line[i - channels] as number) : 0;
			const b = previous[i] as number;
			const c = i >= channels ? (previous[i - channels] as number) : 0;
			let addend: number;
			switch (filter) {
				case 0:
					addend = 0;
					break;
				case 1:
					addend = a;
					break;
				case 2:
					addend = b;
					break;
				case 3:
					addend = Math.floor((a + b) / 2);
					break;
				case 4:
					addend = paeth(a, b, c);
					break;
				default:
					throw new Error(`filter type ${filter} is not one the specification defines`);
			}
			// Assigning into a Uint8Array truncates, which is the modulo 256 the
			// specification calls for.
			line[i] = (line[i] as number) + addend;
		}
		previous.set(line);
		for (let x = 0; x < width; x += 1) {
			out.push([...line.subarray(x * channels, x * channels + channels)]);
		}
	}
	return out;
}

interface RasterOptions {
	readonly width?: number;
	readonly height?: number;
	readonly colourSpace?: ColourSpace;
	/** Makes the first pixel fully transparent and the rest opaque. */
	readonly translucent?: boolean;
}

function raster(options: RasterOptions = {}): RasterImage {
	const { width = 2, height = 2, colourSpace = 'srgb', translucent = false } = options;
	const image = createRaster(width, height, colourSpace, translucent);
	for (let pixel = 0; pixel < width * height; pixel += 1) image.data.set(RED, pixel * 4);
	if (translucent) image.data[3] = 0;
	return image;
}

/* ── Fake codecs ──────────────────────────────────────────────────────── */

/** Ids of the decoders that were actually asked to decode, in order. */
let decodeCalls: string[] = [];
/** Ids of the encoders that were actually asked to encode, in order. */
let encodeCalls: string[] = [];

interface Encoded {
	readonly image: RasterImage;
	readonly options: EncodeOptions;
	readonly context: EncodeContext;
}

let lastEncode: Encoded | undefined;
let lastContext: DecodeContext | undefined;

interface DecoderSpec {
	readonly id: string;
	readonly formats?: readonly FormatId[];
	readonly path?: DecodePath;
	readonly priority?: number;
	readonly available?: boolean;
	/** Thrown instead of decoding, for a rung that fails on this file. */
	readonly fails?: Error;
	readonly image?: RasterImage;
	readonly exif?: Uint8Array;
	readonly iccProfile?: Uint8Array;
	readonly orientation?: Orientation;
	readonly tiles?: number;
	readonly droppedGainMap?: boolean;
}

function decoder(spec: DecoderSpec): Decoder {
	return {
		id: spec.id,
		formats: spec.formats ?? ['png'],
		path: spec.path ?? 'pure',
		priority: spec.priority ?? 10,
		async available() {
			return spec.available ?? true;
		},
		async decode(_bytes, context) {
			decodeCalls.push(spec.id);
			lastContext = context;
			if (spec.fails) throw spec.fails;
			return {
				image: spec.image ?? raster(),
				orientation: spec.orientation ?? UPRIGHT,
				exif: spec.exif,
				iccProfile: spec.iccProfile,
				tiles: spec.tiles,
				droppedGainMap: spec.droppedGainMap,
			};
		},
	};
}

interface EncoderSpec {
	readonly id: string;
	readonly format?: FormatId;
	readonly path?: EncodePath;
	readonly priority?: number;
	readonly available?: boolean;
	readonly fails?: Error;
	readonly bytes?: Uint8Array;
}

function encoder(spec: EncoderSpec): Encoder {
	return {
		id: spec.id,
		format: spec.format ?? 'png',
		path: spec.path ?? 'pure',
		priority: spec.priority ?? 10,
		async available() {
			return spec.available ?? true;
		},
		async encode(image, options, context) {
			encodeCalls.push(spec.id);
			// Recorded rather than asserted in here. An encoder that throws
			// while a later one succeeds has its error swallowed by the ladder
			// on purpose, so an assertion made in this position would pass
			// silently in exactly the case worth catching.
			lastEncode = { image, options, context };
			if (spec.fails) throw spec.fails;
			return spec.bytes ?? new Uint8Array(12);
		},
	};
}

function seenByEncoder(): Encoded {
	if (!lastEncode) throw new Error('the encoder was never asked to encode anything');
	return lastEncode;
}

/**
 * Run a conversion that is expected to fail and hand back the error.
 *
 * `rejects.toThrow` matches on the message, which is the one thing these tests
 * must not depend on: the messages are shown to a person as they are, and get
 * reworded. The code is the contract.
 */
async function failure(
	input: Uint8Array,
	options: ConvertOptions,
	capabilities: Capabilities = CAPABILITIES,
): Promise<ConverterError> {
	try {
		await convert(input, options, capabilities);
	} catch (error) {
		if (isConverterError(error)) return error;
		throw error;
	}
	throw new Error('that conversion was expected to fail and did not');
}

/**
 * Put the package's real codec set back.
 *
 * For the handful of tests that need a whole conversion rather than a
 * dispatch decision. Everything else runs on fakes, for the reason at the top
 * of this file, but a suite in which no test ever produces a file another
 * program could open is a suite that cannot tell a working pipeline from one
 * that hands the encoder a mangled raster.
 */
function withRealCodecs(): void {
	clearRegistry();
	resetDefaultCodecs();
	installDefaultCodecs();
}

beforeEach(() => {
	// `convert` installs the package's own codecs the first time it runs, so
	// let that happen here and then empty the registry. The flag inside
	// `defaults.ts` stays set, which is what keeps a real decoder from quietly
	// answering for one of the fakes below: several of the pure codecs are
	// available under Node, so an empty registry alone would not be empty for
	// long.
	installDefaultCodecs();
	clearRegistry();
	decodeCalls = [];
	encodeCalls = [];
	lastEncode = undefined;
	lastContext = undefined;
});

afterAll(() => {
	clearRegistry();
	resetDefaultCodecs();
});

/* ── The input ────────────────────────────────────────────────────────── */

describe('the input, before a codec is asked for anything', () => {
	it('refuses an empty file as empty, rather than as an unreadable one', async () => {
		// A zero byte file is a failed download or a file picker that handed
		// back a placeholder, and "that file is empty" is something a person can
		// act on. "Nothing here can read it" sends them looking for a plugin.
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(new Uint8Array(0), { to: 'png' });

		expect(error.code).toBe('input/empty');
		expect(decodeCalls).toEqual([]);
	});

	it('refuses bytes that are not an image at all, and keeps the head for a report', async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(new Uint8Array(32).fill(0xab), { to: 'png' });

		expect(error).toBeInstanceOf(UnknownFormatError);
		expect(error.code).toBe('input/unknown-format');
		// Carried on the error so a bug report can quote what arrived. The
		// message must never do it: the file name and its first bytes are the
		// two things somebody would not want pasted into a public tracker.
		expect(error instanceof UnknownFormatError && [...error.head]).toEqual([
			...new Uint8Array(16).fill(0xab),
		]);
		expect(decodeCalls).toEqual([]);
	});

	it('refuses a file cut off inside its own signature', async () => {
		// Half a PNG signature is not a PNG. Matching on a prefix would send
		// four bytes of something else to the PNG decoder, which then reports a
		// damaged PNG for a file that was never one.
		const half = new Uint8Array(32);
		half.set(PNG_SIGNATURE.slice(0, 4));
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(half, { to: 'png' });

		expect(error.code).toBe('input/unknown-format');
		expect(decodeCalls).toEqual([]);
	});
});

/* ── The decode ladder ────────────────────────────────────────────────── */

describe('the decode ladder', () => {
	it('runs the cheapest decoder and never reaches the expensive one', async () => {
		// Registered in the wrong order on purpose. Ordering by registration
		// rather than by priority would put a megabyte of software decoding
		// ahead of the hardware that was sitting there the whole time.
		registerDecoder(decoder({ id: 'software', priority: 40, path: 'pure' }));
		registerDecoder(decoder({ id: 'hardware', priority: 10, path: 'native-image' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(decodeCalls).toEqual(['hardware']);
		expect(result.report.decoderId).toBe('hardware');
		expect(result.report.decodePath).toBe('native-image');
	});

	it('names the decoder that worked, not the one that was tried first', async () => {
		registerDecoder(
			decoder({
				id: 'hardware',
				priority: 10,
				path: 'native-image',
				fails: new DecodeFailedError('png', 'hardware', 'the bitstream is not one this can read'),
			}),
		);
		registerDecoder(decoder({ id: 'software', priority: 40, path: 'pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(decodeCalls).toEqual(['hardware', 'software']);
		expect(result.report.decoderId).toBe('software');
		expect(result.report.decodePath).toBe('pure');
	});

	it('stops at a file too large rather than walking the rest of the ladder', async () => {
		// A file too big for one path is too big for all of them, and the next
		// rung is the slow one. Walking on turns a refusal that took a moment
		// into a refusal that took a minute, having also allocated the buffer
		// that the ceiling exists to prevent.
		registerDecoder(
			decoder({
				id: 'hardware',
				priority: 10,
				fails: new ImageTooLargeError(120_000_000, DEFAULT_MAX_PIXELS),
			}),
		);
		registerDecoder(decoder({ id: 'software', priority: 40 }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(pngInput(), { to: 'png' });

		expect(error.code).toBe('input/too-large');
		expect(decodeCalls).toEqual(['hardware']);
	});

	it('leaves out a decoder that says it cannot run in this browser', async () => {
		registerDecoder(decoder({ id: 'webcodecs', priority: 10, available: false }));
		registerDecoder(decoder({ id: 'pure', priority: 40 }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(decodeCalls).toEqual(['pure']);
		expect(result.report.decoderId).toBe('pure');
	});

	it('hands the decoder the pixel ceiling the caller set, not only the default', async () => {
		registerDecoder(decoder({ id: 'pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png' }, CAPABILITIES);
		expect(lastContext?.maxPixels).toBe(DEFAULT_MAX_PIXELS);

		await convert(pngInput(), { to: 'png', maxPixels: 4_000 }, CAPABILITIES);
		expect(lastContext?.maxPixels).toBe(4_000);
		expect(lastContext?.capabilities).toBe(CAPABILITIES);
	});

	it('passes a ceiling of zero through rather than treating it as unset', async () => {
		// Zero is a legal ceiling: it means refuse everything, which is what a
		// host application probing what this build will accept would pass. It is
		// also falsy, so the difference between `??` and `||` here is the
		// difference between refusing everything and quietly allowing eighty
		// megapixels.
		registerDecoder(decoder({ id: 'pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', maxPixels: 0 }, CAPABILITIES);

		expect(lastContext?.maxPixels).toBe(0);
	});

	it('carries on down the ladder when a plugin throws something unexpected', async () => {
		// A host application's decoder is the rung most likely to throw a plain
		// `TypeError` rather than one of ours. Taking the whole ladder down with
		// it would mean a broken plugin disables the built-in fallback that was
		// there all along, which is the opposite of what a fallback is for.
		registerDecoder(
			decoder({
				id: 'plugin',
				priority: 10,
				path: 'plugin',
				fails: new TypeError('x is not a function'),
			}),
		);
		registerDecoder(decoder({ id: 'png-pure', priority: 40 }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(decodeCalls).toEqual(['plugin', 'png-pure']);
		expect(result.report.decoderId).toBe('png-pure');
	});

	it('lets a plugin error out unwrapped when it was the only rung there was', async () => {
		// Pins what happens today rather than endorsing it. An error that is not
		// one of ours escapes with no `code`, so the website's code to sentence
		// map has nothing to match and the person sees a blank. Changing that is
		// a decision worth making deliberately, and this test is what makes it
		// deliberate.
		registerDecoder(
			decoder({ id: 'plugin', path: 'plugin', fails: new TypeError('x is not a function') }),
		);
		registerEncoder(encoder({ id: 'png-fake' }));

		await expect(convert(pngInput(), { to: 'png' }, CAPABILITIES)).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	it('reports a decode failure, not a missing decoder, when every rung fails', async () => {
		// The two refusals send somebody to different places. "Nothing here can
		// read this" means find another browser or load a plugin; "this file
		// could not be read" means the file is damaged and no browser will help.
		registerDecoder(
			decoder({
				id: 'hardware',
				priority: 10,
				path: 'native-image',
				fails: new DecodeFailedError('png', 'hardware', 'the bitstream is not one this can read'),
			}),
		);
		registerDecoder(
			decoder({
				id: 'software',
				priority: 40,
				fails: new DecodeFailedError('png', 'software', 'the header is damaged'),
			}),
		);
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(pngInput(), { to: 'png' });

		expect(error.code).toBe('decode/failed');
		expect(decodeCalls).toEqual(['hardware', 'software']);
		// The last rung's failure is the one that surfaces, which is the one
		// that had the best chance of reading the file.
		expect(error instanceof DecodeFailedError && error.decoderId).toBe('software');
	});

	it('forwards the abort signal to both codecs, so a conversion can be stopped', async () => {
		// The dispatcher never checks the signal itself. Cancelling a decode
		// that has already begun is the codec's job, and it cannot do it with a
		// signal that stopped at the dispatcher.
		const controller = new AbortController();
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', signal: controller.signal }, CAPABILITIES);

		expect(lastContext?.signal).toBe(controller.signal);
		expect(seenByEncoder().context.signal).toBe(controller.signal);
	});
});

/* ── Nothing can read it ──────────────────────────────────────────────── */

describe('when nothing here can read the file', () => {
	it('refuses with a code a caller can translate rather than a decode failure', async () => {
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(pngInput(), { to: 'png' });

		expect(error.code).toBe('decode/unsupported-here');
		expect(error.message.length).toBeGreaterThan(0);
	});

	it('tells a HEIC user what is actually missing when there is no HEVC decoder', async () => {
		// The generic sentence is useless here: the file is fine and the
		// browser is fine, and the missing piece is a hardware decoder this
		// machine does not have. Matched loosely, because the wording is copy
		// and will be rewritten.
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(buildHeif(), { to: 'png' });

		expect(error.code).toBe('decode/unsupported-here');
		expect(error.message).toMatch(/firefox|hardware/i);
	});

	it('does not blame the hardware when the machine does have HEVC', async () => {
		// Same refusal, different cause: HEVC is there and no decoder is
		// registered against it, so advice about Firefox would send somebody
		// off to fix a browser that is not the problem.
		registerEncoder(encoder({ id: 'png-fake' }));

		const error = await failure(
			buildHeif(),
			{ to: 'png' },
			emptyCapabilities({ hevcVideoDecoder: true }),
		);

		expect(error.code).toBe('decode/unsupported-here');
		expect(error.message.length).toBeGreaterThan(0);
		expect(error.message).not.toMatch(/firefox/i);
	});
});

/* ── The report ───────────────────────────────────────────────────────── */

describe('the report', () => {
	it('records both formats, both paths, both ids and the sizes on either side', async () => {
		registerDecoder(
			decoder({
				id: 'png-pure',
				path: 'pure',
				image: raster({ width: 3, height: 2 }),
				orientation: { rotation: 90, mirror: 'horizontal', source: 'exif' },
				tiles: 6,
				droppedGainMap: true,
			}),
		);
		registerEncoder(
			encoder({ id: 'qoi-pure', format: 'qoi', path: 'plugin', bytes: new Uint8Array(31) }),
		);

		const result = await convert(pngInput(64), { to: 'qoi' }, CAPABILITIES);

		expect(result.report).toMatchObject({
			from: 'png',
			to: 'qoi',
			decodePath: 'pure',
			decoderId: 'png-pure',
			encodePath: 'plugin',
			encoderId: 'qoi-pure',
			// Measured off the raster the encoder is handed, not swapped again
			// because the orientation says a quarter turn. The decoder already
			// applied it, and applying it twice is the 540 degree bug.
			width: 3,
			height: 2,
			orientation: { rotation: 90, mirror: 'horizontal', source: 'exif' },
			tiles: 6,
			// An HDR photograph that came out standard range says so, rather
			// than the interface having to guess why it looks different.
			droppedGainMap: true,
			sourceBytes: 64,
			outputBytes: 31,
		});
		expect(result.mime).toBe('image/qoi');
		expect(result.extension).toBe('qoi');
		expect(result.bytes.length).toBe(31);
	});

	it('says what the source was carrying even though the EXIF is being stripped', async () => {
		// "Your metadata was removed" is a much weaker thing to be told than
		// "the place this was taken and the time were removed", so the summary
		// is reported on a conversion that keeps none of it.
		registerDecoder(decoder({ id: 'png-pure', exif: SAMPLE_EXIF }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(result.report.metadata).toMatchObject({
			orientation: 6,
			hasLocation: true,
			tagCount: 2,
		});
	});

	it('leaves the metadata summary off when the source carried none', async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(result.report.metadata).toBeUndefined();
	});

	it('converts the picture anyway when the metadata it carried is damaged', async () => {
		// A valid byte order mark followed by 43 where the TIFF header requires
		// 42. Somebody whose EXIF has been mangled by three chat apps in a row
		// still wants their photograph converted, so the summary goes missing
		// and nothing else does. A reader that threw here would fail the whole
		// conversion after both codecs had already done their work.
		const damaged = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x00, 0x00, 0x08]);
		registerDecoder(decoder({ id: 'png-pure', exif: damaged }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(result.report.metadata).toBeUndefined();
		expect(result.report.encoderId).toBe('png-fake');
	});

	it('measures a single pixel image as one by one', async () => {
		// The smallest legal image, and the one where every off by one in a
		// stride or a loop bound is either harmless or fatal with nothing in
		// between.
		const image = raster({ width: 1, height: 1, translucent: true });
		registerDecoder(decoder({ id: 'png-pure', image }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		const result = await convert(pngInput(), { to: 'jpeg' }, CAPABILITIES);

		expect(result.report.width).toBe(1);
		expect(result.report.height).toBe(1);
		expect([...seenByEncoder().image.data]).toEqual([255, 255, 255, 255]);
	});
});

/* ── Alpha ────────────────────────────────────────────────────────────── */

describe('alpha', () => {
	it('flattens before a JPEG encoder ever sees the image', async () => {
		// A lossy format with no alpha channel given straight RGBA writes
		// whatever happened to be under the transparent pixels, which is
		// usually black and reads as corruption.
		registerDecoder(decoder({ id: 'png-pure', image: raster({ translucent: true }) }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		await convert(pngInput(), { to: 'jpeg' }, CAPABILITIES);

		const { image } = seenByEncoder();
		expect(image.hasAlpha).toBe(false);
		expect([...image.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
	});

	it('composites onto the background the caller asked for', async () => {
		registerDecoder(decoder({ id: 'png-pure', image: raster({ translucent: true }) }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		await convert(pngInput(), { to: 'jpeg', background: [0, 0, 0] }, CAPABILITIES);

		expect([...seenByEncoder().image.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
	});

	it('keeps the alpha channel for a format that has one', async () => {
		registerDecoder(decoder({ id: 'png-pure', image: raster({ translucent: true }) }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		const { image } = seenByEncoder();
		expect(image.hasAlpha).toBe(true);
		expect(image.data[3]).toBe(0);
	});

	it('notices translucency a decoder did not flag', async () => {
		// A decoder that always reports `hasAlpha: false` is common, because
		// the container often does not say. Trusting it hands transparent
		// pixels to a JPEG encoder unflattened.
		const image = raster({ translucent: true });
		registerDecoder(decoder({ id: 'png-pure', image: { ...image, hasAlpha: false } }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		await convert(pngInput(), { to: 'jpeg' }, CAPABILITIES);

		expect([...seenByEncoder().image.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
	});
});

/* ── Colour ───────────────────────────────────────────────────────────── */

describe('colour', () => {
	it("converts a Display P3 decode to sRGB when the caller asks for 'srgb'", async () => {
		registerDecoder(decoder({ id: 'png-pure', image: raster({ colourSpace: 'display-p3' }) }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png', colour: 'srgb' }, CAPABILITIES);

		const { image, options } = seenByEncoder();
		expect(image.colourSpace).toBe('srgb');
		expect(result.report.colourSpace).toBe('srgb');
		// Checked against the triple worked out from the two sets of published
		// primaries, not against "the red went up". Relabelling instead of
		// converting leaves the bytes untouched and renders flat everywhere
		// without throwing, and a matrix that is merely the wrong size moves
		// every channel in the right direction by the wrong amount.
		expect([...image.data.slice(0, 3)]).toEqual([...RED_IN_SRGB]);
		expect(options.writeColourTag).toBe(false);
	});

	it('leaves a neutral grey exactly where it was, since both spaces share a white point', async () => {
		// Display P3 and sRGB are both D65, so the conversion has no chromatic
		// adaptation step and grey is a fixed point of it. A matrix built on the
		// wrong white point, or one that picked up an adaptation it does not
		// need, shifts grey while leaving every saturated colour looking about
		// right, and a photograph is mostly the colours that still look right.
		const image = raster({ colourSpace: 'display-p3' });
		image.data.set([128, 128, 128, 255], 0);
		registerDecoder(decoder({ id: 'png-pure', image }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', colour: 'srgb' }, CAPABILITIES);

		expect([...seenByEncoder().image.data.slice(0, 4)]).toEqual([128, 128, 128, 255]);
	});

	it('keeps Display P3 for a PNG when the caller asks to preserve it', async () => {
		registerDecoder(decoder({ id: 'png-pure', image: raster({ colourSpace: 'display-p3' }) }));
		registerEncoder(encoder({ id: 'png-fake' }));

		const result = await convert(pngInput(), { to: 'png', colour: 'preserve' }, CAPABILITIES);

		const { image, options } = seenByEncoder();
		expect(image.colourSpace).toBe('display-p3');
		expect(result.report.colourSpace).toBe('display-p3');
		expect([...image.data.slice(0, 3)]).toEqual([...RED.slice(0, 3)]);
		expect(options.writeColourTag).toBe(true);
	});

	it('narrows anyway when the target format cannot carry a wide gamut', async () => {
		// QOI has one byte for the whole question and no way to say Display P3.
		// Writing P3 numbers into it produces a file that is wrong and silent.
		registerDecoder(decoder({ id: 'png-pure', image: raster({ colourSpace: 'display-p3' }) }));
		registerEncoder(encoder({ id: 'qoi-fake', format: 'qoi' }));

		const result = await convert(pngInput(), { to: 'qoi', colour: 'preserve' }, CAPABILITIES);

		expect(seenByEncoder().image.colourSpace).toBe('srgb');
		expect(seenByEncoder().options.writeColourTag).toBe(false);
		expect(result.report.colourSpace).toBe('srgb');
	});

	it('leaves an sRGB image alone rather than running the conversion backwards', async () => {
		// Converting something already in sRGB oversaturates it by about as
		// much as the missing conversion desaturates a P3 photograph, and on a
		// wide gamut display both look plausible.
		registerDecoder(decoder({ id: 'png-pure', image: raster() }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', colour: 'preserve' }, CAPABILITIES);

		const { image, options } = seenByEncoder();
		expect(image.colourSpace).toBe('srgb');
		expect([...image.data.slice(0, 3)]).toEqual([...RED.slice(0, 3)]);
		expect(options.writeColourTag).toBe(false);
	});
});

/* ── Profiles and metadata ────────────────────────────────────────────── */

describe('the ICC profile', () => {
	it("carries the source's own profile to the encoder while the image is wide", async () => {
		registerDecoder(
			decoder({
				id: 'png-pure',
				image: raster({ colourSpace: 'display-p3' }),
				iccProfile: SOURCE_PROFILE,
			}),
		);
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', colour: 'preserve' }, CAPABILITIES);

		expect(seenByEncoder().options.iccProfile).toBe(SOURCE_PROFILE);
	});

	it('drops the source profile once the pixels have been narrowed to sRGB', async () => {
		// Embedding a Display P3 profile beside sRGB numbers is worse than
		// embedding nothing: every reader that honours the profile then
		// stretches an image that was already correct.
		registerDecoder(
			decoder({
				id: 'png-pure',
				image: raster({ colourSpace: 'display-p3' }),
				iccProfile: SOURCE_PROFILE,
			}),
		);
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', colour: 'srgb' }, CAPABILITIES);

		expect(seenByEncoder().options.iccProfile).toBeUndefined();
	});

	it("prefers the source's profile over one the caller supplied", async () => {
		registerDecoder(
			decoder({
				id: 'png-pure',
				image: raster({ colourSpace: 'display-p3' }),
				iccProfile: SOURCE_PROFILE,
			}),
		);
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(
			pngInput(),
			{ to: 'png', colour: 'preserve', metadata: 'preserve', iccProfile: CALLER_PROFILE },
			CAPABILITIES,
		);

		expect(seenByEncoder().options.iccProfile).toBe(SOURCE_PROFILE);
	});
});

describe('metadata', () => {
	it('strips by default, so nothing the caller passed is written unasked', async () => {
		// The default matters more than the option. A phone photo carries the
		// coordinates of somebody's house and the time they were standing in
		// it, and preserving that by accident is the failure worth pinning.
		registerDecoder(decoder({ id: 'png-pure', exif: SAMPLE_EXIF }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(pngInput(), { to: 'png', iccProfile: CALLER_PROFILE }, CAPABILITIES);

		expect(seenByEncoder().options.iccProfile).toBeUndefined();
	});

	it("passes the caller's profile through only when asked to preserve", async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake' }));

		await convert(
			pngInput(),
			{ to: 'png', metadata: 'preserve', iccProfile: CALLER_PROFILE },
			CAPABILITIES,
		);

		expect(seenByEncoder().options.iccProfile).toBe(CALLER_PROFILE);
	});
});

/* ── The encode ladder ────────────────────────────────────────────────── */

describe('the encode ladder', () => {
	it('falls to the next encoder when the first one fails, and says which wrote it', async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(
			encoder({
				id: 'png-canvas',
				priority: 10,
				path: 'canvas',
				fails: new EncodeFailedError('png', 'png-canvas', 'the canvas is over its size limit'),
			}),
		);
		registerEncoder(encoder({ id: 'png-ours', priority: 20, path: 'pure' }));

		const result = await convert(pngInput(), { to: 'png' }, CAPABILITIES);

		expect(encodeCalls).toEqual(['png-canvas', 'png-ours']);
		expect(result.report.encoderId).toBe('png-ours');
		expect(result.report.encodePath).toBe('pure');
	});

	it('hands the encoder the quality the caller chose', async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		await convert(pngInput(), { to: 'jpeg', quality: 0.62 }, CAPABILITIES);

		expect(seenByEncoder().options.quality).toBe(0.62);
	});

	it('hands over a quality of zero rather than reading it as no quality set', async () => {
		// The bottom of the legal range, and the only value in it that is
		// falsy. Somebody dragging a slider to the far end is asking for the
		// smallest file this encoder can make, not for the default.
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'jpeg-fake', format: 'jpeg' }));

		await convert(pngInput(), { to: 'jpeg', quality: 0 }, CAPABILITIES);

		expect(seenByEncoder().options.quality).toBe(0);
	});

	it('reports a write failure, not a missing writer, when every encoder fails', async () => {
		// Same split as on the decode side. "Nothing here can write PNG" means
		// pick another format; "the PNG could not be written" means this
		// particular image defeated the writer and another format may well work.
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(
			encoder({
				id: 'png-canvas',
				priority: 10,
				path: 'canvas',
				fails: new EncodeFailedError('png', 'png-canvas', 'the canvas is over its size limit'),
			}),
		);
		registerEncoder(
			encoder({
				id: 'png-ours',
				priority: 20,
				fails: new EncodeFailedError('png', 'png-ours', 'the deflate stream would not close'),
			}),
		);

		const error = await failure(pngInput(), { to: 'png' });

		expect(error.code).toBe('encode/failed');
		expect(encodeCalls).toEqual(['png-canvas', 'png-ours']);
		expect(error instanceof EncodeFailedError && error.encoderId).toBe('png-ours');
	});

	it('refuses with an encode code, not a decode one, when nothing can write it', async () => {
		registerDecoder(decoder({ id: 'png-pure' }));
		registerEncoder(encoder({ id: 'png-fake', available: false }));

		const error = await failure(pngInput(), { to: 'png' });

		expect(error.code).toBe('encode/unsupported');
		expect(error.message.length).toBeGreaterThan(0);
		expect(decodeCalls).toEqual(['png-pure']);
		expect(encodeCalls).toEqual([]);
	});
});

/* ── A whole conversion, on the real codecs ───────────────────────────── */

describe('a conversion through the codecs this package actually ships', () => {
	// Every other test in this file replaces both codecs with a fake, which is
	// the right way to test a dispatcher and no way at all to find out whether
	// the thing it dispatches to produces a file. These four run the real
	// registry and check the output against the PNG specification and against
	// Node's own zlib, so nothing from `src/` sits on both sides of the
	// comparison.

	beforeEach(() => {
		withRealCodecs();
	});

	it('writes a PNG whose signature, header and end chunk match the specification', async () => {
		const result = await convert(qoiInput(3, 2, QOI_PIXELS), { to: 'png' }, CAPABILITIES);
		const bytes = result.bytes;

		expect([...bytes.slice(0, 8)]).toEqual([...PNG_SIGNATURE]);

		const chunks = pngChunks(bytes);
		expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

		// IHDR, clause 11.2.2: width and height big endian, then bit depth,
		// colour type, compression method, filter method and interlace method.
		const header = chunks[0] as PngChunk;
		expect(header.data.length).toBe(13);
		const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
		expect(view.getUint32(0)).toBe(3);
		expect(view.getUint32(4)).toBe(2);
		expect(header.data[8]).toBe(8);
		// Colour type 2 is truecolour with no alpha, which is what an opaque
		// source should produce. Writing type 6 here would put a wholly
		// redundant fourth channel in every file this tool makes.
		expect(header.data[9]).toBe(2);
		expect(header.data[10]).toBe(0);
		expect(header.data[11]).toBe(0);
		expect(header.data[12]).toBe(0);

		const end = chunks[2] as PngChunk;
		expect(end.data.length).toBe(0);
		expect(end.crc).toBe(IEND_CRC);
	});

	it('carries the pixels the QOI specification describes through to the PNG', async () => {
		// The source chunks were written by hand from the QOI specification and
		// the output is read back with Node's zlib and the filter rules from the
		// PNG specification. If this passes, a file left this tool that another
		// program can open and that holds the picture that went in.
		const result = await convert(qoiInput(3, 2, QOI_PIXELS), { to: 'png' }, CAPABILITIES);

		expect(pngPixels(result.bytes)).toEqual(QOI_PIXELS.map((pixel) => [...pixel]));
	});

	it('names both real codecs and both sizes on the report', async () => {
		const input = qoiInput(3, 2, QOI_PIXELS);

		const result = await convert(input, { to: 'png' }, CAPABILITIES);

		expect(result.report).toMatchObject({
			from: 'qoi',
			to: 'png',
			decoderId: 'qoi-pure',
			encoderId: 'png-pure',
			width: 3,
			height: 2,
			colourSpace: 'srgb',
			sourceBytes: input.length,
			outputBytes: result.bytes.length,
		});
		expect(result.mime).toBe('image/png');
	});

	it('converts a single pixel, which is the smallest legal image there is', async () => {
		const result = await convert(qoiInput(1, 1, [[16, 32, 48]]), { to: 'png' }, CAPABILITIES);

		const header = (pngChunks(result.bytes)[0] as PngChunk).data;
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
		expect(view.getUint32(0)).toBe(1);
		expect(view.getUint32(4)).toBe(1);
		expect(pngPixels(result.bytes)).toEqual([[16, 32, 48]]);
	});

	it('calls a truncated PNG damaged rather than unreadable here', async () => {
		// A signature and nothing else. The two refusals send somebody to
		// opposite places, and `decode/unsupported-here` for a broken file has
		// them installing a plugin that will fail on it in exactly the same way.
		const error = await failure(Uint8Array.from(PNG_SIGNATURE), { to: 'png' });

		expect(error.code).toBe('decode/failed');
		expect(error).toBeInstanceOf(DecodeFailedError);
	});
});
