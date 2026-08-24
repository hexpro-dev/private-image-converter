/**
 * Resolve the primary image of a HEIF file into a plan a decoder can execute.
 *
 * The plan is pure data: tile positions and their compressed bytes, the decoder
 * configuration, the orientation to apply afterwards and the colour space the
 * numbers will be in. Nothing here calls a codec, so the hard part of HEIC
 * reading is testable without a browser.
 */

import { HeifMalformedError, HeifUnsupportedFeatureError } from '../errors.js';
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

export interface HeifImagePlan {
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
	/** The EXIF payload from the TIFF header onwards, if the file carried one. */
	readonly exif?: Uint8Array;
	/**
	 * Whether the file carries an HDR gain map that this reader is discarding.
	 *
	 * Recorded so the interface can say so. Silently returning the SDR base of
	 * an HDR photograph is the right behaviour and the wrong surprise.
	 */
	readonly hasGainMap: boolean;
}

interface GridDescriptor {
	readonly rows: number;
	readonly columns: number;
	readonly outputWidth: number;
	readonly outputHeight: number;
}

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
 * Build the decode plan for the primary image.
 *
 * Handles a plain single-item image and a `grid` derived image. Everything
 * else, including overlays and identity derivations, is refused by name rather
 * than half-attempted.
 */
export function planHeifImage(bytes: Uint8Array): HeifImagePlan {
	const meta = parseMeta(bytes);
	const primaryId = meta.primaryItemId;
	const primary = meta.items.get(primaryId);
	if (!primary) {
		throw new HeifMalformedError('primary-item', 'the main image is not in the item list');
	}

	const hasGainMap = [...meta.items.values()].some((item) => item.type === 'tmap');
	const orientation = orientationOf(meta, primaryId);
	const exif = exifFor(bytes, meta, primaryId);

	let tileIds: number[];
	let grid: GridDescriptor | undefined;

	if (primary.type === 'grid') {
		const children = meta.references.get('dimg')?.get(primaryId);
		if (!children || children.length === 0) {
			throw new HeifMalformedError('grid', 'the main image is a grid with no tiles');
		}
		grid = parseGrid(itemBytes(bytes, meta, primaryId));
		if (children.length !== grid.rows * grid.columns) {
			throw new HeifMalformedError(
				'grid',
				`the main image claims ${grid.rows * grid.columns} tiles but lists ${children.length}`,
			);
		}
		tileIds = [...children];
	} else if (primary.type === 'hvc1') {
		tileIds = [primaryId];
	} else if (primary.type === 'iovl') {
		throw new HeifUnsupportedFeatureError('iovl', 'an overlay of several images');
	} else if (primary.type === 'iden') {
		throw new HeifUnsupportedFeatureError('iden', 'a derived image this reader does not follow');
	} else if (primary.type === 'av01') {
		throw new HeifUnsupportedFeatureError('av01', 'AV1 rather than HEVC inside a HEIF container');
	} else {
		throw new HeifUnsupportedFeatureError(primary.type, `an image of type "${primary.type}"`);
	}

	const config = itemProperty(meta, tileIds[0] as number, 'hvcC');
	if (!config) {
		throw new HeifMalformedError('decoder-config', 'the image has no HEVC decoder configuration');
	}

	const firstExtent = itemProperty(meta, tileIds[0] as number, 'ispe');
	if (!firstExtent) {
		throw new HeifMalformedError('item-properties', 'the image does not record its own size');
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
			`the image claims to be ${width} by ${height} but its tiles only cover ${canvasWidth} by ${canvasHeight}`,
		);
	}

	const quarterTurn = orientation.rotation === 90 || orientation.rotation === 270;
	const colour =
		colourSpaceOf(meta, primaryId).colourSpace === 'display-p3'
			? colourSpaceOf(meta, primaryId)
			: colourSpaceOf(meta, tileIds[0] as number);

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
		exif,
		hasGainMap,
	};
}
