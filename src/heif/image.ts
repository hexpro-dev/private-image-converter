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
 *
 * Transparency is a third picture on the same principle. A sticker, a
 * screenshot with rounded corners or an exported logo keeps its alpha as a
 * separate monochrome image, tied to the photograph by an `auxl` reference and
 * identified by the urn in its `auxC` property. It is planned by the same code
 * again, because the alpha plane of a grid is itself a grid, and a second
 * reader for it would be the grid arithmetic written twice.
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
	/**
	 * Whether the file hangs an alpha auxiliary image off the primary at all.
	 *
	 * Separate from `alphaAuxiliary` for the same reason `hasGainMap` is
	 * separate from `gainMap`: true here with nothing beside it means the
	 * picture is meant to be transparent and came out opaque, which is a
	 * sentence an interface can say. A file with no transparency in it sets
	 * neither and there is nothing to report.
	 */
	readonly hasAlphaAuxiliary: boolean;
	/** The alpha plane, where the file carried one this reader could resolve. */
	readonly alphaAuxiliary?: HeifPicturePlan;
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

/**
 * The auxiliary type urns that mark a picture as an alpha plane.
 *
 * The first is ISO/IEC 23008-12 clause 6.10.2, "Alpha plane", which requires
 * the `auxC` urn of a HEVC coded alpha auxiliary to be the auxId 1 name from
 * ISO/IEC 23008-2 Annex F. The second is ISO/IEC 23000-22 (MIAF) clause
 * 7.3.5.2, which is what newer writers and every AVIF use. A file carries one
 * or the other, nothing downstream cares which, so both are accepted.
 *
 * Matched exactly, never by prefix. `urn:mpeg:hevc:2015:auxid:2` is a depth
 * map: same family, same shape, same grey rectangle, and multiplying a
 * photograph's coverage by a depth map produces a picture that fades out with
 * distance and throws nothing anywhere.
 */
const ALPHA_AUX_TYPES: readonly string[] = [
	'urn:mpeg:hevc:2015:auxid:1',
	'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha',
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

interface Colourant {
	/** The tag signature that holds it. */
	readonly tag: string;
	/** Media-relative X, Y and Z, in that order. */
	readonly xyz: readonly [number, number, number];
}

/**
 * Display P3's colourants, as an ICC profile records them.
 *
 * Against the D50 profile connection space, because that is what ICC requires
 * of an `XYZType` colourant tag. These are therefore the Bradford adapted
 * numbers out of Apple's published profile, not the D65 matrix a colour
 * science table prints, and the difference between the two is about 0.03 in
 * red's X, which is larger than the tolerance below.
 */
const DISPLAY_P3_COLOURANTS: readonly Colourant[] = [
	{ tag: 'rXYZ', xyz: [0.51512, 0.2416, -0.00105] },
	{ tag: 'gXYZ', xyz: [0.29197, 0.69224, 0.04189] },
	{ tag: 'bXYZ', xyz: [0.1571, 0.06606, 0.78407] },
];

/**
 * How far a colourant may sit from P3's and still count as P3.
 *
 * Room for the s15Fixed16 rounding and for the small disagreements between
 * vendors' adaptation matrices, and well inside the gap to anything else that
 * ships: sRGB's red colourant is 0.079 below P3's in X and Adobe RGB's is
 * 0.095 above it. Widening this is how the bug below comes back.
 */
const COLOURANT_TOLERANCE = 0.02;

/**
 * Whether an ICC profile describes Display P3.
 *
 * A near copy of `iccIsWideGamut` in `src/metadata/icc.ts`, which is not an
 * oversight: `eslint.config.js` forbids `src/heif/**` from importing
 * `src/metadata/**` so the container reader stays liftable into a package of
 * its own, and nine numbers duplicated is cheaper than the parser acquiring a
 * dependency on the metadata layer. The two must answer identically, a test
 * imports both and compares them, so neither is changed without the other.
 *
 * All three primaries are checked rather than only red, and that is the whole
 * point of the shape. Deciding from red's X alone means any threshold that
 * admits P3 also admits Adobe RGB, ProPhoto and Rec.2020, whose reds all sit
 * further out again. Those files then get P3 pixels written under a profile
 * that says something else, which is the exact failure this predicate exists
 * to prevent, in the direction nobody notices until the image is on a wide
 * gamut screen.
 *
 * A profile that is not quite any of these reads as false, and false is the
 * safe answer: the picture is then treated as sRGB and left alone, whereas a
 * wrong true converts numbers that were already right.
 */
export function iccIsWideGamut(profile: Uint8Array): boolean {
	if (profile.length < 132) return false;
	const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
	const tagCount = view.getUint32(128);
	// A plausible profile has a handful of tags. A four billion tag count means
	// this is not a profile at all.
	if (tagCount === 0 || tagCount > 1024) return false;

	let matched = 0;
	for (let i = 0; i < tagCount; i += 1) {
		const entry = 132 + i * 12;
		if (entry + 12 > profile.length) break;
		let signature = '';
		for (let c = 0; c < 4; c += 1) signature += String.fromCharCode(view.getUint8(entry + c));
		const expected = DISPLAY_P3_COLOURANTS.find((colourant) => colourant.tag === signature);
		if (!expected) continue;
		const offset = view.getUint32(entry + 4);
		// An XYZType tag is its signature, four reserved bytes, then s15Fixed16
		// X, Y and Z.
		if (offset + 20 > profile.length) return false;
		for (let axis = 0; axis < 3; axis += 1) {
			const value = view.getInt32(offset + 8 + axis * 4) / 65536;
			if (Math.abs(value - expected.xyz[axis]) > COLOURANT_TOLERANCE) return false;
		}
		matched += 1;
	}
	// Every one of them, so a profile carrying a P3 red beside somebody else's
	// green is not read as P3 on the strength of the half that matched.
	return matched === DISPLAY_P3_COLOURANTS.length;
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
		colourSpace: iccIsWideGamut(profile) ? 'display-p3' : 'srgb',
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

/** Whether an item's auxiliary type marks it as an alpha plane. */
function isAlphaAuxiliary(meta: HeifMeta, itemId: number): boolean {
	const auxiliary = itemProperty(meta, itemId, 'auxC');
	return auxiliary !== undefined && ALPHA_AUX_TYPES.includes(auxiliary.auxType);
}

/**
 * Find the alpha plane and plan it.
 *
 * The reference runs from the auxiliary to the picture it belongs to, which is
 * the direction ISO/IEC 23008-12 defines for `auxl` and the opposite of the
 * one a reader tends to assume, so the search is over the referring items
 * rather than over the primary's own references. A photograph can hang several
 * auxiliaries off itself at once, an iPhone routinely does, and the gain map
 * is one of them: the `auxC` urn is the only thing that tells them apart, so
 * it is checked before the item is planned rather than after.
 *
 * `present` means the file meant this picture to be transparent. `plan` means
 * the plane can actually be decoded. They disagree when the plane is a codec
 * or a derivation this reader does not follow, when its item is damaged, or
 * when it does not measure the same as the picture it covers. None of those
 * throws. The photograph underneath is complete and refusing it because its
 * transparency is odd would be the same mistake a damaged gain map once caused
 * here, where one wrong length field in the second half of a file stopped the
 * first half being read at all.
 *
 * The size rule is a refusal rather than a resize on purpose. An alpha plane
 * is coverage, not colour: it is stored at the picture's own size by every
 * writer, and a plane that is not that size means the reader has found the
 * wrong item or the file disagrees with itself. Stretching it to fit would put
 * the holes in the wrong places and there would be nothing to say so.
 */
function planAlphaAuxiliary(
	bytes: Uint8Array,
	meta: HeifMeta,
	primary: HeifPicturePlan,
): { present: boolean; plan?: HeifPicturePlan } {
	const auxiliaries = meta.references.get('auxl');
	if (!auxiliaries) return { present: false };

	let itemId: number | undefined;
	for (const [from, to] of auxiliaries) {
		if (to.includes(meta.primaryItemId) && isAlphaAuxiliary(meta, from)) {
			itemId = from;
			break;
		}
	}
	if (itemId === undefined) return { present: false };

	let plan: HeifPicturePlan;
	try {
		plan = planPicture(bytes, meta, itemId, {
			name: 'the transparency',
			absentStage: 'item-info',
		});
	} catch (error) {
		if (error instanceof HeifMalformedError || error instanceof HeifUnsupportedFeatureError) {
			return { present: true };
		}
		throw error;
	}

	// Compared after orientation, because each item carries its own `irot` and
	// a plane that matches the picture only once both have been turned is still
	// the right plane.
	if (plan.displayWidth !== primary.displayWidth || plan.displayHeight !== primary.displayHeight) {
		return { present: true };
	}
	return { present: true, plan };
}

/**
 * Build the decode plan for the primary image, and for the gain map and alpha
 * plane beside it where the file has them.
 */
export function planHeifImage(bytes: Uint8Array): HeifImagePlan {
	const meta = parseMeta(bytes);
	const primary = planPicture(bytes, meta, meta.primaryItemId, {
		name: 'the main image',
		absentStage: 'primary-item',
	});
	const gainMap = planGainMap(bytes, meta);
	const alpha = planAlphaAuxiliary(bytes, meta, primary);

	return {
		...primary,
		exif: exifFor(bytes, meta, meta.primaryItemId),
		hasGainMap: gainMap.present,
		gainMap: gainMap.plan,
		hasAlphaAuxiliary: alpha.present,
		alphaAuxiliary: alpha.plan,
	};
}
