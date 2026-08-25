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
 *
 * The two rungs also disagree about HDR, and the disagreement is not an
 * oversight. A recent iPhone stores its gain map as a second, hidden picture
 * inside the container, so reading the container is how you reach it and the
 * WebCodecs rung returns it. `createImageBitmap` hands back one composited
 * picture with no argument that asks for anything else, so the native rung
 * cannot reach it at any price and reports that it dropped it. Preferring the
 * faster rung therefore costs the highlights of an HDR photograph, which is
 * something the caller gets told rather than something decided quietly here.
 */

import type {
	ColourSpace,
	Decoder,
	DecodeContext,
	DecodeOutput,
	FormatId,
	GainMap,
	RasterImage,
} from '../../types.js';
import { ImageTooLargeError, UnsupportedHereError } from '../../errors.js';
import { assembleHeifImage } from '../../heif/assemble.js';
import type { TileDecoder, TileDecoderConfig } from '../../heif/assemble.js';
import { planHeifImage } from '../../heif/image.js';
import type { HeifImagePlan } from '../../heif/image.js';
import { MAX_CANVAS_AREA, canvasCanHold } from '../../raster/canvas.js';
import { detectAlpha } from '../../raster/image.js';
import { decodeNative, nativeDecodeAvailable } from '../native/decode.js';
import { supportsHevcConfig, webCodecsTileDecoder } from './webcodecs.js';

/** The browser's own image decoder, in the shape this file calls it. */
export type NativeImageDecoder = (
	bytes: Uint8Array,
	format: FormatId,
	mime: string,
	preferColourSpace: ColourSpace,
) => Promise<RasterImage>;

/**
 * The platform calls each rung makes, gathered so that a test can stand in for
 * them.
 *
 * `VideoDecoder` and `createImageBitmap` both need a browser, and neither has
 * a shape worth faking well enough to test through. This is the same seam
 * `assembleHeifImage` already uses for tiles and it exists for the same
 * reason: what needs checking is the arithmetic and the decisions around the
 * codec, not the codec. Left unset, every one of these is the real thing, so
 * the decoders this package ships are the ones the tests describe with exactly
 * one substitution each.
 */
export interface HeicNativeSeams {
	readonly decodeImage?: NativeImageDecoder;
	readonly available?: () => boolean;
}

export interface HeicWebCodecsSeams {
	readonly decodeTiles?: () => TileDecoder;
	readonly supports?: (config: TileDecoderConfig) => Promise<boolean>;
}

/**
 * Whether this decode should spend a second pass on the gain map.
 *
 * Read off the context rather than declared on it, and defaulting to yes. A
 * gain map is a whole second decode and a caller writing a JPEG has no use for
 * one, so this belongs on `DecodeContext` as a field the converter sets from
 * what the chosen encoder can carry. Until it is there, the default has to be
 * to read it: a caller who has never heard of the field gets the whole
 * photograph, and paying for a decode nobody wanted is a smaller failure than
 * discarding highlights nobody can get back.
 */
function gainMapWanted(context: DecodeContext): boolean {
	return (context as DecodeContext & { readonly gainMap?: boolean }).gainMap !== false;
}

/**
 * Decode the gain map, or decide to go on without it.
 *
 * A failure here is swallowed deliberately. The base picture has already
 * decoded by this point, and the gain map is a separate HEVC stream that a
 * decoder is entitled to refuse on its own: it is often a different profile,
 * frequently monochrome, and on some hardware that combination is exactly the
 * one with no decode block behind it. Turning that into a thrown error would
 * refuse a photograph the browser has just demonstrated it can read. An abort
 * is the exception, because somebody asked for it and the caller is waiting to
 * be told it happened.
 */
async function decodeGainMap(
	plan: HeifImagePlan,
	makeTileDecoder: () => TileDecoder,
	context: DecodeContext,
): Promise<GainMap | undefined> {
	const map = plan.gainMap;
	// Checked before the decoder is built, not after. Constructing a
	// `VideoDecoder` and closing it again is not free, and a caller who has said
	// they do not want the gain map should not pay for one.
	if (!map || !gainMapWanted(context)) return undefined;
	try {
		const image = await assembleHeifImage(map, makeTileDecoder(), context.signal);
		return {
			image: { ...image, colourSpace: map.colourSpace, hasAlpha: false },
			metadata: map.metadata,
			standard: map.standard,
			iccProfile: map.iccProfile,
		};
	} catch (error) {
		if (context.signal?.aborted) throw error;
		return undefined;
	}
}

/**
 * Safari's own HEIC decoder.
 *
 * Declines large images rather than failing on them. Reading back from a
 * canvas is the only way to get pixels out of an `ImageBitmap`, and a 48
 * megapixel photograph cannot be a canvas on the phone that took it. Declining
 * lets the WebCodecs rung take it instead, which assembles into a plain buffer
 * and has no such ceiling.
 */
export function createHeicNativeDecoder(seams: HeicNativeSeams = {}): Decoder {
	const decodeImage = seams.decodeImage ?? decodeNative;
	const isAvailable = seams.available ?? nativeDecodeAvailable;
	return {
		id: 'heic-native',
		formats: ['heic'],
		path: 'native-image',
		priority: 10,
		async available(capabilities) {
			return capabilities.nativeDecode.has('image/heic') && isAvailable();
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
			const image = await decodeImage(bytes, 'heic', 'image/heic', plan.colourSpace);
			return {
				// Safari has already applied the rotation, so nothing is left to do
				// and saying otherwise would rotate it a second time.
				image,
				orientation: { rotation: 0, mirror: 'none', source: 'decoder' },
				exif: plan.exif,
				iccProfile: plan.iccProfile,
				tiles: plan.tiles.length,
				// Unconditional, unlike the rung below. There is no argument to
				// `createImageBitmap` that asks for an auxiliary item, so an HDR
				// photograph read this way has lost its gain map whatever the file
				// contained and whatever the caller wanted.
				droppedGainMap: plan.hasGainMap,
			};
		},
	};
}

export function createHeicWebCodecsDecoder(seams: HeicWebCodecsSeams = {}): Decoder {
	const makeTileDecoder = seams.decodeTiles ?? webCodecsTileDecoder;
	const supports = seams.supports ?? supportsHevcConfig;
	return {
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
				const supported = await supports({
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

			// The gain map goes through a decoder of its own. It is a separate
			// item with its own `hvcC`, and a `VideoDecoder` is configured once
			// with a description and a coded size it then expects every chunk to
			// match, so feeding it the other picture's tiles means reconfiguring
			// it in the middle of a stream. Two decoders is the cheaper answer
			// and the one that cannot go wrong halfway through.
			const image = await assembleHeifImage(plan, makeTileDecoder(), context.signal);
			const gainMap = await decodeGainMap(plan, makeTileDecoder, context);

			return {
				image: { ...image, colourSpace: plan.colourSpace, hasAlpha: detectAlpha(image) },
				orientation: plan.orientation,
				exif: plan.exif,
				iccProfile: plan.iccProfile,
				tiles: plan.tiles.length,
				gainMap,
				// Only where the file had one and this pass did not produce it. Set
				// beside a returned gain map it would be telling the converter the
				// HDR was lost while handing it the thing it asked about.
				droppedGainMap: plan.hasGainMap && !gainMap,
			};
		},
	};
}

export const heicNativeDecoder: Decoder = createHeicNativeDecoder();

export const heicWebCodecsDecoder: Decoder = createHeicWebCodecsDecoder();

export { supportsHevcConfig, webCodecsTileDecoder } from './webcodecs.js';
