/**
 * Convert images in the browser, without uploading them anywhere.
 *
 * The headline case is HEIC, the format every iPhone writes and most of the
 * web cannot read. It is handled without any runtime dependency by parsing the
 * container here and handing the compressed picture to the decoder the device
 * already has, which on most machines is the same hardware that plays video.
 * Where that is not available, a host application can register a software
 * decoder and the result says which one ran.
 *
 * Around it sits everything else that is awkward to open: TIFF from scanners
 * and print shops, PSD from Photoshop, DDS from game engines, Radiance and
 * OpenEXR from renderers, the preview a camera embeds in its raw file, Apple
 * icon suites, and the older formats that outlived the software that wrote
 * them. Animation survives where the target can hold it, so an animated GIF
 * can become an APNG and back.
 *
 * Nothing in this package makes a network request. There is no call to
 * `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`
 * anywhere in it, and nothing is written to `localStorage`, `sessionStorage`,
 * `indexedDB` or a cookie. That is a property of the code rather than a
 * promise about intent, and the check worth doing is the simple one: turn the
 * network off and use it anyway.
 */

export { convert, DEFAULT_MAX_PIXELS } from './convert.js';
export { installDefaultCodecs, resetDefaultCodecs } from './defaults.js';

export {
	FORMATS,
	FORMAT_IDS,
	formatForExtension,
	formatForMime,
	formatInfo,
	isDisplayable,
} from './formats.js';

export {
	clearRegistry,
	decodersFor,
	encodersFor,
	readableFormats,
	registerDecoder,
	registerEncoder,
	registeredDecoders,
	registeredEncoders,
	unregisterDecoder,
	unregisterEncoder,
	writableFormats,
} from './registry.js';

export { SNIFF_BYTES, requireFormat, sniffFormat } from './detect/sniff.js';
export { detectCapabilities, emptyCapabilities, resetCapabilities } from './detect/capabilities.js';

export {
	applyOrientation,
	attachAlpha,
	blit,
	createRaster,
	crop,
	detectAlpha,
	flatten,
	mirror,
	rotate,
	withColourSpace,
} from './raster/image.js';
export { outOfSrgbGamut, toColourSpace } from './raster/colour.js';
export { MAX_CANVAS_AREA, MAX_CANVAS_SIDE, canvasCanHold } from './raster/canvas.js';
export { exactPalette, indexedToRaster, quantise } from './raster/quantise.js';
export type { IndexedImage, Palette, QuantiseOptions } from './raster/quantise.js';
export { fitSquare, resizeRaster } from './raster/resize.js';
export { halfToFloat, toneMap } from './raster/tonemap.js';
export type { ToneMapOptions } from './raster/tonemap.js';

export { ByteWriter, LsbBitReader, LsbBitWriter, MsbBitReader, MsbBitWriter } from './bits.js';

/**
 * The two paths that need a browser rather than only a runtime.
 *
 * Both are exported from the root rather than from `./codecs` because neither
 * is a codec in the sense that subpath means: they are the browser doing the
 * work, and whether they can run at all is a question about the page they are
 * on. The `available` predicates beside them are how you ask.
 */
export { rasteriseSvg, svgIntrinsicSize, svgRasteriseAvailable } from './codecs/svg/rasterise.js';
export type { SvgIntrinsicSize, SvgRasteriseOptions } from './codecs/svg/rasterise.js';
export {
	MAX_FRAMES,
	decodeAnimatedNative,
	imageDecoderAvailable,
} from './codecs/native/animated.js';
export type { AnimatedDecode } from './codecs/native/animated.js';

export { planHeifImage, assembleHeifImage, parseMeta, hevcCodecString } from './heif/index.js';
export type { HeifImagePlan, HeifTile, TileDecoder, TileDecoderConfig } from './heif/index.js';

export {
	CancelledError,
	CodecUnavailableError,
	ConverterError,
	DecodeFailedError,
	EmptyInputError,
	EncodeFailedError,
	EncodeUnsupportedError,
	HeifMalformedError,
	HeifUnsupportedFeatureError,
	ImageTooLargeError,
	UnknownFormatError,
	UnsupportedHereError,
	isConverterError,
} from './errors.js';
export type { ConverterErrorCode, HeifStage } from './errors.js';

export { attempt, err, ok, unwrap } from './result.js';
export type { Result } from './result.js';

export type {
	Animation,
	AnimationFrame,
	Capabilities,
	ColourSpace,
	ConvertOptions,
	ConvertReport,
	ConvertResult,
	DecodeContext,
	DecodeOutput,
	DecodePath,
	Decoder,
	EncodeContext,
	EncodeOptions,
	EncodePath,
	Encoder,
	FormatId,
	FormatInfo,
	Mirror,
	Orientation,
	RasterImage,
	Rotation,
} from './types.js';
