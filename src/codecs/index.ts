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
 * answering it is the registry's job. Import them from the root instead.
 */

export { decodeBmp } from './bmp/decode.js';
export { encodeBmp } from './bmp/encode.js';
export { decodeFarbfeld } from './farbfeld/decode.js';
export { encodeFarbfeld } from './farbfeld/encode.js';
export { decodeIco, readIcoDirectory } from './ico/decode.js';
export { encodeIco } from './ico/encode.js';
export { decodeNative, nativeDecodeAvailable } from './native/decode.js';
export { encodeNative } from './native/encode.js';
export { adler32, crc32 } from './png/crc.js';
export { decodePng } from './png/decode.js';
export { deflate, hasCompressionStream, inflate } from './png/deflate.js';
export { encodePng } from './png/encode.js';
export { decodePnm } from './pnm/decode.js';
export { encodePnm } from './pnm/encode.js';
export { decodeQoi } from './qoi/decode.js';
export { encodeQoi } from './qoi/encode.js';
export { decodeTga } from './tga/decode.js';
export { encodeTga } from './tga/encode.js';
