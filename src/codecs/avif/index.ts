/**
 * AVIF, written.
 *
 * The one encoder here that is half ours and half the browser's. The AV1
 * inside comes from `VideoEncoder`, which is why `available` asks the
 * capability probe rather than answering yes: a browser with no AV1 encoder
 * cannot write this format at all, and finding that out at the end of a
 * conversion instead of before it starts is the difference between choosing
 * another format and losing the work.
 *
 * `path` says `webcodecs`, which is the same thing the HEIC reader says when it
 * runs a hardware decoder over a photograph's tiles. The container is written
 * here in TypeScript from end to end and is the part that decides whether the
 * file is correct, but the picture inside it comes from the browser, and
 * saying `pure` would promise a file that is the same everywhere. It is not:
 * two Chrome versions will encode the same image to different bytes.
 */

import type { Encoder } from '../../types.js';
import { encodeAvif } from './encode.js';

export const avifEncoder: Encoder = {
	id: 'avif-webcodecs',
	format: 'avif',
	path: 'webcodecs',
	priority: 10,
	gainMaps: true,
	exif: true,
	async available(capabilities) {
		return capabilities.av1VideoEncoder;
	},
	async encode(image, options, context) {
		return encodeAvif(image, options, context);
	},
};

export { av1CodecString, encodeAvif } from './encode.js';
export { buildAv1C, parseSequenceHeader, splitObus } from './av1.js';
export type { Av1SequenceHeader, Obu } from './av1.js';
export { ALPHA_AUX_URN, muxAvif } from './mux.js';
export type { AvifCodedImage, AvifGainMapSpec, AvifMuxSpec } from './mux.js';
export { webCodecsAv1Encoder } from './webcodecs.js';
export type { Av1FrameEncoder, Av1FrameRequest } from './webcodecs.js';
