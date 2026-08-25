import { describe, expect, it } from 'vitest';
import { assembleHeifImage } from '../../src/heif/assemble.js';
import { planHeifImage } from '../../src/heif/image.js';
import { itemBytes, itemProperty, parseMeta } from '../../src/heif/parse.js';
import { hevcCodecString } from '../../src/heif/properties.js';
import { HeifMalformedError, HeifUnsupportedFeatureError } from '../../src/errors.js';
import { SAMPLE_HVCC, buildHeif, fakeTileDecoder } from '../helpers/heif.js';

describe('the meta box', () => {
	it('finds the primary item and its tiles', () => {
		const meta = parseMeta(buildHeif({ columns: 3, rows: 2 }));
		expect(meta.primaryItemId).toBe(1);
		expect(meta.items.get(1)?.type).toBe('grid');
		expect(meta.references.get('dimg')?.get(1)).toHaveLength(6);
	});

	it('reads the grid descriptor out of idat, not out of the file', () => {
		// Construction method 1 means the extent is an offset into the idat
		// box. A reader that assumes method 0 reads from the front of the file
		// instead and sees a version and flags where the row count should be.
		const bytes = buildHeif({ columns: 4, rows: 3, tileSize: 64 });
		const meta = parseMeta(bytes);
		expect(meta.locations.get(1)?.constructionMethod).toBe(1);
		const descriptor = itemBytes(bytes, meta, 1);
		expect(descriptor[2]).toBe(2); // rows minus one
		expect(descriptor[3]).toBe(3); // columns minus one
	});

	it('associates properties by their one-based index', () => {
		const meta = parseMeta(buildHeif({ rotation: 90 }));
		expect(itemProperty(meta, 1, 'irot')?.rotation).toBe(90);
		expect(itemProperty(meta, 2, 'hvcC')?.raw).toEqual(SAMPLE_HVCC);
		// The rotation belongs to the grid, never to a tile.
		expect(itemProperty(meta, 2, 'irot')).toBeUndefined();
	});

	it('refuses a file with no ftyp box', () => {
		const bytes = buildHeif();
		expect(() => parseMeta(bytes.subarray(24))).toThrow(HeifMalformedError);
	});

	it('refuses a truncated file rather than returning nonsense', () => {
		const bytes = buildHeif({ columns: 2, rows: 2 });
		expect(() => parseMeta(bytes.subarray(0, 60))).toThrow(HeifMalformedError);
	});
});

describe('the decode plan', () => {
	it('pads the canvas to whole tiles and crops back to the real size', () => {
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, tileSize: 64 }));
		expect(plan.canvasWidth).toBe(192);
		expect(plan.canvasHeight).toBe(128);
		expect(plan.width).toBe(184);
		expect(plan.height).toBe(124);
		expect(plan.tiles).toHaveLength(6);
	});

	it('places tiles in row-major order', () => {
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, tileSize: 64 }));
		expect(plan.tiles.map((tile) => [tile.x, tile.y])).toEqual([
			[0, 0],
			[64, 0],
			[128, 0],
			[0, 64],
			[64, 64],
			[128, 64],
		]);
	});

	it.each([
		[0, 184, 124],
		[180, 184, 124],
		[90, 124, 184],
		[270, 124, 184],
	] as const)('reports display size for a rotation of %i degrees', (rotation, width, height) => {
		// A quarter turn swaps the dimensions. Getting this wrong is not
		// cosmetic: every portrait photograph from a phone is stored landscape
		// with a rotation beside it, so a reader that ignores this produces a
		// sideways image for the most common input there is.
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, rotation }));
		expect(plan.displayWidth).toBe(width);
		expect(plan.displayHeight).toBe(height);
	});

	it('handles a single untiled image', () => {
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, tileSize: 64 }));
		expect(plan.tiles).toHaveLength(1);
		expect(plan.width).toBe(56);
	});

	it('reads Display P3 from the colour property', () => {
		expect(planHeifImage(buildHeif({ primaries: 12 })).colourSpace).toBe('display-p3');
		expect(planHeifImage(buildHeif({ primaries: 1 })).colourSpace).toBe('srgb');
	});

	it('notices a gain map without failing on it', () => {
		// The right behaviour is to plan the standard range base and record that
		// the second picture is there. Refusing the file would refuse every HDR
		// photograph a recent iPhone takes, which is all of them.
		expect(planHeifImage(buildHeif({ gainMap: {} })).hasGainMap).toBe(true);
		expect(planHeifImage(buildHeif({})).hasGainMap).toBe(false);
	});

	it('extracts the EXIF payload past its offset header', () => {
		const exif = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0]);
		const plan = planHeifImage(buildHeif({ exif }));
		expect(plan.exif).toEqual(exif);
	});

	it('builds a codec string the shape a decoder expects', () => {
		const plan = planHeifImage(buildHeif());
		expect(plan.codecString).toMatch(/^hvc1\.\d+\.[0-9a-f]+\.[LH]\d+/);
	});

	it('refuses a grid whose tiles do not cover it', () => {
		expect(() => planHeifImage(buildHeif({ underCoveredGrid: true }))).toThrow(HeifMalformedError);
	});
});

describe('assembly', () => {
	it('composites tiles, crops the padding and applies the rotation', async () => {
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, tileSize: 64 }));
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([120, 124]);
		// Tile 0 is black and occupies the top left of the unrotated image.
		expect([...image.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
	});

	it('rotates a quarter turn anticlockwise, swapping the dimensions', async () => {
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, tileSize: 64, rotation: 90 }));
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([124, 120]);
	});

	it('refuses a tile decoder that returns the wrong number of tiles', async () => {
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2 }));
		await expect(assembleHeifImage(plan, async () => [])).rejects.toThrow(/tiles/);
	});
});

describe('refusals', () => {
	it('names an AV1 payload rather than handing it to an HEVC decoder', () => {
		// An AVIF is also mif1 compatible, so a reader that recognises the
		// brand but not the payload feeds AV1 to an HEVC decoder and reports a
		// corrupt file.
		const patched = Uint8Array.from(buildHeif({ columns: 1, rows: 1 }));
		const marker = new TextEncoder().encode('hvc1');
		for (let i = 0; i < patched.length - 4; i += 1) {
			if (
				patched[i] === marker[0] &&
				patched[i + 1] === marker[1] &&
				patched[i + 2] === marker[2] &&
				patched[i + 3] === marker[3]
			) {
				patched.set(new TextEncoder().encode('av01'), i);
				break;
			}
		}
		expect(() => planHeifImage(patched)).toThrow(HeifUnsupportedFeatureError);
	});
});

describe('the codec string', () => {
	it('reverses the compatibility bits, as the specification requires', () => {
		// Written most significant bit first would give a different string, and
		// a browser rejects it, which reads as "this machine has no HEVC" rather
		// than as the bug it is.
		const config = {
			kind: 'hvcC' as const,
			raw: new Uint8Array(0),
			profileSpace: 0,
			tierFlag: 0,
			profileIdc: 1,
			profileCompatibilityFlags: 0x60000000,
			constraintFlags: Uint8Array.from([0xb0, 0, 0, 0, 0, 0]),
			levelIdc: 93,
			lengthSize: 4,
			parameterSets: [],
		};
		expect(hevcCodecString(config)).toBe('hvc1.1.6.L93.B0');
	});

	it('marks a high tier and a profile space', () => {
		const config = {
			kind: 'hvcC' as const,
			raw: new Uint8Array(0),
			profileSpace: 1,
			tierFlag: 1,
			profileIdc: 2,
			profileCompatibilityFlags: 0,
			constraintFlags: new Uint8Array(6),
			levelIdc: 120,
			lengthSize: 4,
			parameterSets: [],
		};
		expect(hevcCodecString(config)).toBe('hvc1.A2.0.H120');
	});
});
