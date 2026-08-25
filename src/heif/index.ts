/**
 * The HEIF reader.
 *
 * A container parser and nothing else. It never decodes HEVC: it finds the
 * primary image and the HDR gain map beside it, resolves their tiles, reads the
 * decoder configuration the file carries and hands all of that to whatever can
 * actually decode video on the platform. That division is the whole reason this
 * package needs no runtime dependency to read an iPhone photograph.
 */

export { ByteReader, findBox, readFullBoxHeader, walkBoxes } from './boxes.js';
export type { BoxHeader, FullBoxHeader } from './boxes.js';
export { itemBytes, itemProperties, itemProperty, parseMeta } from './parse.js';
export type { HeifItem, HeifMeta, ItemExtent, ItemLocation } from './parse.js';
export { hevcCodecString, parseProperty } from './properties.js';
export type {
	AuxiliaryType,
	CleanAperture,
	ColourProperty,
	ContentLightLevel,
	HevcConfigProperty,
	ItemProperty,
	MirrorProperty,
	PixelInformation,
	RotationProperty,
	SpatialExtent,
} from './properties.js';
export { planHeifImage } from './image.js';
export type { HeifGainMapPlan, HeifImagePlan, HeifPicturePlan, HeifTile } from './image.js';
export { assembleHeifImage } from './assemble.js';
export type { TileDecoder, TileDecoderConfig } from './assemble.js';
