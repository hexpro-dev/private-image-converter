/**
 * The animated WebP container, written.
 *
 * WebP is RIFF underneath: twelve bytes of file header, then a run of chunks,
 * each a four character tag, a little-endian size, and a payload padded up to
 * an even length. A still WebP is usually one `VP8 ` or `VP8L` chunk and
 * nothing else at all. An animated one has to be the extended form: `VP8X` to
 * declare the canvas and which optional pieces are present, `ANIM` to carry
 * the background colour and the loop count, and then one `ANMF` per frame,
 * each wrapping the same picture chunks a still file would have held on its
 * own.
 *
 * The padding rule is where a RIFF writer goes wrong quietly. The size field
 * counts the payload and never the pad byte, so a writer that includes the pad
 * in the size, or a reader that adds the size to the offset without rounding
 * up, lands one byte out on everything after the first odd chunk and then
 * reads tags out of the middle of a bitstream. Both halves of the rule are
 * here, in `chunk` and in `readWebpChunks`, and the tests keep an odd length
 * payload around for exactly this reason.
 *
 * Every frame is a whole picture at the canvas size, and that is what makes
 * this writer short enough to trust. `Animation` in `src/types.ts` hands over
 * frames that have already been composited, so every `ANMF` sits at 0,0,
 * covers the canvas, and has no disposal or blending subtlety to reproduce. A
 * writer fed the dirty rectangles a GIF actually stores would have to restate
 * GIF's disposal rules in WebP's spelling, and the two formats do not mean the
 * same thing by "restore to background".
 */

import { EncodeFailedError } from '../../errors.js';

const ENCODER_ID = 'webp-animated';

function fail(detail: string): never {
	throw new EncodeFailedError('webp', ENCODER_ID, detail);
}

/* ── Bytes ────────────────────────────────────────────────────────────── */

const EMPTY = new Uint8Array(0);

function u8(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff);
}

function u16le(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

/** Three bytes, least significant first. `VP8X` and `ANMF` are built of these. */
function u24le(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
}

function u32le(value: number): Uint8Array {
	return Uint8Array.of(
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	);
}

/** A four character chunk tag. ASCII by definition of the format. */
function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
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

/**
 * A chunk: a tag, the size of the payload, the payload, and a pad if it is odd.
 *
 * The pad byte is deliberately not counted in the size it follows. Counting it
 * there produces a file of exactly the right length whose every reader is one
 * byte out, which is worse than a file that is obviously broken.
 */
function chunk(fourCC: string, ...parts: Uint8Array[]): Uint8Array {
	const payload = concat(parts);
	return concat([
		ascii(fourCC),
		u32le(payload.length),
		payload,
		payload.length & 1 ? Uint8Array.of(0) : EMPTY,
	]);
}

function tagAt(bytes: Uint8Array, at: number): string {
	let tag = '';
	for (let i = 0; i < 4; i += 1) tag += String.fromCharCode(bytes[at + i] as number);
	return tag;
}

function u32leAt(bytes: Uint8Array, at: number): number {
	return (
		((bytes[at] as number) |
			((bytes[at + 1] as number) << 8) |
			((bytes[at + 2] as number) << 16) |
			((bytes[at + 3] as number) << 24)) >>>
		0
	);
}

/* ── Reading ──────────────────────────────────────────────────────────── */

/** One RIFF chunk, as a tag and a view over the payload inside the file. */
export interface WebpChunk {
	readonly fourCC: string;
	readonly payload: Uint8Array;
}

/**
 * Walk a WebP file and hand back its chunks.
 *
 * Views rather than copies: the caller here is lifting a frame's picture out
 * of a file the browser wrote a moment ago, and copying every frame twice on
 * the way into a container costs real memory on a long animation.
 *
 * Anything that is not a WebP walks to nothing rather than throwing. The one
 * caller has already been told by `encodeNative` that these bytes really are a
 * WebP, so an empty answer here means something stranger than a wrong format
 * and the message it writes says so.
 */
export function readWebpChunks(bytes: Uint8Array): readonly WebpChunk[] {
	if (bytes.length < 12) return [];
	if (tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'WEBP') return [];

	// Bounded by the declared size as well as by the buffer, because either can
	// be the shorter of the two. A truncated write leaves a size field
	// describing bytes that are not there, and a caller may hand over a view
	// with other things after it.
	const end = Math.min(bytes.length, 8 + u32leAt(bytes, 4));
	const out: WebpChunk[] = [];
	let at = 12;
	while (at + 8 <= end) {
		const size = u32leAt(bytes, at + 4);
		// A chunk claiming more than is left is where a truncated file stops.
		// Keeping the part of it that did arrive would put half a picture in a
		// frame, which decodes to noise rather than to an error.
		if (at + 8 + size > end) break;
		out.push({ fourCC: tagAt(bytes, at), payload: bytes.subarray(at + 8, at + 8 + size) });
		at += 8 + size + (size & 1);
	}
	return out;
}

/* ── Writing ──────────────────────────────────────────────────────────── */

/** One frame's coded picture, lifted out of the still WebP that carried it. */
export interface WebpCodedFrame {
	/** The picture itself: a `VP8 ` or `VP8L` chunk, tag and payload together. */
	readonly bitstream: WebpChunk;
	/** The `ALPH` payload, where a lossy picture carries its coverage separately. */
	readonly alpha?: Uint8Array;
	/** How long the frame is shown, in milliseconds. */
	readonly durationMs: number;
}

export interface WebpAnimationSpec {
	readonly width: number;
	readonly height: number;
	readonly frames: readonly WebpCodedFrame[];
	/** 0 plays forever, which is what the format means by it as well. */
	readonly loopCount: number;
	/** The canvas background, as the rest of this package spells a colour. */
	readonly background?: readonly [number, number, number];
}

/** `VP8X` feature bits. Only these two are ever set by this writer. */
const FLAG_ANIMATION = 0x02;
const FLAG_ALPHA = 0x10;

/** The three reserved bytes that follow the `VP8X` flags. */
const VP8X_RESERVED = new Uint8Array(3);

/**
 * Blending off, disposal off, on every frame.
 *
 * Bit 1 is the blending method and bit 0 the disposal method, and the values
 * that matter are 1 for "do not blend" and 0 for "leave the canvas alone".
 * Both are forced by the frames being composited already: alpha blending would
 * draw a frame's transparent holes over whatever the previous frame left
 * underneath, so a fading animation would smear instead of fading, and any
 * disposal at all would be undoing a frame that covers the whole canvas.
 */
const FRAME_FLAGS = 0x02;

/** Canvas and frame sides are stored minus one, in 24 bits. */
const MAX_SIDE = 1 << 24;

/** `ANMF` stores a duration in 24 bits of milliseconds: a shade under 4.7 hours. */
const MAX_DURATION = 0xffffff;

/** `ANIM` stores the loop count in 16 bits. */
const MAX_LOOPS = 0xffff;

/**
 * A frame duration in the field's own units.
 *
 * Clamped rather than wrapped at the top, on the same reasoning the APNG
 * writer uses: a frame held for longer than the field can say is a strange
 * file, and a five hour pause wrapping round to twenty minutes would look like
 * a decoding bug rather than a clamp. Zero is passed through, because the
 * readers in this package have already resolved GIF's and APNG's "as fast as
 * possible" spellings into real milliseconds, so a zero arriving here came
 * from a source that meant it.
 */
function duration(delayMs: number): number {
	if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
	return Math.min(MAX_DURATION, Math.round(delayMs));
}

/**
 * The loop count, in the format's own spelling.
 *
 * Both conventions agree that zero means forever, so this is a clamp and not a
 * conversion, and the clamp is the part worth writing down. A count above the
 * field has to come out as 65535 and not as the low sixteen bits of itself:
 * wrapping 65536 gives zero, which turns "play it a great many times" into
 * "play it until the tab is closed". That is the one value anybody notices.
 */
function loops(loopCount: number): number {
	if (!Number.isFinite(loopCount) || loopCount <= 0) return 0;
	return Math.min(MAX_LOOPS, Math.round(loopCount));
}

/**
 * Whether a lossless bitstream says it uses alpha.
 *
 * `VP8L` is a signature byte of 0x2f and then a bit field filled from the
 * least significant end: fourteen bits of width minus one, fourteen of height
 * minus one, one `alpha_is_used` bit, three of version. The alpha bit is
 * therefore bit 28 of that field, which is bit 4 of the fifth byte of the
 * chunk. It is read rather than inferred from the raster, because the flag in
 * `VP8X` has to describe what is in the file: a picture whose translucent
 * pixels the encoder decided to drop is opaque now, whatever it used to be.
 */
function losslessUsesAlpha(payload: Uint8Array): boolean {
	if (payload.length < 5 || payload[0] !== 0x2f) return false;
	return ((payload[4] as number) & 0x10) !== 0;
}

function carriesAlpha(frame: WebpCodedFrame): boolean {
	if (frame.alpha) return true;
	return frame.bitstream.fourCC === 'VP8L' && losslessUsesAlpha(frame.bitstream.payload);
}

/**
 * One frame, as the `ANMF` chunk that places it on the canvas.
 *
 * The offsets are stored in units of two pixels, and both of them are zero,
 * which is the whole reason there is no rounding here: a composited frame
 * covers the canvas, so there is no rectangle to place and no odd coordinate
 * that would have to move by a pixel to be expressible.
 */
function anmf(frame: WebpCodedFrame, width: number, height: number): Uint8Array {
	return chunk(
		'ANMF',
		u24le(0),
		u24le(0),
		u24le(width - 1),
		u24le(height - 1),
		u24le(duration(frame.durationMs)),
		u8(FRAME_FLAGS),
		// `ALPH` first where there is one. The specification gives the frame's
		// payload the same shape as an extended still file's, and a reader
		// looking for coverage before the picture it belongs to is entitled to
		// stop at the picture.
		...(frame.alpha ? [chunk('ALPH', frame.alpha)] : []),
		chunk(frame.bitstream.fourCC, frame.bitstream.payload),
	);
}

/**
 * Write an animated WebP around frames that are already coded.
 *
 * Nothing here encodes a picture: the frames arrive as the `VP8 `, `VP8L` and
 * `ALPH` chunks somebody else produced, and this decides where they go. That
 * split is what lets the container be tested under Node, where there is no
 * WebP encoder of any kind.
 */
export function muxAnimatedWebp(spec: WebpAnimationSpec): Uint8Array {
	const { width, height, frames } = spec;
	if (frames.length === 0) fail('there are no frames to put in it.');
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the canvas has no width or no height, so there is nothing to write.');
	}
	if (width > MAX_SIDE || height > MAX_SIDE) {
		fail('the canvas is larger than the size fields of this format can describe.');
	}

	const [red, green, blue] = spec.background ?? [255, 255, 255];
	const body = concat([
		chunk(
			'VP8X',
			u8(FLAG_ANIMATION | (frames.some(carriesAlpha) ? FLAG_ALPHA : 0)),
			VP8X_RESERVED,
			u24le(width - 1),
			u24le(height - 1),
		),
		chunk(
			'ANIM',
			// Blue, green, red, alpha, in that order in the file, which is the
			// one place in this format where a colour is not written in the
			// order the rest of this package reads one. A viewer is permitted
			// to paint it around frames smaller than the canvas and through the
			// transparent pixels of the first frame; no frame here is smaller
			// than the canvas, so only the second of those can happen, and it
			// is the reason this is the flatten colour rather than a fixed one.
			Uint8Array.of(blue & 0xff, green & 0xff, red & 0xff, 0xff),
			u16le(loops(spec.loopCount)),
		),
		...frames.map((frame) => anmf(frame, width, height)),
	]);

	// The size field covers everything after itself, which includes the four
	// bytes of `WEBP` as well as the chunks.
	return concat([ascii('RIFF'), u32le(4 + body.length), ascii('WEBP'), body]);
}
