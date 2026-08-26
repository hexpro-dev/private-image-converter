/**
 * Read every frame of an animation the browser already understands.
 *
 * `createImageBitmap` decodes an animated WebP, AVIF or GIF and hands back one
 * picture: the first frame, silently. That is the right answer for a preview
 * and the wrong one for a conversion, and somebody who drops in a moving image
 * and gets a still one back has no way to tell whether the tool ignored the
 * animation or the file never had one.
 *
 * `ImageDecoder` is the API that answers properly. It exists in Chromium and
 * not yet in Safari or Firefox, which is why this is a rung above the ordinary
 * native decoder rather than a replacement for it: where it is missing, the
 * pure GIF and APNG readers cover the two formats people actually animate, and
 * an animated WebP falls back to its first frame with the report saying so.
 *
 * Browser only, so not covered by the Node suite. It is on the manual
 * checklist in RELEASING.md instead.
 */

import { DecodeFailedError, SurfaceTooLargeError } from '../../errors.js';
import type { Animation, AnimationFrame, FormatId, RasterImage } from '../../types.js';
import { canvasHolds, context2d, requireCanvas } from '../../raster/canvas.js';

/**
 * The parts of `ImageDecoder` this uses.
 *
 * Declared structurally rather than relying on the DOM library, because the
 * shape has moved between TypeScript releases and a consumer of this package
 * should not have to be on a particular one to compile it.
 */
interface DecodedImage {
	readonly image: {
		readonly displayWidth: number;
		readonly displayHeight: number;
		/** Microseconds, and null on a file that does not say. */
		readonly duration: number | null;
		close(): void;
	};
	readonly complete: boolean;
}

interface DecoderTrack {
	readonly frameCount: number;
	/** Infinity when the file asks to loop forever, which most of them do. */
	readonly repetitionCount: number;
	readonly animated: boolean;
}

interface Decoder {
	readonly tracks: {
		readonly selectedTrack: DecoderTrack | null;
		readonly ready: Promise<void>;
	};
	readonly completed: Promise<void>;
	decode(options: { frameIndex: number }): Promise<DecodedImage>;
	close(): void;
}

type DecoderConstructor = new (init: { data: Uint8Array; type: string }) => Decoder;

function decoderClass(): DecoderConstructor | undefined {
	return (globalThis as { ImageDecoder?: DecoderConstructor }).ImageDecoder;
}

export function imageDecoderAvailable(): boolean {
	return typeof decoderClass() === 'function';
}

/**
 * The most frames this will pull out of one file.
 *
 * A frame is a whole uncompressed picture. Five hundred frames of a 1920 by
 * 1080 animation is four gigabytes, which is not a conversion, it is a crash.
 * The limit is reported rather than hidden, so a file that hits it says the
 * animation was truncated instead of quietly losing its ending.
 */
export const MAX_FRAMES = 300;

export interface AnimatedDecode {
	readonly image: RasterImage;
	readonly animation?: Animation;
	/** True when the file had more frames than were read. */
	readonly truncated: boolean;
}

export async function decodeAnimatedNative(
	bytes: Uint8Array,
	format: FormatId,
	mime: string,
): Promise<AnimatedDecode> {
	const ImageDecoderClass = decoderClass();
	if (!ImageDecoderClass) {
		throw new DecodeFailedError(format, 'native-animated', 'this browser has no frame decoder');
	}

	let decoder: Decoder;
	try {
		decoder = new ImageDecoderClass({ data: bytes, type: mime });
		await decoder.tracks.ready;
	} catch (error) {
		throw new DecodeFailedError(format, 'native-animated', 'the browser refused it', {
			cause: error,
		});
	}

	try {
		const track = decoder.tracks.selectedTrack;
		if (!track) {
			throw new DecodeFailedError(format, 'native-animated', 'it carries no image track');
		}
		// A frame count of zero means the decoder has not finished reading the
		// container yet, which happens on a file handed over in one go often
		// enough to be worth waiting for rather than reporting as empty.
		if (track.frameCount === 0) await decoder.completed;

		const total = Math.max(1, track.frameCount);
		const wanted = Math.min(total, MAX_FRAMES);
		const frames: AnimationFrame[] = [];

		for (let index = 0; index < wanted; index += 1) {
			const decoded = await decoder.decode({ frameIndex: index });
			try {
				const { displayWidth, displayHeight } = decoded.image;
				if (!canvasHolds(displayWidth, displayHeight)) {
					throw new SurfaceTooLargeError(displayWidth, displayHeight);
				}
				frames.push({
					image: frameToRaster(decoded.image, displayWidth, displayHeight),
					// Microseconds on the frame, and the two conventions for
					// "as fast as possible" are resolved the same way every
					// browser resolves them when it plays the file.
					delayMs: normaliseDelay(decoded.image.duration),
				});
			} finally {
				// A VideoFrame holds a decoded surface open. Three hundred of
				// them left to the collector is three hundred surfaces, and the
				// tab runs out well before the animation does.
				decoded.image.close();
			}
		}

		const first = frames[0];
		if (!first) {
			throw new DecodeFailedError(format, 'native-animated', 'it decoded to no frames at all');
		}

		return {
			image: first.image,
			animation:
				frames.length > 1
					? {
							frames,
							loopCount: loopCountFrom(track.repetitionCount),
						}
					: undefined,
			truncated: total > wanted,
		};
	} finally {
		decoder.close();
	}
}

/**
 * WebCodecs counts repeats. This package counts plays. They disagree at zero.
 *
 * `ImageTrack.repetitionCount` is the number of times the animation repeats
 * *after* the first pass, with `Infinity` for a file that loops forever, so a
 * GIF carrying no `NETSCAPE` extension reports 0 and means "play once".
 * `Animation.loopCount` here is the value the container stores, where 0 means
 * forever, which is what every format on disk means by it.
 *
 * Mapping 0 straight through therefore said "forever" about the one file that
 * most explicitly did not ask for it, and a play-once GIF looped without end in
 * every browser with an `ImageDecoder`. Anything above zero passes through
 * unchanged, which is what keeps a round trip stable: `ImageDecoder` derives
 * that number from the same `NETSCAPE` field the pure reader hands back, and
 * this package deliberately does not try to reinterpret it.
 */
export function loopCountFrom(repetitionCount: number): number {
	if (!Number.isFinite(repetitionCount)) return 0;
	return repetitionCount <= 0 ? 1 : repetitionCount;
}

function normaliseDelay(duration: number | null): number {
	if (duration === null || !Number.isFinite(duration) || duration <= 0) return 100;
	const ms = duration / 1000;
	// GIF stores hundredths and treats 0 and 1 as "as fast as possible", which
	// a browser renders as a tenth of a second. The decoder passes the stored
	// value straight through, so the convention has to be applied here or an
	// animation converted out of a GIF plays several times too fast.
	return ms <= 10 ? 100 : ms;
}

function frameToRaster(frame: { close(): void }, width: number, height: number): RasterImage {
	const canvas = requireCanvas(width, height);
	const context = context2d(canvas, 'srgb');
	context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
	const pixels = context.getImageData(0, 0, width, height);
	let hasAlpha = false;
	for (let i = 3; i < pixels.data.length; i += 4) {
		if (pixels.data[i] !== 255) {
			hasAlpha = true;
			break;
		}
	}
	return { data: pixels.data, width, height, colourSpace: 'srgb', hasAlpha };
}
