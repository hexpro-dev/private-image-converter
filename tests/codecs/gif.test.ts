import { describe, expect, it } from 'vitest';

import { LsbBitWriter } from '../../src/bits.js';
import { decodeGif, decodeGifAnimation } from '../../src/codecs/gif/decode.js';
import { encodeGif } from '../../src/codecs/gif/encode.js';
import { lzwDecode, lzwEncode } from '../../src/codecs/gif/lzw.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { AnimationFrame, ColourSpace, RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

type Rgb = readonly [number, number, number];

function raster(
	width: number,
	height: number,
	pixels: readonly number[],
	hasAlpha = false,
	colourSpace: ColourSpace = 'srgb',
): RasterImage {
	const image = createRaster(width, height, colourSpace, hasAlpha);
	image.data.set(pixels);
	return image;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

/**
 * Deterministic pixels drawn from a palette of a known size.
 *
 * Random RGB would exceed 256 colours on anything larger than a thumbnail and
 * every round trip would then be testing the quantiser rather than the codec.
 * The mapping from `pick` to a colour is injective because 37, 91 and 173 are
 * odd, so the image has exactly `colours` distinct colours in it.
 */
function paletteNoise(width: number, height: number, colours: number): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	let state = 0x2545f491;
	for (let i = 0; i < width * height; i += 1) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		// The first pixels walk the palette so the image really does hold the
		// number of colours the caller asked for, which several assertions
		// below depend on. Everything after that is noise, so the compressor
		// has something to work at rather than a repeating pattern.
		const pick = i < colours ? i : (state >>> 16) % colours;
		image.data[i * 4] = (pick * 37 + 3) & 0xff;
		image.data[i * 4 + 1] = (pick * 91 + 11) & 0xff;
		image.data[i * 4 + 2] = (pick * 173 + 29) & 0xff;
		image.data[i * 4 + 3] = 255;
	}
	return image;
}

/** A smooth ramp, which has far more colours than a palette can hold. */
function gradient(width: number, height: number): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			image.data[at] = Math.round((x * 255) / (width - 1));
			image.data[at + 1] = Math.round((y * 255) / (height - 1));
			image.data[at + 2] = Math.round(((x + y) * 255) / (width + height - 2));
			image.data[at + 3] = 255;
		}
	}
	return image;
}

function meanError(a: RasterImage, b: RasterImage): number {
	let total = 0;
	for (let i = 0; i < a.data.length; i += 1) {
		total += Math.abs((a.data[i] as number) - (b.data[i] as number));
	}
	return total / a.data.length;
}

/** The size field a colour table of `count` entries needs, as a power of two. */
function tableBits(count: number): number {
	let bits = 1;
	while (1 << bits < count) bits += 1;
	return bits;
}

/**
 * Compress by emitting one literal code per pixel and reusing no phrase.
 *
 * A perfectly legal LZW stream that any decoder has to read, written here from
 * the code width rules in the specification rather than by calling this
 * package's own compressor. A fixture built with it tests the reader; one built
 * with `lzwEncode` would only prove that the two halves of this codec agree
 * with each other.
 */
function literalCodes(indices: readonly number[], minCodeSize: number): Uint8Array {
	const writer = new LsbBitWriter();
	const clear = 1 << minCodeSize;
	let codeSize = minCodeSize + 1;
	let next = clear + 2;
	writer.write(clear, codeSize);
	indices.forEach((value, at) => {
		writer.write(value, codeSize);
		// A decoder builds an entry for every code but the first one after a
		// clear, and widens as soon as its table reaches a power of two.
		if (at > 0 && next < 4096) {
			next += 1;
			if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
		}
	});
	writer.write(clear + 1, codeSize);
	return writer.finish();
}

/** A handful of codes at one fixed width, for streams short enough not to grow. */
function fixedCodes(codes: readonly number[], bits: number): Uint8Array {
	const writer = new LsbBitWriter();
	for (const code of codes) writer.write(code, bits);
	return writer.finish();
}

interface ControlSpec {
	readonly delay?: number;
	readonly disposal?: number;
	readonly transparentIndex?: number;
	readonly userInput?: boolean;
	/** Override the declared block size, to build a broken extension. */
	readonly blockSize?: number;
	readonly terminator?: number;
}

interface FrameSpec {
	readonly left?: number;
	readonly top?: number;
	readonly width: number;
	readonly height: number;
	readonly palette?: readonly Rgb[];
	readonly interlaced?: boolean;
	/** Indices in stored order, which for an interlaced frame is pass order. */
	readonly indices?: readonly number[];
	readonly control?: ControlSpec;
	readonly minCodeSize?: number;
	/** A raw code stream, when the point of the fixture is the LZW itself. */
	readonly codes?: Uint8Array;
}

interface GifSpec {
	readonly signature?: string;
	readonly width: number;
	readonly height: number;
	readonly palette?: readonly Rgb[];
	readonly background?: number;
	readonly aspect?: number;
	readonly loop?: number;
	readonly loopIdentifier?: string;
	/** An application extension written verbatim, for the malformed cases. */
	readonly application?: { readonly identifier: string; readonly body: readonly number[] };
	readonly comment?: string;
	readonly plainText?: boolean;
	readonly extraLabel?: number;
	readonly introducer?: number;
	readonly frames: readonly FrameSpec[];
	readonly trailer?: boolean;
}

function pushAscii(out: number[], text: string): void {
	for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i));
}

function pushU16(out: number[], value: number): void {
	out.push(value & 0xff, (value >> 8) & 0xff);
}

function pushColourTable(out: number[], palette: readonly Rgb[]): void {
	const entries = 1 << tableBits(palette.length);
	for (let i = 0; i < entries; i += 1) {
		const entry = (palette[i] ?? [0, 0, 0]) as Rgb;
		out.push(entry[0], entry[1], entry[2]);
	}
}

function pushSubBlocks(out: number[], data: Uint8Array): void {
	let at = 0;
	while (at < data.length) {
		const size = Math.min(255, data.length - at);
		out.push(size);
		for (let i = 0; i < size; i += 1) out.push(data[at + i] as number);
		at += size;
	}
	out.push(0);
}

/**
 * Hand build a GIF from field values rather than from the encoder.
 *
 * The decoder tests have to read files this package did not write, so the
 * fixtures are assembled from the numbers in the specification directly, the
 * same way `tests/codecs/bmp.test.ts` does it.
 */
function buildGif(spec: GifSpec): Uint8Array {
	const out: number[] = [];
	pushAscii(out, spec.signature ?? 'GIF89a');
	pushU16(out, spec.width);
	pushU16(out, spec.height);
	out.push(spec.palette ? 0xf0 | (tableBits(spec.palette.length) - 1) : 0x70);
	out.push(spec.background ?? 0);
	out.push(spec.aspect ?? 0);
	if (spec.palette) pushColourTable(out, spec.palette);

	if (spec.loop !== undefined) {
		const identifier = spec.loopIdentifier ?? 'NETSCAPE2.0';
		out.push(0x21, 0xff, identifier.length);
		pushAscii(out, identifier);
		out.push(3, 1);
		pushU16(out, spec.loop);
		out.push(0);
	}
	if (spec.application) {
		out.push(0x21, 0xff, spec.application.identifier.length);
		pushAscii(out, spec.application.identifier);
		pushSubBlocks(out, Uint8Array.from(spec.application.body));
	}
	if (spec.comment !== undefined) {
		out.push(0x21, 0xfe);
		pushSubBlocks(
			out,
			Uint8Array.from(spec.comment, (c) => c.charCodeAt(0)),
		);
	}
	if (spec.plainText) {
		out.push(0x21, 0x01, 12);
		for (let i = 0; i < 12; i += 1) out.push(0);
		pushSubBlocks(out, Uint8Array.from([0x68, 0x69]));
	}
	if (spec.extraLabel !== undefined) {
		out.push(0x21, spec.extraLabel);
		pushSubBlocks(
			out,
			Uint8Array.from('hello there', (c) => c.charCodeAt(0)),
		);
	}
	if (spec.introducer !== undefined) out.push(spec.introducer);

	for (const frame of spec.frames) {
		const control = frame.control;
		if (control) {
			out.push(0x21, 0xf9, control.blockSize ?? 4);
			out.push(
				((control.disposal ?? 0) << 2) |
					(control.userInput ? 0x02 : 0) |
					(control.transparentIndex === undefined ? 0 : 0x01),
			);
			pushU16(out, control.delay ?? 0);
			out.push(control.transparentIndex ?? 0);
			out.push(control.terminator ?? 0);
		}
		out.push(0x2c);
		pushU16(out, frame.left ?? 0);
		pushU16(out, frame.top ?? 0);
		pushU16(out, frame.width);
		pushU16(out, frame.height);
		out.push(
			(frame.palette ? 0x80 | (tableBits(frame.palette.length) - 1) : 0) |
				(frame.interlaced ? 0x40 : 0),
		);
		if (frame.palette) pushColourTable(out, frame.palette);

		const entries = frame.palette ?? spec.palette ?? [];
		const minCodeSize = frame.minCodeSize ?? Math.max(2, tableBits(Math.max(2, entries.length)));
		out.push(minCodeSize);
		pushSubBlocks(out, frame.codes ?? literalCodes(frame.indices ?? [], minCodeSize));
	}

	if (spec.trailer !== false) out.push(0x3b);
	return Uint8Array.from(out);
}

const BLACK: Rgb = [0, 0, 0];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];

/* ── Encoding ─────────────────────────────────────────────────────────── */

describe('encodeGif', () => {
	it('writes the whole of a one pixel file byte for byte', () => {
		const out = encodeGif(raster(1, 1, [10, 20, 30, 255]));

		expect(Array.from(out)).toEqual([
			// 'GIF89a', one by one, a global table of two entries, background
			// index zero and no pixel aspect ratio.
			0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0xf0, 0x00, 0x00,
			// The one colour that is in the image, then the padding entry a
			// table of two has to carry.
			10, 20, 30, 0, 0, 0,
			// Image descriptor at the origin, full size, no local table.
			0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
			// Two bit codes: a clear, one literal and an end, in two bytes.
			0x02, 0x02, 0x44, 0x01, 0x00,
			// Trailer.
			0x3b,
		]);
	});

	it('writes no graphic control extension for an opaque still image', () => {
		const out = encodeGif(raster(1, 1, [10, 20, 30, 255]));

		expect(out.indexOf(0x21)).toBe(-1);
	});

	it('writes a graphic control extension naming the transparent index', () => {
		const out = encodeGif(raster(2, 1, [10, 20, 30, 255, 0, 0, 0, 0], true));

		// After the header and a two entry table: extension, graphic control
		// label, four bytes, no disposal with the transparency flag set, no
		// delay, index one, terminator.
		expect(Array.from(out.subarray(19, 27))).toEqual([0x21, 0xf9, 0x04, 0x01, 0, 0, 1, 0]);
	});

	it('pads a colour table out to the next power of two', () => {
		const out = encodeGif(raster(3, 1, [1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]));

		// Three colours need a four entry table, so the fourth is padding.
		expect(out[10]).toBe(0xf1);
		expect(Array.from(out.subarray(13, 25))).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 0, 0, 0]);
	});

	it('caps the colour table when asked for a smaller palette', () => {
		const out = encodeGif(paletteNoise(16, 16, 200), { palette: 16 });

		// Sixteen entries is a size field of three.
		expect(out[10]).toBe(0xf3);
		expect(decodeGif(out).width).toBe(16);
	});

	it('clamps a palette request below the two entries a table has to hold', () => {
		const out = encodeGif(paletteNoise(8, 8, 50), { palette: 1 });

		expect(out[10]).toBe(0xf0);
	});

	it('clamps a palette request above the 256 entries a table can hold', () => {
		const out = encodeGif(paletteNoise(24, 24, 256), { palette: 4096 });

		expect(out[10]).toBe(0xf7);
	});

	it('ignores the quality setting, which the format has no use for', () => {
		const image = paletteNoise(16, 16, 64);

		expect(Array.from(encodeGif(image, { quality: 0.1 }))).toEqual(
			Array.from(encodeGif(image, { quality: 1 })),
		);
	});

	it('splits the compressed data into sub-blocks of at most 255 bytes', () => {
		const out = encodeGif(paletteNoise(100, 100, 256));

		// A 256 entry table is 768 bytes, and the image descriptor and the
		// minimum code size are eleven more.
		let at = 13 + 768 + 11;
		const sizes: number[] = [];
		for (;;) {
			const size = out[at] as number;
			at += 1;
			if (size === 0) break;
			sizes.push(size);
			at += size;
		}
		expect(sizes.length).toBeGreaterThan(1);
		expect(Math.max(...sizes)).toBe(255);
		expect(out[at]).toBe(0x3b);
		expect(at + 1).toBe(out.length);
	});

	it('composites a half covered pixel onto white before writing it', () => {
		const out = encodeGif(raster(1, 1, [0, 0, 0, 128], true));

		expect(Array.from(out.subarray(13, 16))).toEqual([127, 127, 127]);
	});

	it('composites a half covered pixel onto the background it was given', () => {
		const out = encodeGif(raster(1, 1, [0, 0, 0, 128], true), { background: [255, 0, 0] });

		expect(Array.from(out.subarray(13, 16))).toEqual([127, 0, 0]);
	});

	it('puts the two sides of the coverage threshold on opposite sides of the line', () => {
		// One pixel either side of halfway. The first falls to the transparent
		// entry, the second is composited onto white and written opaque, which
		// is the whole of what GIF can express about a soft edge.
		const image = raster(2, 1, [9, 9, 9, 127, 9, 9, 9, 128], true);
		const back = decodeGif(encodeGif(image));

		expect(pixelsOf(back)).toEqual([0, 0, 0, 0, 132, 132, 132, 255]);
	});

	it('treats a raster that declares no alpha as opaque even with zero alpha bytes', () => {
		// `createRaster` leaves the alpha channel at zero. A writer that read it
		// anyway would quantise the whole picture to one transparent entry.
		const image = createRaster(2, 1, 'srgb', false);
		image.data.set([10, 20, 30, 0, 40, 50, 60, 0]);
		const back = decodeGif(encodeGif(image));

		expect(pixelsOf(back)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
	});

	it('keeps a Display P3 raster as it is, because GIF cannot record a gamut', () => {
		const out = encodeGif(raster(1, 1, [10, 20, 30, 255], false, 'display-p3'));

		expect(decodeGif(out).colourSpace).toBe('srgb');
		expect(Array.from(out.subarray(13, 16))).toEqual([10, 20, 30]);
	});
});

/* ── Encoding refusals ────────────────────────────────────────────────── */

describe('encodeGif refusals', () => {
	function shaped(width: number, height: number, bytes: number): RasterImage {
		return {
			data: new Uint8ClampedArray(bytes),
			width,
			height,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
	}

	it('refuses an image with no width', () => {
		expect(() => encodeGif(shaped(0, 4, 0))).toThrow(EncodeFailedError);
		expect(() => encodeGif(shaped(0, 4, 0))).toThrow(/no pixels/);
	});

	it('refuses an image with no height', () => {
		expect(() => encodeGif(shaped(4, 0, 0))).toThrow(/no pixels/);
	});

	it('refuses a fractional width', () => {
		expect(() => encodeGif(shaped(1.5, 4, 64))).toThrow(/no pixels/);
	});

	it('refuses a fractional height', () => {
		expect(() => encodeGif(shaped(4, 1.5, 64))).toThrow(/no pixels/);
	});

	it('refuses an image wider than the format can record', () => {
		expect(() => encodeGif(shaped(70000, 1, 4))).toThrow(/65535 pixels a side/);
	});

	it('refuses an image taller than the format can record', () => {
		expect(() => encodeGif(shaped(1, 70000, 4))).toThrow(/65535 pixels a side/);
	});

	it('refuses a pixel buffer shorter than its own dimensions', () => {
		expect(() => encodeGif(shaped(4, 4, 8))).toThrow(/smaller than the width and height/);
	});

	it('refuses an animation frame of a different width', () => {
		const image = raster(2, 2, new Array<number>(16).fill(255));
		const frames: AnimationFrame[] = [
			{ image: raster(3, 2, new Array<number>(24).fill(0)), delayMs: 50 },
		];

		expect(() => encodeGif(image, { animation: { frames, loopCount: 0 } })).toThrow(
			/different size from the image/,
		);
	});

	it('refuses an animation frame of a different height', () => {
		const image = raster(2, 2, new Array<number>(16).fill(255));
		const frames: AnimationFrame[] = [
			{ image: raster(2, 3, new Array<number>(24).fill(0)), delayMs: 50 },
		];

		expect(() => encodeGif(image, { animation: { frames, loopCount: 0 } })).toThrow(
			/different size from the image/,
		);
	});

	it('refuses an animation frame whose buffer is short', () => {
		const image = raster(4, 4, new Array<number>(64).fill(255));
		const frames: AnimationFrame[] = [{ image: shaped(4, 4, 16), delayMs: 50 }];

		expect(() => encodeGif(image, { animation: { frames, loopCount: 0 } })).toThrow(
			/smaller pixel buffer/,
		);
	});
});

/* ── Round trips ──────────────────────────────────────────────────────── */

describe('GIF round trips', () => {
	it('carries a single pixel through unchanged', () => {
		const back = decodeGif(encodeGif(raster(1, 1, [200, 100, 50, 255])));

		expect(back.width).toBe(1);
		expect(back.height).toBe(1);
		expect(back.hasAlpha).toBe(false);
		expect(pixelsOf(back)).toEqual([200, 100, 50, 255]);
	});

	it.each([
		[1, 1],
		[1, 9],
		[9, 1],
		[3, 3],
		[7, 5],
		[16, 16],
		[17, 2],
		[64, 64],
	])('carries a %i by %i image of 256 colours through losslessly', (width, height) => {
		const source = paletteNoise(width, height, 256);
		const back = decodeGif(encodeGif(source));

		expect(back.width).toBe(width);
		expect(back.height).toBe(height);
		expect(pixelsOf(back)).toEqual(pixelsOf(source));
	});

	it.each([2, 3, 5, 8, 17, 129, 255, 256])(
		'carries an image of exactly %i colours through losslessly',
		(colours) => {
			const source = paletteNoise(24, 24, colours);

			expect(pixelsOf(decodeGif(encodeGif(source)))).toEqual(pixelsOf(source));
		},
	);

	it('carries an image large enough to fill and clear the LZW table', () => {
		// A hundred and sixty thousand pixels of 256 colour noise overflows the
		// 4096 entry table several times over, so the encoder has to emit clear
		// codes part way through and the decoder has to act on them.
		const source = paletteNoise(400, 400, 256);

		expect(pixelsOf(decodeGif(encodeGif(source)))).toEqual(pixelsOf(source));
	});

	it('carries a run of identical pixels, which is what produces the KwKwK code', () => {
		const source = raster(
			8,
			1,
			new Array<number>(32).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 7)),
		);

		expect(pixelsOf(decodeGif(encodeGif(source)))).toEqual(pixelsOf(source));
	});

	it('keeps a fully transparent pixel next to an opaque one', () => {
		const source = raster(2, 1, [0, 0, 0, 0, 40, 50, 60, 255], true);
		const back = decodeGif(encodeGif(source));

		expect(back.hasAlpha).toBe(true);
		expect(pixelsOf(back)).toEqual([0, 0, 0, 0, 40, 50, 60, 255]);
	});

	it('reports no alpha for an image that came back opaque', () => {
		expect(decodeGif(encodeGif(paletteNoise(8, 8, 30))).hasAlpha).toBe(false);
	});

	it('keeps a gradient within a bounded mean error once it has been quantised', () => {
		const source = gradient(64, 48);
		const back = decodeGif(encodeGif(source));

		expect(back.width).toBe(64);
		expect(back.height).toBe(48);
		// Approximated rather than exact: 3072 pixels carry far more than 256
		// colours, so this is the quantiser's error and not the codec's.
		expect(meanError(source, back)).toBeLessThan(4);
	});

	it('keeps a gradient closer when it is given the whole palette than a sixteenth of it', () => {
		const source = gradient(64, 48);
		const full = meanError(source, decodeGif(encodeGif(source)));
		const small = meanError(source, decodeGif(encodeGif(source, { palette: 16 })));

		expect(full).toBeLessThan(small);
	});
});

/* ── Animation ────────────────────────────────────────────────────────── */

function flatFrame(width: number, height: number, colour: readonly number[]): RasterImage {
	const image = createRaster(width, height, 'srgb', colour[3] !== 255);
	for (let i = 0; i < width * height; i += 1) image.data.set(colour, i * 4);
	return image;
}

describe('GIF animation', () => {
	const frames: AnimationFrame[] = [
		{ image: flatFrame(4, 3, [255, 0, 0, 255]), delayMs: 40 },
		{ image: flatFrame(4, 3, [0, 255, 0, 255]), delayMs: 60 },
		{ image: flatFrame(4, 3, [0, 0, 255, 255]), delayMs: 200 },
	];

	it('writes the NETSCAPE2.0 application extension with the loop count', () => {
		const out = encodeGif(frames[0]!.image, { animation: { frames, loopCount: 7 } });

		expect(Array.from(out.subarray(13, 32))).toEqual([
			0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03,
			0x01, 0x07, 0x00, 0x00,
		]);
	});

	it('writes no global colour table when every frame carries its own', () => {
		const out = encodeGif(frames[0]!.image, { animation: { frames, loopCount: 0 } });

		// Bit 7 of the packed byte clear means there is no global table, so the
		// first extension starts immediately after the screen descriptor.
		expect(out[10]! & 0x80).toBe(0);
		expect(out[13]).toBe(0x21);
	});

	it('gives every frame a local colour table', () => {
		const out = decodeGifAnimation(
			encodeGif(frames[0]!.image, { animation: { frames, loopCount: 0 } }),
		);

		expect(out.animation.frames.map((frame) => pixelsOf(frame.image).slice(0, 4))).toEqual([
			[255, 0, 0, 255],
			[0, 255, 0, 255],
			[0, 0, 255, 255],
		]);
	});

	it('round trips every frame and every delay', () => {
		const out = decodeGifAnimation(
			encodeGif(frames[0]!.image, { animation: { frames, loopCount: 3 } }),
		);

		expect(out.animation.loopCount).toBe(3);
		expect(out.animation.frames.map((frame) => frame.delayMs)).toEqual([40, 60, 200]);
		out.animation.frames.forEach((frame, i) => {
			expect(pixelsOf(frame.image)).toEqual(pixelsOf(frames[i]!.image));
		});
	});

	it('keeps the frames in place when none of them is see-through', () => {
		const out = encodeGif(frames[0]!.image, { animation: { frames, loopCount: 0 } });

		// Disposal lives in bits 4 to 2 of the graphic control extension's flags.
		expect(((out[35] as number) >> 2) & 0x07).toBe(1);
	});

	it('clears the screen between frames when any frame is see-through', () => {
		const withHole: AnimationFrame[] = [
			{ image: flatFrame(4, 3, [255, 0, 0, 255]), delayMs: 40 },
			{ image: flatFrame(4, 3, [0, 0, 0, 0]), delayMs: 40 },
		];
		const out = encodeGif(withHole[0]!.image, { animation: { frames: withHole, loopCount: 0 } });

		expect(((out[35] as number) >> 2) & 0x07).toBe(2);
	});

	it('does not let a transparent frame show the frame before it', () => {
		const withHole: AnimationFrame[] = [
			{ image: flatFrame(3, 2, [255, 0, 0, 255]), delayMs: 40 },
			{ image: flatFrame(3, 2, [0, 0, 0, 0]), delayMs: 40 },
		];
		const back = decodeGifAnimation(
			encodeGif(withHole[0]!.image, { animation: { frames: withHole, loopCount: 0 } }),
		);

		expect(pixelsOf(back.animation.frames[1]!.image)).toEqual(new Array<number>(24).fill(0));
	});

	it('writes a still image when the animation carries no frames', () => {
		const image = raster(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]);
		const out = encodeGif(image, { animation: { frames: [], loopCount: 0 } });

		expect(out[10]! & 0x80).toBe(0x80);
		expect(pixelsOf(decodeGif(out))).toEqual(pixelsOf(image));
	});

	it('rounds a delay to the hundredths of a second the field holds', () => {
		const odd: AnimationFrame[] = [
			{ image: flatFrame(2, 2, [1, 2, 3, 255]), delayMs: 44 },
			{ image: flatFrame(2, 2, [4, 5, 6, 255]), delayMs: 46 },
		];
		const back = decodeGifAnimation(
			encodeGif(odd[0]!.image, { animation: { frames: odd, loopCount: 0 } }),
		);

		expect(back.animation.frames.map((frame) => frame.delayMs)).toEqual([40, 50]);
	});

	it('turns a delay too small for the field into the tenth of a second browsers use', () => {
		const quick: AnimationFrame[] = [
			{ image: flatFrame(2, 2, [1, 2, 3, 255]), delayMs: 2 },
			{ image: flatFrame(2, 2, [4, 5, 6, 255]), delayMs: 2 },
		];
		const back = decodeGifAnimation(
			encodeGif(quick[0]!.image, { animation: { frames: quick, loopCount: 0 } }),
		);

		expect(back.animation.frames.map((frame) => frame.delayMs)).toEqual([100, 100]);
	});

	it('clamps a delay longer than the field can hold', () => {
		const slow: AnimationFrame[] = [
			{ image: flatFrame(2, 2, [1, 2, 3, 255]), delayMs: 900_000 },
			{ image: flatFrame(2, 2, [4, 5, 6, 255]), delayMs: 100 },
		];
		const back = decodeGifAnimation(
			encodeGif(slow[0]!.image, { animation: { frames: slow, loopCount: 0 } }),
		);

		expect(back.animation.frames[0]!.delayMs).toBe(0xffff * 10);
	});

	it('gives back the first frame when only a picture was asked for', () => {
		const out = encodeGif(frames[0]!.image, { animation: { frames, loopCount: 0 } });

		expect(pixelsOf(decodeGif(out))).toEqual(pixelsOf(frames[0]!.image));
	});

	it('reports one frame and one play for a still image', () => {
		const out = decodeGifAnimation(encodeGif(raster(1, 1, [1, 2, 3, 255])));

		expect(out.animation.frames.length).toBe(1);
		expect(out.animation.loopCount).toBe(1);
	});
});

/* ── Decoding ─────────────────────────────────────────────────────────── */

describe('decodeGif', () => {
	it('reads a minimal GIF87a with a global colour table', () => {
		const file = buildGif({
			signature: 'GIF87a',
			width: 2,
			height: 2,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [{ width: 2, height: 2, indices: [0, 1, 2, 3] }],
		});
		const image = decodeGif(file);

		expect(image.width).toBe(2);
		expect(image.height).toBe(2);
		expect(image.colourSpace).toBe('srgb');
		expect(image.hasAlpha).toBe(false);
		expect(pixelsOf(image)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
		]);
	});

	it('reads a frame that carries its own colour table', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [BLACK, BLACK],
			frames: [{ width: 2, height: 1, palette: [RED, GREEN], indices: [1, 0] }],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
	});

	it('reads a file with no global colour table at all', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			frames: [{ width: 2, height: 1, palette: [RED, BLUE], indices: [0, 1] }],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
	});

	it('reads a sixteen entry colour table at four bits a code', () => {
		const palette: Rgb[] = [];
		for (let i = 0; i < 16; i += 1) palette.push([i * 16, 255 - i * 16, i]);
		const file = buildGif({
			width: 4,
			height: 1,
			palette,
			frames: [{ width: 4, height: 1, indices: [0, 5, 10, 15] }],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([
			0, 255, 0, 255, 80, 175, 5, 255, 160, 95, 10, 255, 240, 15, 15, 255,
		]);
	});

	it('reads the four passes of an interlaced frame back into row order', () => {
		// Eight rows of a single colour each. Stored order is rows 0 and 4 from
		// the first two passes, then 2 and 6, then 1, 3, 5 and 7.
		const palette: Rgb[] = [];
		for (let i = 0; i < 8; i += 1) palette.push([i * 10, 0, 0]);
		const stored = [0, 4, 2, 6, 1, 3, 5, 7];
		const file = buildGif({
			width: 1,
			height: 8,
			palette,
			frames: [{ width: 1, height: 8, interlaced: true, indices: stored }],
		});

		const image = decodeGif(file);
		expect(Array.from(image.data).filter((_, i) => i % 4 === 0)).toEqual([
			0, 10, 20, 30, 40, 50, 60, 70,
		]);
	});

	it('reads an interlaced frame whose height is not a multiple of eight', () => {
		const palette: Rgb[] = [];
		for (let i = 0; i < 8; i += 1) palette.push([i * 10, 0, 0]);
		// Five rows, so the stored order is row 0, then row 4, then row 2, then
		// rows 1 and 3. The last pass carries as many rows as the first three
		// together, which is where an off-by-one in the pass arithmetic shows.
		const file = buildGif({
			width: 1,
			height: 5,
			palette,
			frames: [{ width: 1, height: 5, interlaced: true, indices: [0, 2, 4, 1, 3] }],
		});

		const image = decodeGif(file);
		expect(Array.from(image.data).filter((_, i) => i % 4 === 0)).toEqual([0, 10, 40, 30, 20]);
	});

	it('draws a frame at its own offset on a larger screen', () => {
		const file = buildGif({
			width: 3,
			height: 2,
			palette: [RED, GREEN],
			frames: [{ left: 1, top: 1, width: 2, height: 1, indices: [0, 1] }],
		});

		// Everything the frame does not cover stays transparent.
		expect(pixelsOf(decodeGif(file))).toEqual([
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255,
		]);
	});

	it('grows the screen to fit a first frame larger than the header claims', () => {
		// The screen a header names is a claim like any other, and a first frame
		// that does not fit inside it means the claim was wrong rather than that
		// the picture is meant to be cropped. Chrome and Pillow both show the
		// whole frame; ours has to as well, or a converted file loses pixels the
		// person can see in their own browser.
		const file = buildGif({
			width: 2,
			height: 2,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [{ width: 3, height: 2, indices: [0, 1, 2, 3, 0, 1] }],
		});
		const image = decodeGif(file);

		expect([image.width, image.height]).toEqual([3, 2]);
		expect(pixelsOf(image)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0,
			255,
		]);
	});

	it('grows the screen to fit a first frame that hangs off the right', () => {
		// Grown to the frame's far edge rather than to its width, which is what
		// Chrome does: four pixels across, with the frame starting at the second
		// one and the first left transparent.
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [{ left: 1, top: 0, width: 3, height: 1, indices: [1, 2, 3] }],
		});
		const image = decodeGif(file);

		expect([image.width, image.height]).toEqual([4, 1]);
		expect(pixelsOf(image)).toEqual([
			0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
		]);
	});

	it('grows the screen to fit a first frame that hangs off the bottom', () => {
		const file = buildGif({
			width: 1,
			height: 2,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [{ left: 0, top: 1, width: 1, height: 3, indices: [1, 2, 3] }],
		});
		const image = decodeGif(file);

		expect([image.width, image.height]).toEqual([1, 4]);
		expect(pixelsOf(image)).toEqual([
			0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
		]);
	});

	it('grows the screen to fit a first frame that begins past its right edge', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ left: 2, top: 0, width: 2, height: 1, indices: [0, 1] }],
		});
		const image = decodeGif(file);

		expect([image.width, image.height]).toEqual([4, 1]);
		expect(pixelsOf(image)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('clips a later frame that hangs off the right of the screen', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [
				{ width: 2, height: 1, indices: [0, 0] },
				{ left: 1, top: 0, width: 3, height: 1, indices: [1, 2, 3] },
			],
		});
		const out = decodeGifAnimation(file);

		expect([out.image.width, out.image.height]).toEqual([2, 1]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('clips a later frame that hangs off the bottom of the screen', () => {
		const file = buildGif({
			width: 1,
			height: 2,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [
				{ width: 1, height: 2, indices: [0, 0] },
				{ left: 0, top: 1, width: 1, height: 3, indices: [1, 2, 3] },
			],
		});
		const out = decodeGifAnimation(file);

		expect([out.image.width, out.image.height]).toEqual([1, 2]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('drops a later frame that begins past the right hand edge entirely', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN],
			frames: [
				{ width: 2, height: 1, indices: [0, 0] },
				{ left: 2, top: 0, width: 2, height: 1, indices: [1, 1] },
			],
		});
		const out = decodeGifAnimation(file);

		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
	});

	it('grows the screen for the first frame only', () => {
		// A one pixel screen grown to two by its first frame, and then a second
		// frame that overhangs the two it grew to and is clipped like any other.
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [
				{ width: 2, height: 1, indices: [0, 0] },
				{ left: 1, top: 0, width: 2, height: 1, indices: [1, 2] },
			],
		});
		const out = decodeGifAnimation(file);

		expect([out.image.width, out.image.height]).toEqual([2, 1]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('leaves the canvas alone where a frame names its transparent index', () => {
		const file = buildGif({
			width: 3,
			height: 1,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [{ width: 3, height: 1, control: { transparentIndex: 1 }, indices: [0, 1, 2] }],
		});
		const image = decodeGif(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
	});

	it('honours a transparent index that its own colour table does not reach', () => {
		// A four entry table and a transparent index of six. The index names no
		// colour, but every pixel that uses it is transparent, so the file reads.
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN, BLUE, WHITE],
			frames: [
				{
					width: 2,
					height: 1,
					minCodeSize: 3,
					control: { transparentIndex: 6 },
					indices: [0, 6],
				},
			],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
	});

	it('ignores the background colour index and the pixel aspect ratio', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			background: 3,
			aspect: 49,
			palette: [RED, GREEN],
			frames: [{ width: 1, height: 1, indices: [1] }],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255]);
	});

	it('reads a file that stops after its last frame with no trailer', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			trailer: false,
			frames: [{ width: 1, height: 1, indices: [0] }],
		});

		expect(pixelsOf(decodeGif(file))).toEqual([255, 0, 0, 255]);
	});

	it('reads a file handed to it as a view into a larger buffer', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 1, height: 1, indices: [1] }],
		});
		const padded = new Uint8Array(file.length + 16);
		padded.set(file, 8);

		expect(pixelsOf(decodeGif(padded.subarray(8, 8 + file.length)))).toEqual([0, 255, 0, 255]);
	});

	it('stops at the trailer and ignores whatever follows it', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 1, height: 1, indices: [1] }],
		});
		const trailing = new Uint8Array(file.length + 4);
		trailing.set(file);
		trailing.set([0x99, 0x99, 0x99, 0x99], file.length);

		expect(pixelsOf(decodeGif(trailing))).toEqual([0, 255, 0, 255]);
	});
});

/* ── Extensions ───────────────────────────────────────────────────────── */

describe('decodeGif extensions', () => {
	const oneFrame: FrameSpec[] = [{ width: 1, height: 1, indices: [1] }];
	const base = { width: 1, height: 1, palette: [RED, GREEN] as Rgb[], frames: oneFrame };

	it('reads the loop count out of a NETSCAPE2.0 extension', () => {
		expect(decodeGifAnimation(buildGif({ ...base, loop: 0 })).animation.loopCount).toBe(0);
		expect(decodeGifAnimation(buildGif({ ...base, loop: 12 })).animation.loopCount).toBe(12);
	});

	it('reads the loop count out of the older ANIMEXTS1.0 spelling', () => {
		const file = buildGif({ ...base, loop: 5, loopIdentifier: 'ANIMEXTS1.0' });

		expect(decodeGifAnimation(file).animation.loopCount).toBe(5);
	});

	it('plays once when there is no loop extension', () => {
		expect(decodeGifAnimation(buildGif(base)).animation.loopCount).toBe(1);
	});

	it('ignores an application extension it does not know', () => {
		const file = buildGif({
			...base,
			application: { identifier: 'XMP DataXMP', body: [1, 9, 0] },
		});

		expect(decodeGifAnimation(file).animation.loopCount).toBe(1);
		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255]);
	});

	it('ignores a NETSCAPE block whose body is too short to hold a count', () => {
		const file = buildGif({ ...base, application: { identifier: 'NETSCAPE2.0', body: [1, 9] } });

		expect(decodeGifAnimation(file).animation.loopCount).toBe(1);
	});

	it('ignores a NETSCAPE block whose sub-block index is not one', () => {
		const file = buildGif({
			...base,
			application: { identifier: 'NETSCAPE2.0', body: [2, 9, 0] },
		});

		expect(decodeGifAnimation(file).animation.loopCount).toBe(1);
	});

	it('skips a comment extension', () => {
		const file = buildGif({ ...base, comment: 'written by a tool that likes to sign its work' });

		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255]);
	});

	it('skips an extension whose label GIF does not define', () => {
		// The block is self describing: a label and then a sub-block chain that
		// says where it ends. Chrome and ImageMagick both walk it and draw the
		// picture behind it, and there is nothing in a label a reader has to
		// understand before it can step over the block carrying it.
		const file = buildGif({ ...base, extraLabel: 0x42 });

		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255]);
	});

	it('skips a plain text extension rather than trying to draw it', () => {
		const file = buildGif({ ...base, plainText: true });

		expect(pixelsOf(decodeGif(file))).toEqual([0, 255, 0, 255]);
	});

	it('reads the user input flag without waiting for anything', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 1, height: 1, control: { userInput: true, delay: 25 }, indices: [1] }],
		});
		const out = decodeGifAnimation(file);

		expect(out.animation.frames[0]!.delayMs).toBe(250);
	});

	it.each([
		[0, 100],
		[1, 100],
		[2, 20],
		[10, 100],
		[65535, 655350],
	])('turns a delay field of %i into %i milliseconds', (field, expected) => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 1, height: 1, control: { delay: field }, indices: [1] }],
		});

		expect(decodeGifAnimation(file).animation.frames[0]!.delayMs).toBe(expected);
	});
});

/* ── Composition ──────────────────────────────────────────────────────── */

describe('decodeGifAnimation composition', () => {
	const palette: Rgb[] = [RED, GREEN, BLUE, WHITE];

	function twoFrames(firstDisposal: number, secondTransparent = true): Uint8Array {
		return buildGif({
			width: 2,
			height: 1,
			palette,
			frames: [
				{
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					control: { disposal: firstDisposal, transparentIndex: 3 },
					indices: [0],
				},
				{
					left: 1,
					top: 0,
					width: 1,
					height: 1,
					control: secondTransparent ? { transparentIndex: 3 } : {},
					indices: [1],
				},
			],
		});
	}

	it('leaves the first frame in place under disposal method 0', () => {
		const out = decodeGifAnimation(twoFrames(0));

		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('leaves the first frame in place under disposal method 1', () => {
		const out = decodeGifAnimation(twoFrames(1));

		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('clears the first frame back to transparent under disposal method 2', () => {
		const out = decodeGifAnimation(twoFrames(2));

		expect(pixelsOf(out.animation.frames[0]!.image)).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([0, 0, 0, 0, 0, 255, 0, 255]);
	});

	it('puts back what was underneath under disposal method 3', () => {
		// Three frames: a red one, then a green patch over it that asks for the
		// canvas back, then a blue patch which should land on the red.
		const file = buildGif({
			width: 2,
			height: 1,
			palette,
			frames: [
				{ width: 2, height: 1, indices: [0, 0] },
				{
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					control: { disposal: 3 },
					indices: [1],
				},
				{ left: 1, top: 0, width: 1, height: 1, indices: [2] },
			],
		});
		const out = decodeGifAnimation(file);

		expect(pixelsOf(out.animation.frames[0]!.image)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
		expect(pixelsOf(out.animation.frames[2]!.image)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
	});

	it('applies a graphic control extension to one frame only', () => {
		// The first frame names index 3 transparent; the second, with no
		// extension of its own, must not still be bound by that.
		const file = buildGif({
			width: 2,
			height: 1,
			palette,
			frames: [
				{ width: 2, height: 1, control: { transparentIndex: 3 }, indices: [3, 3] },
				{ width: 2, height: 1, indices: [3, 3] },
			],
		});
		const out = decodeGifAnimation(file);

		expect(pixelsOf(out.animation.frames[0]!.image)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(pixelsOf(out.animation.frames[1]!.image)).toEqual([
			255, 255, 255, 255, 255, 255, 255, 255,
		]);
	});

	it('handles a disposal method 2 rectangle that is entirely off the screen', () => {
		// The overhanging rectangle is the second frame's, because the first
		// frame's would enlarge the screen rather than hang off it.
		const file = buildGif({
			width: 2,
			height: 1,
			palette,
			frames: [
				{ width: 2, height: 1, indices: [3, 3] },
				{ left: 2, top: 0, width: 1, height: 1, control: { disposal: 2 }, indices: [0] },
				{ width: 2, height: 1, indices: [1, 1] },
			],
		});
		const out = decodeGifAnimation(file);

		expect(pixelsOf(out.animation.frames[2]!.image)).toEqual([0, 255, 0, 255, 0, 255, 0, 255]);
	});

	it('handles a disposal method 2 rectangle that hangs off the bottom', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			palette,
			frames: [
				{ width: 1, height: 1, indices: [0] },
				{ left: 0, top: 0, width: 1, height: 3, control: { disposal: 2 }, indices: [0, 1, 2] },
				{ width: 1, height: 1, control: { transparentIndex: 3 }, indices: [3] },
			],
		});
		const out = decodeGifAnimation(file);

		expect(pixelsOf(out.animation.frames[2]!.image)).toEqual([0, 0, 0, 0]);
	});

	it('reads only the first frame when a picture is all that was asked for', () => {
		const image = decodeGif(twoFrames(0));

		expect(pixelsOf(image)).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
	});
});

/* ── LZW ──────────────────────────────────────────────────────────────── */

describe('GIF LZW', () => {
	it('decodes a stream of literal codes', () => {
		const indices = [0, 1, 2, 3, 2, 1, 0];

		expect(Array.from(lzwDecode(literalCodes(indices, 2), 2, indices.length))).toEqual(indices);
	});

	it('decodes the code for the entry it is itself defining', () => {
		// Clear, a literal zero, then code 6, which is the first table entry and
		// has not been defined yet. It can only mean "zero followed by zero".
		const data = fixedCodes([4, 0, 6], 3);

		expect(Array.from(lzwDecode(data, 2, 3))).toEqual([0, 0, 0]);
	});

	it('drops the pixels a final code carries past the end of a frame', () => {
		const data = fixedCodes([4, 0, 6], 3);

		expect(Array.from(lzwDecode(data, 2, 2))).toEqual([0, 0]);
	});

	it('starts again from a clear code in the middle of a stream', () => {
		// Clear, 0, 6 (which is "00"), clear, 1. Resetting means the 1 is read
		// as a literal against a fresh table rather than against the old one.
		const data = fixedCodes([4, 0, 6, 4, 1], 3);

		expect(Array.from(lzwDecode(data, 2, 4))).toEqual([0, 0, 0, 1]);
	});

	it('tolerates a stream that fills its table and never clears it', () => {
		// Four thousand literal codes at eight bits fills the 4096 entry table
		// part way through, and a writer is allowed to keep going against the
		// full table rather than sending a clear.
		const indices: number[] = [];
		for (let i = 0; i < 4200; i += 1) indices.push((i * 7) & 0xff);

		expect(Array.from(lzwDecode(literalCodes(indices, 8), 8, indices.length))).toEqual(indices);
	});

	it('round trips its own compressed output', () => {
		const indices = new Uint8Array(5000);
		let state = 7;
		for (let i = 0; i < indices.length; i += 1) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			indices[i] = (state >>> 16) & 0x0f;
		}

		expect(Array.from(lzwDecode(lzwEncode(indices, 4), 4, indices.length))).toEqual(
			Array.from(indices),
		);
	});

	it('round trips a long run of one value', () => {
		const indices = new Uint8Array(9000).fill(3);

		expect(Array.from(lzwDecode(lzwEncode(indices, 4), 4, indices.length))).toEqual(
			Array.from(indices),
		);
	});

	it('reads a stream coded at a minimum code size of one', () => {
		// Two colours, so the four codes a two bit width can express are used up
		// by the colours, the clear and the end before a single entry exists,
		// and the code after the first literal is already three bits wide. The
		// bytes are 0x92 0x60: clear, 0, 1, 1, 0, end.
		const data = Uint8Array.from([0x92, 0x60]);

		expect(Array.from(lzwDecode(data, 1, 4))).toEqual([0, 1, 1, 0]);
	});

	it('writes a clear and an end code for an empty frame', () => {
		const data = lzwEncode(new Uint8Array(0), 2);

		expect(Array.from(lzwDecode(data, 2, 0))).toEqual([]);
	});

	it.each([1, 2, 3, 4, 5, 6, 7, 8])('round trips at a minimum code size of %i', (minCodeSize) => {
		const indices = new Uint8Array(700);
		for (let i = 0; i < indices.length; i += 1) indices[i] = (i * 5) & ((1 << minCodeSize) - 1);

		expect(
			Array.from(lzwDecode(lzwEncode(indices, minCodeSize), minCodeSize, indices.length)),
		).toEqual(Array.from(indices));
	});
});

/* ── Refusals ─────────────────────────────────────────────────────────── */

describe('decodeGif refusals', () => {
	function expectRefusal(bytes: Uint8Array, pattern: RegExp): void {
		let thrown: unknown;
		try {
			decodeGifAnimation(bytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DecodeFailedError);
		const error = thrown as DecodeFailedError;
		expect(error.code).toBe('decode/failed');
		expect(error.format).toBe('gif');
		expect(error.message).toMatch(pattern);
		// The message is shown to a person, so it has to be a whole sentence.
		expect(error.message.endsWith('.')).toBe(true);
	}

	const simple: GifSpec = {
		width: 2,
		height: 1,
		palette: [RED, GREEN],
		frames: [{ width: 2, height: 1, indices: [0, 1] }],
	};

	it('rejects a file that does not begin with a GIF signature', () => {
		const file = buildGif({ ...simple, signature: 'GIF88a' });
		expectRefusal(file, /GIF87a and GIF89a/);
	});

	it.each([0, 1, 5, 6, 12])('rejects a file cut off at %i bytes', (length) => {
		expectRefusal(buildGif(simple).subarray(0, length), /logical screen descriptor/);
	});

	it('rejects a logical screen with no width', () => {
		expectRefusal(buildGif({ ...simple, width: 0 }), /0 by 1 pixels/);
	});

	it('rejects a logical screen with no height', () => {
		expectRefusal(buildGif({ ...simple, height: 0 }), /2 by 0 pixels/);
	});

	it('rejects a logical screen larger than it will allocate for, without allocating', () => {
		const file = buildGif({ ...simple, width: 65535, height: 65535 });
		expectRefusal(file, /far larger than anything/);
	});

	it('rejects a frame far larger than it will allocate for, without allocating', () => {
		// A one by one logical screen, which is well inside the ceiling the
		// header is checked against, and a frame rectangle of four thousand
		// million pixels. The buffer for the indices is asked for before a
		// single code is read, so nothing later in the frame can refuse it.
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 65535, height: 65535, codes: fixedCodes([4, 0, 5], 3) }],
		});
		expectRefusal(file, /one of its frames is far larger/);
	});

	it('rejects a later frame far larger than it will allocate for', () => {
		// The frame budget is no answer to this one: it is worked out from the
		// screen, and the screen here is a single pixel.
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [
				{ width: 1, height: 1, indices: [0] },
				{ width: 65535, height: 65535, codes: fixedCodes([4, 0, 5], 3) },
			],
		});
		expectRefusal(file, /one of its frames is far larger/);
	});

	it('rejects a first frame whose offset would grow the screen too far', () => {
		// The rectangle itself is exactly at the ceiling. Its offset is what
		// puts the screen it would grow to past it.
		const file = buildGif({
			width: 1,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ left: 1, top: 1, width: 20_000, height: 20_000, codes: fixedCodes([4, 0, 5], 3) }],
		});
		expectRefusal(file, /reaches far outside/);
	});

	it('rejects a file cut off inside its global colour table', () => {
		expectRefusal(buildGif(simple).subarray(0, 15), /global colour table/);
	});

	it('rejects a file that ends after an extension introducer', () => {
		const file = buildGif({ ...simple, comment: 'x' });
		const at = file.indexOf(0x21);
		expectRefusal(file.subarray(0, at + 1), /label of an extension block/);
	});

	it('rejects a file cut off inside an image descriptor', () => {
		const file = buildGif(simple);
		const at = file.indexOf(0x2c);
		expectRefusal(file.subarray(0, at + 5), /image descriptor/);
	});

	it('rejects a file cut off inside a local colour table', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			frames: [{ width: 2, height: 1, palette: [RED, GREEN], indices: [0, 1] }],
		});
		expectRefusal(file.subarray(0, 25), /local colour table/);
	});

	it('rejects a frame that ends before its LZW minimum code size', () => {
		const file = buildGif(simple);
		const at = file.indexOf(0x2c);
		expectRefusal(file.subarray(0, at + 10), /LZW minimum code size/);
	});

	it('rejects a frame whose sub-block chain runs off the end', () => {
		const file = buildGif(simple);
		expectRefusal(file.subarray(0, file.length - 2), /pixel data of a frame/);
	});

	it('rejects a frame whose sub-block chain never terminates', () => {
		const file = buildGif(simple);
		// Turn the chain's terminating zero into a length that walks past the end.
		file[file.length - 2] = 40;
		expectRefusal(file, /pixel data of a frame/);
	});

	it('rejects a frame with no width', () => {
		const file = buildGif({ ...simple, frames: [{ width: 0, height: 1, indices: [] }] });
		expectRefusal(file, /a frame is 0 by 1 pixels/);
	});

	it('rejects a frame with no height', () => {
		const file = buildGif({ ...simple, frames: [{ width: 1, height: 0, indices: [] }] });
		expectRefusal(file, /a frame is 1 by 0 pixels/);
	});

	it('rejects a frame with no colour table anywhere', () => {
		const file = buildGif({
			width: 1,
			height: 1,
			frames: [{ width: 1, height: 1, indices: [0] }],
		});
		expectRefusal(file, /no colour table of its own/);
	});

	it('rejects a frame that names a colour its table does not contain', () => {
		const file = buildGif({
			width: 2,
			height: 1,
			palette: [RED, GREEN],
			frames: [{ width: 2, height: 1, minCodeSize: 4, indices: [0, 9] }],
		});
		expectRefusal(file, /does not contain/);
	});

	it('rejects a file carrying no image data at all', () => {
		expectRefusal(
			buildGif({ width: 1, height: 1, palette: [RED, GREEN], frames: [] }),
			/no image data/,
		);
	});

	it('rejects a file cut off inside an extension GIF does not define', () => {
		// Stepping over an unknown block still means walking its chain rather
		// than believing it, so one that runs off the end is a refusal.
		const file = buildGif({ ...simple, extraLabel: 0x42 });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 6), /an extension labelled 0x42/);
	});

	it('rejects a block introducer GIF does not define', () => {
		expectRefusal(buildGif({ ...simple, introducer: 0x7e }), /introduced by 0x7e/);
	});

	it('rejects a graphic control extension of the wrong declared size', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, control: { blockSize: 5 }, indices: [0, 1] }],
		});
		expectRefusal(file, /declares 5 bytes/);
	});

	it('rejects a graphic control extension that does not end where it says', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, control: { terminator: 9 }, indices: [0, 1] }],
		});
		expectRefusal(file, /does not end where its own length/);
	});

	it('rejects a file cut off inside a graphic control extension', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, control: { delay: 5 }, indices: [0, 1] }],
		});
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 4), /graphic control extension/);
	});

	it('rejects a file cut off inside an application extension identifier', () => {
		const file = buildGif({ ...simple, loop: 0 });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 8), /identifier of an application/);
	});

	it('rejects a file that ends where an application extension size should be', () => {
		const file = buildGif({ ...simple, loop: 0 });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 2), /size of an application/);
	});

	it('rejects a file cut off inside a comment extension', () => {
		const file = buildGif({ ...simple, comment: 'a longer comment than the file now holds' });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 20), /a comment extension/);
	});

	it('rejects a file that ends where a plain text extension size should be', () => {
		const file = buildGif({ ...simple, plainText: true });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 2), /size of a plain text/);
	});

	it('rejects a file cut off inside a plain text extension header', () => {
		const file = buildGif({ ...simple, plainText: true });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 8), /header of a plain text/);
	});

	it('rejects a file cut off inside a plain text extension body', () => {
		const file = buildGif({ ...simple, plainText: true });
		expectRefusal(file.subarray(0, file.indexOf(0x21) + 16), /a plain text extension/);
	});

	it.each([0, 9, 255])('rejects an LZW minimum code size of %i', (minCodeSize) => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, minCodeSize, codes: Uint8Array.from([0, 0, 0]) }],
		});
		expectRefusal(file, /LZW minimum code size/);
	});

	it('rejects a frame whose compressed data runs out early', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, codes: fixedCodes([4, 0], 3) }],
		});
		expectRefusal(file, /ends before the whole frame/);
	});

	it('rejects a frame that sends its end code before the last pixel', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, codes: fixedCodes([4, 0, 5], 3) }],
		});
		expectRefusal(file, /ends before it has given a colour/);
	});

	it("rejects a first code that is not one of the frame's own colours", () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, codes: fixedCodes([4, 6, 0], 3) }],
		});
		expectRefusal(file, /first LZW code/);
	});

	it('rejects a code the table has not defined yet', () => {
		const file = buildGif({
			...simple,
			frames: [{ width: 2, height: 1, codes: fixedCodes([4, 0, 7], 3) }],
		});
		expectRefusal(file, /has not defined yet/);
	});

	it('rejects an animation with more frames than it will hold in memory', () => {
		const frames: FrameSpec[] = [];
		for (let i = 0; i < 10_001; i += 1) frames.push({ width: 1, height: 1, indices: [i & 1] });
		const file = buildGif({ width: 1, height: 1, palette: [RED, GREEN], frames });

		expectRefusal(file, /more than the 10000 frames/);
	});

	it('still reads the first frame of a file with too many of them', () => {
		const frames: FrameSpec[] = [];
		for (let i = 0; i < 10_001; i += 1) frames.push({ width: 1, height: 1, indices: [i & 1] });
		const file = buildGif({ width: 1, height: 1, palette: [RED, GREEN], frames });

		expect(pixelsOf(decodeGif(file))).toEqual([255, 0, 0, 255]);
	});
});
