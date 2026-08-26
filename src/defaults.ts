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
 *     8  the platform's frame decoder, which is the only native path that
 *        returns an animation rather than its first picture
 *    10  the platform's own decoder, hardware where there is hardware
 *    20  our own reader, where it knows something the platform's does not:
 *        HEVC tiles, an animation, or a picture buried in a container
 *    30  the platform's own decoder standing in for one of those, for a file
 *        it refused or an environment our reader cannot run in
 *    40  a pure TypeScript implementation
 *    45  a last resort that pulls a picture out of a file nothing here decodes
 *    50+ left free for a host application's plugin, typically WebAssembly
 */

import { ImageTooLargeError } from './errors.js';
import { FORMATS } from './formats.js';
import { findExif } from './metadata/exif.js';
import { declaresWideGamut, findIccProfile } from './metadata/icc.js';
import { registerDecoder, registerEncoder } from './registry.js';
import type {
	Animation,
	DecodeContext,
	Decoder,
	EncodeOptions,
	Encoder,
	FloatImage,
	FormatId,
	RasterImage,
} from './types.js';
import { fitSquare } from './raster/resize.js';

import { heicNativeDecoder, heicWebCodecsDecoder } from './codecs/heic/index.js';
import { decodeNative, nativeDecodeAvailable } from './codecs/native/decode.js';
import { encodeNative } from './codecs/native/encode.js';
import { decodeAnimatedNative, imageDecoderAvailable } from './codecs/native/animated.js';
import { decodePng, measurePng } from './codecs/png/decode.js';
import { encodePng } from './codecs/png/encode.js';
import { animatedWebpEncoder } from './codecs/webp/encode.js';
import { decodeApng } from './codecs/png/apng.js';
import { encodeApng } from './codecs/png/apngEncode.js';
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
import { decodeIco } from './codecs/ico/decode.js';
import { encodeIco } from './codecs/ico/encode.js';
import { decodeTiff, decodeTiffFloat, readTiffIccProfile } from './codecs/tiff/decode.js';
import { encodeTiff } from './codecs/tiff/encode.js';
import { decodeGifAnimation, measureGif } from './codecs/gif/decode.js';
import { encodeGif } from './codecs/gif/encode.js';
import { decodePsd, measurePsd } from './codecs/psd/decode.js';
import { decodeDds } from './codecs/dds/decode.js';
import { decodeHdr, decodeHdrFloat } from './codecs/hdr/decode.js';
import { encodeHdr, encodeHdrFloat } from './codecs/hdr/encode.js';
import { decodeExr, decodeExrFloat } from './codecs/exr/decode.js';
import { encodeExr, encodeExrFloat } from './codecs/exr/encode.js';
import { avifEncoder } from './codecs/avif/index.js';
import { decodePcx, measurePcx } from './codecs/pcx/decode.js';
import { encodePcx } from './codecs/pcx/encode.js';
import { decodeIcns } from './codecs/icns/decode.js';
import { encodeIcns } from './codecs/icns/encode.js';
import { decodeRas } from './codecs/ras/decode.js';
import { encodeRas } from './codecs/ras/encode.js';
import { decodeXbm } from './codecs/xbm/decode.js';
import { encodeXbm } from './codecs/xbm/encode.js';
import { decodeXpm } from './codecs/xpm/decode.js';
import { encodeXpm } from './codecs/xpm/encode.js';
import { findRawPreview } from './codecs/raw/preview.js';
import { rasteriseSvg, svgRasteriseAvailable } from './codecs/svg/rasterise.js';

/** Formats the browser's own decoder handles, where it has one. */
const NATIVE_DECODABLE: readonly FormatId[] = ['png', 'jpeg', 'jxl', 'webp', 'avif', 'bmp'];

/** Formats a canvas can be asked to write. Whether it will is probed, not assumed. */
const NATIVE_ENCODABLE: readonly FormatId[] = ['png', 'jpeg', 'webp', 'avif'];

/** Formats where our own encoder outranks the browser's. See `nativeEncoder`. */
const OURS_FIRST: ReadonlySet<FormatId> = new Set<FormatId>(['png', 'avif']);

/**
 * Formats whose frames the platform's own frame decoder can read.
 *
 * `createImageBitmap` hands back the first picture of an animation and says
 * nothing about the rest, which is why these get a rung of their own above it.
 * GIF is on the list even though there is a pure reader for it below, because
 * where `ImageDecoder` exists it is faster and it agrees with what the same
 * browser shows in a tab, and where it does not the pure reader is still there.
 */
const NATIVE_ANIMATED: readonly FormatId[] = ['webp', 'avif', 'gif'];

function nativeDecoder(format: FormatId, mimeOverride?: string): Decoder {
	const info = FORMATS[format];
	const mime = mimeOverride ?? info.mime;
	return {
		id: `${format}-native`,
		formats: [format],
		path: 'native-image',
		priority: 10,
		async available(capabilities) {
			return nativeDecodeAvailable() && capabilities.nativeDecode.has(mime);
		},
		async decode(bytes) {
			// Only ask for a wide gamut readback when the file says it is wide.
			// Asking unconditionally converts an ordinary sRGB image into P3
			// numbers, and if anything downstream then loses the tag it renders
			// oversaturated. The safe default is to leave sRGB alone.
			const wide = declaresWideGamut(bytes, format);
			const image = await decodeNative(bytes, format, mime, wide ? 'display-p3' : 'srgb');
			const profile = wide ? findIccProfile(bytes, format) : undefined;
			return {
				iccProfile: profile && profile.length > 0 ? profile : undefined,
				// Read off the container here rather than left to the browser,
				// which strips it during the decode. Without this the report
				// could only say what a HEIC had been carrying, and the tick box
				// offering to keep it had nothing to keep for every other source.
				exif: findExif(bytes, format),
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

/**
 * The platform's decoder, behind one of ours rather than in front of it.
 *
 * Only for a format where our own reader knows something the browser's does
 * not, which today means an animation. Same mechanism as `nativeDecoder` and a
 * different position in the ladder, so it carries a different id: `frames`
 * ahead of `pure` ahead of `fallback` is the order, and reading it off the
 * registry should not require knowing which format is which.
 */
function fallbackNativeDecoder(format: FormatId, mimeOverride?: string): Decoder {
	return { ...nativeDecoder(format, mimeOverride), id: `${format}-fallback`, priority: 30 };
}

function nativeAnimatedDecoder(format: FormatId): Decoder {
	const info = FORMATS[format];
	return {
		id: `${format}-frames`,
		formats: [format],
		path: 'native-image',
		priority: 8,
		async available(capabilities) {
			return (
				imageDecoderAvailable() &&
				capabilities.imageDecoder &&
				capabilities.nativeDecode.has(info.mime)
			);
		},
		async decode(bytes, context) {
			const decoded = await decodeAnimatedNative(bytes, format, info.mime);
			const frames = decoded.animation?.frames.length ?? 1;
			const pixels = decoded.image.width * decoded.image.height * frames;
			if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
			return {
				image: decoded.image,
				animation: decoded.animation,
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
		// Two formats where our own encoder is the better one, so the canvas
		// sits behind them. PNG because ours writes indexed and 24 bit output a
		// canvas cannot, and AVIF because ours can carry a gain map, which is
		// the difference between an HDR photograph surviving the conversion and
		// arriving as its standard range base. For everything else the canvas
		// is the only option and the number does not matter.
		//
		// No browser writes AVIF from a canvas today, so the AVIF entry is a
		// placeholder for one that might. It is ordered now rather than left to
		// be noticed later, because the day it starts working is the day it
		// would silently start dropping gain maps.
		priority: OURS_FIRST.has(format) ? 20 : 10,
		async available(capabilities) {
			return capabilities.canvasEncode.has(info.mime);
		},
		async encode(image, options) {
			return encodeNative(image, format, info.mime, options);
		},
	};
}

type PureDecode = (bytes: Uint8Array) => Promise<RasterImage> | RasterImage;

/** Reads the declared size out of a header. See `Decoder.measure`. */
type PureMeasure = (
	bytes: Uint8Array,
) => { readonly width: number; readonly height: number } | undefined;

function pureDecoder(
	format: FormatId,
	decode: PureDecode,
	available: () => boolean = () => true,
	readLight?: (bytes: Uint8Array) => Promise<FloatImage> | FloatImage,
	measure?: PureMeasure,
): Decoder {
	/**
	 * Refuse a header that describes more than the caller will take.
	 *
	 * Before the decode rather than after it. Every reader here already
	 * refuses a header its file cannot back up, which covers the formats that
	 * store pixels plainly, but a compressed one has no such relationship: the
	 * header and the pixels are separated by a decompressor, and a small file
	 * can honestly declare an enormous image. Measuring first is what turns
	 * that from an allocation into a sentence.
	 */
	const guard = (bytes: Uint8Array, maxPixels: number): void => {
		const size = measure?.(bytes);
		if (!size) return;
		const pixels = size.width * size.height;
		if (pixels > maxPixels) throw new ImageTooLargeError(pixels, maxPixels);
	};

	return {
		id: `${format}-pure`,
		formats: [format],
		path: 'pure',
		priority: 40,
		async available() {
			return available();
		},
		...(measure ? { measure } : {}),
		async decode(bytes, context) {
			guard(bytes, context.maxPixels);
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
		...(readLight
			? {
					async decodeFloat(bytes: Uint8Array, context: DecodeContext) {
						guard(bytes, context.maxPixels);
						const image = await readLight(bytes);
						// The same ceiling, and it bites sooner here: a pixel of
						// light is sixteen bytes against four, so the buffer
						// this refuses to allocate is four times the size.
						const pixels = image.width * image.height;
						if (pixels > context.maxPixels) {
							throw new ImageTooLargeError(pixels, context.maxPixels);
						}
						return {
							image,
							orientation: { rotation: 0, mirror: 'none', source: 'none' } as const,
						};
					},
				}
			: {}),
	};
}

interface AnimatedResult {
	readonly image: RasterImage;
	readonly animation: Animation;
}

type AnimatedDecode = (bytes: Uint8Array) => Promise<AnimatedResult> | AnimatedResult;

/**
 * A pure reader that returns every frame.
 *
 * The ceiling counts the whole animation rather than one frame. Three hundred
 * frames of a modest picture is a larger allocation than one photograph, and a
 * budget that only looked at a single frame would wave it through.
 */
function pureAnimatedDecoder(
	format: FormatId,
	decode: AnimatedDecode,
	available: () => boolean = () => true,
	measure?: PureMeasure,
): Decoder {
	return {
		id: `${format}-pure`,
		formats: [format],
		path: 'pure',
		priority: 20,
		async available() {
			return available();
		},
		...(measure ? { measure } : {}),
		async decode(bytes, context) {
			// The header's own claim, checked before the decompressor is handed
			// a budget shaped by it. One frame is a floor rather than the whole
			// answer, so the screen times frames check below still does the rest.
			const declared = measure?.(bytes);
			if (declared && declared.width * declared.height > context.maxPixels) {
				throw new ImageTooLargeError(declared.width * declared.height, context.maxPixels);
			}
			const decoded = await decode(bytes);
			const frames = Math.max(1, decoded.animation.frames.length);
			const pixels = decoded.image.width * decoded.image.height * frames;
			if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
			return {
				image: decoded.image,
				// One frame is a still picture that happens to live in a
				// container that can hold more, and reporting an animation for
				// it would put a frame count in front of somebody who converted
				// an ordinary GIF.
				animation: decoded.animation.frames.length > 1 ? decoded.animation : undefined,
				orientation: { rotation: 0, mirror: 'none', source: 'none' },
			};
		},
	};
}

interface PureEncoderOptions {
	readonly priority?: number;
	/** Writes light directly, which makes this encoder a destination for it. */
	readonly floats?: (image: FloatImage, options: EncodeOptions) => Promise<Uint8Array> | Uint8Array;
	readonly available?: () => boolean;
	readonly animates?: boolean;
	/** Declares the encoder writes `EncodeOptions.exif`. See `Encoder.exif`. */
	readonly exif?: boolean;
}

function pureEncoder(
	format: FormatId,
	encode: (image: RasterImage, options: EncodeOptions) => Promise<Uint8Array> | Uint8Array,
	options: PureEncoderOptions = {},
): Encoder {
	return {
		id: `${format}-pure`,
		format,
		path: 'pure',
		priority: options.priority ?? 10,
		animates: options.animates,
		exif: options.exif,
		async available() {
			return options.available?.() ?? true;
		},
		async encode(image, encodeOptions) {
			return encode(image, encodeOptions);
		},
		...(options.floats
			? {
					floats: true,
					async encodeFloat(image: FloatImage, encodeOptions: EncodeOptions) {
						return options.floats!(image, encodeOptions);
					},
				}
			: {}),
	};
}

/* ── The ones that are not a plain function call ──────────────────────── */

/**
 * TIFF, with its colour profile carried through.
 *
 * A scanner and a print shop both write a TIFF with an embedded profile and
 * both mean it, so the profile is read out here and handed to whatever encoder
 * runs next. The picture itself comes back as ordinary sRGB numbers, which is
 * what the reader produces; the profile travels beside them rather than
 * changing them.
 */
const tiffDecoder: Decoder = {
	id: 'tiff-pure',
	formats: ['tiff'],
	path: 'pure',
	priority: 40,
	async available() {
		return true;
	},
	async decode(bytes, context) {
		const image = await decodeTiff(bytes);
		const pixels = image.width * image.height;
		if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
		const profile = readTiffIccProfile(bytes);
		return {
			image,
			iccProfile: profile && profile.length > 0 ? profile : undefined,
			// The file is its own EXIF: a TIFF and an EXIF block are the same
			// structure, which is why this one needs no marker walk.
			exif: findExif(bytes, 'tiff'),
			orientation: { rotation: 0, mirror: 'none', source: 'none' },
		};
	},
	/**
	 * A float TIFF read as light rather than reduced to eight bits.
	 *
	 * `decodeTiffFloat` throws immediately for anything that is not floating
	 * point, and for a float file whose values are already bounded by one.
	 * Both refusals matter: `convert` runs the light ladder first for any
	 * decoder that offers one, so a slow refusal would parse every ordinary
	 * TIFF twice, and a display-referred float file handed on as light would be
	 * metered against 0.18 and come out several stops too bright.
	 */
	async decodeFloat(bytes, context) {
		const image = await decodeTiffFloat(bytes);
		// The same ceiling, and it bites sooner here: a pixel of light is
		// sixteen bytes against four.
		const pixels = image.width * image.height;
		if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
		const profile = readTiffIccProfile(bytes);
		return {
			image,
			iccProfile: profile && profile.length > 0 ? profile : undefined,
			exif: findExif(bytes, 'tiff'),
			orientation: { rotation: 0, mirror: 'none', source: 'none' },
		};
	},
};

/**
 * A picture out of a file nothing here can decode.
 *
 * This is the whole camera raw path, and it is also the last resort for a TIFF
 * whose strips are JPEG compressed, which the pure reader refuses by name. In
 * both cases the file carries a complete JPEG that another program already
 * rendered, and handing that to the browser's own decoder produces the picture
 * somebody was asking for.
 *
 * Worth being plain about what this is not. A raw file holds sensor data that
 * has to be demosaiced, white balanced and tone mapped before it is a
 * photograph, and none of that happens here or could. What comes out is the
 * camera's own rendering of its own shot, at whatever size the camera chose to
 * embed, which on every current camera is the full frame.
 */
function embeddedPreviewDecoder(format: FormatId, priority: number): Decoder {
	return {
		id: `${format}-preview`,
		formats: [format],
		path: 'native-image',
		priority,
		async available(capabilities) {
			return nativeDecodeAvailable() && capabilities.nativeDecode.has('image/jpeg');
		},
		async decode(bytes, context) {
			const preview = findRawPreview(bytes);
			const pixels = preview.width * preview.height;
			if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
			const image = await decodeNative(preview.bytes, format, 'image/jpeg', 'srgb');
			return {
				image,
				// The preview is a JPEG and the browser has already applied its
				// EXIF orientation, exactly as on the ordinary native path.
				orientation: { rotation: 0, mirror: 'none', source: 'decoder' },
			};
		},
	};
}

const svgDecoder: Decoder = {
	id: 'svg-native',
	formats: ['svg'],
	path: 'native-image',
	priority: 10,
	async available() {
		return svgRasteriseAvailable();
	},
	async decode(bytes, context) {
		const image = await rasteriseSvg(bytes);
		const pixels = image.width * image.height;
		if (pixels > context.maxPixels) throw new ImageTooLargeError(pixels, context.maxPixels);
		return { image, orientation: { rotation: 0, mirror: 'none', source: 'none' } };
	},
};

/**
 * The sizes an icon gets, largest first.
 *
 * Windows picks from the directory by size rather than by position, but every
 * icon editor writes them descending and a file that reads oddly in one of
 * those is a support question nobody needs. Sizes above the source are left
 * out: an icon that claims 256 and holds a blurred 32 is worse than one that
 * admits to 32.
 */
const ICO_SIDES = [256, 128, 64, 48, 32, 16] as const;

async function encodeIcoFromRaster(
	image: RasterImage,
	options: EncodeOptions,
): Promise<Uint8Array> {
	const longest = Math.max(image.width, image.height);
	const wanted = ICO_SIDES.filter((side) => side <= longest);
	// A drawing smaller than the smallest slot still gets that slot, because an
	// icon holding no images at all is not a file anything will open.
	const sides = wanted.length > 0 ? wanted : [16];
	const entries = [];
	for (const side of sides) {
		entries.push({
			width: side,
			height: side,
			png: await encodePng(fitSquare(image, side), options),
		});
	}
	return encodeIco(entries);
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

	/* ── Decoders ───────────────────────────────────────────────────── */

	registerDecoder(heicNativeDecoder);
	registerDecoder(heicWebCodecsDecoder);

	for (const format of NATIVE_ANIMATED) registerDecoder(nativeAnimatedDecoder(format));
	for (const format of NATIVE_DECODABLE) registerDecoder(nativeDecoder(format));
	registerDecoder(svgDecoder);

	// Both of these are formats a browser will happily decode, and decoding one
	// that way loses the animation without saying so: `createImageBitmap`
	// returns the first picture and nothing else. For an APNG that is often not
	// even a frame of the animation but a poster the author chose to stand for
	// it. So our own reader goes first in both cases, and the browser sits
	// behind it as the fallback for a file it refuses or an environment where
	// it cannot run.
	registerDecoder(pureAnimatedDecoder('apng', decodeApng, hasCompressionStream));
	registerDecoder(fallbackNativeDecoder('apng', 'image/png'));
	registerDecoder(pureAnimatedDecoder('gif', decodeGifAnimation, () => true, measureGif));
	registerDecoder(fallbackNativeDecoder('gif'));

	registerDecoder(pureDecoder('png', decodePng, hasCompressionStream, undefined, measurePng));
	registerDecoder(tiffDecoder);
	registerDecoder(embeddedPreviewDecoder('raw', 20));
	// Behind the pure reader rather than instead of it: a TIFF with JPEG strips
	// is refused by name up there, and this is what turns that refusal into a
	// picture. An ordinary TIFF never reaches it.
	registerDecoder(embeddedPreviewDecoder('tiff', 45));

	registerDecoder(pureDecoder('qoi', decodeQoi));
	registerDecoder(pureDecoder('bmp', decodeBmp));
	registerDecoder(pureDecoder('tga', decodeTga));
	registerDecoder(pureDecoder('pnm', decodePnm));
	registerDecoder(pureDecoder('farbfeld', decodeFarbfeld));
	registerDecoder(pureDecoder('ico', decodeIco));
	registerDecoder(pureDecoder('psd', decodePsd, () => true, undefined, measurePsd));
	registerDecoder(pureDecoder('dds', decodeDds));
	// Both of these read light as well as bytes, and which one runs is decided
	// by where the picture is going rather than here.
	registerDecoder(pureDecoder('hdr', decodeHdr, () => true, decodeHdrFloat));
	registerDecoder(pureDecoder('exr', decodeExr, () => true, decodeExrFloat));
	registerDecoder(pureDecoder('pcx', decodePcx, () => true, undefined, measurePcx));
	registerDecoder(pureDecoder('icns', decodeIcns, hasCompressionStream));
	registerDecoder(pureDecoder('ras', decodeRas));
	registerDecoder(pureDecoder('xbm', decodeXbm));
	registerDecoder(pureDecoder('xpm', decodeXpm));

	/* ── Encoders ───────────────────────────────────────────────────── */

	for (const format of NATIVE_ENCODABLE) registerEncoder(nativeEncoder(format));

	// Ours first for PNG: it writes 24 bit where there is no alpha, indexed
	// where the picture has few enough colours for that to be lossless, embeds
	// the source ICC profile so a wide gamut photograph survives, needs no
	// canvas and so has no size ceiling, and on a phone photograph it produces
	// a smaller file than the canvas does.
	registerEncoder(pureEncoder('png', encodePng, { available: hasCompressionStream, exif: true }));
	registerEncoder(
		pureEncoder('apng', encodeApng, { available: hasCompressionStream, animates: true }),
	);
	registerEncoder(pureEncoder('gif', encodeGif, { animates: true }));

	registerEncoder(pureEncoder('qoi', encodeQoi));
	registerEncoder(pureEncoder('bmp', encodeBmp));
	registerEncoder(pureEncoder('tga', encodeTga));
	registerEncoder(pureEncoder('pnm', encodePnm));
	registerEncoder(pureEncoder('farbfeld', encodeFarbfeld));
	registerEncoder(pureEncoder('tiff', encodeTiff, { exif: true }));
	registerEncoder(pureEncoder('hdr', encodeHdr, { floats: encodeHdrFloat }));
	// No availability check. An uncompressed OpenEXR is always legal, so this
	// is the one encoder here with no platform requirement at all: it prefers
	// deflate and writes the file either way.
	registerEncoder(pureEncoder('exr', encodeExr, { floats: encodeExrFloat }));
	registerEncoder(avifEncoder);
	// Ahead of the plain canvas WebP encoder on priority, not on registration
	// order, and the canvas one stays registered behind it: this rung needs the
	// browser to write a WebP per frame, and where it cannot, a still is still
	// a result.
	registerEncoder(animatedWebpEncoder);
	registerEncoder(pureEncoder('pcx', encodePcx));
	registerEncoder(pureEncoder('ras', encodeRas));
	registerEncoder(pureEncoder('xbm', encodeXbm));
	registerEncoder(pureEncoder('xpm', encodeXpm));
	registerEncoder(pureEncoder('ico', encodeIcoFromRaster, { available: hasCompressionStream }));
	registerEncoder(pureEncoder('icns', encodeIcns, { available: hasCompressionStream }));
}

/** Forget that the defaults were installed. Tests use this. */
export function resetDefaultCodecs(): void {
	installed = false;
}
