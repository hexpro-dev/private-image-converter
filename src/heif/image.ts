/**
 * Resolve the pictures of a HEIF file into plans a decoder can execute.
 *
 * The plan is pure data: tile positions and their compressed bytes, the decoder
 * configuration, the orientation to apply afterwards and the colour space the
 * numbers will be in. Nothing here calls a codec, so the hard part of HEIC
 * reading is testable without a browser.
 *
 * A photograph from a recent phone is not one picture. It is a standard range
 * base, a second and usually smaller picture saying how much brighter each part
 * of it should get, and a short parameter block tying the two together. Both
 * pictures are ordinary HEVC in ordinary items, so the gain map is planned by
 * the same code that plans the base rather than by a second reader that would
 * drift away from it. It hangs off the same plan rather than sitting behind its
 * own entry point, because a caller who has to remember to ask is a caller who
 * will one day forget, and the symptom of forgetting is a photograph that
 * quietly loses its highlights with nothing anywhere saying so.
 */

import { HeifMalformedError, HeifUnsupportedFeatureError } from '../errors.js';
import type { HeifStage } from '../errors.js';
import type { ColourSpace, Orientation } from '../types.js';
import { ByteReader } from './boxes.js';
import { itemBytes, itemProperty, parseMeta } from './parse.js';
import type { HeifMeta } from './parse.js';
import { hevcCodecString } from './properties.js';
import type { HevcConfigProperty } from './properties.js';

export interface HeifTile {
	/** Position of this tile's top left corner in the assembled grid. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** Length prefixed NAL units, exactly as the file stores them. */
	readonly data: Uint8Array;
}

/**
 * Everything needed to turn one item into a raster.
 *
 * Shared by the base picture and by the gain map because the two are the same
 * kind of thing: a grid of HEVC tiles, a size, a rotation and a colour tag.
 * One shape means the assembler has one code path, so the grid arithmetic that
 * is right for a 48 megapixel photograph cannot be subtly wrong for the half
 * sized picture beside it.
 */
export interface HeifPicturePlan {
	/** The assembled grid before cropping. Tiles are padded out to a multiple of the tile size. */
	readonly canvasWidth: number;
	readonly canvasHeight: number;
	/** The real image, after cropping the grid padding away and before rotation. */
	readonly width: number;
	readonly height: number;
	/** What the image measures once its orientation has been applied. */
	readonly displayWidth: number;
	readonly displayHeight: number;
	readonly orientation: Orientation;
	readonly colourSpace: ColourSpace;
	readonly iccProfile?: Uint8Array;
	readonly tiles: readonly HeifTile[];
	readonly config: HevcConfigProperty;
	readonly codecString: string;
}

/**
 * The gain map picture, plus the parameter block that gives it meaning.
 *
 * `metadata` is the `tmap` item's payload, carried byte for byte and never
 * parsed. Every value that defines what the photograph should look like lives
 * in there: the headroom it was graded for, the range of the gain, the gamma,
 * the offsets. Copying the block unchanged into a container that uses the same
 * specification reproduces the photograph exactly, whereas taking it apart in
 * order to write it back could only introduce error, and that error would
 * surface as a picture that looks slightly wrong rather than as a failure
 * anybody can point at.
 */
export interface HeifGainMapPlan extends HeifPicturePlan {
	readonly metadata: Uint8Array;
	/** Which specification wrote `metadata`. A `tmap` payload is ISO 21496-1 by definition. */
	readonly standard: 'iso-21496-1';
}

export interface HeifImagePlan extends HeifPicturePlan {
	/** The EXIF payload from the TIFF header onwards, if the file carried one. */
	readonly exif?: Uint8Array;
	/**
	 * Whether the file carries an HDR gain map at all.
	 *
	 * True even where `gainMap` is absent, which is the case worth naming: the
	 * photograph is HDR and this reader could not get at the second picture.
	 * Returning the standard range base anyway is the right behaviour and the
	 * wrong surprise, so the two facts are reported separately.
	 */
	readonly hasGainMap: boolean;
	/** The gain map, where the file carried one this reader could resolve. */
	readonly gainMap?: HeifGainMapPlan;
}

interface GridDescriptor {
	readonly rows: number;
	readonly columns: number;
	readonly outputWidth: number;
	readonly outputHeight: number;
}

/** How a picture is named in the messages its plan throws. */
interface PictureSubject {
	readonly name: string;
	/** Where an item that is not in the item list gets reported from. */
	readonly absentStage: HeifStage;
}

/**
 * The auxiliary type urns that mark a picture as a gain map.
 *
 * Matched exactly rather than by substring. A recent iPhone hangs several
 * auxiliary pictures off one photograph and one of them, the style delta map,
 * has exactly the same shape as the gain map: a hidden, half sized grid with
 * an `auxl` reference back to the base. Anything looser than an exact match
 * eventually hands the tone mapper a picture of Apple's photographic styles
 * instead of the HDR gain, and both are grey rectangles.
 */
const GAIN_MAP_AUX_TYPES: readonly string[] = [
	'urn:com:apple:photo:2020:aux:hdrgainmap',
	'urn:iso:std:iso:ts:21496:-1',
];

function parseGrid(data: Uint8Array): GridDescriptor {
	const reader = new ByteReader(data, 'grid', 0, data.length);
	reader.u8(); // version
	const flags = reader.u8();
	const rows = reader.u8() + 1;
	const columns = reader.u8() + 1;
	const wide = (flags & 1) === 1;
	const outputWidth = wide ? reader.u32() : reader.u16();
	const outputHeight = wide ? reader.u32() : reader.u16();
	return { rows, columns, outputWidth, outputHeight };
}

/**
 * Whether an ICC profile describes Display P3.
 *
 * Compared against the profile's red primary rather than its description
 * string, because the description is free text that Apple has changed between
 * iOS releases. The red primary of P3 and of sRGB differ in the first decimal
 * place, so a loose tolerance is enough and there is nothing to tune.
 */
function iccLooksLikeP3(profile: Uint8Array): boolean {
	if (profile.length < 132) return false;
	const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
	const tagCount = view.getUint32(128);
	if (tagCount > 1024) return false;
	for (let i = 0; i < tagCount; i += 1) {
		const entry = 132 + i * 12;
		if (entry + 12 > profile.length) break;
		let signature = '';
		for (let c = 0; c < 4; c += 1) signature += String.fromCharCode(view.getUint8(entry + c));
		if (signature !== 'rXYZ') continue;
		const offset = view.getUint32(entry + 4);
		if (offset + 20 > profile.length) return false;
		// s15Fixed16 X of the red colourant. sRGB is about 0.4360, P3 about 0.5151.
		const x = view.getInt32(offset + 8) / 65536;
		return x > 0.48;
	}
	return false;
}

function colourSpaceOf(
	meta: HeifMeta,
	itemId: number,
): {
	colourSpace: ColourSpace;
	iccProfile?: Uint8Array;
} {
	const colr = itemProperty(meta, itemId, 'colr');
	if (!colr) return { colourSpace: 'srgb' };
	if (colr.type === 'nclx') {
		// ITU-T H.273 table 2. 12 is SMPTE EG 432-1, which is Display P3.
		return { colourSpace: colr.primaries === 12 ? 'display-p3' : 'srgb' };
	}
	const profile = colr.iccProfile;
	if (!profile) return { colourSpace: 'srgb' };
	return {
		colourSpace: iccLooksLikeP3(profile) ? 'display-p3' : 'srgb',
		iccProfile: profile,
	};
}

/**
 * The EXIF item attached to an image, if there is one.
 *
 * A HEIF Exif item begins with a four byte offset to the TIFF header, which is
 * almost always zero but is not guaranteed to be, so it is honoured rather
 * than skipped over.
 */
function exifFor(bytes: Uint8Array, meta: HeifMeta, itemId: number): Uint8Array | undefined {
	const described = meta.references.get('cdsc');
	if (!described) return undefined;
	for (const [from, to] of described) {
		if (!to.includes(itemId)) continue;
		const item = meta.items.get(from);
		if (item?.type !== 'Exif') continue;
		const payload = itemBytes(bytes, meta, from);
		if (payload.length < 4) return undefined;
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		const skip = 4 + view.getUint32(0);
		if (skip >= payload.length) return undefined;
		return payload.subarray(skip);
	}
	return undefined;
}

function orientationOf(meta: HeifMeta, itemId: number): Orientation {
	const rotation = itemProperty(meta, itemId, 'irot')?.rotation ?? 0;
	const mirror = itemProperty(meta, itemId, 'imir')?.mirror ?? 'none';
	if (rotation === 0 && mirror === 'none') {
		return { rotation: 0, mirror: 'none', source: 'none' };
	}
	return { rotation, mirror, source: 'heif-irot' };
}

/**
 * Build the plan for one picture item.
 *
 * `subject` names the picture in whatever this throws, because "the main image
 * has no decoder configuration" and "the gain map has no decoder
 * configuration" call for opposite reactions, and one sentence covering both
 * hides which happened.
 *
 * Handles a plain single-item image and a `grid` derived image. Everything
 * else, including overlays and identity derivations, is refused by name rather
 * than half-attempted.
 */
function planPicture(
	bytes: Uint8Array,
	meta: HeifMeta,
	itemId: number,
	subject: PictureSubject,
): HeifPicturePlan {
	const item = meta.items.get(itemId);
	if (!item) {
		throw new HeifMalformedError(subject.absentStage, `${subject.name} is not in the item list`);
	}

	// Each picture carries its own rotation and gets its own applied here. That
	// is what leaves a gain map lined up with its base without ever being
	// resized or turned twice: taking the base's rotation and applying it to
	// the gain map as well makes the two quarter turns of a portrait photograph
	// into a half turn, and the gain then lands on the wrong end of the frame.
	const orientation = orientationOf(meta, itemId);

	let tileIds: number[];
	let grid: GridDescriptor | undefined;

	if (item.type === 'grid') {
		const children = meta.references.get('dimg')?.get(itemId);
		if (!children || children.length === 0) {
			throw new HeifMalformedError('grid', `${subject.name} is a grid with no tiles`);
		}
		grid = parseGrid(itemBytes(bytes, meta, itemId));
		if (children.length !== grid.rows * grid.columns) {
			throw new HeifMalformedError(
				'grid',
				`${subject.name} claims ${grid.rows * grid.columns} tiles but lists ${children.length}`,
			);
		}
		tileIds = [...children];
	} else if (item.type === 'hvc1') {
		tileIds = [itemId];
	} else if (item.type === 'iovl') {
		throw new HeifUnsupportedFeatureError('iovl', 'an overlay of several images');
	} else if (item.type === 'iden') {
		throw new HeifUnsupportedFeatureError('iden', 'a derived image this reader does not follow');
	} else if (item.type === 'av01') {
		throw new HeifUnsupportedFeatureError('av01', 'AV1 rather than HEVC inside a HEIF container');
	} else {
		throw new HeifUnsupportedFeatureError(item.type, `an image of type "${item.type}"`);
	}

	const config = itemProperty(meta, tileIds[0] as number, 'hvcC');
	if (!config) {
		throw new HeifMalformedError(
			'decoder-config',
			`${subject.name} has no HEVC decoder configuration`,
		);
	}

	const firstExtent = itemProperty(meta, tileIds[0] as number, 'ispe');
	if (!firstExtent) {
		throw new HeifMalformedError('item-properties', `${subject.name} does not record its own size`);
	}

	const tiles: HeifTile[] = [];
	const columns = grid?.columns ?? 1;
	let canvasWidth = 0;
	let canvasHeight = 0;

	for (let index = 0; index < tileIds.length; index += 1) {
		const id = tileIds[index] as number;
		const extent = itemProperty(meta, id, 'ispe') ?? firstExtent;
		const column = index % columns;
		const row = Math.floor(index / columns);
		const x = column * firstExtent.width;
		const y = row * firstExtent.height;
		tiles.push({
			x,
			y,
			width: extent.width,
			height: extent.height,
			data: itemBytes(bytes, meta, id),
		});
		canvasWidth = Math.max(canvasWidth, x + extent.width);
		canvasHeight = Math.max(canvasHeight, y + extent.height);
	}

	// The grid's own output size is authoritative: tiles are padded out to a
	// whole number of tiles and the remainder has to be cropped away. Where
	// there is no grid, the item's ispe is the size.
	const width = grid?.outputWidth ?? firstExtent.width;
	const height = grid?.outputHeight ?? firstExtent.height;

	if (width > canvasWidth || height > canvasHeight) {
		throw new HeifMalformedError(
			'grid',
			`${subject.name} claims to be ${width} by ${height} but its tiles only cover ${canvasWidth} by ${canvasHeight}`,
		);
	}

	const quarterTurn = orientation.rotation === 90 || orientation.rotation === 270;
	const own = colourSpaceOf(meta, itemId);
	const colour = own.colourSpace === 'display-p3' ? own : colourSpaceOf(meta, tileIds[0] as number);

	return {
		canvasWidth,
		canvasHeight,
		width,
		height,
		displayWidth: quarterTurn ? height : width,
		displayHeight: quarterTurn ? width : height,
		orientation,
		colourSpace: colour.colourSpace,
		iccProfile: colour.iccProfile,
		tiles,
		config,
		codecString: hevcCodecString(config),
	};
}

/** Whether an item's auxiliary type marks it as a gain map. */
function isGainMapAuxiliary(meta: HeifMeta, itemId: number): boolean {
	const auxiliary = itemProperty(meta, itemId, 'auxC');
	return auxiliary !== undefined && GAIN_MAP_AUX_TYPES.includes(auxiliary.auxType);
}

/**
 * Find the gain map and plan it.
 *
 * `present` means the photograph is HDR. `plan` means the second picture can
 * actually be decoded. There are three ways for those to disagree, and each of
 * them is a file somebody owns rather than a hypothetical:
 *
 *   - Nothing anywhere. Both absent, and nothing gets reported, because a
 *     standard range photograph has lost nothing by being read as one.
 *   - A gain map picture carrying the Apple auxiliary urn, with no `tmap`
 *     item. That is the layout iOS wrote before ISO 21496-1 existed, and its
 *     parameters live in a proprietary block this reader does not read. The
 *     picture on its own is not usable: without the headroom it was graded for
 *     and the range of the gain, it is a grey rectangle of unknown meaning. So
 *     it is reported as present and dropped.
 *   - A `tmap` item whose picture will not plan, because it is in a codec this
 *     reader does not handle or the item is damaged. Present and dropped as
 *     well.
 *   - A `tmap` whose parameter block cannot be read, or whose `dimg` names
 *     anything other than the base and the gain map. Both are a container
 *     disagreeing with itself, and neither is recoverable: the pair is the
 *     entire meaning of the box, and choosing one of three children would be a
 *     guess handed back as a photograph.
 *
 * Nothing here throws. Every one of those is reported as present and dropped,
 * because the base is a perfectly good photograph and refusing to open it
 * because the second half of it is odd would be a worse answer than handing
 * back the standard range version. That is the whole policy, and it applies to
 * a damaged parameter block exactly as much as to a gain map in a codec this
 * reader cannot decode.
 */
function planGainMap(
	bytes: Uint8Array,
	meta: HeifMeta,
): { present: boolean; plan?: HeifGainMapPlan } {
	let toneMapped: number | undefined;
	for (const [id, item] of meta.items) {
		if (item.type === 'tmap') {
			toneMapped = id;
			break;
		}
	}

	if (toneMapped === undefined) {
		for (const id of meta.items.keys()) {
			if (isGainMapAuxiliary(meta, id)) return { present: true };
		}
		return { present: false };
	}

	const children = meta.references.get('dimg')?.get(toneMapped);
	if (!children || children.length !== 2) return { present: true };

	// An empty parameter block is the same situation as a missing one, and so
	// is one that cannot be reached: a truncated extent, an `iloc` entry that
	// is not there, a construction method this reader does not implement. In
	// every case there is nothing to say how the gain should be read, so the
	// picture beside it cannot be applied to anything, and the photograph
	// itself is untouched by any of it.
	let metadata: Uint8Array;
	try {
		metadata = itemBytes(bytes, meta, toneMapped);
	} catch (error) {
		if (error instanceof HeifMalformedError || error instanceof HeifUnsupportedFeatureError) {
			return { present: true };
		}
		throw error;
	}
	if (metadata.length === 0) return { present: true };

	// Second child, by position rather than by elimination. The order is what
	// the specification defines, and picking whichever child is not the primary
	// item would quietly do the wrong thing on a file whose tone mapped image
	// derives from a base that is not the primary.
	let picture: HeifPicturePlan;
	try {
		picture = planPicture(bytes, meta, children[1] as number, {
			name: 'the gain map',
			absentStage: 'item-info',
		});
	} catch (error) {
		if (error instanceof HeifMalformedError || error instanceof HeifUnsupportedFeatureError) {
			return { present: true };
		}
		throw error;
	}

	return { present: true, plan: { ...picture, metadata, standard: 'iso-21496-1' } };
}

/**
 * Build the decode plan for the primary image, and for the gain map beside it
 * where the file has one.
 */
export function planHeifImage(bytes: Uint8Array): HeifImagePlan {
	const meta = parseMeta(bytes);
	const primary = planPicture(bytes, meta, meta.primaryItemId, {
		name: 'the main image',
		absentStage: 'primary-item',
	});
	const gainMap = planGainMap(bytes, meta);

	return {
		...primary,
		exif: exifFor(bytes, meta, meta.primaryItemId),
		hasGainMap: gainMap.present,
		gainMap: gainMap.plan,
	};
}
