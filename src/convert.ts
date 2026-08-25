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
import type {
	Capabilities,
	ConvertOptions,
	ConvertResult,
	DecodeOutput,
	DecodePath,
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

	const context = { capabilities: caps, signal: options.signal, maxPixels };
	const decodeStarted = now();
	let output: DecodeOutput | undefined;
	let decoderId = '';
	let decodePath: DecodePath = 'pure';
	const tried: DecodePath[] = [];
	let lastError: unknown;

	for (const decoder of decoders) {
		tried.push(decoder.path);
		try {
			output = await decoder.decode(input, context);
			decoderId = decoder.id;
			decodePath = decoder.path;
			break;
		} catch (error) {
			// An image that is simply too big will be too big for the next rung
			// as well, so that one stops the ladder rather than walking it.
			if (error instanceof ImageTooLargeError) throw error;
			lastError = error;
		}
	}

	if (!output) {
		if (lastError) throw lastError;
		throw new UnsupportedHereError(from, tried, unsupportedMessage(from, caps));
	}
	const decodeMs = now() - decodeStarted;

	/* ── Correct ────────────────────────────────────────────────────── */

	// Resolved before the corrections rather than after, because whether any
	// encoder for this format can animate decides how much correcting there is
	// to do. Preparing three hundred frames for an encoder that will write one
	// is a lot of work to throw away.
	const encoders = await encodersFor(to, caps);
	if (encoders.length === 0) {
		throw new EncodeUnsupportedError(to, encodeUnsupportedMessage(to, caps));
	}

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
		to === 'tiff';
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

	const image = correct(output.image);

	// An animation survives only when the source had one, the caller wants it,
	// and something registered for this format can actually write it.
	const sourceAnimation = output.animation;
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
	const sourceProfile = image.colourSpace === 'display-p3' ? output.iccProfile : undefined;
	const encodeOptions = {
		quality: options.quality,
		background: options.background,
		palette: options.palette,
		animation,
		iccProfile: sourceProfile ?? (keepMetadata ? options.iccProfile : undefined),
		writeColourTag: image.colourSpace === 'display-p3',
	};

	let bytes: Uint8Array | undefined;
	let encoderId = '';
	let encodePath = encoders[0]?.path ?? 'pure';
	let wroteFrames = false;
	let encodeError: unknown;
	for (const encoder of encoders) {
		try {
			bytes = await encoder.encode(image, encodeOptions, {
				capabilities: caps,
				signal: options.signal,
			});
			encoderId = encoder.id;
			encodePath = encoder.path;
			wroteFrames = encoder.animates === true && animation !== undefined;
			break;
		} catch (error) {
			encodeError = error;
		}
	}
	if (!bytes) {
		if (encodeError) throw encodeError;
		throw new EncodeUnsupportedError(to);
	}
	const encodeMs = now() - encodeStarted;

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
			width: image.width,
			height: image.height,
			colourSpace: image.colourSpace,
			orientation: output.orientation,
			tiles: output.tiles,
			frames: wroteFrames ? animation?.frames.length : undefined,
			// Said out loud rather than left to be noticed. Somebody who
			// converted an animation and got one frame is owed the reason,
			// which is either that they asked for it or that nothing here can
			// write a moving picture in the format they chose.
			droppedFrames:
				sourceAnimation && sourceAnimation.frames.length > 1 && !wroteFrames ? true : undefined,
			metadata: output.exif ? readExif(output.exif) : undefined,
			gainMap: output.droppedGainMap ? 'dropped' : undefined,
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
