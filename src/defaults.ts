/**
 * The codec set this package ships with.
 *
 * Kept out of `src/codecs/` on purpose: choosing which codecs exist and in
 * what order they are tried is a decision about the package, not about any one
 * format, and a codec that imported the registry would make the whole
 * plug-and-play arrangement circular.
 *
 * Priorities are costs, not preferences. Lower runs first.
 *
 *    10  the platform's own decoder, hardware where there is hardware
 *    20  our own reader driving the platform's video decoder
 *    40  a pure TypeScript implementation
 *    50+ left free for a host application's plugin, typically WebAssembly
 */

import { ImageTooLargeError } from './errors.js';
import { FORMATS } from './formats.js';
import { declaresWideGamut, findIccProfile } from './metadata/icc.js';
import { registerDecoder, registerEncoder } from './registry.js';
import type { Decoder, Encoder, FormatId } from './types.js';
import { heicNativeDecoder, heicWebCodecsDecoder } from './codecs/heic/index.js';
import { decodeNative, nativeDecodeAvailable } from './codecs/native/decode.js';
import { encodeNative } from './codecs/native/encode.js';
import { decodePng } from './codecs/png/decode.js';
import { encodePng } from './codecs/png/encode.js';
import { hasCompressionStream } from './codecs/png/deflate.js';
import { decodeQoi } from './codecs/qoi/decode.js';
import { encodeQoi } from './codecs/qoi/encode.js';
import { decodeBmp } from './codecs/bmp/decode.js';
import { encodeBmp } from './codecs/bmp/encode.js';
import { decodeTga } from './codecs/tga/decode.js';
import { encodeTga } from './codecs/tga/encode.js';
import { decodePnm } from './codecs/pnm/decode.js';
import { encodePnm } from './codecs/pnm/encode.js';
import { decodeFarbfeld } from './codecs/farbfeld/decode.js';
import { encodeFarbfeld } from './codecs/farbfeld/encode.js';

/** Formats the browser's own decoder handles, where it has one. */
const NATIVE_DECODABLE: readonly FormatId[] = ['png', 'jpeg', 'gif', 'webp', 'avif', 'bmp'];

/** Formats a canvas can be asked to write. Whether it will is probed, not assumed. */
const NATIVE_ENCODABLE: readonly FormatId[] = ['png', 'jpeg', 'webp', 'avif'];

function nativeDecoder(format: FormatId): Decoder {
	const info = FORMATS[format];
	return {
		id: `${format}-native`,
		formats: [format],
		path: 'native-image',
		priority: 10,
		async available(capabilities) {
			return nativeDecodeAvailable() && capabilities.nativeDecode.has(info.mime);
		},
		async decode(bytes) {
			// Only ask for a wide gamut readback when the file says it is wide.
			// Asking unconditionally converts an ordinary sRGB image into P3
			// numbers, and if anything downstream then loses the tag it renders
			// oversaturated. The safe default is to leave sRGB alone.
			const wide = declaresWideGamut(bytes, format);
			const image = await decodeNative(bytes, format, info.mime, wide ? 'display-p3' : 'srgb');
			const profile = wide ? findIccProfile(bytes, format) : undefined;
			return {
				iccProfile: profile && profile.length > 0 ? profile : undefined,
				// A browser applies EXIF orientation while decoding, so the
				// pixels are already upright. Applying it again is the classic
				// double-rotation bug and it only shows on photographs taken
				// sideways, which is most of them.
				image,
				orientation: { rotation: 0, mirror: 'none', source: 'decoder' },
			};
		},
	};
}

function nativeEncoder(format: FormatId): Encoder {
	const info = FORMATS[format];
	return {
		id: `${format}-native`,
		format,
		path: 'canvas',
		// PNG is the one format where our own encoder is better than the
		// canvas, so this sits behind it. For everything else it is the only
		// option and the number does not matter.
		priority: format === 'png' ? 20 : 10,
		async available(capabilities) {
			return capabilities.canvasEncode.has(info.mime);
		},
		async encode(image, options) {
			return encodeNative(image, format, info.mime, options);
		},
	};
}

function pureDecoder(
	format: FormatId,
	decode: (
		bytes: Uint8Array,
	) => Promise<import('./types.js').RasterImage> | import('./types.js').RasterImage,
	available: () => boolean = () => true,
): Decoder {
	return {
		id: `${format}-pure`,
		formats: [format],
		path: 'pure',
		priority: 40,
		async available() {
			return available();
		},
		async decode(bytes, context) {
			const image = await decode(bytes);
			// Checked here rather than inside each codec. A codec receives bytes
			// and knows nothing about the caller's budget, and every one of them
			// already refuses a dishonest header before allocating, so what is
			// left is an honest header for an image larger than this caller is
			// willing to handle. Without this the ceiling would apply to the
			// HEIC path and quietly not to any other, which is worse than having
			// no ceiling at all because it would look like it worked.
			const pixels = image.width * image.height;
			if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
			return {
				image,
				orientation: { rotation: 0, mirror: 'none', source: 'none' },
			};
		},
	};
}

function pureEncoder(
	format: FormatId,
	encode: (
		image: import('./types.js').RasterImage,
		options: import('./types.js').EncodeOptions,
	) => Promise<Uint8Array> | Uint8Array,
	priority = 10,
	available: () => boolean = () => true,
): Encoder {
	return {
		id: `${format}-pure`,
		format,
		path: 'pure',
		priority,
		async available() {
			return available();
		},
		async encode(image, options) {
			return encode(image, options);
		},
	};
}

let installed = false;

/**
 * Register everything this package ships with.
 *
 * Idempotent, and called automatically the first time anything converts, so a
 * caller that just wants `convert` does not have to know this exists. Call it
 * yourself before registering a plugin only if you want to be certain of the
 * ordering.
 */
export function installDefaultCodecs(): void {
	if (installed) return;
	installed = true;

	registerDecoder(heicNativeDecoder);
	registerDecoder(heicWebCodecsDecoder);

	for (const format of NATIVE_DECODABLE) registerDecoder(nativeDecoder(format));
	for (const format of NATIVE_ENCODABLE) registerEncoder(nativeEncoder(format));

	// Ours first for PNG: it writes 24 bit when there is no alpha, embeds the
	// source ICC profile so a wide gamut photograph survives, needs no canvas
	// and so has no size ceiling, and on a phone photograph it produces a
	// smaller file than the canvas does.
	registerEncoder(pureEncoder('png', encodePng, 10, hasCompressionStream));
	registerDecoder(pureDecoder('png', decodePng, hasCompressionStream));

	registerDecoder(pureDecoder('qoi', decodeQoi));
	registerEncoder(pureEncoder('qoi', encodeQoi));
	registerDecoder(pureDecoder('bmp', decodeBmp));
	registerEncoder(pureEncoder('bmp', encodeBmp));
	registerDecoder(pureDecoder('tga', decodeTga));
	registerEncoder(pureEncoder('tga', encodeTga));
	registerDecoder(pureDecoder('pnm', decodePnm));
	registerEncoder(pureEncoder('pnm', encodePnm));
	registerDecoder(pureDecoder('farbfeld', decodeFarbfeld));
	registerEncoder(pureEncoder('farbfeld', encodeFarbfeld));
}

/** Forget that the defaults were installed. Tests use this. */
export function resetDefaultCodecs(): void {
	installed = false;
}
