/**
 * One AV1 keyframe, encoded by the browser.
 *
 * The mirror image of the HEIC decoder's use of `VideoDecoder`, and the reason
 * this package can write AVIF without carrying an encoder: every Chromium
 * build ships an AV1 encoder for video calls, and a photograph is one frame of
 * a very short one. Nothing else in the AVIF path needs a browser at all, so
 * the whole of it is behind this one function and it is injected rather than
 * imported, which is what lets the container writing be tested under Node
 * against real captured keyframes.
 *
 * Eight bit only, and not by choice. Every Chromium measured refuses a ten bit
 * AV1 configuration under `no-preference`, `prefer-software` and
 * `prefer-hardware` alike, so there is no ten bit path to write and one would
 * be untestable and unreachable if it were here.
 *
 * The quantiser is asked for first and a bitrate is the fallback. A still
 * photograph has no rate to speak of: "eight hundred kilobits a second" is a
 * statement about a video, and turning a quality setting into one for a single
 * frame means guessing at a size before the encoder has seen the picture. A
 * quantiser is the thing the encoder actually acts on, so where the browser
 * accepts one it is used and the size falls out of the picture instead of
 * being imposed on it.
 */

import { CodecUnavailableError, EncodeFailedError, EncodeUnsupportedError } from '../../errors.js';

const ENCODER_ID = 'avif-webcodecs';

/** What one keyframe encode is asked for. Mirrors `VideoEncoderConfig` without naming it. */
export interface Av1FrameRequest {
	/** An `av01.` codec string, with the level chosen for these dimensions. */
	readonly codec: string;
	readonly width: number;
	readonly height: number;
	/** Straight, non-premultiplied RGBA. `width * height * 4` bytes. */
	readonly rgba: Uint8ClampedArray;
	/** 0 to 63, 0 being the finest. Used where the browser takes a quantiser. */
	readonly quantizer: number;
	/** Bits for the one frame, for a browser that only takes a rate. */
	readonly bitrate: number;
}

/**
 * Encode one keyframe and return its OBU chain.
 *
 * Injected rather than imported by `encodeAvif`, so the container writing can
 * be driven from a test with captured bytes. That seam is the whole of what
 * makes the offsets, the references and the property indices testable, none of
 * which need a codec to be wrong.
 */
export type Av1FrameEncoder = (request: Av1FrameRequest) => Promise<Uint8Array>;

/** Per-frame options, plus the AV1 quantiser the DOM types do not yet declare. */
interface Av1EncodeOptions extends VideoEncoderEncodeOptions {
	readonly av1?: { readonly quantizer: number };
}

async function accepts(
	encoderClass: typeof VideoEncoder,
	config: VideoEncoderConfig,
): Promise<boolean> {
	try {
		const support = await encoderClass.isConfigSupported(config);
		return support.supported === true;
	} catch {
		// A browser that cannot answer the question cannot encode, and older
		// builds threw here rather than resolving false.
		return false;
	}
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

export function webCodecsAv1Encoder(): Av1FrameEncoder {
	return async (request) => {
		const encoderClass = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
		const frameClass = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
		if (!encoderClass || !frameClass) {
			throw new EncodeUnsupportedError(
				'avif',
				'This browser has no built-in video encoder, which is what writes the AV1 inside an AVIF.',
			);
		}

		const base: VideoEncoderConfig = {
			codec: request.codec,
			width: request.width,
			height: request.height,
			// One frame a second, so the rate below is the budget for this one
			// picture rather than for a second of moving ones.
			framerate: 1,
			latencyMode: 'quality',
		};
		const quantised: VideoEncoderConfig = { ...base, bitrateMode: 'quantizer' };
		const rated: VideoEncoderConfig = {
			...base,
			bitrate: request.bitrate,
			bitrateMode: 'constant',
		};

		let config = rated;
		let perFrame: Av1EncodeOptions = { keyFrame: true };
		if (await accepts(encoderClass, quantised)) {
			config = quantised;
			perFrame = { keyFrame: true, av1: { quantizer: request.quantizer } };
		} else if (!(await accepts(encoderClass, rated))) {
			throw new EncodeUnsupportedError(
				'avif',
				'This browser has a video encoder, but it will not write AV1, which is the only picture format an AVIF can hold.',
			);
		}

		const parts: Uint8Array[] = [];
		let failure: Error | undefined;
		const encoder = new encoderClass({
			output: (chunk) => {
				const bytes = new Uint8Array(chunk.byteLength);
				chunk.copyTo(bytes as unknown as AllowSharedBufferSource);
				parts.push(bytes);
			},
			error: (error) => {
				failure ??= error;
			},
		});

		try {
			encoder.configure(config);
			const frame = new frameClass(request.rgba as unknown as AllowSharedBufferSource, {
				format: 'RGBA',
				codedWidth: request.width,
				codedHeight: request.height,
				timestamp: 0,
			});
			try {
				encoder.encode(frame, perFrame);
			} finally {
				// The frame holds a buffer the encoder does not own. Leaking one
				// per conversion exhausts the pool within a handful of pictures
				// and every encode after that fails for no visible reason.
				frame.close();
			}
			await encoder.flush();
		} catch (error) {
			if (error instanceof EncodeUnsupportedError) throw error;
			throw new CodecUnavailableError('VideoEncoder', (error as Error).message);
		} finally {
			if (encoder.state !== 'closed') encoder.close();
		}

		if (failure) {
			throw new EncodeFailedError('avif', ENCODER_ID, failure.message, { cause: failure });
		}
		if (parts.length === 0) {
			throw new EncodeFailedError('avif', ENCODER_ID, 'the encoder produced no data at all');
		}
		return concat(parts);
	};
}
