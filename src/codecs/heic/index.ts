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
 *
 * Transparency divides the other way. A HEIC keeps its alpha in a separate
 * auxiliary picture, so the WebCodecs rung has to find it, decode it and put
 * it back on the photograph itself, while the native rung gets it for free
 * because the browser has already composited it into the bitmap it returns.
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
import {
	CancelledError,
	ImageTooLargeError,
	SurfaceTooLargeError,
	UnsupportedHereError,
} from '../../errors.js';
import { assembleHeifImage } from '../../heif/assemble.js';
import type { TileDecoder, TileDecoderConfig } from '../../heif/assemble.js';
import { planHeifImage } from '../../heif/image.js';
import type { HeifImagePlan } from '../../heif/image.js';
import { canvasHolds } from '../../raster/canvas.js';
import { attachAlpha, detectAlpha } from '../../raster/image.js';
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
 * What this file reports beyond the declared shape of a decode.
 *
 * `droppedAlpha` belongs on `DecodeOutput` next to `droppedGainMap` and is
 * written here so the fact exists the moment the decoder knows it, rather than
 * waiting for the type to catch up and being reconstructed later from
 * something that no longer knows. Delete this alias when the field lands.
 */
export type HeicDecodeOutput = DecodeOutput & { readonly droppedAlpha?: boolean };

/**
 * Give up here if somebody has asked us to.
 *
 * Called at each phase boundary rather than once at the top. A 48 megapixel
 * photograph is a container walk, a tile decode, a second decode for the alpha
 * plane and a third for the gain map, and a visitor who navigates away in the
 * middle of that should not have to wait for the rest of it. This throws the
 * package's own error rather than the `AbortError` a `DOMException` would
 * give, so the ladder above recognises a cancellation by its type instead of
 * inferring it from a name on somebody else's error class.
 */
function stopIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new CancelledError();
}

/**
 * Decode the alpha plane, or decide to go on without it.
 *
 * Swallowed for the same reason the gain map is: this is a second HEVC stream,
 * usually monochrome, and monochrome is exactly the profile some hardware has
 * no decode block for. The photograph has already come back by this point.
 * Refusing it because the transparency would not decode would refuse a picture
 * the browser has just demonstrated it can read, and an opaque version of a
 * sticker is a worse answer than no sticker only if nobody is told, which is
 * what `droppedAlpha` is for.
 */
async function decodeAlphaPlane(
	plan: HeifImagePlan,
	makeTileDecoder: () => TileDecoder,
	context: DecodeContext,
): Promise<RasterImage | undefined> {
	const alpha = plan.alphaAuxiliary;
	if (!alpha) return undefined;
	try {
		return await assembleHeifImage(alpha, makeTileDecoder(), context.signal);
	} catch (error) {
		if (error instanceof CancelledError) throw error;
		// A decoder that stopped because it was cancelled reports whatever it
		// felt like reporting, so the signal is the authority on why this
		// failed and not the error that came out.
		stopIfCancelled(context.signal);
		return undefined;
	}
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
		if (error instanceof CancelledError) throw error;
		stopIfCancelled(context.signal);
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
			stopIfCancelled(context.signal);
			const pixels = plan.displayWidth * plan.displayHeight;
			if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
			// A decline, not a refusal. This rung hands the file to the
			// browser's own decoder, which lands on a canvas; the rung below
			// reads the container here and never needs one. Every recent
			// iPhone shoots past what a canvas gives on iOS, so sharing an
			// error class with the hard ceiling stopped the ladder on exactly
			// the photographs this package exists to read.
			if (!canvasHolds(plan.displayWidth, plan.displayHeight)) {
				throw new SurfaceTooLargeError(plan.displayWidth, plan.displayHeight);
			}
			const image = await decodeImage(bytes, 'heic', 'image/heic', plan.colourSpace);
			// The browser's decoder has no cancellation of its own, so the
			// signal cannot stop it partway. Checking on the way out is still
			// worth doing: it keeps a cancelled conversion from going on to
			// encode a picture nobody is waiting for.
			stopIfCancelled(context.signal);
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
				//
				// Transparency is the one auxiliary that needs nothing here.
				// Safari composites the alpha plane into the bitmap it hands
				// back, so `plan.hasAlphaAuxiliary` is already accounted for in
				// the pixels and claiming a drop would be a warning about
				// something that did not happen.
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
		async decode(bytes: Uint8Array, context: DecodeContext): Promise<HeicDecodeOutput> {
			const plan = planHeifImage(bytes);
			stopIfCancelled(context.signal);
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
				stopIfCancelled(context.signal);
				if (!supported) {
					throw new UnsupportedHereError(
						'heic',
						['native-image', 'webcodecs'],
						'This browser has no hardware support for the video format inside this HEIC.',
					);
				}
			}

			// The gain map goes through a decoder of its own, and so does the
			// alpha plane. Each is a separate item with its own `hvcC`, and a
			// `VideoDecoder` is configured once with a description and a coded
			// size it then expects every chunk to match, so feeding it another
			// picture's tiles means reconfiguring it in the middle of a stream.
			// A decoder each is the cheaper answer and the one that cannot go
			// wrong halfway through.
			const base = await assembleHeifImage(plan, makeTileDecoder(), context.signal);
			stopIfCancelled(context.signal);
			const alpha = await decodeAlphaPlane(plan, makeTileDecoder, context);
			// `attachAlpha` takes the red channel of the plane, and red is the
			// coverage. The auxiliary is monochrome: whether it arrives as
			// 4:0:0 with no chroma at all or as 4:2:0 with neutral chroma, the
			// conversion to RGBA leaves R, G and B equal, so any one of them is
			// the value and averaging the three would be a pass over the whole
			// plane to recompute a number already sitting in its first byte.
			const image = alpha ? attachAlpha(base, alpha) : base;
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
				// The same rule for transparency. A picture meant to have holes
				// in it that came back a solid rectangle is worth a sentence,
				// and it is not something anybody can work out downstream from
				// an image that is simply opaque.
				droppedAlpha: plan.hasAlphaAuxiliary && !alpha,
			};
		},
	};
}

export const heicNativeDecoder: Decoder = createHeicNativeDecoder();

export const heicWebCodecsDecoder: Decoder = createHeicWebCodecsDecoder();

export { supportsHevcConfig, webCodecsTileDecoder } from './webcodecs.js';
