/**
 * The conversion itself.
 *
 * Decode through the first rung of the ladder that works here, correct the
 * orientation, put the colour where the caller asked for it, then encode. The
 * only interesting decisions are which rung ran and whether the colour had to
 * be narrowed, and both come back on the report so the interface can say so.
 */

import {
	CancelledError,
	EncodeUnsupportedError,
	ImageTooLargeError,
	UnsupportedHereError,
} from './errors.js';
import { FORMATS } from './formats.js';
import { detectCapabilities } from './detect/capabilities.js';
import { installDefaultCodecs } from './defaults.js';
import { requireFormat } from './detect/sniff.js';
import { readExif, withUprightOrientation } from './metadata/exif.js';
import { decodersFor, encodersFor } from './registry.js';
import { detectAlpha, flatten } from './raster/image.js';
import { toColourSpace } from './raster/colour.js';
import { toFloatColourSpace } from './raster/float.js';
import { fitLongestSide, resizeFloat, resizeRaster } from './raster/resize.js';
import { toneMapImage } from './raster/tonemap.js';
import type {
	Capabilities,
	ConvertOptions,
	ConvertResult,
	DecodeOutput,
	DecodePath,
	FloatDecodeOutput,
	FloatImage,
	RasterImage,
} from './types.js';

/**
 * The default ceiling, in pixels.
 *
 * 80 megapixels is comfortably above the largest phone sensor and below the
 * point where a browser tab reliably falls over: the RGBA buffer alone is
 * 320 megabytes at that size, and a conversion needs room for more than one.
 */
export const DEFAULT_MAX_PIXELS = 80_000_000;

function now(): number {
	return typeof performance === 'object' ? performance.now() : Date.now();
}

/**
 * Whether this failure means the caller asked us to stop.
 *
 * Two shapes reach here. The rungs that check the signal themselves throw
 * `CancelledError`, and the platform APIs underneath them (`VideoDecoder`,
 * `VideoEncoder`) reject with a bare `AbortError` `DOMException` that never
 * passed through this package at all. Both mean the same thing and both have to
 * stop the ladder, because walking on after a cancellation is how pressing stop
 * used to start the slowest rung of all.
 */
function isCancellation(error: unknown): boolean {
	if (error instanceof CancelledError) return true;
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}

export async function convert(
	input: Uint8Array,
	options: ConvertOptions,
	capabilities?: Capabilities,
): Promise<ConvertResult> {
	installDefaultCodecs();
	const caps = capabilities ?? (await detectCapabilities());
	const from = requireFormat(input);
	const to = options.to;
	const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;

	/* ── Decode ─────────────────────────────────────────────────────── */

	const decoders = await decodersFor(from, caps);
	if (decoders.length === 0) {
		throw new UnsupportedHereError(from, [], unsupportedMessage(from, caps));
	}

	// Resolved before the decode rather than after it, because two things about
	// the destination change what the decode should do. Whether any encoder for
	// this format can animate decides how many frames are worth correcting, and
	// whether any of them takes light decides whether the decode should produce
	// light at all. Asked afterwards, the second question is already too late.
	//
	// Decoders are still resolved first, so a file that cannot be read here
	// says so rather than complaining about where it was going.
	const encoders = await encodersFor(to, caps);
	if (encoders.length === 0) {
		throw new EncodeUnsupportedError(to, encodeUnsupportedMessage(to, caps));
	}

	const context = { capabilities: caps, signal: options.signal, maxPixels };
	const decodeStarted = now();
	let output: DecodeOutput | undefined;
	let light: FloatDecodeOutput | undefined;
	let decoderId = '';
	let decodePath: DecodePath = 'pure';
	const tried: DecodePath[] = [];
	let lastError: unknown;

	// The light ladder runs first wherever there is one. A decoder that hands
	// back bytes has already chosen an exposure, and that choice is what the
	// tone option exists to take away from it, so reading light and reducing it
	// later is right even when the destination is an ordinary eight bit format.
	for (const decoder of decoders) {
		if (!decoder.decodeFloat) continue;
		tried.push(decoder.path);
		try {
			light = await decoder.decodeFloat(input, context);
			decoderId = decoder.id;
			decodePath = decoder.path;
			break;
		} catch (error) {
			if (error instanceof ImageTooLargeError) throw error;
			if (isCancellation(error)) throw new CancelledError();
			lastError = error;
		}
	}

	if (!light) {
		for (const decoder of decoders) {
			tried.push(decoder.path);
			try {
				output = await decoder.decode(input, context);
				decoderId = decoder.id;
				decodePath = decoder.path;
				break;
			} catch (error) {
				// An image that is simply too big will be too big for the next
				// rung as well, so that one stops the ladder rather than
				// walking it. A cancellation stops it for the opposite reason:
				// there is nobody left waiting for the answer, and the rung
				// below this one is the slow software decoder, so continuing
				// made pressing stop take longer than not pressing it.
				if (error instanceof ImageTooLargeError) throw error;
				if (isCancellation(error)) throw new CancelledError();
				lastError = error;
			}
		}
	}

	if (!output && !light) {
		if (lastError) throw lastError;
		throw new UnsupportedHereError(from, tried, unsupportedMessage(from, caps));
	}
	const decodeMs = now() - decodeStarted;

	/* ── Correct ────────────────────────────────────────────────────── */

	const target = FORMATS[to];
	// Narrowing the gamut is deliberate and one way: doing it twice, or doing
	// it to something already in sRGB, is the failure this whole path exists to
	// avoid, so it happens exactly here and nowhere else.
	const wantWide = (options.colour ?? 'preserve') === 'preserve';
	const canCarryWide =
		to === 'png' ||
		to === 'apng' ||
		to === 'jpeg' ||
		to === 'webp' ||
		to === 'avif' ||
		to === 'tiff' ||
		// Both light formats carry their own primaries, Radiance in a header
		// line and OpenEXR in a chromaticities attribute, so narrowing on the
		// way into either would be throwing away gamut for no reason.
		to === 'hdr' ||
		to === 'exr';
	const narrow = !wantWide || !canCarryWide;

	/**
	 * The size everything is going to, decided once from the source.
	 *
	 * Taken from the decoded picture rather than per frame, so that every frame
	 * of an animation lands on the same grid. A frame is the same size as its
	 * animation by construction, so this is the same answer either way, and
	 * asking once means a five hundred frame GIF does not recompute it five
	 * hundred times.
	 */
	const sourceGeometry = output?.image ?? light?.image;
	const resized =
		options.resize && sourceGeometry
			? fitLongestSide(sourceGeometry.width, sourceGeometry.height, options.resize.longestSide)
			: undefined;
	const shrinks =
		resized !== undefined &&
		sourceGeometry !== undefined &&
		(resized.width !== sourceGeometry.width || resized.height !== sourceGeometry.height);

	const correct = (source: RasterImage): RasterImage => {
		// Not rotated here. `DecodeOutput.image` is upright by contract, and
		// the orientation on it says what the decoder already did.
		//
		// Resized first, and deliberately. Everything below this line costs a
		// pass over every pixel, so doing them on the smaller picture is the
		// difference between one expensive traversal and three. Narrowing the
		// gamut after resampling is also the correct order: the filter averages
		// in whatever primaries the source had, which is where its numbers mean
		// what the camera meant.
		let corrected: RasterImage = shrinks
			? resizeRaster(source, resized.width, resized.height)
			: source;
		corrected = {
			...corrected,
			hasAlpha: corrected.hasAlpha || detectAlpha(corrected),
		};
		if (!target.alpha && corrected.hasAlpha) {
			corrected = flatten(corrected, options.background);
		}
		if (narrow) corrected = toColourSpace(corrected, 'srgb');
		return corrected;
	};

	/* ── Light ──────────────────────────────────────────────────────── */

	const floatEncoders = encoders.filter(
		(encoder) => encoder.floats === true && typeof encoder.encodeFloat === 'function',
	);
	let toneMapped = false;
	let exposureStops: number | undefined;

	/**
	 * Reduce the decoded light to a picture, once, recording what it took.
	 *
	 * A closure rather than a value because it may not be needed at all: an
	 * OpenEXR going to a Radiance file never reduces, and metering a
	 * hundred megapixel render to throw the answer away is not free.
	 */
	const reduce = (source: FloatDecodeOutput): RasterImage => {
		const placed = narrow ? toFloatColourSpace(source.image, 'srgb') : source.image;
		const mapped = toneMapImage(placed, options.tone);
		toneMapped = true;
		exposureStops = mapped.stops;
		return correct(mapped.image);
	};

	let image = output ? correct(output.image) : undefined;
	let floatImage: FloatImage | undefined;
	if (light) {
		if (floatEncoders.length > 0) {
			// This branch never reaches `correct`, so the resize has to happen
			// here too. It is the same filter over the same footprints; what it
			// must not do is round or clamp, which is why there are two
			// functions rather than a cast.
			const placed = shrinks
				? resizeFloat(light.image, resized.width, resized.height)
				: light.image;
			floatImage = narrow ? toFloatColourSpace(placed, 'srgb') : placed;
		} else {
			image = reduce(light);
		}
	}

	// An animation survives only when the source had one, the caller wants it,
	// and something registered for this format can actually write it.
	const sourceAnimation = output?.animation;
	const keepFrames = (options.frames ?? 'all') === 'all';
	const canAnimate = encoders.some((encoder) => encoder.animates === true);
	const animation =
		sourceAnimation && sourceAnimation.frames.length > 1 && keepFrames && canAnimate
			? {
					loopCount: sourceAnimation.loopCount,
					frames: sourceAnimation.frames.map((frame) => ({
						delayMs: frame.delayMs,
						image: correct(frame.image),
					})),
				}
			: undefined;

	/* ── Encode ─────────────────────────────────────────────────────── */

	const encodeStarted = now();
	const keepMetadata = (options.metadata ?? 'strip') === 'preserve';
	// The source's own profile wins over anything the caller supplied: it is
	// what the camera meant, and re-embedding it is what makes the conversion
	// lossless in colour rather than merely lossless in pixels. It is carried
	// whenever the image is still wide gamut, regardless of the metadata
	// setting, because a colour profile is not personal information and
	// dropping it would silently change how the picture looks.
	// One of the two ladders produced something, which the guard above the
	// decode timer already proved; the assertion is only saying so to the
	// compiler, which does not track the relationship between two variables.
	const decoded = (output ?? light) as DecodeOutput | FloatDecodeOutput;
	const geometry = image ?? floatImage;
	const wide = (geometry?.colourSpace ?? 'srgb') === 'display-p3';

	// Carried on provenance rather than on a gamut test. A profile describes
	// the numbers the decoder produced, so it stays valid for as long as
	// nothing has moved those numbers into a different space. Resizing and
	// flattening do not; narrowing the gamut does, and that is the one case
	// where re-embedding the source profile would be describing the file
	// wrongly rather than describing it well.
	//
	// The old rule was "carry it when the raster is still wide", which silently
	// dropped a profile from every ordinary sRGB source that had one. A TIFF
	// read here carries a profile that its own decoder went and found, and it
	// went straight into the bin.
	const sourceSpace = decoded.image.colourSpace;
	const colourMoved = geometry !== undefined && geometry.colourSpace !== sourceSpace;
	const sourceProfile = colourMoved ? undefined : decoded.iccProfile;

	// EXIF is only written when it was asked for. The orientation tag has to be
	// neutralised first: the pixels reaching the encoder are upright by the
	// decoder contract, so the tag that came off the file describes a rotation
	// that has already happened, and copying it across turns every portrait
	// photograph sideways in anything that honours it.
	const sourceExif =
		keepMetadata && decoded.exif ? withUprightOrientation(decoded.exif) : undefined;

	// A gain map is a set of coefficients, not a picture, so it is carried
	// exactly as it arrived: correcting it would be editing the parameters of
	// the photograph rather than converting it. The one thing that does
	// invalidate it is the base image moving colour space underneath it, since
	// the parameters were written against the primaries the source had, so
	// that is the case where it is let go of rather than written wrongly.
	const sourceGainMap = output?.gainMap;
	const baseColourMoved =
		image !== undefined && output !== undefined && image.colourSpace !== output.image.colourSpace;
	const gainMapToWrite = sourceGainMap && !baseColourMoved ? sourceGainMap : undefined;

	const encodeOptions = {
		quality: options.quality,
		background: options.background,
		palette: options.palette,
		animation,
		gainMap: gainMapToWrite,
		iccProfile: sourceProfile ?? (keepMetadata ? options.iccProfile : undefined),
		exif: sourceExif ?? (keepMetadata ? options.exif : undefined),
		writeColourTag: wide,
	};

	let bytes: Uint8Array | undefined;
	let encoderId = '';
	let encodePath = encoders[0]?.path ?? 'pure';
	let wroteFrames = false;
	let wroteGainMap = false;
	let wroteExif = false;
	let wroteLight = false;
	let encodeError: unknown;

	if (floatImage) {
		for (const encoder of floatEncoders) {
			try {
				bytes = await encoder.encodeFloat!(floatImage, encodeOptions, {
					capabilities: caps,
					signal: options.signal,
				});
				encoderId = encoder.id;
				encodePath = encoder.path;
				wroteLight = true;
				break;
			} catch (error) {
				encodeError = error;
			}
		}
		// Nothing that takes light could write it, so the light is reduced and
		// the ordinary ladder gets its turn. A worse result than the one that
		// was asked for, and still a file, which beats refusing over a rung
		// that was only ever the preferred one.
		if (!bytes && light) {
			image = reduce(light);
			floatImage = undefined;
		}
	}

	if (!bytes && image) {
		for (const encoder of encoders) {
			try {
				bytes = await encoder.encode(image, encodeOptions, {
					capabilities: caps,
					signal: options.signal,
				});
				encoderId = encoder.id;
				encodePath = encoder.path;
				wroteFrames = encoder.animates === true && animation !== undefined;
				wroteGainMap = encoder.gainMaps === true && gainMapToWrite !== undefined;
				wroteExif = encoder.exif === true && encodeOptions.exif !== undefined;
				break;
			} catch (error) {
				encodeError = error;
			}
		}
	}
	if (!bytes) {
		if (encodeError) throw encodeError;
		throw new EncodeUnsupportedError(to);
	}
	const encodeMs = now() - encodeStarted;

	// Whichever of the two actually reached the encoder. They agree on
	// dimensions and colour space, which is all the report wants from it.
	const written = (image ?? floatImage) as RasterImage | FloatImage;

	return {
		bytes,
		mime: target.mime,
		extension: target.extension,
		report: {
			from,
			to,
			decodePath,
			decoderId,
			encodePath,
			encoderId,
			width: written.width,
			height: written.height,
			// Only when it actually moved. An interface that wants to say "5712
			// by 4284, saved at 1920 by 1440" needs both numbers, and a field
			// that was always present would make every caller compare them to
			// find out whether there was anything to say.
			resizedFrom:
				shrinks && sourceGeometry
					? { width: sourceGeometry.width, height: sourceGeometry.height }
					: undefined,
			colourSpace: written.colourSpace,
			orientation: decoded.orientation,
			tiles: output?.tiles,
			frames: wroteFrames ? animation?.frames.length : undefined,
			// Said out loud rather than left to be noticed. Somebody who
			// converted an animation and got one frame is owed the reason,
			// which is either that they asked for it or that nothing here can
			// write a moving picture in the format they chose.
			droppedFrames:
				sourceAnimation && sourceAnimation.frames.length > 1 && !wroteFrames ? true : undefined,
			truncatedFrames: output?.truncatedFrames || undefined,
			droppedAlpha: output?.droppedAlpha || undefined,
			metadata: decoded.exif ? readExif(decoded.exif) : undefined,
			// Reported from what the encoder declared rather than from what was
			// asked for. Saying "kept" about a format that cannot hold EXIF
			// would be worse than dropping it quietly, because somebody would
			// stop checking.
			metadataKept: decoded.exif ? (wroteExif ? 'kept' : 'stripped') : undefined,
			// Three outcomes, and the difference between the last two is the
			// difference between a photograph that will still look right and
			// one that has quietly lost half of what it was.
			gainMap: wroteGainMap
				? 'kept'
				: sourceGainMap || output?.droppedGainMap
					? 'dropped'
					: undefined,
			toneMapped: toneMapped || undefined,
			exposureStops: toneMapped ? exposureStops : undefined,
			highDynamicRange: wroteLight || wroteGainMap || undefined,
			sourceBytes: input.length,
			outputBytes: bytes.length,
			decodeMs,
			encodeMs,
		},
	};
}

/**
 * Why a format cannot be read here, in a sentence somebody can act on.
 *
 * Generic for most formats and specific for HEIC, because HEIC is the one
 * where the answer is interesting: the file is fine, the browser is fine, and
 * the missing piece is a hardware decoder that this machine does not have.
 */
function unsupportedMessage(format: string, capabilities: Capabilities): string | undefined {
	if (format !== 'heic') return undefined;
	if (capabilities.hevcVideoDecoder) return undefined;
	return 'This browser cannot read HEIC files. Safari reads them directly, and Chrome and Edge read them on a machine with hardware video decoding. Firefox has neither, so it needs a software decoder loaded alongside this tool.';
}

function encodeUnsupportedMessage(format: string, capabilities: Capabilities): string | undefined {
	if (format === 'webp' && !capabilities.canvasEncode.has('image/webp')) {
		return 'This browser cannot write WebP files. Safari has never supported it, so choose PNG or JPEG instead.';
	}
	if (format === 'avif' && !capabilities.canvasEncode.has('image/avif')) {
		return 'No browser can write AVIF files yet. Choose WebP, PNG or JPEG instead.';
	}
	if (format === 'heic') {
		return 'Nothing can write HEIC in a browser, and this tool will not pretend to. Choose PNG, JPEG or WebP instead.';
	}
	return undefined;
}
