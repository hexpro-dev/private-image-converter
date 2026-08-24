/**
 * The HEIC decode ladder.
 *
 * Three rungs, in the order of what they cost the person waiting:
 *
 *   heic-native      Safari decodes HEIC itself, grid and rotation included.
 *   heic-webcodecs   We read the container and the platform decodes the HEVC,
 *                    in hardware, which is every Chromium build on a machine
 *                    with a decode block.
 *   (host plugin)    Whatever the application registers, typically a software
 *                    decoder compiled to WebAssembly. Registered from outside
 *                    this package, because it is the only part that cannot be
 *                    written without a dependency.
 *
 * The first two are the reason this package has no dependencies. The third is
 * why it still works in Firefox. A caller can tell which one ran, and should
 * say so, because the difference is visible as time.
 */

import type { Decoder, DecodeContext, DecodeOutput } from '../../types.js';
import { ImageTooLargeError, UnsupportedHereError } from '../../errors.js';
import { assembleHeifImage } from '../../heif/assemble.js';
import { planHeifImage } from '../../heif/image.js';
import { MAX_CANVAS_AREA, canvasCanHold } from '../../raster/canvas.js';
import { detectAlpha } from '../../raster/image.js';
import { decodeNative, nativeDecodeAvailable } from '../native/decode.js';
import { supportsHevcConfig, webCodecsTileDecoder } from './webcodecs.js';

/**
 * Safari's own HEIC decoder.
 *
 * Declines large images rather than failing on them. Reading back from a
 * canvas is the only way to get pixels out of an `ImageBitmap`, and a 48
 * megapixel photograph cannot be a canvas on the phone that took it. Declining
 * lets the WebCodecs rung take it instead, which assembles into a plain buffer
 * and has no such ceiling.
 */
export const heicNativeDecoder: Decoder = {
	id: 'heic-native',
	formats: ['heic'],
	path: 'native-image',
	priority: 10,
	async available(capabilities) {
		return capabilities.nativeDecode.has('image/heic') && nativeDecodeAvailable();
	},
	async decode(bytes: Uint8Array, context: DecodeContext): Promise<DecodeOutput> {
		// The container is read first anyway, cheaply, because it is the only
		// way to know the size before committing to a canvas, and because the
		// EXIF and the gain map flag come from it either way.
		const plan = planHeifImage(bytes);
		const pixels = plan.displayWidth * plan.displayHeight;
		if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
		if (!canvasCanHold(plan.displayWidth, plan.displayHeight)) {
			throw new ImageTooLargeError(pixels, MAX_CANVAS_AREA);
		}
		const image = await decodeNative(bytes, 'heic', 'image/heic', plan.colourSpace);
		return {
			// Safari has already applied the rotation, so nothing is left to do
			// and saying otherwise would rotate it a second time.
			image,
			orientation: { rotation: 0, mirror: 'none', source: 'decoder' },
			exif: plan.exif,
			iccProfile: plan.iccProfile,
			tiles: plan.tiles.length,
			droppedGainMap: plan.hasGainMap,
		};
	},
};

export const heicWebCodecsDecoder: Decoder = {
	id: 'heic-webcodecs',
	formats: ['heic'],
	path: 'webcodecs',
	priority: 20,
	async available(capabilities) {
		return capabilities.hevcVideoDecoder;
	},
	async decode(bytes: Uint8Array, context: DecodeContext): Promise<DecodeOutput> {
		const plan = planHeifImage(bytes);
		const pixels = plan.displayWidth * plan.displayHeight;
		if (pixels > context.maxPixels) {
			throw new ImageTooLargeError(pixels, context.maxPixels);
		}

		// Asked again with this file's own configuration rather than relying on
		// the capability probe, because the probe asks about a representative
		// still-picture profile and a given file may use another.
		const first = plan.tiles[0];
		if (first) {
			const supported = await supportsHevcConfig({
				codec: plan.codecString,
				description: plan.config.raw,
				codedWidth: first.width,
				codedHeight: first.height,
			});
			if (!supported) {
				throw new UnsupportedHereError(
					'heic',
					['native-image', 'webcodecs'],
					'This browser has no hardware support for the video format inside this HEIC.',
				);
			}
		}

		const image = await assembleHeifImage(plan, webCodecsTileDecoder(), context.signal);
		return {
			image: { ...image, colourSpace: plan.colourSpace, hasAlpha: detectAlpha(image) },
			orientation: plan.orientation,
			exif: plan.exif,
			iccProfile: plan.iccProfile,
			tiles: plan.tiles.length,
			droppedGainMap: plan.hasGainMap,
		};
	},
};

export { supportsHevcConfig, webCodecsTileDecoder } from './webcodecs.js';
