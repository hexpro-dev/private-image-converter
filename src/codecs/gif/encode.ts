/**
 * A GIF writer, 89a, still and animated.
 *
 * GIF is the one format here that every browser can read and none of them can
 * write, so this is not a fallback for a canvas that refused: it is the only
 * way to get an animation out of this package at all.
 *
 * Three decisions are worth stating up front, because each of them is a place
 * where the obvious choice produces a file that looks wrong rather than one
 * that fails.
 *
 * Colour. GIF stores indices, so an image has to be reduced to at most 256
 * entries. That is done by `raster/quantise.js`, which tries the exact palette
 * first, so a screenshot, a logo or a diagram comes back byte for byte and only
 * a photograph is approximated.
 *
 * Alpha. There is one fully transparent entry and nothing in between. A pixel
 * that is half covered has to land on one side of that line, and a half covered
 * pixel written out opaque with its own colour draws a dark fringe along every
 * soft edge, so partial coverage is composited onto the background first.
 *
 * Disposal. The frames handed to an encoder here are whole pictures rather than
 * patches, so each one is written at the full screen size. That makes disposal
 * a two-way choice rather than a three-way one, and getting it wrong is
 * invisible until a frame with a transparent hole in it lets the frame before
 * it show through.
 */

import { ByteWriter } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';
import { createRaster } from '../../raster/image.js';
import { quantise } from '../../raster/quantise.js';
import type { IndexedImage, Palette } from '../../raster/quantise.js';
import type { AnimationFrame, EncodeOptions, RasterImage } from '../../types.js';
import { lzwEncode } from './lzw.js';

const ENCODER_ID = 'gif-pure';

/** Every dimension in a GIF is sixteen bits, screen and frame alike. */
const MAX_SIDE = 0xffff;

/**
 * Where a pixel stops being transparent and starts being opaque.
 *
 * The same number the quantiser uses, so the two agree about which pixels are
 * about to become the transparent entry rather than each deciding separately.
 */
const ALPHA_THRESHOLD = 128;

const EXTENSION = 0x21;
const IMAGE_DESCRIPTOR = 0x2c;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const APPLICATION_LABEL = 0xff;

/** Clear the frame's rectangle before the next one, which here is the screen. */
const DISPOSE_BACKGROUND = 2;
/** Leave the frame in place, which is right when nothing after it is see-through. */
const DISPOSE_KEEP = 1;

function fail(detail: string): never {
	throw new EncodeFailedError('gif', ENCODER_ID, detail);
}

function requireDrawable(image: RasterImage): void {
	const { width, height } = image;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the image has no pixels in it.');
	}
	if (width > MAX_SIDE || height > MAX_SIDE) {
		fail(`the image is ${width} by ${height}, and a GIF stops at ${MAX_SIDE} pixels a side.`);
	}
	if (image.data.length < width * height * 4) {
		fail('the pixel buffer is smaller than the width and height say it should be.');
	}
}

/**
 * Fold partial coverage away before quantising.
 *
 * Two separate jobs, and the second one is the one that bites. A pixel below
 * the threshold becomes the transparent entry and a pixel above it keeps its
 * colour composited onto the background, which is the fringe problem described
 * at the top of this file.
 *
 * Then there is the raster that says it has no alpha. `createRaster` hands back
 * a buffer whose alpha bytes are all zero, so a caller that filled in only the
 * colours has an image that is opaque by declaration and invisible by content.
 * Reading its alpha channel would quantise the whole picture to one transparent
 * entry and write an empty file, which is the one failure that looks like a bug
 * in the reader on the other side.
 */
function hardenAlpha(
	image: RasterImage,
	background: readonly [number, number, number],
): RasterImage {
	const source = image.data;
	const used = image.width * image.height * 4;
	let mixed = false;
	for (let i = 3; i < used; i += 4) {
		if (source[i] !== 255) {
			mixed = true;
			break;
		}
	}
	if (!mixed) return image;

	const out = createRaster(image.width, image.height, image.colourSpace, image.hasAlpha);
	const target = out.data;
	const [br, bg, bb] = background;
	for (let i = 0; i < target.length; i += 4) {
		const alpha = image.hasAlpha ? (source[i + 3] as number) : 255;
		// Below the line the pixel is left as the zeroes `createRaster` gave it,
		// which is a fully transparent black and exactly what the quantiser
		// looks for.
		if (alpha < ALPHA_THRESHOLD) continue;
		target[i + 3] = 255;
		if (alpha === 255) {
			target[i] = source[i] as number;
			target[i + 1] = source[i + 1] as number;
			target[i + 2] = source[i + 2] as number;
			continue;
		}
		const cover = alpha / 255;
		const rest = 1 - cover;
		target[i] = (source[i] as number) * cover + br * rest;
		target[i + 1] = (source[i + 1] as number) * cover + bg * rest;
		target[i + 2] = (source[i + 2] as number) * cover + bb * rest;
	}
	return out;
}

/** How many bits an index needs, which is also the colour table's size field. */
function bitsFor(palette: Palette): number {
	const count = palette.colours.length / 4;
	let bits = 1;
	while (1 << bits < count) bits += 1;
	return bits;
}

/**
 * Write a colour table, padded out to a power of two.
 *
 * GIF has no count field: the size is a power of two and the reader takes every
 * entry of it. A palette of eleven colours therefore ships five entries of
 * black that nothing indexes, which is fifteen bytes and the format's problem
 * rather than ours.
 */
function writeColourTable(out: ByteWriter, palette: Palette, bits: number): void {
	const entries = 1 << bits;
	const count = palette.colours.length / 4;
	for (let i = 0; i < entries; i += 1) {
		if (i >= count) {
			out.u8(0);
			out.u8(0);
			out.u8(0);
			continue;
		}
		out.u8(palette.colours[i * 4] as number);
		out.u8(palette.colours[i * 4 + 1] as number);
		out.u8(palette.colours[i * 4 + 2] as number);
	}
}

/** Split a byte stream into the length-prefixed chain GIF stores it as. */
function writeSubBlocks(out: ByteWriter, data: Uint8Array): void {
	let at = 0;
	while (at < data.length) {
		const size = Math.min(255, data.length - at);
		out.u8(size);
		out.bytesOf(data.subarray(at, at + size));
		at += size;
	}
	out.u8(0);
}

/** Milliseconds to the hundredths of a second the field actually holds. */
function hundredths(delayMs: number): number {
	return Math.max(0, Math.min(0xffff, Math.round(delayMs / 10)));
}

/**
 * Write a GIF.
 *
 * `options.palette` caps the colour table, `options.background` is what partial
 * coverage is composited onto, and `options.animation` turns this into an
 * animated file. `options.quality` is ignored, because the only lossy step here
 * is the palette reduction and that already has its own setting; a second knob
 * meaning the same thing would be a knob that disagrees with itself.
 */
export function encodeGif(image: RasterImage, options: EncodeOptions = {}): Uint8Array {
	requireDrawable(image);
	const { width, height } = image;

	// An animation carrying no frames is not an animation, so it falls through
	// to the single frame path rather than producing a file with nothing in it.
	const animation =
		options.animation && options.animation.frames.length > 0 ? options.animation : undefined;
	if (animation) {
		for (const frame of animation.frames) {
			const source = frame.image;
			if (source.width !== width || source.height !== height) {
				fail('one of its frames is a different size from the image, and this writer cannot scale.');
			}
			if (source.data.length < width * height * 4) {
				fail('one of its frames has a smaller pixel buffer than its own dimensions call for.');
			}
		}
	}
	const animated = animation !== undefined;

	const maxColours = Math.max(2, Math.min(256, options.palette ?? 256));
	const background = options.background ?? [255, 255, 255];
	const inputs: readonly AnimationFrame[] = animation ? animation.frames : [{ image, delayMs: 0 }];
	// Each frame gets its own palette. One frame of an animation is often
	// nothing like the frame before it, and a single table shared across all of
	// them spends its entries on colours most frames never use.
	const layers = inputs.map((frame) => ({
		indexed: quantise(hardenAlpha(frame.image, background), {
			maxColours,
			alphaThreshold: ALPHA_THRESHOLD,
		}),
		delayMs: frame.delayMs,
	}));
	const first = layers[0] as { indexed: IndexedImage; delayMs: number };

	const out = new ByteWriter(1024 + width * height);
	// GIF89a even where the file uses nothing 87a lacked. The two extensions
	// that matter here, transparency and the loop count, are both 89a, and a
	// reader that only knows 87a would have to skip them and get the wrong
	// picture rather than a refusal.
	out.ascii('GIF89a');
	out.u16le(width);
	out.u16le(height);

	// Bit 7 is the global colour table flag, bits 6 to 4 are the colour
	// resolution of the source and bits 2 to 0 the table size. An animated file
	// gives every frame a local table instead, so it has no global one and the
	// background colour index below means nothing.
	const globalBits = bitsFor(first.indexed.palette);
	out.u8(animated ? 0x70 : 0xf0 | (globalBits - 1));
	out.u8(0);
	out.u8(0);
	if (!animated) writeColourTable(out, first.indexed.palette, globalBits);

	if (animation) {
		// The loop count lives in an application extension Netscape defined in
		// 1995 and nobody ever standardised. Its identifier has to be these
		// exact eleven bytes or a browser plays the animation once.
		out.u8(EXTENSION);
		out.u8(APPLICATION_LABEL);
		out.u8(11);
		out.ascii('NETSCAPE2.0');
		out.u8(3);
		out.u8(1);
		out.u16le(Math.max(0, Math.min(0xffff, Math.round(animation.loopCount))));
		out.u8(0);
	}

	// Every frame here is a whole picture, so a frame with a transparent hole in
	// it has to be drawn over a cleared screen rather than over its predecessor,
	// or the hole shows the previous frame instead of showing through. Clearing
	// costs a redraw of the whole screen each frame, which is why it is only
	// asked for when some frame actually needs it.
	const disposal = layers.some((layer) => layer.indexed.palette.transparentIndex >= 0)
		? DISPOSE_BACKGROUND
		: DISPOSE_KEEP;

	for (const layer of layers) {
		const palette = layer.indexed.palette;
		const transparentIndex = palette.transparentIndex;
		const bits = bitsFor(palette);

		// A still image needs a graphic control extension only to name its
		// transparent entry. Writing an empty one on every opaque GIF would add
		// eight bytes that say nothing.
		if (animated || transparentIndex >= 0) {
			out.u8(EXTENSION);
			out.u8(GRAPHIC_CONTROL_LABEL);
			out.u8(4);
			out.u8(((animated ? disposal : 0) << 2) | (transparentIndex >= 0 ? 1 : 0));
			out.u16le(hundredths(layer.delayMs));
			out.u8(transparentIndex >= 0 ? transparentIndex : 0);
			out.u8(0);
		}

		out.u8(IMAGE_DESCRIPTOR);
		out.u16le(0);
		out.u16le(0);
		out.u16le(width);
		out.u16le(height);
		// Bit 7 is the local colour table flag and bit 6 is interlace, which this
		// writer never sets: it existed so that a picture arriving over a modem
		// resolved gradually, and it costs compression on every file that has it.
		out.u8(animated ? 0x80 | (bits - 1) : 0);
		if (animated) writeColourTable(out, palette, bits);

		// Two is the floor the format sets even for a two colour image, so a
		// one bit palette still codes at two bits and wastes half its code
		// space. That is the specification's arithmetic, not a rounding here.
		const minCodeSize = Math.max(2, bits);
		out.u8(minCodeSize);
		writeSubBlocks(out, lzwEncode(layer.indexed.indices, minCodeSize));
	}

	out.u8(TRAILER);
	return out.finish();
}
