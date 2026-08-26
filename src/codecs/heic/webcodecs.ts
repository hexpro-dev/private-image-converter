/**
 * Decode HEIC tiles with the browser's own HEVC decoder.
 *
 * This is the whole reason the package needs no runtime dependency to read an
 * iPhone photograph. The container is parsed here in TypeScript, which is
 * ordinary byte reading, and the actual HEVC is handed to `VideoDecoder`,
 * which on every platform that has it is the hardware decoder the device
 * already uses for video.
 *
 * The catch is that Chromium's HEVC support is hardware only by design, so a
 * machine without a decode block reports no support and the caller has to fall
 * back. That is not a failure to handle quietly: it is the difference between
 * a conversion that takes a moment and one that takes a while, and the
 * interface says which happened.
 */

import { CancelledError, CodecUnavailableError, DecodeFailedError } from '../../errors.js';
import type { RasterImage } from '../../types.js';
import type { TileDecoder, TileDecoderConfig } from '../../heif/assemble.js';
import type { HeifTile } from '../../heif/image.js';

/**
 * Copy a decoded frame out as straight RGBA.
 *
 * `copyTo` with a format conversion is the direct route and avoids a canvas
 * entirely. Not every implementation that has `VideoDecoder` also converts on
 * copy, so a canvas of the tile's own size is kept as the fallback. Tiles are
 * 512 by 512 on every phone photograph, well inside even the iOS canvas
 * limits, so the fallback is safe where a full size canvas would not be.
 */
async function frameToRaster(
	frame: VideoFrame,
	width: number,
	height: number,
): Promise<RasterImage> {
	const data = new Uint8ClampedArray(width * height * 4);
	try {
		await frame.copyTo(data as unknown as AllowSharedBufferSource, { format: 'RGBA' });
		return { data, width, height, colourSpace: 'srgb', hasAlpha: false };
	} catch {
		// Fall through to the canvas path.
	}

	const canvas =
		typeof OffscreenCanvas === 'function'
			? new OffscreenCanvas(width, height)
			: (() => {
					const element = document.createElement('canvas');
					element.width = width;
					element.height = height;
					return element;
				})();
	const context = canvas.getContext('2d') as
		CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	if (!context) {
		throw new CodecUnavailableError('canvas', 'This browser could not open a drawing surface.');
	}
	context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
	const pixels = context.getImageData(0, 0, width, height);
	return { data: pixels.data, width, height, colourSpace: 'srgb', hasAlpha: false };
}

/** Whether `VideoDecoder` here will take this configuration. */
export async function supportsHevcConfig(config: TileDecoderConfig): Promise<boolean> {
	const VideoDecoderClass = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
	if (typeof VideoDecoderClass?.isConfigSupported !== 'function') return false;
	try {
		const support = await VideoDecoderClass.isConfigSupported({
			codec: config.codec,
			description: config.description as unknown as AllowSharedBufferSource,
			codedWidth: config.codedWidth,
			codedHeight: config.codedHeight,
		});
		return support.supported === true;
	} catch {
		// Older Chromium threw rather than resolving false. Treat a throw as a
		// no, because a decoder that cannot answer the question cannot decode.
		return false;
	}
}

/**
 * A tile decoder backed by WebCodecs.
 *
 * One decoder instance for the whole image. Building 48 of them for one
 * photograph costs more than the decode does, and the tiles all share a
 * configuration by construction: they are the same picture cut up.
 */
export function webCodecsTileDecoder(): TileDecoder {
	return async (config, tiles, signal) => {
		const VideoDecoderClass = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
		const ChunkClass = (globalThis as { EncodedVideoChunk?: typeof EncodedVideoChunk })
			.EncodedVideoChunk;
		if (!VideoDecoderClass || !ChunkClass) {
			throw new CodecUnavailableError(
				'VideoDecoder',
				'This browser has no built-in video decoder, which is what reads the HEVC inside a HEIC.',
			);
		}

		// Before the decoder exists, so a conversion cancelled while the
		// container was being read does not go on to claim a hardware decoder
		// and hand it back unused.
		if (signal?.aborted) throw new CancelledError();

		const out: RasterImage[] = new Array(tiles.length);
		const pending: Promise<void>[] = [];
		let received = 0;
		let failure: Error | undefined;

		const decoder = new VideoDecoderClass({
			output: (frame) => {
				// Frames come back in the order the chunks went in, so the
				// timestamp is not needed to reorder them. It is still set,
				// because a decoder is entitled to refuse chunks that share one.
				const index = received;
				received += 1;
				const tile = tiles[index] as HeifTile | undefined;
				if (!tile) {
					frame.close();
					return;
				}
				pending.push(
					frameToRaster(frame, tile.width, tile.height)
						.then((raster) => {
							out[index] = raster;
						})
						.catch((error: unknown) => {
							failure ??= error as Error;
						})
						.finally(() => {
							// Every frame holds a GPU buffer until it is closed.
							// At 48 tiles a photograph, leaking them exhausts the
							// pool within a handful of images and every decode
							// after that fails for no visible reason.
							frame.close();
						}),
				);
			},
			error: (error) => {
				failure ??= error;
			},
		});

		try {
			decoder.configure({
				codec: config.codec,
				description: config.description as unknown as AllowSharedBufferSource,
				codedWidth: config.codedWidth,
				codedHeight: config.codedHeight,
			});

			for (let index = 0; index < tiles.length; index += 1) {
				// The package's own error rather than an `AbortError`
				// `DOMException`. Both stop the ladder, but one says so by its
				// type and the other has to be recognised by the name on
				// somebody else's error class, which is a string comparison
				// standing in for a decision.
				if (signal?.aborted) throw new CancelledError();
				const tile = tiles[index] as HeifTile;
				// Every tile of a still image is a key frame: there is nothing
				// for it to reference.
				decoder.decode(
					new ChunkClass({
						type: 'key',
						timestamp: index,
						duration: 0,
						data: tile.data as unknown as AllowSharedBufferSource,
					}),
				);
			}

			await decoder.flush();
			await Promise.all(pending);
			// The flush is the long wait on a 48 tile photograph and nothing
			// inside it looks at the signal, so this is where a cancellation
			// that arrived during the decode is noticed. Inside the `try`, so
			// the decoder is still closed on the way out.
			if (signal?.aborted) throw new CancelledError();
		} finally {
			if (decoder.state !== 'closed') decoder.close();
		}

		if (failure) {
			throw new DecodeFailedError('heic', 'heic-webcodecs', failure.message, { cause: failure });
		}
		if (received !== tiles.length) {
			throw new DecodeFailedError(
				'heic',
				'heic-webcodecs',
				`the decoder returned ${received} of ${tiles.length} tiles`,
			);
		}
		return out;
	};
}
