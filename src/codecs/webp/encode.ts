/**
 * Animated WebP, written.
 *
 * The other encoder that is half ours and half the browser's. Every frame is
 * encoded by the canvas, exactly as a still WebP would be, and the container
 * around them is written here in `mux.ts`. That division is not a preference:
 * no browser will write an animated WebP from a canvas, and this package
 * carries no encoder of its own, so the only animated WebP obtainable in a tab
 * is one assembled out of stills.
 *
 * Which is the honest cost of it. A purpose-built encoder predicts each frame
 * from the one before it and stores the difference; every frame here is a
 * keyframe, so the file is larger than one `cwebp` would write, and on a
 * mostly static animation it is a great deal larger. It is still a fraction of
 * the GIF it usually came from, because even a keyframe-only WebP is a modern
 * lossy codec against 256 colours and LZW. Both halves of that are worth
 * knowing before somebody compares this output with a reference encoder's and
 * concludes something is broken.
 *
 * Without this, the mismatch the `Encoder.animates` comment in `src/types.ts`
 * warns about was live: `FORMATS` declares WebP animated, the canvas encoder
 * cannot animate, and a GIF converted to WebP came out as its first frame with
 * `droppedFrames` set on a report nobody reads.
 *
 * One frame in, and the browser's still WebP comes back out unchanged. Wrapping
 * a single picture in `VP8X`, `ANIM` and `ANMF` would add three chunks and an
 * extended container to a file that has nothing to animate.
 */

import { CancelledError, EncodeFailedError } from '../../errors.js';
import type {
	AnimationFrame,
	EncodeContext,
	EncodeOptions,
	Encoder,
	RasterImage,
} from '../../types.js';
import { encodeNative } from '../native/encode.js';
import { muxAnimatedWebp, readWebpChunks } from './mux.js';
import type { WebpCodedFrame } from './mux.js';

const ENCODER_ID = 'webp-animated';

function fail(detail: string): never {
	throw new EncodeFailedError('webp', ENCODER_ID, detail);
}

/**
 * Encode one frame as an ordinary still WebP.
 *
 * Injected rather than imported, for the same reason the AVIF encoder injects
 * its keyframe encoder: Node has no canvas, and the container writing is the
 * part that decides whether the file is correct. A test supplies frame
 * payloads and drives the whole of this file without a browser anywhere.
 */
export type WebpFrameEncoder = (image: RasterImage, options: EncodeOptions) => Promise<Uint8Array>;

/**
 * The default: the browser's own WebP encoder, through a canvas.
 *
 * `encodeNative` rather than a canvas call written out here, because it
 * already carries the check that matters. Safari answers a request for WebP
 * with a PNG instead of refusing, and a PNG lifted into an `ANMF` would
 * produce an animation of nothing at all.
 */
export const nativeWebpFrameEncoder: WebpFrameEncoder = (image, options) =>
	encodeNative(image, 'webp', 'image/webp', options);

/** The picture chunks of a still WebP, ready to be placed in an `ANMF`. */
function liftFrame(webp: Uint8Array, durationMs: number): WebpCodedFrame {
	const chunks = readWebpChunks(webp);
	const bitstream = chunks.find((part) => part.fourCC === 'VP8 ' || part.fourCC === 'VP8L');
	if (!bitstream) {
		fail('the browser returned a file with no WebP picture inside it.');
	}
	// An `ALPH` chunk beside a lossless bitstream is malformed, and pointlessly
	// so: `VP8L` carries its own coverage. No browser writes the pair, and
	// dropping it here costs nothing if one ever starts.
	const alpha =
		bitstream.fourCC === 'VP8 '
			? chunks.find((part) => part.fourCC === 'ALPH')?.payload
			: undefined;
	return { bitstream, alpha, durationMs };
}

/**
 * Write a WebP, animated where there is an animation to write.
 *
 * `encodeFrame` defaults to the browser and is a parameter so a test can hand
 * over frame payloads instead.
 */
export async function encodeAnimatedWebp(
	image: RasterImage,
	options: EncodeOptions,
	context: EncodeContext,
	encodeFrame: WebpFrameEncoder = nativeWebpFrameEncoder,
): Promise<Uint8Array> {
	// Only the two settings a still encode can act on. Handing the whole of
	// `options` down would give the frame encoder the animation it is a part
	// of, which reads as a recursion waiting to happen.
	const still: EncodeOptions = { quality: options.quality, background: options.background };
	const animation = options.animation;
	const frames = animation?.frames ?? [];

	if (context.signal?.aborted) throw new CancelledError();
	if (!animation || frames.length < 2) {
		// A one frame animation is a still that happens to be in a container
		// which could hold more, and `image` is what a caller with no animation
		// at all has given us.
		return encodeFrame(frames[0]?.image ?? image, still);
	}

	const { width, height } = (frames[0] as AnimationFrame).image;
	for (const frame of frames) {
		if (frame.image.width !== width || frame.image.height !== height) {
			fail(
				'the frames are not all the same size, and every frame of this animation has to cover the whole canvas.',
			);
		}
	}

	const coded: WebpCodedFrame[] = [];
	for (const frame of frames) {
		// Asked per frame rather than once at the top. Five hundred frames is
		// five hundred canvas encodes, and the reason the signal reaches this
		// far is that somebody who pressed stop should not wait out the rest of
		// them.
		if (context.signal?.aborted) throw new CancelledError();
		coded.push(liftFrame(await encodeFrame(frame.image, still), frame.delayMs));
	}

	return muxAnimatedWebp({
		width,
		height,
		frames: coded,
		loopCount: animation.loopCount,
		background: options.background,
	});
}

/**
 * The encoder as the registry sees it.
 *
 * An object rather than a plain function through `pureEncoder`, because
 * `available` has a question to ask: a pure encoder's takes no arguments,
 * having no platform to ask about, and this one has to know whether the canvas
 * in front of it really writes WebP. `path` is `canvas` for the same reason it
 * is `webcodecs` on the AVIF encoder. The container is ours from end to end,
 * and the pictures inside it are the browser's, so two builds of Chrome will
 * write different bytes for the same animation and calling this `pure` would
 * promise otherwise.
 */
export const animatedWebpEncoder: Encoder = {
	id: ENCODER_ID,
	format: 'webp',
	path: 'canvas',
	// Ahead of `webp-native`, which sits at 10 and cannot animate. That one
	// stays registered behind this rather than being replaced: if the frames
	// handed over here are refused, the still encoder writes the first of them
	// and `convert` reports the animation as dropped, which beats failing the
	// conversion outright.
	priority: 5,
	animates: true,
	async available(capabilities) {
		return capabilities.canvasEncode.has('image/webp');
	},
	async encode(image, options, context) {
		return encodeAnimatedWebp(image, options, context);
	},
};
