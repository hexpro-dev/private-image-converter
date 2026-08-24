/**
 * APNG codec tests, and the PNG encoder's indexed output.
 *
 * Every fixture is assembled here from the field layouts in the specification:
 * `acTL` is two 32 bit counts, `fcTL` is 26 bytes of geometry and timing, and
 * `fdAT` is a sequence number followed by exactly the stream an `IDAT` holds.
 * Nothing below was produced by this package's encoder, and the compressed
 * pixels are stored deflate blocks written byte by byte with a hand computed
 * Adler-32, so a fixture is a fixed sequence of bytes rather than whatever the
 * platform's compressor felt like emitting.
 *
 * The composition cases are worked out from the two operator definitions on
 * paper. `APNG_BLEND_OP_OVER` in particular is checked against a pair whose
 * arithmetic is exact in eight bits, because a source-over written with the
 * wrong denominator agrees with the right one on every fully opaque frame,
 * which is most frames in most files.
 *
 * A separate rig under `scratch/` checks the same code against an APNG written
 * by ffmpeg, and reads back what this encoder writes with ffmpeg and with
 * ImageMagick. None of it is committed: nothing binary belongs in this
 * repository.
 */

import { describe, expect, it } from 'vitest';

import { decodeApng } from '../../src/codecs/png/apng.js';
import { encodeApng } from '../../src/codecs/png/apngEncode.js';
import { crc32 } from '../../src/codecs/png/crc.js';
import { decodePng } from '../../src/codecs/png/decode.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import { deflate, inflate } from '../../src/codecs/png/deflate.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { Animation, RasterImage } from '../../src/types.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* ── Building files ───────────────────────────────────────────────────── */

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

function ascii(text: string): Uint8Array {
	return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
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
 * 0x78 0x01 is the two byte header whose value is a multiple of 31 at the
 * lowest compression setting, which is what the FCHECK field requires. The
 * Adler-32 trailer is real, so `DecompressionStream` rejects this outright if
 * the layout is wrong rather than quietly handing back short data.
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

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(ascii(type), 4);
	out.set(data, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

interface HeaderPlan {
	readonly width: number;
	readonly height: number;
	readonly bitDepth?: number;
	readonly colourType?: number;
	readonly interlace?: number;
}

function ihdr(plan: HeaderPlan): Uint8Array {
	const body = new Uint8Array(13);
	const view = new DataView(body.buffer);
	view.setUint32(0, plan.width);
	view.setUint32(4, plan.height);
	body[8] = plan.bitDepth ?? 8;
	body[9] = plan.colourType ?? 6;
	body[12] = plan.interlace ?? 0;
	return chunk('IHDR', body);
}

function actl(frames: number, plays = 0): Uint8Array {
	const body = new Uint8Array(8);
	const view = new DataView(body.buffer);
	view.setUint32(0, frames);
	view.setUint32(4, plays);
	return chunk('acTL', body);
}

interface ControlPlan {
	readonly sequence: number;
	readonly width: number;
	readonly height: number;
	readonly x?: number;
	readonly y?: number;
	readonly delayNum?: number;
	readonly delayDen?: number;
	readonly dispose?: number;
	readonly blend?: number;
}

function fctl(plan: ControlPlan): Uint8Array {
	const body = new Uint8Array(26);
	const view = new DataView(body.buffer);
	view.setUint32(0, plan.sequence);
	view.setUint32(4, plan.width);
	view.setUint32(8, plan.height);
	view.setUint32(12, plan.x ?? 0);
	view.setUint32(16, plan.y ?? 0);
	view.setUint16(20, plan.delayNum ?? 0);
	view.setUint16(22, plan.delayDen ?? 0);
	body[24] = plan.dispose ?? 0;
	body[25] = plan.blend ?? 0;
	return chunk('fcTL', body);
}

/** Scanlines with a filter byte of 0 in front of each, then zlib wrapped. */
function imageData(rows: readonly (readonly number[])[]): Uint8Array {
	const raw: number[] = [];
	for (const row of rows) raw.push(0, ...row);
	return zlibStored(Uint8Array.from(raw));
}

function idat(rows: readonly (readonly number[])[]): Uint8Array {
	return chunk('IDAT', imageData(rows));
}

function fdat(sequence: number, rows: readonly (readonly number[])[]): Uint8Array {
	const data = imageData(rows);
	const body = new Uint8Array(4 + data.length);
	new DataView(body.buffer).setUint32(0, sequence);
	body.set(data, 4);
	return chunk('fdAT', body);
}

function apng(chunks: readonly Uint8Array[]): Uint8Array {
	return concat([Uint8Array.from(SIGNATURE), ...chunks, chunk('IEND', new Uint8Array(0))]);
}

/** A block of one colour, as the packed rows a frame of that size carries. */
function solid(width: number, height: number, colour: readonly number[]): number[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => colour).flat());
}

const CLEAR = [0, 0, 0, 0];
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];

function pixels(image: RasterImage): number[] {
	return Array.from(image.data);
}

/* ── Reading files back ───────────────────────────────────────────────── */

interface ReadChunk {
	readonly type: string;
	readonly data: Uint8Array;
	readonly crc: number;
	readonly recomputed: number;
}

function readChunks(bytes: Uint8Array): ReadChunk[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: ReadChunk[] = [];
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

function chunksNamed(bytes: Uint8Array, type: string): ReadChunk[] {
	return readChunks(bytes).filter((found) => found.type === type);
}

function chunkNamed(bytes: Uint8Array, type: string): ReadChunk {
	const found = chunksNamed(bytes, type)[0];
	if (!found) throw new Error(`the encoded file has no ${type} chunk`);
	return found;
}

interface ReadControl {
	readonly sequence: number;
	readonly width: number;
	readonly height: number;
	readonly x: number;
	readonly y: number;
	readonly delayNum: number;
	readonly delayDen: number;
	readonly dispose: number;
	readonly blend: number;
}

function readControls(bytes: Uint8Array): ReadControl[] {
	return chunksNamed(bytes, 'fcTL').map(({ data }) => {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return {
			sequence: view.getUint32(0),
			width: view.getUint32(4),
			height: view.getUint32(8),
			x: view.getUint32(12),
			y: view.getUint32(16),
			delayNum: view.getUint16(20),
			delayDen: view.getUint16(22),
			dispose: data[24] as number,
			blend: data[25] as number,
		};
	});
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

function frameRaster(
	width: number,
	height: number,
	fill: (x: number, y: number) => readonly number[],
	hasAlpha = false,
): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			image.data.set(fill(x, y), (y * width + x) * 4);
		}
	}
	return image;
}

/* ── The animation control chunk ──────────────────────────────────────── */

describe('the APNG animation control', () => {
	/** Two frames, the default image among them, at a known delay. */
	const twoFrames = apng([
		ihdr({ width: 1, height: 1 }),
		actl(2, 7),
		fctl({ sequence: 0, width: 1, height: 1, delayNum: 1, delayDen: 10 }),
		idat(solid(1, 1, RED)),
		fctl({ sequence: 1, width: 1, height: 1, delayNum: 1, delayDen: 10 }),
		fdat(2, solid(1, 1, GREEN)),
	]);

	it('reads the frame count from the frames the file carries', async () => {
		expect((await decodeApng(twoFrames)).animation.frames.length).toBe(2);
	});

	it('reads the loop count from num_plays', async () => {
		expect((await decodeApng(twoFrames)).animation.loopCount).toBe(7);
	});

	it('reads a num_plays of zero as forever, which is what loopCount means', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await decodeApng(file)).animation.loopCount).toBe(0);
	});

	it('reads the canvas size from IHDR rather than from a frame', async () => {
		const file = apng([
			ihdr({ width: 3, height: 2 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 3, height: 2 }),
			idat(solid(3, 2, BLUE)),
		]);
		const { image, animation } = await decodeApng(file);
		expect([image.width, image.height]).toEqual([3, 2]);
		expect([animation.frames[0]?.image.width, animation.frames[0]?.image.height]).toEqual([3, 2]);
	});
});

/* ── The default image ────────────────────────────────────────────────── */

describe('the APNG default image', () => {
	/** An fcTL before the IDAT: the default image is frame zero. */
	const animated = apng([
		ihdr({ width: 1, height: 1 }),
		actl(2, 0),
		fctl({ sequence: 0, width: 1, height: 1 }),
		idat(solid(1, 1, RED)),
		fctl({ sequence: 1, width: 1, height: 1 }),
		fdat(2, solid(1, 1, GREEN)),
	]);

	/** No fcTL before the IDAT: the default image is a poster frame. */
	const poster = apng([
		ihdr({ width: 1, height: 1 }),
		actl(2, 0),
		idat(solid(1, 1, BLUE)),
		fctl({ sequence: 0, width: 1, height: 1 }),
		fdat(1, solid(1, 1, RED)),
		fctl({ sequence: 2, width: 1, height: 1 }),
		fdat(3, solid(1, 1, GREEN)),
	]);

	it('counts the default image as a frame when an fcTL comes before it', async () => {
		const { animation } = await decodeApng(animated);
		expect(animation.frames.length).toBe(2);
		expect(pixels(animation.frames[0]!.image)).toEqual(RED);
		expect(pixels(animation.frames[1]!.image)).toEqual(GREEN);
	});

	it('leaves the default image out of the animation when no fcTL comes before it', async () => {
		// The classic bug: counting the poster frame as frame zero gives the
		// animation a frame nobody expected, and because a poster frame usually
		// looks like the animation it reads as a stutter rather than as a bug.
		const { animation } = await decodeApng(poster);
		expect(animation.frames.length).toBe(2);
		expect(pixels(animation.frames[0]!.image)).toEqual(RED);
		expect(pixels(animation.frames[1]!.image)).toEqual(GREEN);
	});

	it('still returns the poster frame as the still image', async () => {
		// It is what every reader that cannot animate shows, and it is what the
		// author chose to stand for the whole thing.
		expect(pixels((await decodeApng(poster)).image)).toEqual(BLUE);
	});

	it('returns frame zero as the still image when the default image is animated', async () => {
		const { image, animation } = await decodeApng(animated);
		expect(pixels(image)).toEqual(pixels(animation.frames[0]!.image));
	});

	it('reads the same frame count from both arrangements of the same animation', async () => {
		expect((await decodeApng(animated)).animation.frames.length).toBe(
			(await decodeApng(poster)).animation.frames.length,
		);
	});
});

/* ── Timing ───────────────────────────────────────────────────────────── */

describe('the APNG frame delay', () => {
	async function delayOf(delayNum: number, delayDen: number): Promise<number> {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1, delayNum, delayDen }),
			idat(solid(1, 1, RED)),
		]);
		return (await decodeApng(file)).animation.frames[0]!.delayMs;
	}

	it('reads a tenth of a second as a hundred milliseconds', async () => {
		expect(await delayOf(1, 10)).toBe(100);
	});

	it('reads a denominator of zero as a hundred, not as a division by zero', async () => {
		// The one place the format has a special case, and a reader that misses
		// it produces Infinity, which turns into a frame that never advances.
		expect(await delayOf(5, 0)).toBe(50);
	});

	it('keeps a delay that does not divide evenly', async () => {
		expect(await delayOf(1, 30)).toBeCloseTo(33.3333, 3);
	});

	it('reads whole seconds', async () => {
		expect(await delayOf(2, 1)).toBe(2000);
	});

	it('leaves a delay of zero as zero rather than inventing a frame rate', async () => {
		// Zero means "as fast as the reader can manage". Clamping it here would
		// put this reader's idea of a sensible rate into an encoder's output,
		// where the person converting the file cannot see it.
		expect(await delayOf(0, 100)).toBe(0);
	});

	it('reads the largest delay the fields can hold', async () => {
		expect(await delayOf(65535, 1)).toBe(65_535_000);
	});
});

/* ── Compositing ──────────────────────────────────────────────────────── */

describe('the APNG blend operations', () => {
	/** A 2 by 2 canvas whose first frame fills it, then one patch over it. */
	function twoFrame(
		patch: readonly number[],
		blend: number,
		base: readonly number[] = BLUE,
	): Uint8Array {
		return apng([
			ihdr({ width: 2, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, base)),
			fctl({ sequence: 1, width: 2, height: 2, blend }),
			fdat(2, solid(2, 2, patch)),
		]);
	}

	it('overwrites the region under APNG_BLEND_OP_SOURCE, alpha and all', async () => {
		// Source is the operation that can make a canvas more transparent than
		// it was. A reader that treats every frame as source-over cannot.
		const { animation } = await decodeApng(twoFrame(CLEAR, 0));
		expect(pixels(animation.frames[1]!.image)).toEqual([...CLEAR, ...CLEAR, ...CLEAR, ...CLEAR]);
	});

	it('composites under APNG_BLEND_OP_OVER', async () => {
		// Half of 255 is 128, and 255 less 128 is 127, so both channels are
		// exact in eight bits and a wrong denominator cannot hide in rounding.
		const { animation } = await decodeApng(twoFrame([255, 0, 0, 128], 1));
		expect(pixels(animation.frames[1]!.image).slice(0, 4)).toEqual([128, 0, 127, 255]);
	});

	it('leaves the canvas alone where an OVER frame is fully transparent', async () => {
		const { animation } = await decodeApng(twoFrame(CLEAR, 1));
		expect(pixels(animation.frames[1]!.image).slice(0, 4)).toEqual(BLUE);
	});

	it('replaces the canvas where an OVER frame is fully opaque', async () => {
		const { animation } = await decodeApng(twoFrame(RED, 1));
		expect(pixels(animation.frames[1]!.image).slice(0, 4)).toEqual(RED);
	});

	it('keeps a translucent OVER frame unchanged over a transparent canvas', async () => {
		// The specification notes that OVER on the first frame is the same as
		// SOURCE, because the canvas starts fully transparent. It only holds if
		// the source-over is written with the composite alpha as denominator.
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1, blend: 1 }),
			idat([[10, 20, 30, 128]]),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([10, 20, 30, 128]);
	});

	it('composites translucent over translucent', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[0, 0, 255, 128]]),
			fctl({ sequence: 1, width: 1, height: 1, blend: 1 }),
			fdat(2, [[255, 0, 0, 128]]),
		]);
		// Source and target are both 128 of 255, so the composite alpha is
		// 128/255 + (128/255)(127/255), which is 0.75198 and lands on 192. The
		// red keeps 128/255 of its 255 and the blue keeps the remaining
		// 0.25002 of its own, both divided back out by that composite alpha.
		const [r, g, b, a] = pixels((await decodeApng(file)).animation.frames[1]!.image);
		expect(a).toBe(192);
		expect(r).toBe(170);
		expect(g).toBe(0);
		expect(b).toBe(85);
	});

	it('blends only inside the frame rectangle', async () => {
		const file = apng([
			ihdr({ width: 2, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat(solid(2, 1, BLUE)),
			fctl({ sequence: 1, width: 1, height: 1, x: 1, blend: 1 }),
			fdat(2, [[255, 0, 0, 128]]),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[1]!.image)).toEqual([...BLUE, 128, 0, 127, 255]);
	});
});

describe('the APNG disposal operations', () => {
	/** Blue everywhere, then a red pixel top left, then a green one bottom right. */
	function threeFrame(dispose: number): Uint8Array {
		return apng([
			ihdr({ width: 2, height: 2 }),
			actl(3, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, BLUE)),
			fctl({ sequence: 1, width: 1, height: 1, dispose }),
			fdat(2, solid(1, 1, RED)),
			fctl({ sequence: 3, width: 1, height: 1, x: 1, y: 1 }),
			fdat(4, solid(1, 1, GREEN)),
		]);
	}

	it('leaves the canvas as it stands under APNG_DISPOSE_OP_NONE', async () => {
		const { animation } = await decodeApng(threeFrame(0));
		expect(pixels(animation.frames[2]!.image)).toEqual([...RED, ...BLUE, ...BLUE, ...GREEN]);
	});

	it('clears only the frame rectangle under APNG_DISPOSE_OP_BACKGROUND', async () => {
		// Clearing the whole canvas instead is the mistake that looks right on
		// a file whose frames all cover it.
		const { animation } = await decodeApng(threeFrame(1));
		expect(pixels(animation.frames[2]!.image)).toEqual([...CLEAR, ...BLUE, ...BLUE, ...GREEN]);
	});

	it('puts back what was underneath under APNG_DISPOSE_OP_PREVIOUS', async () => {
		const { animation } = await decodeApng(threeFrame(2));
		expect(pixels(animation.frames[2]!.image)).toEqual([...BLUE, ...BLUE, ...BLUE, ...GREEN]);
	});

	it('shows the frame before disposing of it', async () => {
		// Disposal prepares the canvas for the next frame. Doing it before the
		// frame is drawn instead is wrong by exactly one frame, which reads as
		// an animation that is a beat behind rather than as a broken one.
		for (const dispose of [0, 1, 2]) {
			const { animation } = await decodeApng(threeFrame(dispose));
			expect(pixels(animation.frames[1]!.image), `disposal ${dispose}`).toEqual([
				...RED,
				...BLUE,
				...BLUE,
				...BLUE,
			]);
		}
	});

	it('treats APNG_DISPOSE_OP_PREVIOUS on the first frame as a clear', async () => {
		// The specification says so outright, and it falls out of keeping the
		// region rather than needing a case: the canvas starts fully
		// transparent, so putting the first frame's rectangle back clears it.
		const file = apng([
			ihdr({ width: 2, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1, dispose: 2 }),
			idat(solid(2, 1, BLUE)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(2, solid(1, 1, RED)),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[1]!.image)).toEqual([...RED, ...CLEAR]);
	});

	it('restores a rectangle that is not at the origin', async () => {
		const file = apng([
			ihdr({ width: 2, height: 2 }),
			actl(3, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, BLUE)),
			fctl({ sequence: 1, width: 1, height: 1, x: 1, y: 1, dispose: 2 }),
			fdat(2, solid(1, 1, RED)),
			fctl({ sequence: 3, width: 1, height: 1 }),
			fdat(4, solid(1, 1, GREEN)),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[2]!.image)).toEqual([...GREEN, ...BLUE, ...BLUE, ...BLUE]);
	});
});

describe('the APNG frame rectangle', () => {
	it('lands a frame at the offset it declares', async () => {
		const file = apng([
			ihdr({ width: 3, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 3, height: 2 }),
			idat(solid(3, 2, BLUE)),
			fctl({ sequence: 1, width: 1, height: 1, x: 2, y: 1 }),
			fdat(2, solid(1, 1, RED)),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[1]!.image)).toEqual([
			...BLUE,
			...BLUE,
			...BLUE,
			...BLUE,
			...BLUE,
			...RED,
		]);
	});

	it('reads a patch that is wider than it is tall the right way round', async () => {
		// A frame's rows are its own width, not the canvas width. Reading them
		// at the canvas stride skews the patch, which on a small frame looks
		// like a colour bug rather than a geometry one.
		const file = apng([
			ihdr({ width: 3, height: 3 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 3, height: 3 }),
			idat(solid(3, 3, CLEAR)),
			fctl({ sequence: 1, width: 2, height: 1, x: 1, y: 2 }),
			fdat(2, [[...RED, ...GREEN]]),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[1]!.image).slice(24)).toEqual([...CLEAR, ...RED, ...GREEN]);
	});

	it('accepts a frame that exactly reaches the far edge', async () => {
		const file = apng([
			ihdr({ width: 2, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, CLEAR)),
			fctl({ sequence: 1, width: 1, height: 1, x: 1, y: 1 }),
			fdat(2, solid(1, 1, RED)),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[1]!.image).slice(12)).toEqual(RED);
	});
});

/* ── The pixel formats a frame can be in ──────────────────────────────── */

describe('the APNG frame formats', () => {
	it('reads greyscale frames', async () => {
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 0 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0, 255]]),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(2, [[128]]),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[0]!.image)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
		expect(pixels(animation.frames[1]!.image).slice(0, 4)).toEqual([128, 128, 128, 255]);
	});

	it('reads one bit greyscale frames', async () => {
		const file = apng([
			ihdr({ width: 8, height: 1, bitDepth: 1, colourType: 0 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 8, height: 1 }),
			idat([[0b10110010]]),
		]);
		const frame = (await decodeApng(file)).animation.frames[0]!.image;
		expect(pixels(frame).filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255, 255, 0, 0, 255, 0]);
	});

	it('reads sixteen bit frames', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1, bitDepth: 16, colourType: 2 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[0xff, 0xff, 0x00, 0x00, 0x80, 0x00]]),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([255, 0, 128, 255]);
	});

	it('reads palettised frames, sharing the one PLTE', async () => {
		// A frame has no palette of its own. A reader that looked for one per
		// frame would find nothing and paint every patch black.
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 3 }),
			chunk('PLTE', Uint8Array.from([255, 0, 0, 0, 255, 0])),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0, 1]]),
			fctl({ sequence: 1, width: 1, height: 1, x: 1 }),
			fdat(2, [[0]]),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[0]!.image)).toEqual([...RED, ...GREEN]);
		expect(pixels(animation.frames[1]!.image)).toEqual([...RED, ...RED]);
	});

	it('reads a tRNS table alongside a palette', async () => {
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 3 }),
			chunk('PLTE', Uint8Array.from([255, 0, 0, 0, 255, 0])),
			chunk('tRNS', Uint8Array.from([0])),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0, 1]]),
		]);
		const frame = (await decodeApng(file)).animation.frames[0]!.image;
		expect(pixels(frame)).toEqual([255, 0, 0, 0, ...GREEN]);
		expect(frame.hasAlpha).toBe(true);
	});

	it('lets a colour key show the canvas through a truecolour frame', async () => {
		// A tRNS beside a file with no alpha channel names one colour, and every
		// pixel of that colour is fully transparent. Compositing it opaque paints
		// a block of key colour where the frame meant to leave the canvas alone,
		// which is a magenta rectangle in the middle of somebody's animation.
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 2 }),
			chunk('tRNS', Uint8Array.from([0, 255, 0, 0, 0, 255])),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat(solid(2, 1, [0, 0, 255])),
			fctl({ sequence: 1, width: 2, height: 1, blend: 1 }),
			fdat(2, [[0, 255, 0, 255, 0, 255]]),
		]);
		const { animation } = await decodeApng(file);
		expect(pixels(animation.frames[1]!.image)).toEqual([...GREEN, ...BLUE]);
	});

	it('reads a greyscale colour key as transparent', async () => {
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 0 }),
			chunk('tRNS', Uint8Array.from([0, 0])),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0, 128]]),
		]);
		const frame = (await decodeApng(file)).animation.frames[0]!.image;
		expect(pixels(frame)).toEqual([0, 0, 0, 0, 128, 128, 128, 255]);
		expect(frame.hasAlpha).toBe(true);
	});

	it('compares a colour key against the samples the file holds, not scaled ones', async () => {
		// A key of 1 in a one bit file is the white pixel. Scaling the key to
		// eight bits first looks for 255 among samples that only ever hold 0 or
		// 1, and then nothing is ever transparent.
		const file = apng([
			ihdr({ width: 2, height: 1, bitDepth: 1, colourType: 0 }),
			chunk('tRNS', Uint8Array.from([0, 1])),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0b0100_0000]]),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([
			0, 0, 0, 255, 255, 255, 255, 0,
		]);
	});

	it('compares a sixteen bit colour key at sixteen bits', async () => {
		// 0x0101 and 0x0100 both come out as 1 once they are scaled to eight
		// bits, so a reader that compares after scaling makes the wrong pixel
		// disappear and keeps the one the file singled out.
		const file = apng([
			ihdr({ width: 2, height: 1, bitDepth: 16, colourType: 2 }),
			chunk('tRNS', Uint8Array.from([1, 1, 0, 0, 0, 0])),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0x01, 0x01, 0, 0, 0, 0, 0x01, 0x00, 0, 0, 0, 0]]),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([
			1, 0, 0, 0, 1, 0, 0, 255,
		]);
	});

	it('ignores a tRNS too short for the colour type it sits beside', async () => {
		// Lenient for the same reason the short palette above is: the picture is
		// still there to be read, and one badly written ancillary chunk is a poor
		// reason to hand somebody nothing.
		const truecolour = apng([
			ihdr({ width: 1, height: 1, colourType: 2 }),
			chunk('tRNS', Uint8Array.from([0, 255])),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[255, 0, 255]]),
		]);
		const grey = apng([
			ihdr({ width: 1, height: 1, colourType: 0 }),
			chunk('tRNS', Uint8Array.from([0])),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[0]]),
		]);
		expect(pixels((await decodeApng(truecolour)).animation.frames[0]!.image)).toEqual([
			255, 0, 255, 255,
		]);
		expect(pixels((await decodeApng(grey)).animation.frames[0]!.image)).toEqual([0, 0, 0, 255]);
	});

	it('reads the same colour key on the still path', async () => {
		// The same assembler with none of the animation chunks in it is an
		// ordinary PNG. A frame uses the key to let the canvas through and a still
		// uses it to let the page through, and one implementation reads both.
		const still = apng([
			ihdr({ width: 2, height: 1, colourType: 2 }),
			chunk('tRNS', Uint8Array.from([0, 255, 0, 0, 0, 255])),
			idat([[255, 0, 255, 0, 0, 255]]),
		]);
		const image = await decodePng(still);
		expect(pixels(image)).toEqual([255, 0, 255, 0, ...BLUE]);
		expect(image.hasAlpha).toBe(true);
	});

	it('reads an index its palette does not reach as black', async () => {
		// Lenient on purpose, and worth naming so it does not drift. A palette
		// shorter than the indices in the file is a broken file, but the pixels
		// around the broken one are fine, and a frame of an animation is a poor
		// place to give up on the whole thing.
		const file = apng([
			ihdr({ width: 2, height: 1, colourType: 3 }),
			chunk('PLTE', Uint8Array.from([255, 0, 0])),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat([[0, 3]]),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([
			...RED,
			0,
			0,
			0,
			255,
		]);
	});

	it('carries a cICP colour space onto the canvas and every frame', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			chunk('cICP', Uint8Array.from([12, 13, 0, 1])),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		const { image, animation } = await decodeApng(file);
		expect(image.colourSpace).toBe('display-p3');
		expect(animation.frames[0]!.image.colourSpace).toBe('display-p3');
	});

	it('reads an sRGB file as sRGB', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			chunk('cICP', Uint8Array.from([1, 13, 0, 1])),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await decodeApng(file)).animation.frames[0]!.image.colourSpace).toBe('srgb');
	});

	it('applies the scanline filters inside a frame', async () => {
		// The frame data is an ordinary PNG stream, filters and all, so a reader
		// that only handles filter 0 works on hand written fixtures and fails on
		// every file a real encoder produced.
		// Row zero stored as it is, row one filtered against the row above it.
		const raw = Uint8Array.from([0, 10, 20, 30, 255, 2, 5, 6, 7, 0]);
		const body = new Uint8Array(4 + zlibStored(raw).length);
		new DataView(body.buffer).setUint32(0, 2);
		body.set(zlibStored(raw), 4);
		const file = apng([
			ihdr({ width: 1, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 2 }),
			idat(solid(1, 2, CLEAR)),
			fctl({ sequence: 1, width: 1, height: 2 }),
			chunk('fdAT', body),
		]);
		const frame = (await decodeApng(file)).animation.frames[1]!.image;
		expect(pixels(frame)).toEqual([10, 20, 30, 255, 15, 26, 37, 255]);
	});

	it('reports transparency on a frame that has some and not on one that has none', async () => {
		const file = apng([
			ihdr({ width: 2, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat(solid(2, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(2, [[0, 0, 0, 0]]),
		]);
		const { animation } = await decodeApng(file);
		expect(animation.frames[0]!.image.hasAlpha).toBe(false);
		expect(animation.frames[1]!.image.hasAlpha).toBe(true);
	});
});

/* ── Chunk handling ───────────────────────────────────────────────────── */

describe('the APNG chunk walk', () => {
	it('joins frame data split across several fdAT chunks', async () => {
		// A real encoder splits at some chunk size, so a reader that only takes
		// the first fdAT works on everything it wrote itself and on little else.
		const whole = imageData(solid(2, 1, GREEN));
		function part(sequence: number, slice: Uint8Array): Uint8Array {
			const body = new Uint8Array(4 + slice.length);
			new DataView(body.buffer).setUint32(0, sequence);
			body.set(slice, 4);
			return chunk('fdAT', body);
		}
		const file = apng([
			ihdr({ width: 2, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat(solid(2, 1, RED)),
			fctl({ sequence: 1, width: 2, height: 1 }),
			part(2, whole.subarray(0, 3)),
			part(3, whole.subarray(3)),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[1]!.image)).toEqual([
			...GREEN,
			...GREEN,
		]);
	});

	it('joins a default image split across several IDAT chunks', async () => {
		const whole = imageData(solid(2, 1, RED));
		const file = apng([
			ihdr({ width: 2, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			chunk('IDAT', whole.subarray(0, 4)),
			chunk('IDAT', whole.subarray(4)),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual([...RED, ...RED]);
	});

	it('steps over a chunk it has no use for', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			chunk('tEXt', ascii('Comment\0nothing to see')),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			chunk('gAMA', Uint8Array.from([0, 1, 0x86, 0xa0])),
			idat(solid(1, 1, RED)),
		]);
		expect(pixels((await decodeApng(file)).animation.frames[0]!.image)).toEqual(RED);
	});

	it('stops at IEND rather than reading whatever follows it', async () => {
		const file = concat([
			apng([
				ihdr({ width: 1, height: 1 }),
				actl(1, 0),
				fctl({ sequence: 0, width: 1, height: 1 }),
				idat(solid(1, 1, RED)),
			]),
			ascii('and then something else entirely'),
		]);
		expect((await decodeApng(file)).animation.frames.length).toBe(1);
	});

	it('reads a file sitting inside a larger buffer', async () => {
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, GREEN)),
		]);
		const padded = new Uint8Array(file.length + 48);
		padded.set(file, 16);
		const decoded = await decodeApng(padded.subarray(16, 16 + file.length));
		expect(pixels(decoded.animation.frames[0]!.image)).toEqual(GREEN);
	});

	it('reads a long animation frame by frame', async () => {
		// Twenty frames, each one pixel further along a strip, so a reader that
		// composited into the wrong buffer or reused a frame comes out obviously
		// wrong rather than subtly so.
		const chunks: Uint8Array[] = [ihdr({ width: 20, height: 1 }), actl(20, 0)];
		chunks.push(fctl({ sequence: 0, width: 20, height: 1 }), idat(solid(20, 1, CLEAR)));
		for (let i = 1; i < 20; i += 1) {
			chunks.push(fctl({ sequence: i * 2 - 1, width: 1, height: 1, x: i }));
			chunks.push(fdat(i * 2, solid(1, 1, RED)));
		}
		const { animation } = await decodeApng(apng(chunks));
		expect(animation.frames.length).toBe(20);
		expect(pixels(animation.frames[19]!.image).filter((_, i) => i % 4 === 3)).toEqual([
			0,
			...new Array<number>(19).fill(255),
		]);
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('the APNG decoder over files it will not read', () => {
	async function expectRefusal(bytes: Uint8Array): Promise<DecodeFailedError> {
		let thrown: unknown;
		try {
			await decodeApng(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('apng');
		expect(error.decoderId).toBe('apng-pure');
		expect(error.message.length).toBeGreaterThan(20);
		return error;
	}

	const valid = apng([
		ihdr({ width: 2, height: 1 }),
		actl(2, 0),
		fctl({ sequence: 0, width: 2, height: 1 }),
		idat(solid(2, 1, RED)),
		fctl({ sequence: 1, width: 2, height: 1 }),
		fdat(2, solid(2, 1, GREEN)),
	]);

	it('reads the file the damaged ones below are made from', async () => {
		expect((await decodeApng(valid)).animation.frames.length).toBe(2);
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
		const bytes = Uint8Array.from(valid);
		new DataView(bytes.buffer).setUint32(8 + 25, 0x00ff_ffff);
		expect((await expectRefusal(bytes)).message).toContain('past the end');
	});

	it('refuses a file with no header chunk', async () => {
		const bytes = apng([actl(1, 0), fctl({ sequence: 0, width: 1, height: 1 }), idat([[1]])]);
		expect((await expectRefusal(bytes)).message).toContain('header chunk');
	});

	it('refuses a header chunk too short to hold the image description', async () => {
		const bytes = apng([
			chunk('IHDR', new Uint8Array(9)),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[1]]),
		]);
		expect((await expectRefusal(bytes)).message).toContain('too short');
	});

	it('refuses a file with no image data', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
		]);
		expect((await expectRefusal(bytes)).message).toContain('image data');
	});

	it('refuses a still PNG, which has no animation in it to read', async () => {
		// This is a person converting the wrong file, so the message says what
		// is missing rather than that something is broken.
		const bytes = apng([ihdr({ width: 1, height: 1 }), idat(solid(1, 1, RED))]);
		expect((await expectRefusal(bytes)).message).toContain('animation control');
	});

	it('refuses an animation control chunk too short to read', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			chunk('acTL', Uint8Array.from([0, 0, 0, 1])),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('animation control');
	});

	it('refuses a file carrying fewer frames than it declares', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(3, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('3 frames and describes 1');
	});

	it('refuses a file carrying more frames than it declares', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(2, solid(1, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('1 frames and describes 2');
	});

	it('refuses a file that declares no frames at all', async () => {
		const bytes = apng([ihdr({ width: 1, height: 1 }), actl(0, 0), idat(solid(1, 1, RED))]);
		expect((await expectRefusal(bytes)).message).toContain('no frames');
	});

	it('refuses a sequence number that skips one', async () => {
		// The numbers are the only thing tying the two chunk types into one
		// order, so a gap means a frame was dropped somewhere between here and
		// whatever wrote the file.
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 2, width: 1, height: 1 }),
			fdat(3, solid(1, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('numbered 2 where 1 was expected');
	});

	it('refuses a repeated sequence number', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(1, solid(1, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('numbered 1 where 2 was expected');
	});

	it('refuses a sequence that does not start at zero', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 1, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('numbered 1 where 0 was expected');
	});

	it('refuses frame data that arrives before any frame is described', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			idat(solid(1, 1, RED)),
			fdat(0, solid(1, 1, GREEN)),
			fctl({ sequence: 1, width: 1, height: 1 }),
		]);
		expect((await expectRefusal(bytes)).message).toContain('before any frame');
	});

	it('refuses a frame control chunk shorter than its 26 bytes of fields', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			chunk('fcTL', new Uint8Array(20)),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('26 bytes');
	});

	it('refuses frame data too short to hold its sequence number', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			chunk('fdAT', Uint8Array.from([0, 0])),
		]);
		expect((await expectRefusal(bytes)).message).toContain('sequence number');
	});

	it('refuses a frame that carries no data of its own', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
		]);
		expect((await expectRefusal(bytes)).message).toContain('carries no data');
	});

	it('refuses a frame whose frame data chunks are all empty', async () => {
		// An fdAT carrying its sequence number and nothing after it is a legal
		// chunk holding no data at all. Counting chunks rather than bytes lets a
		// frame made of those through to the decompressor, which fails on an empty
		// stream with a bare TypeError whose message is the empty string.
		const body = new Uint8Array(4);
		new DataView(body.buffer).setUint32(0, 2);
		const bytes = apng([
			ihdr({ width: 2, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, RED)),
			fctl({ sequence: 1, width: 2, height: 2 }),
			chunk('fdAT', body),
		]);
		expect((await expectRefusal(bytes)).message).toContain('carries no data');
	});

	it('refuses a frame that reaches past the edge of the canvas', async () => {
		// Compositing it anyway writes into the next row, or past the end of the
		// buffer, which is how a decoder becomes a security problem.
		const bytes = apng([
			ihdr({ width: 2, height: 2 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 2 }),
			idat(solid(2, 2, RED)),
			fctl({ sequence: 1, width: 2, height: 1, x: 1 }),
			fdat(2, solid(2, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('past the edge');
	});

	it('refuses a frame taller than the canvas', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 2 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('past the edge');
	});

	it('refuses a frame with no width', async () => {
		const bytes = apng([
			ihdr({ width: 2, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 2, height: 1 }),
			idat(solid(2, 1, RED)),
			fctl({ sequence: 1, width: 0, height: 1 }),
			fdat(2, solid(1, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('width or a height of zero');
	});

	it('refuses a disposal method that does not exist', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1, dispose: 3 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('disposal method 3');
	});

	it('refuses a blend method that does not exist', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1, blend: 2 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('blend method 2');
	});

	it('refuses more than one frame described before the image data', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			fctl({ sequence: 1, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('before the image data');
	});

	it('refuses a default image frame that does not cover the canvas', async () => {
		const bytes = apng([
			ihdr({ width: 2, height: 2 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(2, 2, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('does not cover the whole canvas');
	});

	it('refuses a default image frame that is offset', async () => {
		const bytes = apng([
			ihdr({ width: 2, height: 2 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 2, height: 2, x: 1 }),
			idat(solid(2, 2, RED)),
		]);
		// The offset alone puts it past the edge, which is caught first and is
		// the more useful of the two things to say.
		expect((await expectRefusal(bytes)).message).toContain('past the edge');
	});

	it('refuses a first frame that carries both image data and frame data', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fdat(1, solid(1, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('may hold only one');
	});

	it('refuses frame data for the first frame that arrives before the image data', async () => {
		// The same contradiction from the other side. Which of the two the file
		// meant is not knowable, and picking one quietly is how a reader ends up
		// showing a frame the author never wrote.
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			fdat(1, solid(1, 1, GREEN)),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('may hold only one');
	});

	it('refuses an interlaced file by name', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1, interlace: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('interlaced');
	});

	it('refuses a colour type that does not exist', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1, colourType: 5 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('colour type 5');
	});

	it.each([
		[16, 3],
		[2, 2],
		[3, 0],
		[8, 7],
	])('refuses %i bits per sample with colour type %i', async (bitDepth, colourType) => {
		const bytes = apng([
			ihdr({ width: 1, height: 1, bitDepth, colourType }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		const message = (await expectRefusal(bytes)).message;
		expect(message).toMatch(/bits per sample|colour type/);
	});

	it('refuses a palettised file with no palette', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1, colourType: 3 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat([[0]]),
		]);
		expect((await expectRefusal(bytes)).message).toContain('palette');
	});

	it('refuses a canvas with no width', async () => {
		const bytes = apng([
			ihdr({ width: 0, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('width or a height of zero');
	});

	it('refuses a canvas too large to allocate, before allocating it', async () => {
		// Sixty thousand square is fourteen gigabytes of raster described by
		// eight bytes of header. Trying it and catching the failure is not the
		// same thing: the allocator takes the tab down with it.
		const bytes = apng([
			ihdr({ width: 60_000, height: 60_000 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 60_000, height: 60_000 }),
			idat(solid(1, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('more pixels');
	});

	it('refuses more frames than it will hold at that canvas size', async () => {
		// Every frame is kept as a whole picture, so the memory a file asks for
		// is the canvas times the frame count, and a few hundred bytes of
		// control chunks can ask for gigabytes.
		const chunks: Uint8Array[] = [ihdr({ width: 1000, height: 1000 }), actl(300, 0)];
		chunks.push(fctl({ sequence: 0, width: 1000, height: 1000 }), idat([[0]]));
		for (let i = 1; i < 300; i += 1) {
			chunks.push(fctl({ sequence: i * 2 - 1, width: 1000, height: 1000 }));
			chunks.push(fdat(i * 2, [[0]]));
		}
		expect((await expectRefusal(apng(chunks))).message).toContain('in memory at once');
	});

	it('refuses a scanline filter type that does not exist', async () => {
		const raw = Uint8Array.from([9, 1, 2, 3, 4]);
		const file = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			chunk('IDAT', zlibStored(raw)),
		]);
		expect((await expectRefusal(file)).message).toContain('filter type 9');
	});

	it('refuses a frame whose data is shorter than its rectangle', async () => {
		const bytes = apng([
			ihdr({ width: 4, height: 4 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 4, height: 4 }),
			idat(solid(4, 4, RED)),
			fctl({ sequence: 1, width: 4, height: 4 }),
			fdat(2, solid(4, 1, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('shorter');
	});

	it('refuses a default image shorter than the canvas', async () => {
		const bytes = apng([
			ihdr({ width: 4, height: 4 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 4, height: 4 }),
			idat(solid(4, 1, RED)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('shorter');
	});

	it('refuses a frame carrying more data than its rectangle holds', async () => {
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			fdat(2, solid(1, 2, GREEN)),
		]);
		expect((await expectRefusal(bytes)).message).toContain('expands to more');
	});

	it('refuses image data that expands far past the canvas, without allocating it', async () => {
		// The one fixture here the platform's compressor wrote, because the whole
		// point of it is the ratio: deflate runs to about a thousand to one, so a
		// megabyte of file asks for a gigabyte of memory. None of the size
		// refusals above can see it coming. The canvas gate reads the header and
		// the header says one pixel; the frame count gate multiplies that one
		// pixel by one frame. Measuring the stream once it is in memory is too
		// late on a phone, so it is counted as it arrives and dropped.
		const bomb = await deflate(new Uint8Array(4_000_000));
		expect(bomb.length).toBeLessThan(20_000);
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(1, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			chunk('IDAT', bomb),
		]);
		expect((await expectRefusal(bytes)).message).toContain('expands to more');
	});

	it('refuses a frame whose compressed data cannot be decompressed at all', async () => {
		// A damaged stream comes back out of the platform as a TypeError carrying
		// an empty message, which names neither the format nor the reason and
		// tells the person holding the file nothing.
		const body = Uint8Array.from([0, 0, 0, 2, 0xff, 0xff, 0xff, 0xff]);
		const bytes = apng([
			ihdr({ width: 1, height: 1 }),
			actl(2, 0),
			fctl({ sequence: 0, width: 1, height: 1 }),
			idat(solid(1, 1, RED)),
			fctl({ sequence: 1, width: 1, height: 1 }),
			chunk('fdAT', body),
		]);
		expect((await expectRefusal(bytes)).message).toContain('damaged');
	});

	it('names no file in any of its messages', async () => {
		// The one rule every message here has to keep: somebody's photograph is
		// called IMG_2059.HEIC, but it is just as often called something they
		// would not want in a screenshot pasted into a bug report.
		const bytes = apng([ihdr({ width: 1, height: 1 }), idat(solid(1, 1, RED))]);
		expect((await expectRefusal(bytes)).message).not.toMatch(/\.(png|apng)\b/i);
	});
});

/* ── Writing ──────────────────────────────────────────────────────────── */

describe('the APNG the encoder writes', () => {
	const first = frameRaster(2, 2, () => RED);
	const second = frameRaster(2, 2, () => GREEN);
	const animation: Animation = {
		frames: [
			{ image: first, delayMs: 100 },
			{ image: second, delayMs: 250 },
		],
		loopCount: 0,
	};

	it('starts with the eight byte signature', async () => {
		const bytes = await encodeApng(first, { animation });
		expect([...bytes.subarray(0, 8)]).toEqual(SIGNATURE);
	});

	it('writes an IHDR at the canvas size, depth 8 and no interlacing', async () => {
		const bytes = await encodeApng(first, { animation });
		expect(readHeader(bytes)).toEqual([2, 2, 8, 2, 0, 0, 0]);
	});

	it('writes the chunks in the order a reader expects', async () => {
		// acTL before the image data, the first frame's control before its IDAT,
		// and every later frame's control before its data. A reader is entitled
		// to give up at the first chunk that arrives out of order.
		const bytes = await encodeApng(first, { animation });
		expect(readChunks(bytes).map((piece) => piece.type)).toEqual([
			'IHDR',
			'acTL',
			'fcTL',
			'IDAT',
			'fcTL',
			'fdAT',
			'IEND',
		]);
	});

	it('writes an acTL holding the frame count and the loop count', async () => {
		const bytes = await encodeApng(first, {
			animation: { frames: animation.frames, loopCount: 5 },
		});
		const { data } = chunkNamed(bytes, 'acTL');
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		expect([view.getUint32(0), view.getUint32(4)]).toEqual([2, 5]);
	});

	it('numbers fcTL and fdAT in one ascending run with no gaps', async () => {
		const bytes = await encodeApng(first, { animation });
		const numbers: number[] = [];
		for (const piece of readChunks(bytes)) {
			if (piece.type !== 'fcTL' && piece.type !== 'fdAT') continue;
			const view = new DataView(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength);
			numbers.push(view.getUint32(0));
		}
		expect(numbers).toEqual([0, 1, 2]);
	});

	it('gives the first frame no sequence number of its own in the IDAT', async () => {
		// An IDAT carries no sequence number, because a reader that cannot
		// animate has to be able to ignore every chunk that does.
		const bytes = await encodeApng(first, { animation });
		const idatData = chunkNamed(bytes, 'IDAT').data;
		expect([...(await inflate(idatData))].length).toBe((2 * 3 + 1) * 2);
	});

	it('writes every frame at the full canvas size and at the origin', async () => {
		const controls = readControls(await encodeApng(first, { animation }));
		expect(
			controls.map((control) => [control.width, control.height, control.x, control.y]),
		).toEqual([
			[2, 2, 0, 0],
			[2, 2, 0, 0],
		]);
	});

	it('writes disposal NONE and blend SOURCE on every frame', async () => {
		// Correct for whole frames whatever came before them, which is the whole
		// reason this writer only writes whole frames.
		const controls = readControls(await encodeApng(first, { animation }));
		for (const control of controls) {
			expect([control.dispose, control.blend]).toEqual([0, 0]);
		}
	});

	it('gives every chunk a CRC that validates when recomputed', async () => {
		const bytes = await encodeApng(first, {
			animation,
			iccProfile: Uint8Array.from({ length: 64 }, (_, i) => i),
		});
		const chunks = readChunks(bytes);
		expect(chunks.length).toBeGreaterThan(5);
		for (const piece of chunks) {
			expect(piece.recomputed, `CRC of the ${piece.type} chunk`).toBe(piece.crc);
		}
	});

	it('ends with an empty IEND carrying the CRC that constant always has', async () => {
		const chunks = readChunks(await encodeApng(first, { animation }));
		const last = chunks[chunks.length - 1] as ReadChunk;
		expect(last.type).toBe('IEND');
		expect(last.data.length).toBe(0);
		expect(last.crc).toBe(0xae426082);
	});

	it('writes colour type 6 when any frame carries alpha and 2 when none does', async () => {
		const clear = frameRaster(2, 2, () => CLEAR, true);
		expect(readHeader(await encodeApng(first, { animation }))[3]).toBe(2);
		expect(
			readHeader(
				await encodeApng(first, {
					animation: {
						frames: [
							{ image: first, delayMs: 0 },
							{ image: clear, delayMs: 0 },
						],
						loopCount: 0,
					},
				}),
			)[3],
		).toBe(6);
	});

	it('writes an opaque frame opaque in a file that carries alpha', async () => {
		// A raster that says it has no alpha is written opaque whatever its
		// fourth bytes hold. A buffer straight from `createRaster` is all
		// zeroes, and honouring that alpha writes a frame nobody can see.
		const blank = createRaster(2, 2, 'srgb', false);
		blank.data.set([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0]);
		const translucent = frameRaster(2, 2, () => [0, 0, 0, 0], true);
		const bytes = await encodeApng(blank, {
			animation: {
				frames: [
					{ image: blank, delayMs: 0 },
					{ image: translucent, delayMs: 0 },
				],
				loopCount: 0,
			},
		});
		const { animation: back } = await decodeApng(bytes);
		expect(pixels(back.frames[0]!.image)).toEqual([
			1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
		]);
	});

	it('writes a single frame APNG when it is given no animation', async () => {
		const bytes = await encodeApng(first);
		expect(readChunks(bytes).map((piece) => piece.type)).toEqual([
			'IHDR',
			'acTL',
			'fcTL',
			'IDAT',
			'IEND',
		]);
		const { data } = chunkNamed(bytes, 'acTL');
		expect(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)).toBe(1);
	});

	it('falls back to the image when the animation carries no frames', async () => {
		const bytes = await encodeApng(first, { animation: { frames: [], loopCount: 4 } });
		expect(chunksNamed(bytes, 'fcTL').length).toBe(1);
		// The loop count is still the caller's, because they did say that much.
		const { data } = chunkNamed(bytes, 'acTL');
		expect(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4)).toBe(4);
	});

	it('carries an ICC profile through to the file', async () => {
		const profile = Uint8Array.from({ length: 128 }, (_, i) => (i * 7) & 0xff);
		const bytes = await encodeApng(first, { animation, iccProfile: profile });
		const { data } = chunkNamed(bytes, 'iCCP');
		const terminator = data.indexOf(0);
		expect(String.fromCharCode(...data.subarray(0, terminator))).toBe('ICC profile');
		expect([...(await inflate(data.subarray(terminator + 2)))]).toEqual([...profile]);
	});

	it('writes a colour tag from the frames rather than from the fallback image', async () => {
		const wide = frameRaster(2, 2, () => RED);
		const bytes = await encodeApng(createRaster(2, 2, 'srgb'), {
			animation: {
				frames: [{ image: { ...wide, colourSpace: 'display-p3' }, delayMs: 0 }],
				loopCount: 0,
			},
			writeColourTag: true,
		});
		expect([...chunkNamed(bytes, 'cICP').data]).toEqual([12, 13, 0, 1]);
	});
});

describe('the APNG encoder delay field', () => {
	async function delayFieldsOf(delayMs: number): Promise<number[]> {
		const image = frameRaster(1, 1, () => RED);
		const bytes = await encodeApng(image, {
			animation: { frames: [{ image, delayMs }], loopCount: 0 },
		});
		const control = readControls(bytes)[0] as ReadControl;
		return [control.delayNum, control.delayDen];
	}

	it('writes milliseconds over a thousand, which is exact', async () => {
		expect(await delayFieldsOf(100)).toEqual([100, 1000]);
	});

	it('writes a delay of zero as zero', async () => {
		expect(await delayFieldsOf(0)).toEqual([0, 1000]);
	});

	it('coarsens the denominator when the numerator would not fit', async () => {
		// Both fields are unsigned 16 bit, so 65.535 seconds is as long as a
		// thousandth of a second can express. A numerator that wrapped instead
		// would turn a long pause into a short one.
		expect(await delayFieldsOf(70_000)).toEqual([7000, 100]);
		expect(await delayFieldsOf(700_000)).toEqual([7000, 10]);
		expect(await delayFieldsOf(7_000_000)).toEqual([7000, 1]);
	});

	it('clamps a delay longer than the fields can hold', async () => {
		expect(await delayFieldsOf(100_000_000)).toEqual([0xffff, 1]);
	});

	it('treats a delay that is not a number as no delay at all', async () => {
		expect(await delayFieldsOf(Number.NaN)).toEqual([0, 1000]);
		expect(await delayFieldsOf(-5)).toEqual([0, 1000]);
	});
});

describe('the APNG encoder over images it will not write', () => {
	function expectRefusal(run: () => Promise<Uint8Array>): Promise<EncodeFailedError> {
		return run().then(
			() => {
				throw new Error('the encoder accepted an image it should have refused');
			},
			(error: unknown) => {
				expect(error).toBeInstanceOf(EncodeFailedError);
				const failure = error as EncodeFailedError;
				expect(failure.code).toBe('encode/failed');
				expect(failure.format).toBe('apng');
				expect(failure.encoderId).toBe('apng-pure');
				return failure;
			},
		);
	}

	it('refuses frames that are not all the same size', async () => {
		const error = await expectRefusal(() =>
			encodeApng(
				frameRaster(2, 2, () => RED),
				{
					animation: {
						frames: [
							{ image: frameRaster(2, 2, () => RED), delayMs: 0 },
							{ image: frameRaster(3, 2, () => GREEN), delayMs: 0 },
						],
						loopCount: 0,
					},
				},
			),
		);
		expect(error.message).toContain('not all the same size');
	});

	it('refuses an image with no width', async () => {
		const error = await expectRefusal(() => encodeApng(createRaster(0, 4)));
		expect(error.message).toContain('nothing to write');
	});

	it('refuses an image with no height', async () => {
		const error = await expectRefusal(() => encodeApng(createRaster(4, 0)));
		expect(error.message).toContain('nothing to write');
	});

	it('refuses a frame whose buffer is shorter than its dimensions', async () => {
		const short = { ...createRaster(2, 2), data: new Uint8ClampedArray(8) };
		const error = await expectRefusal(() => encodeApng(short));
		expect(error.message).toContain('fewer pixels');
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('APNG round trips', () => {
	it('brings back every frame of an opaque animation', async () => {
		const frames = [RED, GREEN, BLUE].map((colour, i) => ({
			image: frameRaster(5, 3, (x, y) => ((x + y + i) % 2 === 0 ? colour : [0, 0, 0, 255])),
			delayMs: 40 + i,
		}));
		const bytes = await encodeApng(frames[0]!.image, { animation: { frames, loopCount: 2 } });
		const { animation } = await decodeApng(bytes);
		expect(animation.loopCount).toBe(2);
		expect(animation.frames.map((frame) => frame.delayMs)).toEqual([40, 41, 42]);
		for (let i = 0; i < 3; i += 1) {
			expect(pixels(animation.frames[i]!.image), `frame ${i}`).toEqual(pixels(frames[i]!.image));
		}
	});

	it('brings back an animation carrying alpha', async () => {
		const frames = [0, 64, 255].map((alpha, i) => ({
			image: frameRaster(4, 2, (x) => [10 * x, 20, 30, x === 0 ? alpha : 255], true),
			delayMs: 100 * (i + 1),
		}));
		const bytes = await encodeApng(frames[0]!.image, { animation: { frames, loopCount: 0 } });
		const { animation } = await decodeApng(bytes);
		for (let i = 0; i < 3; i += 1) {
			expect(pixels(animation.frames[i]!.image), `frame ${i}`).toEqual(pixels(frames[i]!.image));
		}
	});

	it('brings back a single frame written from an image alone', async () => {
		const image = frameRaster(7, 5, (x, y) => [x * 30, y * 40, 200, 255]);
		const { animation, image: still } = await decodeApng(await encodeApng(image));
		expect(animation.frames.length).toBe(1);
		expect(pixels(animation.frames[0]!.image)).toEqual(pixels(image));
		expect(pixels(still)).toEqual(pixels(image));
	});

	it('is pixel identical at 37 by 23, where a stride bug cannot hide', async () => {
		// An odd width means the row is not a multiple of anything convenient,
		// so an off by one in the filter stride shifts every row after the first.
		const image = frameRaster(37, 23, (x, y) => [(x * 7) & 0xff, (y * 11) & 0xff, x ^ y, 255]);
		const { animation } = await decodeApng(await encodeApng(image));
		expect(pixels(animation.frames[0]!.image)).toEqual(pixels(image));
	});

	it('keeps a one pixel canvas', async () => {
		const image = frameRaster(1, 1, () => [12, 34, 56, 255]);
		const { animation } = await decodeApng(await encodeApng(image));
		expect(pixels(animation.frames[0]!.image)).toEqual([12, 34, 56, 255]);
	});
});

/* ── The PNG encoder's indexed output ─────────────────────────────────── */

/**
 * A picture of exactly `count` colours in no useful order.
 *
 * Scrambled rather than banded on purpose. A banded picture deflates to almost
 * nothing whatever its colour type, so which of the two encodings comes out
 * smaller says more about the pattern than about the encoder, and a test whose
 * answer turns on that is a test that will flip on the next zlib.
 */
function mosaic(width: number, height: number, count: number, hasAlpha = false): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	let state = 0x2545f491;
	for (let i = 0; i < width * height; i += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		// The first `count` pixels take each entry once, so the palette is
		// exactly the size the test asked for whatever the noise does.
		const index = i < count ? i : state % count;
		image.data.set([(index * 37) & 0xff, (index * 91) & 0xff, (index * 53) & 0xff, 255], i * 4);
	}
	return image;
}

/** The same picture with a hole in it, so the palette needs a transparent entry. */
function mosaicWithHole(width: number, height: number, count: number): RasterImage {
	const image = mosaic(width, height, count, true);
	for (let i = 0; i < width * height; i += 3) image.data.set([0, 0, 0, 0], i * 4);
	return image;
}

describe('the PNG encoder writing a palette', () => {
	it('writes colour type 3 for a picture with few enough colours', async () => {
		const bytes = await encodePng(mosaic(64, 64, 32));
		expect(readHeader(bytes)[3]).toBe(3);
	});

	it.each([
		[2, 1],
		[3, 2],
		[4, 2],
		[5, 4],
		[16, 4],
		[17, 8],
		[200, 8],
	])('packs %i colours into %i bits per pixel', async (colours, bits) => {
		const bytes = await encodePng(mosaic(96, 96, colours));
		expect(readHeader(bytes)[2]).toBe(bits);
		expect(readHeader(bytes)[3]).toBe(3);
	});

	it('writes a PLTE holding the colours themselves, three bytes an entry', async () => {
		const plte = chunkNamed(await encodePng(mosaic(64, 64, 2)), 'PLTE').data;
		expect(plte.length).toBe(6);
		// The two colours `mosaic` builds for entries 0 and 1, in either order.
		expect([...plte]).toEqual([0, 0, 0, 37, 91, 53]);
	});

	it('writes a palette a decoder can look every pixel up in', async () => {
		const image = mosaic(64, 64, 5);
		const bytes = await encodePng(image);
		const plte = chunkNamed(bytes, 'PLTE').data;
		expect(plte.length).toBe(15);
		const decoded = await decodePng(bytes);
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('round trips a palettised picture exactly', async () => {
		const image = mosaic(64, 64, 200);
		const decoded = await decodePng(await encodePng(image));
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it.each([2, 3, 7, 16, 17, 64, 256])('round trips a picture of %i colours', async (colours) => {
		const image = mosaic(48, 32, colours);
		const decoded = await decodePng(await encodePng(image));
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('writes a file a fraction of the size of the truecolour one', async () => {
		// The whole point of the feature, and the reason it is worth the second
		// encode: the same pixels in a third of the bytes.
		const image = mosaic(200, 200, 64);
		const indexed = await encodePng(image);
		// A wide gamut raster carrying a profile is never indexed, which is how
		// the truecolour encoding of the same pixels is obtained here.
		const truecolour = await encodePng(
			{ ...image, colourSpace: 'display-p3' },
			{ iccProfile: Uint8Array.from([1, 2, 3, 4]) },
		);
		expect(readHeader(indexed)[3]).toBe(3);
		expect(readHeader(truecolour)[3]).toBe(2);
		expect(indexed.length).toBeLessThan(truecolour.length / 2);
	});

	it('writes a tRNS of one byte, naming the first entry', async () => {
		// Both palette builders put the transparent entry last, which would need
		// a table as long as the palette to reach. Moving it to the front makes
		// that table one byte.
		const bytes = await encodePng(mosaicWithHole(64, 64, 32));
		expect(readHeader(bytes)[3]).toBe(3);
		expect([...chunkNamed(bytes, 'tRNS').data]).toEqual([0]);
	});

	it('brings the transparency back through a round trip', async () => {
		const image = mosaicWithHole(64, 64, 32);
		const decoded = await decodePng(await encodePng(image));
		expect(decoded.hasAlpha).toBe(true);
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('writes the palette chunks in the order a reader expects', async () => {
		// PLTE after any colour chunk and before tRNS, which is where every
		// reader looks for them and where the specification requires them.
		const types = readChunks(
			await encodePng(mosaicWithHole(64, 64, 32), { writeColourTag: true }),
		).map((piece) => piece.type);
		expect(types).toEqual(['IHDR', 'cICP', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
	});

	it('writes no tRNS for an opaque picture', async () => {
		const bytes = await encodePng(mosaic(64, 64, 32));
		expect(readChunks(bytes).some((piece) => piece.type === 'tRNS')).toBe(false);
	});

	it('leaves a picture with soft edges in truecolour', async () => {
		// The palette builders here collapse translucency to a single
		// transparent entry, so a picture with a soft edge would come back
		// changed. Nobody asked for that.
		const image = createRaster(64, 64, 'srgb', true);
		for (let i = 0; i < 64 * 64; i += 1) {
			image.data.set([255, 0, 0, i % 4 === 0 ? 128 : 255], i * 4);
		}
		expect(readHeader(await encodePng(image))[3]).toBe(6);
	});

	it('leaves a photograph in truecolour', async () => {
		const image = createRaster(64, 64, 'srgb', false);
		let state = 0x2545f491;
		for (let i = 0; i < 64 * 64; i += 1) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			image.data.set([state & 0xff, (state >>> 8) & 0xff, (state >>> 16) & 0xff, 255], i * 4);
		}
		expect(readHeader(await encodePng(image))[3]).toBe(2);
	});

	it('leaves a picture alone where the palette would cost more than it saves', async () => {
		// Four pixels of four colours: the colour table is longer than the image
		// data it would shorten. Working that out means writing both, because
		// deflate does not answer questions about output it has not produced.
		const image = createRaster(2, 2, 'srgb', false);
		image.data.set([...RED, ...GREEN, ...BLUE, 1, 2, 3, 255]);
		expect(readHeader(await encodePng(image))[3]).toBe(2);
	});

	it('leaves a wide gamut picture with a profile in truecolour', async () => {
		const image = { ...mosaic(64, 64, 16), colourSpace: 'display-p3' as const };
		const bytes = await encodePng(image, {
			iccProfile: Uint8Array.from({ length: 64 }, (_, i) => i),
		});
		expect(readHeader(bytes)[3]).toBe(2);
	});

	it('still writes a palette for an sRGB picture with a profile', async () => {
		const bytes = await encodePng(mosaic(64, 64, 16), {
			iccProfile: Uint8Array.from({ length: 64 }, (_, i) => i),
		});
		expect(readHeader(bytes)[3]).toBe(3);
	});

	it('writes a palette for a wide gamut picture with only a colour tag', async () => {
		const image = { ...mosaic(64, 64, 16), colourSpace: 'display-p3' as const };
		expect(readHeader(await encodePng(image, { writeColourTag: true }))[3]).toBe(3);
	});
});

describe('the PNG encoder quantising on request', () => {
	/** Deterministic noise: far more than 256 colours, so nothing is exact. */
	function photograph(width: number, height: number): RasterImage {
		const image = createRaster(width, height, 'srgb', false);
		let state = 0x2545f491;
		for (let i = 0; i < width * height; i += 1) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			image.data.set([state & 0xff, (state >>> 8) & 0xff, (state >>> 16) & 0xff, 255], i * 4);
		}
		return image;
	}

	it('quantises a photograph when a palette size is asked for', async () => {
		const bytes = await encodePng(photograph(64, 64), { palette: 16 });
		expect(readHeader(bytes)[3]).toBe(3);
		expect(readHeader(bytes)[2]).toBe(4);
		expect(chunkNamed(bytes, 'PLTE').data.length).toBeLessThanOrEqual(16 * 3);
	});

	it('writes the palette even where truecolour would be smaller', async () => {
		// Asked for outright, so it is written whatever it costs. An option that
		// is accepted and ignored is worse than one that does not exist.
		const image = createRaster(2, 2, 'srgb', false);
		image.data.set([...RED, ...GREEN, ...BLUE, 1, 2, 3, 255]);
		const bytes = await encodePng(image, { palette: 4 });
		expect(readHeader(bytes)[3]).toBe(3);
		expect(bytes.length).toBeGreaterThan((await encodePng(image)).length);
	});

	it('honours a palette request on a wide gamut picture with a profile', async () => {
		const image = { ...photograph(32, 32), colourSpace: 'display-p3' as const };
		const bytes = await encodePng(image, { palette: 8, iccProfile: Uint8Array.from([9, 9, 9, 9]) });
		expect(readHeader(bytes)[3]).toBe(3);
	});

	it('reads back within sight of the original', async () => {
		// Quantising is lossy, so the test is that it is close rather than
		// identical. A palette built from the wrong channel passes neither.
		const image = photograph(32, 32);
		const decoded = await decodePng(await encodePng(image, { palette: 64 }));
		let worst = 0;
		let total = 0;
		for (let i = 0; i < image.data.length; i += 4) {
			for (let channel = 0; channel < 3; channel += 1) {
				const difference = Math.abs(
					(decoded.data[i + channel] as number) - (image.data[i + channel] as number),
				);
				worst = Math.max(worst, difference);
				total += difference;
			}
		}
		expect(total / (32 * 32 * 3)).toBeLessThan(40);
		expect(worst).toBeLessThan(190);
	});

	it('keeps a transparent entry through a forced quantisation', async () => {
		const image = photograph(32, 32);
		const withHole = createRaster(32, 32, 'srgb', true);
		withHole.data.set(image.data);
		for (let i = 0; i < 32; i += 1) withHole.data[i * 4 + 3] = 0;
		const bytes = await encodePng(withHole, { palette: 32 });
		expect([...chunkNamed(bytes, 'tRNS').data]).toEqual([0]);
		const decoded = await decodePng(bytes);
		expect(decoded.data[3]).toBe(0);
		expect(decoded.data[32 * 4 + 3]).toBe(255);
	});

	it('ignores a palette size of zero, which asks for nothing', async () => {
		expect(readHeader(await encodePng(photograph(32, 32), { palette: 0 }))[3]).toBe(2);
	});
});
