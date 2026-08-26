/**
 * The codecs, as plain functions.
 *
 * Exposed for a caller who wants one directly rather than through `convert`:
 * writing a QOI from a raster it already has, or reading a PNG in Node where
 * there is no canvas to do it. Nothing here consults the registry or picks a
 * path, so what you ask for is what runs.
 *
 * The HEIC decoders are not here. They are `Decoder` objects rather than
 * functions because which one can run is a question about the browser, and
 * answering it is the registry's job. Import them from the root instead. The
 * same goes for anything else whose answer depends on the platform: the SVG
 * rasteriser and the frame decoder both need a browser, and both are exported
 * from the root for a caller that has one.
 *
 * `encodeAvif` is here despite needing a browser, because unlike those it is
 * still a function of its arguments: the container is written in full here and
 * only the AV1 frame inside comes from the platform, which the caller can
 * supply itself through the encoder seam.
 */

export { encodeAvif, muxAvif, webCodecsAv1Encoder } from './avif/index.js';
export type {
	Av1FrameEncoder,
	Av1FrameRequest,
	AvifCodedImage,
	AvifGainMapSpec,
	AvifMuxSpec,
} from './avif/index.js';
export { decodeBmp } from './bmp/decode.js';
export { encodeBmp } from './bmp/encode.js';
export { decodeDds } from './dds/decode.js';
export { decodeExr, decodeExrFloat } from './exr/decode.js';
export { encodeExr, encodeExrFloat, floatToHalf } from './exr/encode.js';
export { decodeFarbfeld } from './farbfeld/decode.js';
export { encodeFarbfeld } from './farbfeld/encode.js';
export { decodeGif, decodeGifAnimation } from './gif/decode.js';
export type { GifResult } from './gif/decode.js';
export { encodeGif } from './gif/encode.js';
export { decodeHdr, decodeHdrFloat } from './hdr/decode.js';
export { encodeHdr, encodeHdrFloat } from './hdr/encode.js';
export { decodeIcns, readIcnsDirectory } from './icns/decode.js';
export type { IcnsDirectory, IcnsEntry, IcnsEntryKind } from './icns/decode.js';
export { encodeIcns } from './icns/encode.js';
export { decodeIco, readIcoDirectory } from './ico/decode.js';
export { encodeIco } from './ico/encode.js';
export type { IcoEntry } from './ico/encode.js';
export { decodeNative, nativeDecodeAvailable } from './native/decode.js';
export { encodeNative } from './native/encode.js';
export { adler32, crc32 } from './png/crc.js';
export { decodeApng } from './png/apng.js';
export type { ApngDecode } from './png/apng.js';
export { encodeApng } from './png/apngEncode.js';
export { decodePng } from './png/decode.js';
export { deflate, hasCompressionStream, inflate, openDeflate } from './png/deflate.js';
export type { DeflateSink } from './png/deflate.js';
export { encodePng } from './png/encode.js';
export { decodePcx } from './pcx/decode.js';
export { encodePcx } from './pcx/encode.js';
export { decodePnm } from './pnm/decode.js';
export { encodePnm } from './pnm/encode.js';
export { decodePsd } from './psd/decode.js';
export { decodeQoi } from './qoi/decode.js';
export { encodeQoi } from './qoi/encode.js';
export { decodeRas } from './ras/decode.js';
export { encodeRas } from './ras/encode.js';
export { findRawPreview, jpegDimensions } from './raw/preview.js';
export type { RawPreview } from './raw/preview.js';
export { decodeTga } from './tga/decode.js';
export { encodeTga } from './tga/encode.js';
export { decodeTiff, readTiffIccProfile } from './tiff/decode.js';
export { encodeTiff } from './tiff/encode.js';
export { encodeAnimatedWebp, nativeWebpFrameEncoder } from './webp/encode.js';
export type { WebpFrameEncoder } from './webp/encode.js';
export { muxAnimatedWebp, readWebpChunks } from './webp/mux.js';
export type { WebpAnimationSpec, WebpChunk, WebpCodedFrame } from './webp/mux.js';
export { decodeXbm } from './xbm/decode.js';
export { encodeXbm } from './xbm/encode.js';
export { decodeXpm } from './xpm/decode.js';
export { encodeXpm } from './xpm/encode.js';
