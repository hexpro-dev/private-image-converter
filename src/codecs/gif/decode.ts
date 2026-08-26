/**
 * A GIF reader, 87a and 89a, still and animated.
 *
 * The container is small: a screen descriptor, an optional palette, and then a
 * stream of blocks that runs until a trailer byte. Almost all of the work is in
 * two places, and neither is the part that looks hard.
 *
 * The first is composition. A GIF frame is not a picture, it is a patch drawn
 * at an offset over whatever the last frame left on the screen, and what the
 * last frame left depends on its disposal method rather than on anything in the
 * current frame. Every frame this reader returns is a whole picture at the
 * logical screen size, because the alternative is every encoder in this package
 * reimplementing the same three disposal rules and disagreeing about them.
 *
 * The second is that a frame's dimensions are its own. A patch may be smaller
 * than the screen, offset anywhere on it, and stored in four interlaced passes
 * rather than in rows. Nothing in the file says which of those is happening
 * beyond one flag and four numbers, and getting any of it wrong produces a
 * picture rather than an error.
 *
 * Every read is bounds checked. These bytes came from a stranger's file, and
 * GIF is one of the few formats where a length field genuinely disagrees with
 * the data often enough to matter.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { Animation, AnimationFrame, RasterImage } from '../../types.js';
import { DECODER_ID, lzwDecode } from './lzw.js';

/** Header plus logical screen descriptor, which are always present together. */
const HEADER_BYTES = 13;

const EXTENSION = 0x21;
const IMAGE_DESCRIPTOR = 0x2c;
const TRAILER = 0x3b;

const PLAIN_TEXT_LABEL = 0x01;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const COMMENT_LABEL = 0xfe;
const APPLICATION_LABEL = 0xff;

/**
 * Disposal methods.
 *
 * Method 1, "do not dispose", is not named here because it is what happens when
 * neither of these two matches, and so is method 0, "no disposal specified".
 * The pair being indistinguishable in practice is why files use them
 * interchangeably.
 */
const DISPOSE_NONE = 0;
/** Clear the frame's own rectangle back to transparent. */
const DISPOSE_BACKGROUND = 2;
/** Put back whatever the canvas held before this frame was drawn. */
const DISPOSE_PREVIOUS = 3;

/**
 * The largest logical screen this reader will allocate for.
 *
 * A GIF records its dimensions in sixteen bits each, so a thirteen byte header
 * can honestly claim 65535 by 65535, which is four thousand million pixels and
 * sixteen gigabytes of raster. The buffer for that is requested long before the
 * pixel data runs out and the reader notices there was never an image there.
 * The same number caps a single frame, which is a separate question: a frame
 * carries its own sixteen bit rectangle and the logical screen puts no ceiling
 * on it at all, so a file whose screen is one pixel can still name a frame of
 * four thousand million.
 *
 * The converter applies its own `maxPixels` on top of this; this exists so the
 * decoder is safe to call on its own.
 *
 * This one stays where it is while the animation budget below has come down to
 * the converter's default, and the two are answering different questions.
 * `measureGif` reads the screen descriptor for a caller that has a budget, so
 * a still GIF is refused on the caller's number long before this one is
 * reached. What is left here is somebody calling `decodeGif` directly with no
 * budget of their own, and for them the useful bound is the one that says the
 * buffer cannot be requested at all, not one that guesses at what they meant
 * to allow.
 */
const MAX_PIXELS = 400_000_000;

/**
 * The budget across every frame of an animation.
 *
 * Every frame comes back as a whole picture, so a modest screen and a long
 * animation multiply out to the same problem as one enormous frame. Counted in
 * pixels rather than in frames, because two hundred frames of a thumbnail and
 * two hundred frames of a wallpaper are not the same request.
 *
 * The converter's own default budget, which is not the number above it and is
 * not meant to be. `pureAnimatedDecoder` multiplies the screen by the frame
 * count and compares that product against the caller's `maxPixels`, so this is
 * the same arithmetic against the same figure, one layer earlier. It used to
 * be five times larger, which meant a nine thousand square animation was
 * inside this reader's budget at fifty frames and fourteen gigabytes of
 * raster, and the check that would have caught it ran after every one of those
 * frames had been built. The frame budget is what stops before the first of
 * them.
 */
const MAX_ANIMATION_PIXELS = 80_000_000;

/**
 * A ceiling on the frame count regardless of how small the frames are.
 *
 * The pixel budget alone would allow four hundred million single pixel frames,
 * each of them a separate object with a separate typed array, so the count
 * needs its own bound. Ten thousand is well past anything a person converts and
 * well short of anything that matters.
 */
const MAX_FRAMES = 10_000;

/**
 * Rows of an interlaced frame, in the order they are stored.
 *
 * Four passes: every eighth row from the top, then every eighth from row four,
 * then every fourth from row two, then every second from row one. It exists so
 * that a partly downloaded GIF showed something recognisable on a dial-up
 * connection, and it survives in files from tools that have not changed their
 * defaults since.
 */
const INTERLACE_STARTS = [0, 4, 2, 1];
const INTERLACE_STEPS = [8, 8, 4, 2];

function fail(detail: string): never {
	throw new DecodeFailedError('gif', DECODER_ID, detail);
}

/**
 * The one place a length is compared against the buffer.
 *
 * Funnelling every read through this is what keeps the failure mode honest: a
 * short file names the structure it stopped inside instead of reading undefined
 * and painting it.
 */
function requireBytes(bytes: Uint8Array, at: number, count: number, what: string): void {
	if (at + count > bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
	let out = '';
	for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] as number);
	return out;
}

function hex(value: number): string {
	return `0x${value.toString(16).padStart(2, '0')}`;
}

/** Where a chain of length-prefixed sub-blocks ends, and how much it carries. */
function scanSubBlocks(
	bytes: Uint8Array,
	at: number,
	what: string,
): { end: number; total: number } {
	let cursor = at;
	let total = 0;
	for (;;) {
		requireBytes(bytes, cursor, 1, `the end of ${what}`);
		const size = bytes[cursor] as number;
		cursor += 1;
		if (size === 0) return { end: cursor, total };
		requireBytes(bytes, cursor, size, `the end of ${what}`);
		cursor += size;
		total += size;
	}
}

function skipSubBlocks(bytes: Uint8Array, at: number, what: string): number {
	return scanSubBlocks(bytes, at, what).end;
}

/**
 * Join a chain of sub-blocks into one buffer.
 *
 * Measured first and copied second. A frame's compressed data can be several
 * megabytes spread over tens of thousands of 255 byte blocks, and growing a
 * buffer per block copies everything written so far each time.
 */
function readSubBlocks(
	bytes: Uint8Array,
	at: number,
	what: string,
): { data: Uint8Array; next: number } {
	const { end, total } = scanSubBlocks(bytes, at, what);
	const data = new Uint8Array(total);
	let write = 0;
	let read = at;
	for (;;) {
		const size = bytes[read] as number;
		read += 1;
		if (size === 0) break;
		data.set(bytes.subarray(read, read + size), write);
		write += size;
		read += size;
	}
	return { data, next: end };
}

/** A colour table, as three bytes an entry exactly as the file stores it. */
function readColourTable(bytes: Uint8Array, at: number, count: number, what: string): Uint8Array {
	requireBytes(bytes, at, count * 3, `the end of ${what}`);
	return bytes.slice(at, at + count * 3);
}

/** What a Graphic Control Extension says about the frame that follows it. */
interface FrameControl {
	readonly disposal: number;
	/** The palette index to leave untouched, or -1 when the frame is opaque. */
	readonly transparentIndex: number;
	readonly delayMs: number;
}

const DEFAULT_CONTROL: FrameControl = {
	disposal: DISPOSE_NONE,
	transparentIndex: -1,
	delayMs: 100,
};

interface Rectangle {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** The rows of an interlaced frame, in stored order, as image row numbers. */
function interlaceMap(height: number): Int32Array {
	const map = new Int32Array(height);
	let at = 0;
	for (let pass = 0; pass < INTERLACE_STARTS.length; pass += 1) {
		const step = INTERLACE_STEPS[pass] as number;
		for (let y = INTERLACE_STARTS[pass] as number; y < height; y += step) {
			map[at] = y;
			at += 1;
		}
	}
	return map;
}

/**
 * Draw one frame's indices onto the running canvas.
 *
 * Clipped to the screen rather than growing it. A patch that hangs off the edge
 * is either a writer's mistake or a deliberate scrolling trick, and a browser
 * draws the part that fits and drops the rest, so clipping is what makes a
 * converted file match what the person saw. The first frame is the one
 * exception, and it has already been settled by the time this is called: see
 * where the canvas is allocated in `readGif`.
 */
function drawFrame(
	canvas: Uint8ClampedArray,
	screen: Rectangle,
	rect: Rectangle,
	indices: Uint8Array,
	palette: Uint8Array,
	interlaced: boolean,
	transparentIndex: number,
): void {
	const entries = palette.length / 3;
	const map = interlaced ? interlaceMap(rect.height) : undefined;
	const columns = Math.min(rect.width, screen.width - rect.left);

	for (let row = 0; row < rect.height; row += 1) {
		const y = rect.top + (map ? (map[row] as number) : row);
		if (y >= screen.height) continue;
		const from = row * rect.width;
		const to = (y * screen.width + rect.left) * 4;
		for (let x = 0; x < columns; x += 1) {
			const index = indices[from + x] as number;
			// Tested before the palette bounds check, and in that order on
			// purpose. Writers do set a transparent index past the end of their
			// own colour table, and a file whose every use of that index is
			// transparent is perfectly readable even though the index names no
			// colour.
			if (index === transparentIndex) continue;
			if (index >= entries) {
				fail('a frame refers to a colour its own colour table does not contain.');
			}
			const source = index * 3;
			const at = to + x * 4;
			canvas[at] = palette[source] as number;
			canvas[at + 1] = palette[source + 1] as number;
			canvas[at + 2] = palette[source + 2] as number;
			canvas[at + 3] = 255;
		}
	}
}

/** Clear a frame's rectangle back to transparent, which is disposal method 2. */
function clearRectangle(canvas: Uint8ClampedArray, screen: Rectangle, rect: Rectangle): void {
	const columns = Math.min(rect.width, screen.width - rect.left);
	if (columns <= 0) return;
	for (let row = 0; row < rect.height; row += 1) {
		const y = rect.top + row;
		if (y >= screen.height) continue;
		const to = (y * screen.width + rect.left) * 4;
		canvas.fill(0, to, to + columns * 4);
	}
}

/** A copy of the running canvas as a finished picture. */
function snapshot(canvas: Uint8ClampedArray, screen: Rectangle): RasterImage {
	// GIF has no way to record a colour space. Everything that writes one means
	// sRGB, so saying so is honest where inventing a wider claim would not be.
	const image = createRaster(screen.width, screen.height, 'srgb', false);
	image.data.set(canvas);
	return { ...image, hasAlpha: detectAlpha(image) };
}

export interface GifResult {
	readonly image: RasterImage;
	readonly animation: Animation;
}

/**
 * Read a GIF, stopping after the first frame when that is all the caller wants.
 *
 * `firstOnly` is what makes a still GIF cost nothing extra. Most of the GIFs
 * handed to a converter are a single frame, and decoding the rest of a file
 * whose frames are about to be thrown away is work nobody asked for.
 */
function readGif(bytes: Uint8Array, firstOnly: boolean): GifResult {
	requireBytes(bytes, 0, HEADER_BYTES, 'the end of its logical screen descriptor');
	const signature = ascii(bytes, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') {
		fail('it does not begin with either of the two GIF signatures, GIF87a and GIF89a.');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint16(6, true);
	const height = view.getUint16(8, true);
	const packed = bytes[10] as number;
	// The background colour index at byte 11 and the pixel aspect ratio at byte
	// 12 are both read past. No browser has honoured either since the nineties:
	// the canvas starts transparent rather than filled with the background
	// colour, and a non-square aspect ratio would mean resampling every frame of
	// an animation to correct for a field almost nothing writes.
	if (width < 1 || height < 1) {
		fail(`its logical screen is ${width} by ${height} pixels, which holds no image.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('its logical screen is far larger than anything this reader will allocate for.');
	}

	let at = HEADER_BYTES;
	let globalPalette: Uint8Array | undefined;
	if ((packed & 0x80) !== 0) {
		// Three bits give the size as a power of two, one less than the count,
		// so the smallest table a GIF can carry is two entries and the largest
		// is 256.
		const count = 2 << (packed & 0x07);
		globalPalette = readColourTable(bytes, at, count, 'its global colour table');
		at += count * 3;
	}

	const frames: AnimationFrame[] = [];
	// All three are settled by the first image descriptor rather than here,
	// because a first frame larger than the screen it was written on enlarges
	// the screen. Until one arrives there is nothing to draw and nothing to
	// draw it on.
	let screen: Rectangle = { left: 0, top: 0, width, height };
	let canvas: Uint8ClampedArray | undefined;
	// One number rather than two checks, because the two bounds are the same
	// bound: how much of this reader's memory an animation is allowed to be.
	let frameBudget = 0;

	// Without a NETSCAPE application extension a GIF plays exactly once, which
	// is what every browser does with one and what this has to record so that a
	// re-encode does not turn a single play into a loop.
	let loopCount = 1;
	let control: FrameControl | undefined;
	/** What the previous frame asked to have undone before this one is drawn. */
	let restore: (() => void) | undefined;

	// A file that simply stops after a complete frame is missing only its
	// trailer, which costs nothing and which plenty of writers omit. Running out
	// of blocks is the end of the file; running out inside a block is not, and
	// every read below says which it was.
	while (at < bytes.length) {
		const introducer = bytes[at] as number;
		at += 1;
		if (introducer === TRAILER) break;

		if (introducer === EXTENSION) {
			requireBytes(bytes, at, 1, 'the label of an extension block');
			const label = bytes[at] as number;
			at += 1;

			if (label === GRAPHIC_CONTROL_LABEL) {
				requireBytes(bytes, at, 6, 'the end of a graphic control extension');
				const size = bytes[at] as number;
				if (size !== 4) {
					fail(`a graphic control extension declares ${size} bytes, and GIF89a fixes it at 4.`);
				}
				const flags = bytes[at + 1] as number;
				const delay = view.getUint16(at + 2, true);
				const transparentIndex = bytes[at + 4] as number;
				if ((bytes[at + 5] as number) !== 0) {
					fail('a graphic control extension does not end where its own length says it does.');
				}
				at += 6;
				// Bit 1 of the flags is the user input flag, which asks a viewer
				// to wait for a keypress before moving on. It is read as part of
				// the byte and then deliberately ignored: nothing here is a
				// viewer, and a conversion cannot wait for somebody to press a
				// key.
				control = {
					disposal: (flags >> 2) & 0x07,
					transparentIndex: (flags & 0x01) !== 0 ? transparentIndex : -1,
					// The field is hundredths of a second. Zero and one both mean
					// "as fast as the viewer can manage", which every browser has
					// rendered as a tenth of a second for twenty years, so a file
					// written with either plays at the speed people expect rather
					// than at whatever the reading machine happens to manage.
					delayMs: delay <= 1 ? 100 : delay * 10,
				};
				continue;
			}

			if (label === APPLICATION_LABEL) {
				requireBytes(bytes, at, 1, 'the size of an application extension');
				const size = bytes[at] as number;
				requireBytes(bytes, at + 1, size, 'the identifier of an application extension');
				const identifier = ascii(bytes, at + 1, size);
				at += 1 + size;
				const block = readSubBlocks(bytes, at, 'the body of an application extension');
				at = block.next;
				// NETSCAPE2.0 carries the loop count, and ANIMEXTS1.0 is the same
				// three bytes under the name an older Netscape build used. Every
				// other application extension, XMP and colour profiles included,
				// is read past: this is a converter, and none of them change a
				// pixel.
				const known = identifier === 'NETSCAPE2.0' || identifier === 'ANIMEXTS1.0';
				if (known && block.data.length >= 3 && block.data[0] === 1) {
					// Taken as written. Netscape never said whether the number
					// counts plays or repeats after the first play, and writers
					// split both ways: ImageMagick asked for three plays writes
					// two. Nothing here can tell which a given file meant, and
					// interpreting it would make every re-encode drift by one.
					loopCount = (block.data[1] as number) | ((block.data[2] as number) << 8);
				}
				continue;
			}

			if (label === COMMENT_LABEL) {
				at = skipSubBlocks(bytes, at, 'a comment extension');
				continue;
			}

			if (label === PLAIN_TEXT_LABEL) {
				// Twelve bytes of grid geometry and then the text itself. It asks
				// a viewer to draw characters in a font of its own choosing over
				// the image, which no browser has ever done and which this reader
				// is in no position to start doing, so the whole block is stepped
				// over and the picture underneath is what comes back.
				requireBytes(bytes, at, 1, 'the size of a plain text extension');
				const size = bytes[at] as number;
				requireBytes(bytes, at + 1, size, 'the header of a plain text extension');
				at += 1 + size;
				at = skipSubBlocks(bytes, at, 'a plain text extension');
				continue;
			}

			// An extension GIF does not define is still shaped like one: a label
			// and then a chain of length prefixed sub-blocks that says where it
			// ends. Being able to step over it is the whole point of that shape,
			// and Chrome and ImageMagick both do, so a file carrying one still
			// gives back its picture. The chain is walked rather than trusted,
			// so a truncated one is still a refusal.
			at = skipSubBlocks(bytes, at, `an extension labelled ${hex(label)}`);
			continue;
		}

		if (introducer !== IMAGE_DESCRIPTOR) {
			fail(`it carries a block introduced by ${hex(introducer)}, which GIF does not define.`);
		}

		requireBytes(bytes, at, 9, 'the end of an image descriptor');
		const rect: Rectangle = {
			left: view.getUint16(at, true),
			top: view.getUint16(at + 2, true),
			width: view.getUint16(at + 4, true),
			height: view.getUint16(at + 6, true),
		};
		const flags = bytes[at + 8] as number;
		at += 9;
		if (rect.width < 1 || rect.height < 1) {
			fail(`a frame is ${rect.width} by ${rect.height} pixels, which holds no image.`);
		}
		// Tested here because the decompressor is handed this product and
		// allocates it before it reads a single code, so by the time a short
		// frame is noticed the buffer has already been asked for. Sixteen bits
		// a side means thirty five bytes can ask for four thousand million
		// indices, and in a browser that is a bare RangeError rather than
		// anything this package can name.
		if (rect.width * rect.height > MAX_PIXELS) {
			fail('one of its frames is far larger than anything this reader will allocate for.');
		}

		if (!canvas) {
			// The first frame may enlarge the screen, and only the first. A
			// writer that gets the logical screen wrong usually gets it wrong by
			// leaving it at one by one, and Chrome and Pillow both show the
			// whole of that first frame rather than the corner of it the header
			// asked for. Grown to the frame's far edge rather than to its size,
			// which is what both of them do with a first frame that is also
			// offset. Every later frame is clipped instead, which is equally
			// what they do: a patch that overhangs a screen the file has already
			// established is a scrolling trick, not a mistake.
			const grownWidth = Math.max(screen.width, rect.left + rect.width);
			const grownHeight = Math.max(screen.height, rect.top + rect.height);
			if (grownWidth * grownHeight > MAX_PIXELS) {
				fail('its first frame reaches far outside anything this reader will allocate for.');
			}
			screen = { left: 0, top: 0, width: grownWidth, height: grownHeight };
			canvas = new Uint8ClampedArray(grownWidth * grownHeight * 4);
			frameBudget = Math.max(
				1,
				Math.min(MAX_FRAMES, Math.floor(MAX_ANIMATION_PIXELS / (grownWidth * grownHeight))),
			);
		}
		// A local binding so that the closures below, and the reader, are
		// looking at a canvas that certainly exists.
		const pixels = canvas;

		let palette = globalPalette;
		if ((flags & 0x80) !== 0) {
			const count = 2 << (flags & 0x07);
			palette = readColourTable(bytes, at, count, 'a local colour table');
			at += count * 3;
		}
		if (!palette) {
			fail('a frame has no colour table of its own and the file has no global one either.');
		}

		requireBytes(bytes, at, 1, 'the LZW minimum code size of a frame');
		const minCodeSize = bytes[at] as number;
		at += 1;
		const compressed = readSubBlocks(bytes, at, 'the pixel data of a frame');
		at = compressed.next;
		const indices = lzwDecode(compressed.data, minCodeSize, rect.width * rect.height);

		if (frames.length >= frameBudget) {
			fail(`it holds more than the ${frameBudget} frames this reader will keep in memory.`);
		}

		// The disposal method belongs to the frame it was written on but acts on
		// the frame after it, so it is applied here rather than where it was
		// read.
		if (restore) restore();

		const settings = control ?? DEFAULT_CONTROL;
		// Taken before the frame is drawn, which is the whole meaning of
		// "restore to previous": the state being kept is the one this frame is
		// about to cover up.
		const kept = settings.disposal === DISPOSE_PREVIOUS ? pixels.slice() : undefined;
		const interlaced = (flags & 0x40) !== 0;

		drawFrame(pixels, screen, rect, indices, palette, interlaced, settings.transparentIndex);
		frames.push({ image: snapshot(pixels, screen), delayMs: settings.delayMs });

		if (settings.disposal === DISPOSE_BACKGROUND) {
			restore = () => clearRectangle(pixels, screen, rect);
		} else if (kept) {
			restore = () => pixels.set(kept);
		} else {
			restore = undefined;
		}
		// A graphic control extension governs the next rendering block only, so
		// a second frame with no extension of its own is not still bound by the
		// first one's transparency.
		control = undefined;

		if (firstOnly) break;
	}

	const first = frames[0];
	if (!first) fail('it carries no image data at all.');
	return { image: first.image, animation: { frames, loopCount } };
}

/**
 * The logical screen a GIF declares, read on its own and before any decoding.
 *
 * Worth having because the screen descriptor is not a claim this reader can
 * afford to check later. The canvas is allocated from those two numbers at the
 * first image descriptor, before a single LZW code has been read, so a file
 * that stops immediately after its header has still asked for the buffer.
 * Thirteen bytes can honestly say 65535 by 65535, and the compressed pixels
 * behind them are a stream with no length in the header at all, which is why a
 * short file cannot be caught the way a Sun raster or a Netpbm can.
 *
 * Two reasons the answer is a floor rather than the final size, both of which
 * are safe in this direction and would not be in the other. A first frame that
 * reaches outside the declared screen enlarges it, which is what browsers do
 * and what `readGif` does below. And an animation returns every frame at that
 * size, so the memory an animated file actually costs is this multiplied by a
 * frame count nothing in the header states. A caller refusing on a number that
 * is too small refuses nothing that should have been allowed; one refusing on
 * a number that is too large would reject working files, so do not be tempted
 * to guess a frame count here.
 *
 * Never throws, and says nothing rather than guessing. A file this cannot read
 * is one `readGif` refuses with a sentence naming what it stopped inside.
 */
export function measureGif(
	bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
	if (bytes.length < HEADER_BYTES) return undefined;
	const signature = ascii(bytes, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined;
	const width = (bytes[6] as number) | ((bytes[7] as number) << 8);
	const height = (bytes[8] as number) | ((bytes[9] as number) << 8);
	if (width < 1 || height < 1) return undefined;
	return { width, height };
}

/**
 * Read the first frame of a GIF as a picture.
 *
 * Composited rather than raw, so a file whose first frame is a small patch in
 * the corner of a large screen comes back the size it claims to be.
 */
export function decodeGif(bytes: Uint8Array): RasterImage {
	return readGif(bytes, true).image;
}

/**
 * Read every frame of a GIF.
 *
 * Each frame is a whole picture at the logical screen size with the disposal
 * rules already applied, for the reason given on `AnimationFrame`: the two
 * animated formats this package reads disagree about what "restore to
 * background" means, and settling it here means the disagreement never reaches
 * an encoder.
 */
export function decodeGifAnimation(bytes: Uint8Array): GifResult {
	return readGif(bytes, false);
}
