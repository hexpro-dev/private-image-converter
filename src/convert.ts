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

	// Not rotated here. `DecodeOutput.image` is upright by contract, and the
	// orientation on it says what the decoder already did.
	let image: RasterImage = {
		...output.image,
		hasAlpha: output.image.hasAlpha || detectAlpha(output.image),
	};

	const target = FORMATS[to];
	if (!target.alpha && image.hasAlpha) {
		image = flatten(image, options.background);
	}

	// Narrow the gamut when asked to, or when the output cannot carry it. The
	// conversion is deliberate and one way: doing it twice, or doing it to
	// something already in sRGB, is the failure this whole path exists to
	// avoid, so it happens exactly here and nowhere else.
	const wantWide = (options.colour ?? 'preserve') === 'preserve';
	const canCarryWide = to === 'png' || to === 'jpeg' || to === 'webp' || to === 'avif';
	if (!wantWide || !canCarryWide) {
		image = toColourSpace(image, 'srgb');
	}

	/* ── Encode ─────────────────────────────────────────────────────── */

	const encoders = await encodersFor(to, caps);
	if (encoders.length === 0) {
		throw new EncodeUnsupportedError(to, encodeUnsupportedMessage(to, caps));
	}

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
		iccProfile: sourceProfile ?? (keepMetadata ? options.iccProfile : undefined),
		writeColourTag: image.colourSpace === 'display-p3',
	};

	let bytes: Uint8Array | undefined;
	let encoderId = '';
	let encodePath = encoders[0]?.path ?? 'pure';
	let encodeError: unknown;
	for (const encoder of encoders) {
		try {
			bytes = await encoder.encode(image, encodeOptions, {
				capabilities: caps,
				signal: options.signal,
			});
			encoderId = encoder.id;
			encodePath = encoder.path;
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
			metadata: output.exif ? readExif(output.exif) : undefined,
			droppedGainMap: output.droppedGainMap,
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
