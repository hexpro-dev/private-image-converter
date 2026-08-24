/**
 * An APNG writer.
 *
 * Every frame is written whole, at the canvas size, with disposal method NONE
 * and blend method SOURCE. That is deliberately the dullest of the choices the
 * format offers, and it is exactly right for whole frames: SOURCE overwrites
 * the canvas including its alpha, so no frame can be affected by what was under
 * it, and NONE has nothing to undo. The alternative, cropping each frame to the
 * rectangle that changed and picking a disposal to suit, is where every
 * compositing subtlety in the format lives, and it buys size rather than
 * correctness. A writer that carried those subtleties would have to be right
 * about them on files nobody looks at twice.
 *
 * The picture is `options.animation`. A caller that has no animation to give
 * gets a one frame APNG of the image it passed, which is a legal file and
 * displays as a still everywhere.
 */

import { EncodeFailedError } from '../../errors.js';
import type { AnimationFrame, EncodeOptions, RasterImage } from '../../types.js';
import {
	colourChunks,
	compressedPixels,
	concatChunks,
	PNG_SIGNATURE,
	pngChunk,
	pngHeaderChunk,
} from './encode.js';

const ENCODER_ID = 'apng-pure';

/** `delay_num` and `delay_den` are both unsigned 16 bit fields. */
const MAX_DELAY_FIELD = 0xffff;

/** The denominators worth trying, finest first. */
const DENOMINATORS = [1000, 100, 10, 1];

function fail(detail: string): never {
	throw new EncodeFailedError('apng', ENCODER_ID, detail);
}

/**
 * A duration in milliseconds as the rational seconds the format stores.
 *
 * A thousandth is the finest denominator worth writing, because a duration in
 * milliseconds cannot say anything finer, and it holds any frame up to 65.535
 * seconds. Past that the numerator would not fit, so the denominator coarsens
 * a step at a time. A frame shown for longer than eighteen hours is clamped
 * rather than wrapped: wrapping would turn a very long pause into a very short
 * one, which reads as a broken file rather than a clamped one.
 */
function delayRational(delayMs: number): readonly [number, number] {
	if (!Number.isFinite(delayMs) || delayMs <= 0) return [0, 1000];
	for (const denominator of DENOMINATORS) {
		const numerator = Math.round((delayMs * denominator) / 1000);
		if (numerator <= MAX_DELAY_FIELD) return [numerator, denominator];
	}
	return [MAX_DELAY_FIELD, 1];
}

function frameControl(
	sequence: number,
	width: number,
	height: number,
	delayMs: number,
): Uint8Array {
	const body = new Uint8Array(26);
	const view = new DataView(body.buffer);
	const [delayNumerator, delayDenominator] = delayRational(delayMs);
	view.setUint32(0, sequence);
	view.setUint32(4, width);
	view.setUint32(8, height);
	// x_offset and y_offset stay zero: every frame here covers the canvas.
	view.setUint16(20, delayNumerator);
	view.setUint16(22, delayDenominator);
	body[24] = 0; // APNG_DISPOSE_OP_NONE
	body[25] = 0; // APNG_BLEND_OP_SOURCE
	return pngChunk('fcTL', body);
}

/** `fdAT` is a sequence number followed by the same stream an IDAT holds. */
function frameData(sequence: number, compressed: Uint8Array): Uint8Array {
	const body = new Uint8Array(4 + compressed.length);
	new DataView(body.buffer).setUint32(0, sequence);
	body.set(compressed, 4);
	return pngChunk('fdAT', body);
}

function animationControl(frames: number, loopCount: number): Uint8Array {
	const body = new Uint8Array(8);
	const view = new DataView(body.buffer);
	view.setUint32(0, frames);
	// num_plays of zero means forever, which is what loopCount means as well.
	view.setUint32(4, Math.max(0, Math.min(0xffffffff, Math.trunc(loopCount))));
	return pngChunk('acTL', body);
}

export async function encodeApng(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	const supplied = options.animation?.frames ?? [];
	// An animation with no frames in it is not a request for an empty file. It
	// is a caller that had nothing to add, and the image is what it has.
	const frames: readonly AnimationFrame[] =
		supplied.length > 0 ? supplied : [{ image, delayMs: 0 }];

	const first = (frames[0] as AnimationFrame).image;
	const { width, height } = first;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the image has no width or no height, so there is nothing to write.');
	}

	for (const frame of frames) {
		if (frame.image.width !== width || frame.image.height !== height) {
			fail(
				'the frames are not all the same size, and this writer only writes frames that cover the whole canvas.',
			);
		}
		if (frame.image.data.length < width * height * 4) {
			fail('a frame holds fewer pixels than its width and height say it should.');
		}
	}

	// One colour type for the whole file, so a frame that carries alpha decides
	// it for all of them. `compressedPixels` writes an opaque alpha for a frame
	// that says it has none, which is what stops a frame straight out of
	// `createRaster` being written as fully transparent.
	const hasAlpha = frames.some((frame) => frame.image.hasAlpha);
	const channels = hasAlpha ? 4 : 3;

	const pieces: Uint8Array[] = [
		PNG_SIGNATURE,
		pngHeaderChunk(width, height, 8, hasAlpha ? 6 : 2),
		// Tagged from the frames rather than from `image`, which is only the
		// fallback picture and need not be one of them.
		...(await colourChunks(first, options)),
		animationControl(frames.length, options.animation?.loopCount ?? 0),
	];

	// fcTL and fdAT share one ascending run of sequence numbers, and the IDAT
	// that carries the first frame is not part of it: an IDAT has no sequence
	// number, because a reader that cannot animate has to be able to ignore
	// every chunk that does.
	let sequence = 0;
	for (let i = 0; i < frames.length; i += 1) {
		const frame = frames[i] as AnimationFrame;
		pieces.push(frameControl(sequence, width, height, frame.delayMs));
		sequence += 1;
		const compressed = await compressedPixels(frame.image, channels);
		if (i === 0) {
			pieces.push(pngChunk('IDAT', compressed));
		} else {
			pieces.push(frameData(sequence, compressed));
			sequence += 1;
		}
	}

	pieces.push(pngChunk('IEND', new Uint8Array(0)));
	return concatChunks(pieces);
}
