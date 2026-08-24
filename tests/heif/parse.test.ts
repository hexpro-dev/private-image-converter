import { describe, expect, it } from 'vitest';
import { itemBytes, itemProperties, itemProperty, parseMeta } from '../../src/heif/parse.js';
import { HeifMalformedError } from '../../src/errors.js';
import { ascii, box, concat, fullBox, u16, u32, u8 } from '../helpers/heif.js';

/**
 * Assemble a file around a hand-built `meta` box.
 *
 * The container builder in the helpers writes one shape of file, which is the
 * shape Apple writes. These tests are about the shapes it does not: older
 * `iloc` versions, wider identifier fields, several extents per item. Building
 * the box directly is the only way to reach them.
 */
function file(...metaChildren: Uint8Array[]): Uint8Array {
	const ftyp = box('ftyp', ascii('heic'), u32(0), ascii('mif1'));
	return concat([ftyp, fullBox('meta', 0, 0, ...metaChildren)]);
}

const HDLR = fullBox('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), u8(0));

function iinf(...infes: Uint8Array[]): Uint8Array {
	return fullBox('iinf', 0, 0, u16(infes.length), ...infes);
}

function infe(id: number, type: string, version = 2, flags = 0): Uint8Array {
	const idBytes = version === 2 ? u16(id) : u32(id);
	return fullBox('infe', version, flags, idBytes, u16(0), ascii(type), u8(0));
}

describe('the primary item', () => {
	it('reads a 16 bit identifier at version 0 and a 32 bit one at version 1', () => {
		// The width changes with the version. Reading the wrong one leaves the
		// primary item pointing at something that is not there.
		const narrow = file(HDLR, fullBox('pitm', 0, 0, u16(0x1234)), iinf(infe(0x1234, 'hvc1')));
		expect(parseMeta(narrow).primaryItemId).toBe(0x1234);

		const wide = file(HDLR, fullBox('pitm', 1, 0, u32(0x00012345)), iinf(infe(0x2345, 'hvc1')));
		expect(parseMeta(wide).primaryItemId).toBe(0x12345);
	});

	it('refuses a file that never says which image is the main one', () => {
		expect(() => parseMeta(file(HDLR, iinf(infe(1, 'hvc1'))))).toThrow(HeifMalformedError);
	});

	it('refuses a file with no meta box at all', () => {
		expect(() => parseMeta(box('ftyp', ascii('heic')))).toThrow(HeifMalformedError);
	});
});

describe('item information', () => {
	it('records the type, the name and the hidden flag', () => {
		// A thumbnail and a gain map are both marked hidden, which is how they
		// are told apart from the picture somebody actually wants.
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1', 2, 0), infe(2, 'hvc1', 2, 1)),
		);
		const meta = parseMeta(bytes);
		expect(meta.items.get(1)?.hidden).toBe(false);
		expect(meta.items.get(2)?.hidden).toBe(true);
		expect(meta.items.get(1)?.type).toBe('hvc1');
	});

	it('reads a 32 bit identifier at infe version 3', () => {
		const bytes = file(HDLR, fullBox('pitm', 1, 0, u32(70000)), iinf(infe(70000, 'hvc1', 3)));
		expect(parseMeta(bytes).items.get(70000)?.type).toBe('hvc1');
	});

	it('reads the content type of a mime item', () => {
		const entry = fullBox(
			'infe',
			2,
			0,
			u16(9),
			u16(0),
			ascii('mime'),
			u8(0),
			ascii('application/rdf+xml'),
			u8(0),
		);
		const bytes = file(HDLR, fullBox('pitm', 0, 0, u16(9)), iinf(entry));
		expect(parseMeta(bytes).items.get(9)?.contentType).toBe('application/rdf+xml');
	});

	it('reads the uri of a uri item, which is how Apple tags its photo styles', () => {
		const uri = 'urn:com.apple.photo:2023:styles';
		const entry = fullBox('infe', 2, 0, u16(9), u16(0), ascii('uri '), u8(0), ascii(uri), u8(0));
		const bytes = file(HDLR, fullBox('pitm', 0, 0, u16(9)), iinf(entry));
		expect(parseMeta(bytes).items.get(9)?.contentType).toBe(uri);
	});

	it('refuses an infe older than version 2, which predates item types', () => {
		// Nothing that produces HEIC writes one, and guessing a type for it
		// would mean guessing what the item is.
		const bytes = file(HDLR, fullBox('pitm', 0, 0, u16(1)), iinf(infe(1, 'hvc1', 1)));
		expect(() => parseMeta(bytes)).toThrow(HeifMalformedError);
	});
});

describe('item locations', () => {
	/** An `iloc` with the field widths packed the way the format specifies. */
	function iloc(
		version: number,
		widths: { offset: number; length: number; base: number; index: number },
		entries: Uint8Array[],
	): Uint8Array {
		const count = version < 2 ? u16(entries.length) : u32(entries.length);
		return fullBox(
			'iloc',
			version,
			0,
			u8((widths.offset << 4) | widths.length),
			u8((widths.base << 4) | widths.index),
			count,
			...entries,
		);
	}

	it('reads a version 0 entry, which has no construction method', () => {
		// Version 0 has no method field at all, so a reader that expects one
		// consumes the data reference index and every field after it shifts.
		const entry = concat([u16(1), u16(0), u16(1), u32(100), u32(4)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			iloc(0, { offset: 4, length: 4, base: 0, index: 0 }, [entry]),
		);
		const location = parseMeta(bytes).locations.get(1);
		expect(location?.constructionMethod).toBe(0);
		expect(location?.extents).toEqual([{ offset: 100, length: 4 }]);
	});

	it('reads a version 2 entry, whose identifiers and count are 32 bit', () => {
		const entry = concat([u32(70000), u16(0), u16(0), u16(1), u32(8), u32(2)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 1, 0, u32(70000)),
			iinf(infe(70000, 'hvc1', 3)),
			iloc(2, { offset: 4, length: 4, base: 0, index: 0 }, [entry]),
		);
		expect(parseMeta(bytes).locations.get(70000)?.extents[0]).toEqual({ offset: 8, length: 2 });
	});

	it('adds the base offset to every extent', () => {
		// The base is a shared prefix, so an extent offset is relative to it.
		// Ignoring it reads from the front of the file instead.
		const entry = concat([u16(1), u16(0), u16(0), u32(1000), u16(1), u32(24), u32(4)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			iloc(1, { offset: 4, length: 4, base: 4, index: 0 }, [entry]),
		);
		expect(parseMeta(bytes).locations.get(1)?.extents[0]?.offset).toBe(1024);
	});

	it('steps over an extent index when the file declares one', () => {
		const entry = concat([u16(1), u16(0), u16(0), u16(1), u16(7), u32(40), u32(4)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			iloc(1, { offset: 4, length: 4, base: 0, index: 2 }, [entry]),
		);
		expect(parseMeta(bytes).locations.get(1)?.extents[0]).toEqual({ offset: 40, length: 4 });
	});

	it('joins several extents into one payload, in the order listed', () => {
		// An item split across the file. Concatenating them out of order or
		// returning only the first yields a bitstream that decodes to nothing.
		const header = concat([
			file(
				HDLR,
				fullBox('pitm', 0, 0, u16(1)),
				iinf(infe(1, 'hvc1')),
				fullBox(
					'iloc',
					1,
					0,
					u8(0x44),
					u8(0x00),
					u16(1),
					concat([u16(1), u16(0), u16(0), u16(2), u32(0), u32(0), u32(0), u32(0)]),
				),
			),
		]);
		// Rebuild with real offsets now that the header length is known.
		const payloadA = u8(0xaa, 0xbb);
		const payloadB = u8(0xcc);
		const base = header.length + 8;
		const bytes = concat([
			file(
				HDLR,
				fullBox('pitm', 0, 0, u16(1)),
				iinf(infe(1, 'hvc1')),
				fullBox(
					'iloc',
					1,
					0,
					u8(0x44),
					u8(0x00),
					u16(1),
					concat([u16(1), u16(0), u16(0), u16(2), u32(base), u32(2), u32(base + 2), u32(1)]),
				),
			),
			box('mdat', payloadA, payloadB),
		]);
		expect([...itemBytes(bytes, parseMeta(bytes), 1)]).toEqual([0xaa, 0xbb, 0xcc]);
	});

	it('refuses a construction method it does not follow', () => {
		// Method 2 builds an item by reference to another item. Returning the
		// raw bytes for one would hand a decoder something that is not a
		// bitstream at all.
		const entry = concat([u16(1), u16(2), u16(0), u16(1), u32(0), u32(4)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			iloc(1, { offset: 4, length: 4, base: 0, index: 0 }, [entry]),
		);
		expect(() => itemBytes(bytes, parseMeta(bytes), 1)).toThrow(HeifMalformedError);
	});

	it('refuses an extent that runs past the end of the file', () => {
		const entry = concat([u16(1), u16(0), u16(0), u16(1), u32(10), u32(99999)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			iloc(1, { offset: 4, length: 4, base: 0, index: 0 }, [entry]),
		);
		expect(() => itemBytes(bytes, parseMeta(bytes), 1)).toThrow(HeifMalformedError);
	});

	it('refuses an item with no recorded location', () => {
		const bytes = file(HDLR, fullBox('pitm', 0, 0, u16(1)), iinf(infe(1, 'hvc1')));
		expect(() => itemBytes(bytes, parseMeta(bytes), 1)).toThrow(HeifMalformedError);
	});

	it('refuses an idat reference in a file with no idat box', () => {
		const entry = concat([u16(1), u16(1), u16(0), u16(1), u32(0), u32(4)]);
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'grid')),
			iloc(1, { offset: 4, length: 4, base: 0, index: 0 }, [entry]),
		);
		expect(() => itemBytes(bytes, parseMeta(bytes), 1)).toThrow(HeifMalformedError);
	});
});

describe('item references', () => {
	it('reads 32 bit identifiers at version 1', () => {
		// Apple writes version 0, but a file with more than 65535 items has to
		// use version 1 and a reader that assumes otherwise mangles the graph.
		const dimg = box('dimg', u32(1), u16(2), u32(2), u32(3));
		const bytes = file(
			HDLR,
			fullBox('pitm', 1, 0, u32(1)),
			iinf(infe(1, 'grid', 3), infe(2, 'hvc1', 3), infe(3, 'hvc1', 3)),
			fullBox('iref', 1, 0, dimg),
		);
		expect(parseMeta(bytes).references.get('dimg')?.get(1)).toEqual([2, 3]);
	});

	it('keeps each reference type in its own map', () => {
		const bytes = file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1'), infe(2, 'hvc1'), infe(3, 'Exif')),
			fullBox(
				'iref',
				0,
				0,
				box('thmb', u16(2), u16(1), u16(1)),
				box('cdsc', u16(3), u16(1), u16(1)),
			),
		);
		const meta = parseMeta(bytes);
		expect(meta.references.get('thmb')?.get(2)).toEqual([1]);
		expect(meta.references.get('cdsc')?.get(3)).toEqual([1]);
	});
});

describe('property associations', () => {
	function withAssociations(version: number, flags: number, body: Uint8Array): Uint8Array {
		const ipco = box('ipco', fullBox('ispe', 0, 0, u32(8), u32(8)), box('irot', u8(1)));
		return file(
			HDLR,
			fullBox('pitm', 0, 0, u16(1)),
			iinf(infe(1, 'hvc1')),
			box('iprp', ipco, fullBox('ipma', version, flags, u32(1), body)),
		);
	}

	it('reads a one byte index when the wide flag is clear', () => {
		const meta = parseMeta(withAssociations(0, 0, concat([u16(1), u8(2), u8(0x81, 0x02)])));
		expect(itemProperties(meta, 1).map((p) => p.kind)).toEqual(['ispe', 'irot']);
	});

	it('reads a two byte index when the wide flag is set', () => {
		// The essential bit lives in the top bit of whichever width is in use,
		// so masking the wrong number of bits turns index 1 into index 129.
		const meta = parseMeta(
			withAssociations(0, 1, concat([u16(1), u8(2), u16(0x8001), u16(0x0002)])),
		);
		expect(itemProperties(meta, 1).map((p) => p.kind)).toEqual(['ispe', 'irot']);
	});

	it('reads a 32 bit item identifier at version 1', () => {
		const ipco = box('ipco', box('irot', u8(2)));
		const bytes = file(
			HDLR,
			fullBox('pitm', 1, 0, u32(70000)),
			iinf(infe(70000, 'hvc1', 3)),
			box('iprp', ipco, fullBox('ipma', 1, 0, u32(1), concat([u32(70000), u8(1), u8(1)]))),
		);
		expect(itemProperty(parseMeta(bytes), 70000, 'irot')?.rotation).toBe(180);
	});

	it('ignores an association pointing at a property that is not there', () => {
		// A dishonest index must not become an undefined in the property list,
		// because every caller then has to guard a lookup that should not fail.
		const meta = parseMeta(withAssociations(0, 0, concat([u16(1), u8(2), u8(0x01, 0x7f)])));
		expect(itemProperties(meta, 1).map((p) => p.kind)).toEqual(['ispe']);
	});

	it('returns undefined for a property an item does not claim', () => {
		const meta = parseMeta(withAssociations(0, 0, concat([u16(1), u8(1), u8(0x01)])));
		expect(itemProperty(meta, 1, 'hvcC')).toBeUndefined();
		expect(itemProperties(meta, 999)).toEqual([]);
	});
});
