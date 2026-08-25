/**
 * The conversion itself.
 *
 * Decode through the first rung of the ladder that works here, correct the
 * orientation, put the colour where the caller asked for it, then encode. The
 * only interesting decisions are which rung ran and whether the colour had to
 * be narrowed, and both come back on the report so the interface can say so.
 */

import { UnsupportedHereError, EncodeUnsupportedError, ImageTooLargeError } from './errors.js';
import { FORMATS } from './formats.js';
import { detectCapabilities } from './detect/capabilities.js';
import { installDefaultCodecs } from './defaults.js';
import { requireFormat } from './detect/sniff.js';
import { readExif } from './metadata/exif.js';
import { decodersFor, encodersFor } from './registry.js';
import { detectAlpha, flatten } from './raster/image.js';
import { toColourSpace } from './raster/colour.js';
import { toFloatColourSpace } from './raster/float.js';
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
				// walking it.
				if (error instanceof ImageTooLargeError) throw error;
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

	const correct = (source: RasterImage): RasterImage => {
		// Not rotated here. `DecodeOutput.image` is upright by contract, and
		// the orientation on it says what the decoder already did.
		let corrected: RasterImage = {
			...source,
			hasAlpha: source.hasAlpha || detectAlpha(source),
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
			floatImage = narrow ? toFloatColourSpace(light.image, 'srgb') : light.image;
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
	const sourceProfile = wide ? decoded?.iccProfile : undefined;

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
		writeColourTag: wide,
	};

	let bytes: Uint8Array | undefined;
	let encoderId = '';
	let encodePath = encoders[0]?.path ?? 'pure';
	let wroteFrames = false;
	let wroteGainMap = false;
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
			metadata: decoded.exif ? readExif(decoded.exif) : undefined,
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
