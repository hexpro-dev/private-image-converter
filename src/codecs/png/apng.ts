/**
 * An APNG reader.
 *
 * An APNG is an ordinary PNG with three extra chunks: `acTL` says how many
 * frames there are and how many times to play them, `fcTL` describes where one
 * frame lands and how long it is shown, and `fdAT` carries the frame's pixels
 * in exactly the stream an `IDAT` holds. Every frame is a normal PNG image at
 * its own size, so nothing here reads a filter or a sample: `decode.ts` does
 * that, and this file only decides what lands where.
 *
 * Two things about the format catch every reader that skims the specification.
 *
 * The default image, the one an `IDAT` carries, is part of the animation only
 * when an `fcTL` appears before it. When it does not, the file's author chose a
 * poster frame for readers that cannot animate, and it is not shown during
 * playback at all. Treating it as frame zero regardless is the classic bug: the
 * animation gains a frame nobody expected, and because a poster frame usually
 * looks like the animation, it reads as a stutter rather than as a bug.
 *
 * And a frame is a patch, not a picture. It carries a rectangle, a rule for
 * what to do with the canvas afterwards and a rule for how to mix itself in.
 * Reproducing those rules is this reader's job exactly once, because
 * `AnimationFrame` is a whole composited picture: a converter that received
 * patches would have to implement APNG's compositing to write any other format.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { Animation, AnimationFrame, ColourSpace, RasterImage } from '../../types.js';
import {
	checkPngHeader,
	decodePngImage,
	joinChunkData,
	readPngChunks,
	readPngHeader,
	type PngHeader,
} from './decode.js';

const DECODER_ID = 'apng-pure';

/** The whole of `fcTL` after its length and type: 26 bytes of fields. */
const FRAME_CONTROL_BYTES = 26;

// Disposal method 0 is APNG_DISPOSE_OP_NONE, which leaves the canvas exactly
// as the frame drew it and so needs no code of its own.
const DISPOSE_BACKGROUND = 1;
const DISPOSE_PREVIOUS = 2;

const BLEND_SOURCE = 0;
const BLEND_OVER = 1;

/**
 * The most composited pixels this reader will hold at once.
 *
 * Every frame is kept as a whole picture at canvas size, which is what makes an
 * animation usable by an encoder for any other format and also what makes a
 * long one expensive: a thousand frames of 500 by 500 is a gigabyte. The number
 * is where a browser tab stops coping rather than anything the format says, and
 * it is checked against the frame count the file actually carries rather than
 * the count it declares, so a file cannot reserve memory by lying.
 */
const MAX_ANIMATION_PIXELS = 200_000_000;

function fail(detail: string): never {
	throw new DecodeFailedError('apng', DECODER_ID, detail);
}

/** One `fcTL`, with the fields named as the specification names them. */
interface FrameControl {
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

interface PendingFrame {
	readonly control: FrameControl;
	/** The `fdAT` payloads for this frame, sequence numbers already stripped. */
	readonly parts: Uint8Array[];
}

/**
 * How much frame data a frame actually carries, in bytes.
 *
 * Counted rather than the chunks being counted, because an `fdAT` holding its
 * sequence number and nothing after it is a legal chunk carrying nothing. A
 * frame made of those has as little in it as a frame with no `fdAT` at all, and
 * counting chunks lets it through to the decompressor, which fails on an empty
 * stream with a bare `TypeError` instead of the sentence this reader owes the
 * person holding the file.
 */
function payloadBytes(parts: readonly Uint8Array[]): number {
	let total = 0;
	for (const part of parts) total += part.length;
	return total;
}

export interface ApngDecode {
	/**
	 * The still a person would expect to see.
	 *
	 * The default image, which is what every reader that cannot animate shows.
	 * When the default image is part of the animation this is frame zero
	 * composited; when it is a poster frame it is that poster frame, which is
	 * the picture its author chose to stand for the whole thing.
	 */
	readonly image: RasterImage;
	readonly animation: Animation;
}

function readFrameControl(body: Uint8Array): FrameControl {
	if (body.length < FRAME_CONTROL_BYTES) {
		fail('a frame control chunk is shorter than the 26 bytes of fields it must carry.');
	}
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	return {
		sequence: view.getUint32(0),
		width: view.getUint32(4),
		height: view.getUint32(8),
		x: view.getUint32(12),
		y: view.getUint32(16),
		delayNum: view.getUint16(20),
		delayDen: view.getUint16(22),
		dispose: body[24] as number,
		blend: body[25] as number,
	};
}

/**
 * How long a frame is shown, in milliseconds.
 *
 * The file stores a rational in seconds, and a denominator of zero means a
 * hundredth rather than a division by zero. A numerator of zero is legal and
 * means "as fast as the reader can manage", which is left as the zero it is:
 * clamping it here would put this reader's idea of a sensible frame rate into
 * an encoder's output, where the person converting the file cannot see it.
 */
function delayOf(control: FrameControl): number {
	return (control.delayNum * 1000) / (control.delayDen === 0 ? 100 : control.delayDen);
}

function checkFrameRect(control: FrameControl, header: PngHeader): void {
	if (control.width < 1 || control.height < 1) {
		fail('a frame declares a width or a height of zero.');
	}
	// Written as a subtraction so that an offset near four billion cannot carry
	// the sum past what a double counts exactly and come out looking small.
	if (control.x > header.width - control.width || control.y > header.height - control.height) {
		fail('a frame reaches past the edge of the canvas it is drawn on.');
	}
	if (control.dispose > DISPOSE_PREVIOUS) {
		fail(`a frame declares disposal method ${control.dispose}, which does not exist.`);
	}
	if (control.blend > BLEND_OVER) {
		fail(`a frame declares blend method ${control.blend}, which does not exist.`);
	}
}

/** Overwrite the frame's rectangle, alpha and all. `APNG_BLEND_OP_SOURCE`. */
function drawSource(canvas: RasterImage, frame: RasterImage, x: number, y: number): void {
	for (let row = 0; row < frame.height; row += 1) {
		const from = row * frame.width * 4;
		const to = ((y + row) * canvas.width + x) * 4;
		canvas.data.set(frame.data.subarray(from, from + frame.width * 4), to);
	}
}

/**
 * Composite the frame over what is already there. `APNG_BLEND_OP_OVER`.
 *
 * Straight alpha in and straight alpha out, which is the arithmetic in the
 * alpha channel clause of the PNG specification. Premultiplying instead would
 * be the same picture, but every frame would have to be divided back out for
 * the next one, and the rounding of that round trip accumulates over a long
 * animation into a visible drift.
 */
function drawOver(canvas: RasterImage, frame: RasterImage, x: number, y: number): void {
	for (let row = 0; row < frame.height; row += 1) {
		for (let column = 0; column < frame.width; column += 1) {
			const from = (row * frame.width + column) * 4;
			const to = ((y + row) * canvas.width + x + column) * 4;
			const sourceAlpha = (frame.data[from + 3] as number) / 255;
			if (sourceAlpha === 1) {
				canvas.data[to] = frame.data[from] as number;
				canvas.data[to + 1] = frame.data[from + 1] as number;
				canvas.data[to + 2] = frame.data[from + 2] as number;
				canvas.data[to + 3] = 255;
				continue;
			}
			if (sourceAlpha === 0) continue;
			const targetAlpha = (canvas.data[to + 3] as number) / 255;
			const kept = targetAlpha * (1 - sourceAlpha);
			const alpha = sourceAlpha + kept;
			for (let channel = 0; channel < 3; channel += 1) {
				const source = frame.data[from + channel] as number;
				const target = canvas.data[to + channel] as number;
				canvas.data[to + channel] = Math.round((source * sourceAlpha + target * kept) / alpha);
			}
			canvas.data[to + 3] = Math.round(alpha * 255);
		}
	}
}

/** The frame's rectangle, kept so `APNG_DISPOSE_OP_PREVIOUS` can put it back. */
function copyRegion(canvas: RasterImage, control: FrameControl): Uint8ClampedArray {
	const kept = new Uint8ClampedArray(control.width * control.height * 4);
	for (let row = 0; row < control.height; row += 1) {
		const from = ((control.y + row) * canvas.width + control.x) * 4;
		kept.set(canvas.data.subarray(from, from + control.width * 4), row * control.width * 4);
	}
	return kept;
}

function restoreRegion(canvas: RasterImage, control: FrameControl, kept: Uint8ClampedArray): void {
	for (let row = 0; row < control.height; row += 1) {
		const to = ((control.y + row) * canvas.width + control.x) * 4;
		canvas.data.set(kept.subarray(row * control.width * 4, (row + 1) * control.width * 4), to);
	}
}

/** Clear the frame's rectangle to fully transparent black. */
function clearRegion(canvas: RasterImage, control: FrameControl): void {
	for (let row = 0; row < control.height; row += 1) {
		const to = ((control.y + row) * canvas.width + control.x) * 4;
		canvas.data.fill(0, to, to + control.width * 4);
	}
}

/** A frame of the animation: the whole canvas as it stands, copied. */
function snapshot(canvas: RasterImage): RasterImage {
	const out = createRaster(canvas.width, canvas.height, canvas.colourSpace, false);
	out.data.set(canvas.data);
	return { ...out, hasAlpha: detectAlpha(out) };
}

interface Parsed {
	readonly header: PngHeader;
	readonly palette?: Uint8Array;
	readonly transparency?: Uint8Array;
	readonly colourSpace: ColourSpace;
	readonly idat: Uint8Array[];
	readonly pending: PendingFrame[];
	/** True when an `fcTL` came before the first `IDAT`. */
	readonly defaultIsFrame: boolean;
	readonly numPlays: number;
}

function parse(bytes: Uint8Array): Parsed {
	const chunks = readPngChunks(bytes, fail);

	let header: PngHeader | undefined;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	let colourSpace: ColourSpace = 'srgb';
	let control: { numFrames: number; numPlays: number } | undefined;
	const idat: Uint8Array[] = [];
	const pending: PendingFrame[] = [];
	// One ascending run shared by both chunk types, so they are collected
	// together in the order the file wrote them.
	const sequences: number[] = [];
	let seenIdat = false;
	let defaultIsFrame = false;

	for (const { type, body } of chunks) {
		switch (type) {
			case 'IHDR':
				header = readPngHeader(body, fail);
				break;
			case 'PLTE':
				palette = body;
				break;
			case 'tRNS':
				transparency = body;
				break;
			case 'cICP':
				// Colour primaries 12 is SMPTE EG 432-1, which is Display P3.
				if (body[0] === 12) colourSpace = 'display-p3';
				break;
			case 'acTL': {
				if (body.length < 8) fail('its animation control chunk is too short to be read.');
				const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
				control = { numFrames: view.getUint32(0), numPlays: view.getUint32(4) };
				break;
			}
			case 'fcTL': {
				const frame = readFrameControl(body);
				sequences.push(frame.sequence);
				pending.push({ control: frame, parts: [] });
				break;
			}
			case 'fdAT': {
				if (body.length < 4) fail('a frame data chunk is too short to hold its sequence number.');
				const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
				sequences.push(view.getUint32(0));
				const current = pending[pending.length - 1];
				if (!current) fail('a frame data chunk arrives before any frame has been described.');
				current.parts.push(body.subarray(4));
				break;
			}
			case 'IDAT':
				if (!seenIdat) {
					seenIdat = true;
					// The whole poster frame question, decided here and nowhere
					// else: a frame described before the image data owns it.
					if (pending.length > 1) {
						fail('more than one frame is described before the image data, and only one may be.');
					}
					defaultIsFrame = pending.length === 1;
				}
				idat.push(body);
				break;
			default:
				break;
		}
	}

	if (!header) fail('it has no header chunk.');
	if (idat.length === 0) fail('it has no image data.');
	if (!control) {
		fail('it carries no animation control chunk, so there is no animation in it to read.');
	}
	checkPngHeader(header, fail);
	if (header.colourType === 3 && !palette) fail('it is palettised but carries no palette.');

	for (let i = 0; i < sequences.length; i += 1) {
		if (sequences[i] !== i) {
			fail(
				`a frame chunk is numbered ${sequences[i] as number} where ${i} was expected, so frames are missing, repeated or out of order.`,
			);
		}
	}

	if (control.numFrames !== pending.length) {
		fail(
			`it says it has ${control.numFrames} frames and describes ${pending.length}, so part of it is missing.`,
		);
	}
	if (pending.length === 0) fail('it declares no frames at all.');
	if (header.width * header.height * pending.length > MAX_ANIMATION_PIXELS) {
		fail('it holds more frames at that size than this reader will keep in memory at once.');
	}

	for (const frame of pending) checkFrameRect(frame.control, header);

	if (defaultIsFrame) {
		// The default image is this frame's pixels, so its rectangle has to be
		// the whole canvas. A file that says otherwise is describing a frame it
		// has not supplied.
		const first = pending[0] as PendingFrame;
		if (
			first.control.x !== 0 ||
			first.control.y !== 0 ||
			first.control.width !== header.width ||
			first.control.height !== header.height
		) {
			fail('the first frame is the default image but does not cover the whole canvas.');
		}
		// Checked on either side of the IDAT at once. Frame data arriving before
		// it is the same contradiction as frame data arriving after it, and the
		// version of this check that lived in the chunk walk could only see one
		// of the two.
		if (first.parts.length > 0) {
			fail('the first frame carries both image data and frame data, and it may hold only one.');
		}
	}

	for (let i = defaultIsFrame ? 1 : 0; i < pending.length; i += 1) {
		if (payloadBytes((pending[i] as PendingFrame).parts) === 0) {
			fail('a frame is described but carries no data of its own.');
		}
	}

	return {
		header,
		palette,
		transparency,
		colourSpace,
		idat,
		pending,
		defaultIsFrame,
		numPlays: control.numPlays,
	};
}

export async function decodeApng(bytes: Uint8Array): Promise<ApngDecode> {
	const parsed = parse(bytes);
	const { header, palette, transparency, colourSpace, pending, defaultIsFrame } = parsed;

	const shared = {
		bitDepth: header.bitDepth,
		colourType: header.colourType,
		palette,
		transparency,
		colourSpace,
	};

	const defaultImage = await decodePngImage(
		joinChunkData(parsed.idat),
		{ ...shared, width: header.width, height: header.height },
		fail,
	);

	// Fully transparent black, which is what the specification starts the output
	// buffer at and what makes `APNG_BLEND_OP_OVER` on the first frame the same
	// as `APNG_BLEND_OP_SOURCE`.
	const canvas = createRaster(header.width, header.height, colourSpace, true);
	const frames: AnimationFrame[] = [];

	for (let i = 0; i < pending.length; i += 1) {
		const { control, parts } = pending[i] as PendingFrame;
		const patch =
			defaultIsFrame && i === 0
				? defaultImage
				: await decodePngImage(
						joinChunkData(parts),
						{ ...shared, width: control.width, height: control.height },
						fail,
					);

		// Kept before the frame is drawn, because "previous" means the canvas as
		// it stood before this frame, not before the one after it. The
		// specification says a `DISPOSE_PREVIOUS` on the first frame is to be
		// treated as `DISPOSE_BACKGROUND`, and no special case is needed for it
		// here: the canvas starts fully transparent, so putting the first
		// frame's rectangle back is clearing it.
		const kept = control.dispose === DISPOSE_PREVIOUS ? copyRegion(canvas, control) : undefined;

		if (control.blend === BLEND_SOURCE) {
			drawSource(canvas, patch, control.x, control.y);
		} else {
			drawOver(canvas, patch, control.x, control.y);
		}

		frames.push({ image: snapshot(canvas), delayMs: delayOf(control) });

		// Disposal happens after the frame has been shown, to prepare the canvas
		// for the next one. Doing it before drawing instead is the other way this
		// gets written, and it is wrong by exactly one frame.
		if (control.dispose === DISPOSE_BACKGROUND) clearRegion(canvas, control);
		else if (kept) restoreRegion(canvas, control, kept);
	}

	return {
		// The poster frame when there is one, and frame zero when there is not.
		// Both are the default image, which is the whole point of it.
		image: defaultImage,
		// `num_plays` of zero means forever, which is what `loopCount` means too,
		// so this is a copy rather than a conversion.
		animation: { frames, loopCount: parsed.numPlays },
	};
}
