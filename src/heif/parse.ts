/**
 * The `meta` box: which items exist, where their bytes are, and what
 * properties they carry.
 *
 * This is a reader, not a decoder. Nothing here touches pixels, which is what
 * lets the whole of it run under Node in a unit test with no browser APIs at
 * all.
 */

import { HeifMalformedError } from '../errors.js';
import { ByteReader, findBox, readFullBoxHeader, walkBoxes } from './boxes.js';
import { parseProperty } from './properties.js';
import type { ItemProperty } from './properties.js';

export interface HeifItem {
	readonly id: number;
	/** Four character item type: `hvc1`, `grid`, `Exif`, `mime`, `iden`, ... */
	readonly type: string;
	readonly name: string;
	readonly contentType?: string;
	/** Set when the item is marked hidden, as thumbnails and gain maps are. */
	readonly hidden: boolean;
}

export interface ItemExtent {
	readonly offset: number;
	readonly length: number;
}

export interface ItemLocation {
	/**
	 * 0 means the extents are file offsets, 1 means they are offsets into the
	 * `idat` box.
	 *
	 * Method 1 is not an exotic case to handle later: it is where Apple puts
	 * the grid descriptor on every iPhone photo, so a reader that assumes
	 * method 0 reads eight bytes from the front of the file and concludes the
	 * image is zero by zero tiles.
	 */
	readonly constructionMethod: number;
	readonly extents: readonly ItemExtent[];
}

export interface HeifMeta {
	readonly primaryItemId: number;
	readonly items: ReadonlyMap<number, HeifItem>;
	readonly locations: ReadonlyMap<number, ItemLocation>;
	/** `ipco` children in order. `ipma` indices are one based into this. */
	readonly properties: readonly ItemProperty[];
	/** Item id to the one-based property indices it claims. */
	readonly associations: ReadonlyMap<number, readonly number[]>;
	/** Reference type to a map of referring item to referenced items. */
	readonly references: ReadonlyMap<string, ReadonlyMap<number, readonly number[]>>;
	readonly idat?: Uint8Array;
}

function parseItemInfo(bytes: Uint8Array, start: number, end: number): Map<number, HeifItem> {
	const items = new Map<number, HeifItem>();
	for (const box of walkBoxes(bytes, start, end, 'item-info')) {
		if (box.type !== 'infe') continue;
		const full = readFullBoxHeader(bytes, box, 'item-info');
		const reader = new ByteReader(bytes, 'item-info', full.bodyStart, box.end);
		if (full.version < 2) {
			// Versions 0 and 1 predate item types and only ever described
			// MIME-ish resources. Nothing that produces HEIC writes them.
			throw new HeifMalformedError(
				'item-info',
				`an infe box used version ${full.version}`,
				box.start,
			);
		}
		const id = full.version === 2 ? reader.u16() : reader.u32();
		reader.u16(); // item_protection_index
		const type = reader.ascii(4);
		const name = reader.cString();
		let contentType: string | undefined;
		if (type === 'mime') {
			contentType = reader.cString();
		} else if (type === 'uri ') {
			contentType = reader.cString();
		}
		items.set(id, { id, type, name, contentType, hidden: (full.flags & 1) === 1 });
	}
	return items;
}

function parseItemLocation(
	bytes: Uint8Array,
	box: { bodyStart: number; end: number; start: number },
): Map<number, ItemLocation> {
	const full = readFullBoxHeader(bytes, box as never, 'item-location');
	const reader = new ByteReader(bytes, 'item-location', full.bodyStart, box.end);
	const sizes = reader.u8();
	const offsetSize = sizes >> 4;
	const lengthSize = sizes & 0x0f;
	const sizes2 = reader.u8();
	const baseOffsetSize = sizes2 >> 4;
	const indexSize = full.version === 1 || full.version === 2 ? sizes2 & 0x0f : 0;
	const itemCount = full.version < 2 ? reader.u16() : reader.u32();

	const locations = new Map<number, ItemLocation>();
	for (let i = 0; i < itemCount; i += 1) {
		const id = full.version < 2 ? reader.u16() : reader.u32();
		let constructionMethod = 0;
		if (full.version === 1 || full.version === 2) {
			constructionMethod = reader.u16() & 0x0f;
		}
		reader.u16(); // data_reference_index
		const baseOffset = reader.uint(baseOffsetSize);
		const extentCount = reader.u16();
		const extents: ItemExtent[] = [];
		for (let e = 0; e < extentCount; e += 1) {
			if (indexSize > 0) reader.uint(indexSize);
			const offset = reader.uint(offsetSize);
			const length = reader.uint(lengthSize);
			extents.push({ offset: baseOffset + offset, length });
		}
		locations.set(id, { constructionMethod, extents });
	}
	return locations;
}

function parseProperties(
	bytes: Uint8Array,
	start: number,
	end: number,
): { properties: ItemProperty[]; associations: Map<number, number[]> } {
	const properties: ItemProperty[] = [];
	const associations = new Map<number, number[]>();

	for (const box of walkBoxes(bytes, start, end, 'item-properties')) {
		if (box.type === 'ipco') {
			for (const property of walkBoxes(bytes, box.bodyStart, box.end, 'item-properties')) {
				properties.push(parseProperty(bytes, property));
			}
		} else if (box.type === 'ipma') {
			const full = readFullBoxHeader(bytes, box, 'item-properties');
			const reader = new ByteReader(bytes, 'item-properties', full.bodyStart, box.end);
			const entryCount = reader.u32();
			for (let i = 0; i < entryCount; i += 1) {
				const id = full.version < 1 ? reader.u16() : reader.u32();
				const count = reader.u8();
				const indices: number[] = [];
				for (let a = 0; a < count; a += 1) {
					// The essential bit is deliberately discarded. This reader
					// refuses on the properties it cannot honour by name rather
					// than by trusting a file to mark them, because Apple marks
					// `irot` non-essential and dropping it turns every portrait
					// photograph on its side.
					indices.push(full.flags & 1 ? reader.u16() & 0x7fff : reader.u8() & 0x7f);
				}
				associations.set(id, indices);
			}
		}
	}
	return { properties, associations };
}

function parseItemReferences(
	bytes: Uint8Array,
	box: { bodyStart: number; end: number; start: number },
): Map<string, Map<number, number[]>> {
	const full = readFullBoxHeader(bytes, box as never, 'item-references');
	const references = new Map<string, Map<number, number[]>>();
	for (const entry of walkBoxes(bytes, full.bodyStart, box.end, 'item-references')) {
		const reader = new ByteReader(bytes, 'item-references', entry.bodyStart, entry.end);
		const from = full.version === 0 ? reader.u16() : reader.u32();
		const count = reader.u16();
		const to: number[] = [];
		for (let i = 0; i < count; i += 1) {
			to.push(full.version === 0 ? reader.u16() : reader.u32());
		}
		let byType = references.get(entry.type);
		if (!byType) {
			byType = new Map();
			references.set(entry.type, byType);
		}
		byType.set(from, to);
	}
	return references;
}

/** Parse the `meta` box of a HEIF file. */
export function parseMeta(bytes: Uint8Array): HeifMeta {
	const ftyp = findBox(bytes, 0, bytes.length, 'ftyp', 'ftyp');
	if (!ftyp) throw new HeifMalformedError('ftyp', 'the file does not start with an ftyp box', 0);

	const meta = findBox(bytes, 0, bytes.length, 'meta', 'meta');
	if (!meta) throw new HeifMalformedError('meta', 'the file has no meta box', 0);
	const metaFull = readFullBoxHeader(bytes, meta, 'meta');

	let primaryItemId = -1;
	let items = new Map<number, HeifItem>();
	let locations = new Map<number, ItemLocation>();
	let properties: ItemProperty[] = [];
	let associations = new Map<number, number[]>();
	let references = new Map<string, Map<number, number[]>>();
	let idat: Uint8Array | undefined;

	for (const box of walkBoxes(bytes, metaFull.bodyStart, meta.end, 'meta')) {
		switch (box.type) {
			case 'pitm': {
				const full = readFullBoxHeader(bytes, box, 'primary-item');
				const reader = new ByteReader(bytes, 'primary-item', full.bodyStart, box.end);
				primaryItemId = full.version === 0 ? reader.u16() : reader.u32();
				break;
			}
			case 'iinf': {
				const full = readFullBoxHeader(bytes, box, 'item-info');
				const reader = new ByteReader(bytes, 'item-info', full.bodyStart, box.end);
				// The entry count is read and discarded: walking the child
				// boxes is authoritative, and a file whose count disagrees with
				// its children is still readable.
				if (full.version === 0) reader.u16();
				else reader.u32();
				items = parseItemInfo(bytes, reader.offset, box.end);
				break;
			}
			case 'iloc':
				locations = parseItemLocation(bytes, box);
				break;
			case 'iprp': {
				const parsed = parseProperties(bytes, box.bodyStart, box.end);
				properties = parsed.properties;
				associations = parsed.associations;
				break;
			}
			case 'iref':
				references = parseItemReferences(bytes, box);
				break;
			case 'idat':
				idat = bytes.subarray(box.bodyStart, box.end);
				break;
			default:
				break;
		}
	}

	if (primaryItemId < 0) {
		throw new HeifMalformedError(
			'primary-item',
			'the file does not say which image is the main one',
		);
	}

	return { primaryItemId, items, locations, properties, associations, references, idat };
}

/** The bytes of one item, following its construction method. */
export function itemBytes(bytes: Uint8Array, meta: HeifMeta, id: number): Uint8Array {
	const location = meta.locations.get(id);
	if (!location) {
		throw new HeifMalformedError('item-location', `item ${id} has no recorded location`);
	}
	const source = location.constructionMethod === 1 ? meta.idat : bytes;
	if (!source) {
		throw new HeifMalformedError(
			'item-location',
			`item ${id} points into an idat box that is not there`,
		);
	}
	if (location.constructionMethod > 1) {
		throw new HeifMalformedError(
			'item-location',
			`item ${id} is built by reference to another item, which this reader does not follow`,
		);
	}

	if (location.extents.length === 1) {
		const only = location.extents[0] as ItemExtent;
		if (only.offset + only.length > source.length) {
			throw new HeifMalformedError(
				'tile-data',
				`item ${id} runs past the end of the file`,
				only.offset,
			);
		}
		return source.subarray(only.offset, only.offset + only.length);
	}

	let total = 0;
	for (const extent of location.extents) total += extent.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const extent of location.extents) {
		if (extent.offset + extent.length > source.length) {
			throw new HeifMalformedError(
				'tile-data',
				`item ${id} runs past the end of the file`,
				extent.offset,
			);
		}
		out.set(source.subarray(extent.offset, extent.offset + extent.length), at);
		at += extent.length;
	}
	return out;
}

/** The properties an item claims, resolved through `ipma`. */
export function itemProperties(meta: HeifMeta, id: number): ItemProperty[] {
	const indices = meta.associations.get(id) ?? [];
	const out: ItemProperty[] = [];
	for (const index of indices) {
		const property = meta.properties[index - 1];
		if (property) out.push(property);
	}
	return out;
}

/** The first property of a given kind an item claims. */
export function itemProperty<K extends ItemProperty['kind']>(
	meta: HeifMeta,
	id: number,
	kind: K,
): Extract<ItemProperty, { kind: K }> | undefined {
	for (const property of itemProperties(meta, id)) {
		if (property.kind === kind) return property as Extract<ItemProperty, { kind: K }>;
	}
	return undefined;
}
