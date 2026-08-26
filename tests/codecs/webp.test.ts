import { describe, expect, it } from 'vitest';
import {
	animatedWebpEncoder,
	encodeAnimatedWebp,
	nativeWebpFrameEncoder,
} from '../../src/codecs/webp/encode.js';
import type { WebpFrameEncoder } from '../../src/codecs/webp/encode.js';
import { muxAnimatedWebp, readWebpChunks } from '../../src/codecs/webp/mux.js';
import type { WebpCodedFrame } from '../../src/codecs/webp/mux.js';
import { CancelledError, CodecUnavailableError, EncodeFailedError } from '../../src/errors.js';
import type {
	Animation,
	Capabilities,
	EncodeContext,
	EncodeOptions,
	RasterImage,
} from '../../src/types.js';

/**
 * The container, written out here from the specification.
 *
 * Deliberately a second implementation rather than a call into the one under
 * test: a fixture built by the code it is checking only proves that the code
 * agrees with itself, and the two places a RIFF writer goes wrong, the pad
 * byte and what the size field counts, are exactly the two places both copies
 * would agree on the same mistake. These are written from the document, and
 * the expected files below are assembled with them byte by byte.
 */
function tagInto(bytes: Uint8Array, at: number, fourCC: string): void {
	for (let i = 0; i < 4; i += 1) bytes[at + i] = fourCC.charCodeAt(i);
}

function riff(fourCC: string, payload: Uint8Array): Uint8Array {
	// The payload is padded to an even length and the size field does not count
	// the pad.
	const out = new Uint8Array(8 + payload.length + (payload.length % 2));
	tagInto(out, 0, fourCC);
	new DataView(out.buffer).setUint32(4, payload.length, true);
	out.set(payload, 8);
	return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function webpFile(chunks: readonly Uint8Array[]): Uint8Array {
	const body = join(chunks);
	const out = new Uint8Array(12 + body.length);
	tagInto(out, 0, 'RIFF');
	new DataView(out.buffer).setUint32(4, 4 + body.length, true);
	tagInto(out, 8, 'WEBP');
	out.set(body, 12);
	return out;
}

/* ── Reading a file back ──────────────────────────────────────────────── */

interface Chunk {
	readonly tag: string;
	readonly payload: Uint8Array;
}

/** An independent walk, so a test never asks the writer to mark its own work. */
function chunksOf(file: Uint8Array, from = 12): Chunk[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const out: Chunk[] = [];
	let at = from;
	while (at + 8 <= file.length) {
		let tag = '';
		for (let i = 0; i < 4; i += 1) tag += String.fromCharCode(file[at + i] as number);
		const size = view.getUint32(at + 4, true);
		out.push({ tag, payload: file.subarray(at + 8, at + 8 + size) });
		at += 8 + size + (size % 2);
	}
	return out;
}

function only(file: Uint8Array, tag: string): Chunk {
	const found = chunksOf(file).filter((part) => part.tag === tag);
	if (found.length !== 1) throw new Error(`expected one ${tag}, found ${found.length}`);
	return found[0] as Chunk;
}

function u24At(bytes: Uint8Array, at: number): number {
	return (
		(bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16)
	);
}

/** `VP8X`: one flag byte, three reserved, then the canvas minus one, twice. */
function canvasOf(file: Uint8Array): { flags: number; width: number; height: number } {
	const payload = only(file, 'VP8X').payload;
	return {
		flags: payload[0] as number,
		width: u24At(payload, 4) + 1,
		height: u24At(payload, 7) + 1,
	};
}

/** `ANIM`: the background in blue, green, red, alpha order, then the loop count. */
function animOf(file: Uint8Array): { background: number[]; loops: number } {
	const payload = only(file, 'ANIM').payload;
	return {
		background: [...payload.subarray(0, 4)],
		loops: (payload[4] as number) | ((payload[5] as number) << 8),
	};
}

interface Anmf {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly durationMs: number;
	readonly flags: number;
	readonly chunks: Chunk[];
}

function anmfsOf(file: Uint8Array): Anmf[] {
	return chunksOf(file)
		.filter((part) => part.tag === 'ANMF')
		.map((part) => ({
			x: u24At(part.payload, 0) * 2,
			y: u24At(part.payload, 3) * 2,
			width: u24At(part.payload, 6) + 1,
			height: u24At(part.payload, 9) + 1,
			durationMs: u24At(part.payload, 12),
			flags: part.payload[15] as number,
			// The frame's own chunks start straight after the sixteen byte
			// header, and follow the same rules the file's do.
			chunks: chunksOf(part.payload, 16),
		}));
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/**
 * The bytes a browser would hand back for one frame.
 *
 * The lossy payloads are not real VP8. Nothing in this package decodes one and
 * nothing in the container reads into one, so what matters about them is their
 * length and that they come out the other end unaltered. The lossless header
 * is real, because the writer reads the alpha bit out of it to decide what to
 * declare in `VP8X`.
 */
const LOSSY = Uint8Array.of(0x30, 0x01, 0x00, 0x9d, 0x2a);
const ALPH = Uint8Array.of(0x01, 0x40, 0x7f);

/**
 * A `VP8L` header: 0x2f, then fourteen bits of width minus one, fourteen of
 * height minus one, one alpha bit and three of version, filled from the least
 * significant end.
 */
function vp8l(width: number, height: number, alpha: boolean): Uint8Array {
	const header = (width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0);
	return Uint8Array.of(
		0x2f,
		header & 0xff,
		(header >>> 8) & 0xff,
		(header >>> 16) & 0xff,
		(header >>> 24) & 0xff,
		0xc3,
		0x07,
	);
}

/** A simple lossy still, which is the shape a canvas writes for an opaque picture. */
function stillLossy(payload: Uint8Array = LOSSY): Uint8Array {
	return webpFile([riff('VP8 ', payload)]);
}

/** An extended still with alpha, which is what a canvas writes for a translucent one. */
function stillLossyWithAlpha(): Uint8Array {
	return webpFile([
		riff('VP8X', Uint8Array.of(0x10, 0, 0, 0, 3, 0, 0, 2, 0, 0)),
		riff('ALPH', ALPH),
		riff('VP8 ', LOSSY),
	]);
}

function stillLossless(alpha: boolean): Uint8Array {
	return webpFile([riff('VP8L', vp8l(4, 3, alpha))]);
}

function coded(bytes: Uint8Array, durationMs: number, fourCC = 'VP8 '): WebpCodedFrame {
	return { bitstream: { fourCC, payload: bytes }, durationMs };
}

const CAPABILITIES: Capabilities = {
	nativeDecode: new Set<string>(),
	canvasEncode: new Set<string>(['image/webp']),
	hevcVideoDecoder: false,
	av1VideoEncoder: false,
	displayP3Canvas: false,
	compressionStream: false,
	offscreenCanvas: false,
	imageDecoder: false,
};

const CONTEXT: EncodeContext = { capabilities: CAPABILITIES };

function raster(width: number, height: number): RasterImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = i & 0xff;
		data[i + 3] = 255;
	}
	return { data, width, height, colourSpace: 'srgb', hasAlpha: false };
}

function animationOf(
	sizes: readonly (readonly [number, number])[],
	delays: readonly number[],
	loopCount = 0,
): Animation {
	return {
		loopCount,
		frames: sizes.map((size, at) => ({
			image: raster(size[0], size[1]),
			delayMs: delays[at] as number,
		})),
	};
}

interface Call {
	readonly image: RasterImage;
	readonly options: EncodeOptions;
}

/** A stand-in for the browser, handing back stills that were built by hand. */
function fakeEncoder(replies: readonly Uint8Array[], calls: Call[] = []): WebpFrameEncoder {
	let at = 0;
	return async (image, options) => {
		calls.push({ image, options });
		const reply = replies[Math.min(at, replies.length - 1)] as Uint8Array;
		at += 1;
		return reply;
	};
}

/* ── The chunk walk ───────────────────────────────────────────────────── */

describe('the chunk walk', () => {
	it('finds every chunk of a still, stepping over the pad after an odd one', () => {
		// `ALPH` is three bytes here, so anything that forgets the pad reads the
		// next tag one byte early and finds rubbish.
		const chunks = readWebpChunks(stillLossyWithAlpha());
		expect(chunks.map((part) => part.fourCC)).toEqual(['VP8X', 'ALPH', 'VP8 ']);
		expect(chunks[1]?.payload).toEqual(ALPH);
		expect(chunks[2]?.payload).toEqual(LOSSY);
	});

	it('walks a simple lossless file, which has no VP8X at all', () => {
		const chunks = readWebpChunks(stillLossless(true));
		expect(chunks.map((part) => part.fourCC)).toEqual(['VP8L']);
		expect(chunks[0]?.payload).toEqual(vp8l(4, 3, true));
	});

	it('reads nothing out of bytes that are not a WebP', () => {
		expect(readWebpChunks(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toEqual([]);
		const png = new Uint8Array(32);
		tagInto(png, 0, 'RIFF');
		tagInto(png, 8, 'AVI ');
		expect(readWebpChunks(png)).toEqual([]);
	});

	it('stops at the length the RIFF header declares', () => {
		// A view with something after the file in it. Reading past the declared
		// size would lift whatever happened to follow into a frame.
		const file = stillLossy();
		const extended = join([file, riff('JUNK', Uint8Array.of(1, 2, 3, 4))]);
		expect(readWebpChunks(extended).map((part) => part.fourCC)).toEqual(['VP8 ']);
	});

	it('drops a final chunk that runs off the end', () => {
		const file = stillLossy();
		// Claim sixteen more bytes than the file holds.
		new DataView(file.buffer).setUint32(16, LOSSY.length + 16, true);
		expect(readWebpChunks(file)).toEqual([]);
	});
});

/* ── The container ────────────────────────────────────────────────────── */

describe('the animated container', () => {
	it('writes the exact bytes the specification calls for', async () => {
		const file = await encodeAnimatedWebp(
			raster(4, 3),
			{
				animation: animationOf(
					[
						[4, 3],
						[4, 3],
					],
					[40, 60],
				),
			},
			CONTEXT,
			fakeEncoder([stillLossyWithAlpha(), stillLossless(false)]),
		);

		const expected = webpFile([
			// Animation and alpha, three reserved bytes, then 4 and 3 minus one.
			riff('VP8X', Uint8Array.of(0x12, 0, 0, 0, 3, 0, 0, 2, 0, 0)),
			// White, opaque, in blue, green, red, alpha order, and no loop limit.
			riff('ANIM', Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0, 0)),
			riff(
				'ANMF',
				join([
					Uint8Array.of(0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 0, 0, 40, 0, 0, 0x02),
					riff('ALPH', ALPH),
					riff('VP8 ', LOSSY),
				]),
			),
			riff(
				'ANMF',
				join([
					Uint8Array.of(0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 0, 0, 60, 0, 0, 0x02),
					riff('VP8L', vp8l(4, 3, false)),
				]),
			),
		]);

		expect(file).toEqual(expected);
	});

	it('sizes the file from its contents, on an even boundary', () => {
		const file = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [coded(LOSSY, 40), coded(ALPH, 40)],
			loopCount: 0,
		});
		const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
		// The size field covers everything after itself, which includes `WEBP`.
		expect(view.getUint32(4, true)).toBe(file.length - 8);
		// Both payloads are odd, so a writer that failed to pad would land here
		// with an odd file and every chunk after the first misaligned.
		expect(file.length % 2).toBe(0);
	});

	it('declares the canvas as its sides minus one', () => {
		const file = muxAnimatedWebp({
			width: 1920,
			height: 1080,
			frames: [coded(LOSSY, 40)],
			loopCount: 0,
		});
		expect(canvasOf(file)).toEqual({ flags: 0x02, width: 1920, height: 1080 });
		const payload = only(file, 'VP8X').payload;
		expect(payload.length).toBe(10);
		expect([...payload.subarray(1, 4)]).toEqual([0, 0, 0]);
		// 1919 is 0x77f, which is two bytes, so an implementation that wrote a
		// big-endian or a two byte field passes nothing here.
		expect([...payload.subarray(4, 7)]).toEqual([0x7f, 0x07, 0x00]);
	});

	it('sets the alpha flag from what the frames actually carry', () => {
		const opaque = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [coded(LOSSY, 40), coded(LOSSY, 40)],
			loopCount: 0,
		});
		expect(canvasOf(opaque).flags).toBe(0x02);

		const withAlph = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [coded(LOSSY, 40), { ...coded(LOSSY, 40), alpha: ALPH }],
			loopCount: 0,
		});
		expect(canvasOf(withAlph).flags).toBe(0x12);
	});

	it('reads the alpha bit out of a lossless frame rather than assuming', () => {
		const lossless = (payload: Uint8Array) =>
			canvasOf(
				muxAnimatedWebp({
					width: 4,
					height: 3,
					frames: [coded(payload, 40, 'VP8L')],
					loopCount: 0,
				}),
			).flags;

		expect(lossless(vp8l(4, 3, true))).toBe(0x12);
		expect(lossless(vp8l(4, 3, false))).toBe(0x02);
		// A header too short to hold the bit, and one whose signature says this
		// is not a lossless stream at all. Neither may be read as alpha.
		expect(lossless(Uint8Array.of(0x2f, 0x03, 0x80))).toBe(0x02);
		expect(lossless(Uint8Array.of(0x00, 0x03, 0x80, 0x00, 0x10))).toBe(0x02);
	});

	it('writes the background as blue, green, red, alpha', () => {
		const file = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [coded(LOSSY, 40)],
			loopCount: 0,
			background: [10, 20, 30],
		});
		expect(animOf(file).background).toEqual([30, 20, 10, 255]);
	});

	it('carries a loop count across, clamping rather than wrapping', () => {
		const loopsOf = (loopCount: number) =>
			animOf(muxAnimatedWebp({ width: 4, height: 3, frames: [coded(LOSSY, 40)], loopCount })).loops;

		// Both conventions spell "forever" as zero, so this is a copy.
		expect(loopsOf(0)).toBe(0);
		expect(loopsOf(3)).toBe(3);
		// 70000 truncated to sixteen bits is 4464, and 65536 is 0, which would
		// turn a long finite animation into an endless one.
		expect(loopsOf(70000)).toBe(0xffff);
		expect(loopsOf(65536)).toBe(0xffff);
		expect(loopsOf(-1)).toBe(0);
		expect(loopsOf(Number.NaN)).toBe(0);
	});

	it('places every frame over the whole canvas, with no blending or disposal', () => {
		const file = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [coded(LOSSY, 40), { ...coded(LOSSY, 60), alpha: ALPH }],
			loopCount: 0,
		});
		const frames = anmfsOf(file);
		expect(frames).toHaveLength(2);
		for (const frame of frames) {
			expect(frame.x).toBe(0);
			expect(frame.y).toBe(0);
			expect(frame.width).toBe(4);
			expect(frame.height).toBe(3);
			// Bit 1 set is "do not blend", bit 0 clear is "leave the canvas".
			expect(frame.flags).toBe(0x02);
		}
		expect(frames.map((frame) => frame.durationMs)).toEqual([40, 60]);
		expect(frames[0]?.chunks.map((part) => part.tag)).toEqual(['VP8 ']);
		expect(frames[1]?.chunks.map((part) => part.tag)).toEqual(['ALPH', 'VP8 ']);
		expect(frames[1]?.chunks[0]?.payload).toEqual(ALPH);
	});

	it('rounds a duration and clamps one the field cannot hold', () => {
		const file = muxAnimatedWebp({
			width: 4,
			height: 3,
			frames: [
				coded(LOSSY, 33.4),
				coded(LOSSY, -5),
				coded(LOSSY, Number.NaN),
				coded(LOSSY, 20 * 60 * 60 * 1000),
			],
			loopCount: 0,
		});
		expect(anmfsOf(file).map((frame) => frame.durationMs)).toEqual([33, 0, 0, 0xffffff]);
	});

	it('refuses a canvas or a frame list it cannot describe', () => {
		const frames = [coded(LOSSY, 40)];
		expect(() => muxAnimatedWebp({ width: 4, height: 3, frames: [], loopCount: 0 })).toThrow(
			/no frames/,
		);
		expect(() => muxAnimatedWebp({ width: 0, height: 3, frames, loopCount: 0 })).toThrow(
			EncodeFailedError,
		);
		expect(() => muxAnimatedWebp({ width: 4, height: 0.5, frames, loopCount: 0 })).toThrow(
			EncodeFailedError,
		);
		// One past what a twenty-four bit field can hold, minus one.
		expect(() =>
			muxAnimatedWebp({ width: (1 << 24) + 1, height: 3, frames, loopCount: 0 }),
		).toThrow(/size fields/);
		expect(() =>
			muxAnimatedWebp({ width: 4, height: (1 << 24) + 1, frames, loopCount: 0 }),
		).toThrow(/size fields/);
	});
});

/* ── The encoder ──────────────────────────────────────────────────────── */

describe('encodeAnimatedWebp', () => {
	it('hands a still straight back, without a container of its own', async () => {
		const calls: Call[] = [];
		const still = stillLossy();
		const file = await encodeAnimatedWebp(raster(4, 3), {}, CONTEXT, fakeEncoder([still], calls));
		// The same object, so nothing was unpacked and rewrapped on the way.
		expect(file).toBe(still);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.image.width).toBe(4);
	});

	it('takes the picture from a one frame animation rather than the fallback', async () => {
		const calls: Call[] = [];
		await encodeAnimatedWebp(
			raster(4, 3),
			{ animation: animationOf([[8, 8]], [40]) },
			CONTEXT,
			fakeEncoder([stillLossy()], calls),
		);
		expect(calls[0]?.image.width).toBe(8);
	});

	it('encodes every frame once, with only the settings a still can act on', async () => {
		const calls: Call[] = [];
		const file = await encodeAnimatedWebp(
			raster(4, 3),
			{
				quality: 0.7,
				background: [1, 2, 3],
				animation: animationOf(
					[
						[4, 3],
						[4, 3],
						[4, 3],
					],
					[10, 20, 30],
					5,
				),
			},
			CONTEXT,
			fakeEncoder([stillLossy()], calls),
		);

		expect(calls).toHaveLength(3);
		expect(calls[0]?.options.quality).toBe(0.7);
		expect(calls[0]?.options.background).toEqual([1, 2, 3]);
		// The frame encoder must not be handed the animation it is part of.
		expect('animation' in (calls[0]?.options ?? {})).toBe(false);
		expect(anmfsOf(file).map((frame) => frame.durationMs)).toEqual([10, 20, 30]);
		expect(animOf(file).loops).toBe(5);
		expect(animOf(file).background).toEqual([3, 2, 1, 255]);
	});

	it('drops an ALPH that arrives beside a lossless picture', async () => {
		// Malformed by the specification, and no browser writes it. If one ever
		// does, the alpha belongs to the lossless stream already.
		const odd = webpFile([
			riff('VP8X', Uint8Array.of(0x10, 0, 0, 0, 3, 0, 0, 2, 0, 0)),
			riff('ALPH', ALPH),
			riff('VP8L', vp8l(4, 3, true)),
		]);
		const file = await encodeAnimatedWebp(
			raster(4, 3),
			{
				animation: animationOf(
					[
						[4, 3],
						[4, 3],
					],
					[40, 40],
				),
			},
			CONTEXT,
			fakeEncoder([odd]),
		);
		expect(anmfsOf(file)[0]?.chunks.map((part) => part.tag)).toEqual(['VP8L']);
		// The flag still gets set, from the lossless header rather than the ALPH.
		expect(canvasOf(file).flags).toBe(0x12);
	});

	it('refuses frames that are not all the same size', async () => {
		await expect(
			encodeAnimatedWebp(
				raster(4, 3),
				{
					animation: animationOf(
						[
							[4, 3],
							[4, 4],
						],
						[40, 40],
					),
				},
				CONTEXT,
				fakeEncoder([stillLossy()]),
			),
		).rejects.toThrow(/same size/);
	});

	it('refuses bytes with no WebP picture in them', async () => {
		const calls: Call[] = [];
		await expect(
			encodeAnimatedWebp(
				raster(4, 3),
				{
					animation: animationOf(
						[
							[4, 3],
							[4, 3],
						],
						[40, 40],
					),
				},
				CONTEXT,
				// A PNG, which is what Safari answers a WebP request with.
				fakeEncoder([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)], calls),
			),
		).rejects.toThrow(EncodeFailedError);
		expect(calls).toHaveLength(1);
	});

	it('stops before the first frame when the conversion was already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		const calls: Call[] = [];
		await expect(
			encodeAnimatedWebp(
				raster(4, 3),
				{
					animation: animationOf(
						[
							[4, 3],
							[4, 3],
						],
						[40, 40],
					),
				},
				{ capabilities: CAPABILITIES, signal: controller.signal },
				fakeEncoder([stillLossy()], calls),
			),
		).rejects.toBeInstanceOf(CancelledError);
		expect(calls).toHaveLength(0);
	});

	it('stops partway through rather than encoding the rest of the frames', async () => {
		const controller = new AbortController();
		let calls = 0;
		const encodeFrame: WebpFrameEncoder = async () => {
			calls += 1;
			controller.abort();
			return stillLossy();
		};
		await expect(
			encodeAnimatedWebp(
				raster(4, 3),
				{
					animation: animationOf(
						[
							[4, 3],
							[4, 3],
							[4, 3],
						],
						[40, 40, 40],
					),
				},
				{ capabilities: CAPABILITIES, signal: controller.signal },
				encodeFrame,
			),
		).rejects.toBeInstanceOf(CancelledError);
		expect(calls).toBe(1);
	});
});

describe('the encoder', () => {
	it('sits ahead of the still WebP encoder and says that it animates', () => {
		expect(animatedWebpEncoder.id).toBe('webp-animated');
		expect(animatedWebpEncoder.format).toBe('webp');
		expect(animatedWebpEncoder.animates).toBe(true);
		// The pictures are the browser's, so this is not a pure path.
		expect(animatedWebpEncoder.path).toBe('canvas');
		// `webp-native` is registered at 10 and cannot animate, so this has to
		// be the lower number or the frames are dropped before it is asked.
		expect(animatedWebpEncoder.priority).toBeLessThan(10);
	});

	it('is available only where the canvas really writes WebP', async () => {
		await expect(animatedWebpEncoder.available(CAPABILITIES)).resolves.toBe(true);
		await expect(
			animatedWebpEncoder.available({ ...CAPABILITIES, canvasEncode: new Set<string>() }),
		).resolves.toBe(false);
	});

	it('has no frame encoder of its own where there is no canvas', async () => {
		// Node has no drawing surface, so the default seam declines instead of
		// inventing frames. A browser is the only thing that can fill it.
		await expect(nativeWebpFrameEncoder(raster(4, 3), {})).rejects.toBeInstanceOf(
			CodecUnavailableError,
		);
		await expect(animatedWebpEncoder.encode(raster(4, 3), {}, CONTEXT)).rejects.toBeInstanceOf(
			CodecUnavailableError,
		);
	});
});
