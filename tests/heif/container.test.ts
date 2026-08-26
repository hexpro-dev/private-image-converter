import { describe, expect, it } from 'vitest';
import { assembleHeifImage } from '../../src/heif/assemble.js';
import { planHeifImage } from '../../src/heif/image.js';
import { itemBytes, itemProperty, parseMeta } from '../../src/heif/parse.js';
import { hevcCodecString } from '../../src/heif/properties.js';
import { HeifMalformedError, HeifUnsupportedFeatureError } from '../../src/errors.js';
import type { RasterImage } from '../../src/types.js';
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

/**
 * The colour `fakeTileDecoder` paints tile `index`.
 *
 * Restated rather than imported. Asking the helper what it had painted would
 * only show that the helper agrees with itself; what these tests have to state
 * is which tile owns a given pixel, and that comes from the grid arithmetic.
 */
function tileColour(index: number): readonly number[] {
	return [(index * 40) % 256, (index * 70) % 256, (index * 110) % 256, 255];
}

/**
 * Every pixel of `image` not carrying the colour of the tile that owns it.
 *
 * `sourceOf` maps a pixel of the finished image back to a position in the
 * unrotated grid, and is the identity where no orientation was applied. Written
 * as a description of the whole field rather than as a handful of sampled
 * corners, because a tile placed one row out, or a grid assembled at the padded
 * size and then cropped from the wrong origin, still puts the right colours in
 * the four corners.
 */
function misplaced(
	image: RasterImage,
	grid: { readonly tileSize: number; readonly columns: number },
	sourceOf: (x: number, y: number) => readonly [number, number] = (x, y) => [x, y],
): string[] {
	const wrong: string[] = [];
	for (let y = 0; y < image.height; y += 1) {
		for (let x = 0; x < image.width; x += 1) {
			const [sx, sy] = sourceOf(x, y);
			const index = Math.floor(sy / grid.tileSize) * grid.columns + Math.floor(sx / grid.tileSize);
			const at = (y * image.width + x) * 4;
			const found = [...image.data.slice(at, at + 4)];
			const wanted = tileColour(index);
			if (found.join() !== wanted.join()) {
				wrong.push(`(${x}, ${y}) is ${found.join()} and should be ${wanted.join()}`);
			}
		}
	}
	return wrong;
}

/**
 * Run `work` with the length of every `Uint8ClampedArray` allocated recorded.
 *
 * Blunt, and it has to be: what is under test is how many full sized buffers an
 * assembly allocates, and no output pixel can tell one buffer from three. The
 * proxy stands in for the global only for the duration of the call, and
 * `createRaster` reaches the global through the same lookup as everything else,
 * so nothing has to be injected into the code under test to see this.
 */
async function recordAllocations(work: () => Promise<unknown>): Promise<number[]> {
	const real = globalThis.Uint8ClampedArray;
	const sizes: number[] = [];
	globalThis.Uint8ClampedArray = new Proxy(real, {
		construct(target, args) {
			const made = Reflect.construct(target, args) as Uint8ClampedArray;
			sizes.push(made.length);
			return made;
		},
	});
	try {
		await work();
	} finally {
		globalThis.Uint8ClampedArray = real;
	}
	return sizes;
}

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

	it('allocates one raster at the cropped size and never one at the padded grid', async () => {
		// Three columns of 32 pixel tiles for an image 88 wide, two rows for one
		// 60 tall: the grid covers 96 by 64, and 864 of those pixels are padding
		// nobody asked for. Assembling into the padded size and cropping out of it
		// allocates 24576 bytes and then copies 21120 of them into a second
		// buffer, which is a 201 megabyte allocation plus a 195 megabyte copy at
		// the size a current phone photographs at.
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, tileSize: 32 }));
		expect([plan.canvasWidth, plan.canvasHeight]).toEqual([96, 64]);
		expect([plan.width, plan.height]).toEqual([88, 60]);

		let image: RasterImage | undefined;
		const sizes = await recordAllocations(async () => {
			image = await assembleHeifImage(plan, fakeTileDecoder());
		});

		// Six tiles of 32 by 32 from the fake decoder, then the image. A padded
		// grid shows up here as an extra 24576, and a crop that copies rather than
		// returning its input shows up as a second 21120.
		expect(sizes).toEqual([4096, 4096, 4096, 4096, 4096, 4096, 21120]);
		expect(image?.data.length).toBe(21120);
	});

	it('leaves the array the tile decoder returned untouched', async () => {
		// Tiles are released as they are consumed, and the array that gets its
		// slots emptied has to be one this package owns. A decoder is entitled to
		// hand back something frozen, or to keep using its array afterwards, and
		// clearing it under them would be a bug with no symptom until then.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, tileSize: 32 }));
		let returned: readonly (RasterImage | undefined)[] = [];
		await assembleHeifImage(plan, async (config, tiles, signal) => {
			const decoded = await fakeTileDecoder()(config, tiles, signal);
			returned = decoded;
			return Object.freeze(decoded);
		});
		expect(returned).toHaveLength(4);
		expect(returned.filter((tile) => tile === undefined)).toHaveLength(0);
	});

	it('drops a tile that falls outside the image and clips one that straddles the edge', async () => {
		// Three by three tiles of 32 for an image of 40 by 36. The right hand
		// column and the bottom row are outside it altogether, and the middle
		// column and middle row hang over its edge. Assembling at the padded size
		// hid all of this behind the crop; assembling at the image size means
		// `blit` has to do the clipping, and a tile at (64, 64) has to write
		// nothing at all rather than wrap onto the row below.
		const plan = planHeifImage(
			buildHeif({ columns: 3, rows: 3, tileSize: 32, width: 40, height: 36 }),
		);
		expect([plan.canvasWidth, plan.canvasHeight]).toEqual([96, 96]);

		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([40, 36]);
		expect(misplaced(image, { tileSize: 32, columns: 3 }).slice(0, 3)).toEqual([]);

		// Tiles 0, 1, 3 and 4 are the only ones any of this image can see, and
		// their reds are 0, 40, 120 and 160. A red of anything else is a tile
		// belonging off the edge having been written somewhere inside. A pixel
		// nothing wrote is zero in every channel, so it hides among tile 0's black
		// here and is caught by the alpha in `misplaced` above instead.
		const reds = new Set<number>();
		for (let i = 0; i < image.data.length; i += 4) reds.add(image.data[i] as number);
		expect([...reds].sort((a, b) => a - b)).toEqual([0, 40, 120, 160]);
	});

	it('places every tile correctly under a quarter turn', async () => {
		// The rotation tests above compare dimensions, which a quarter turn
		// applied to a wrongly assembled grid passes. This one says where each
		// pixel has to be: `irot` is anticlockwise, so the pixel at (x, y) of the
		// unrotated image lands at (y, width - 1 - x), and reading that backwards
		// gives the map below.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, tileSize: 32, rotation: 90 }));
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([60, 56]);
		expect(
			misplaced(image, { tileSize: 32, columns: 2 }, (x, y) => [55 - y, x]).slice(0, 3),
		).toEqual([]);
	});

	it('places every tile correctly under a mirror and a quarter turn together', async () => {
		// Mirrored horizontally and then turned a quarter anticlockwise, the two
		// maps compose into a transpose, which is a shape a wrong composition
		// cannot produce by accident.
		const plan = planHeifImage(
			buildHeif({ columns: 2, rows: 2, tileSize: 32, rotation: 90, mirror: 'horizontal' }),
		);
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([60, 56]);
		expect(misplaced(image, { tileSize: 32, columns: 2 }, (x, y) => [y, x]).slice(0, 3)).toEqual(
			[],
		);
	});

	it('assembles the gain map through the same path at its own size', async () => {
		// An HDR photograph goes through here twice, and the second picture is
		// about a quarter of the size and on a grid of its own. A base assembled
		// at the size of its own grid and a gain map assembled at the size of the
		// base's would line up for exactly as long as nobody looked.
		const plan = planHeifImage(
			buildHeif({
				columns: 3,
				rows: 2,
				tileSize: 64,
				gainMap: { columns: 2, rows: 2, tileSize: 16 },
			}),
		);
		const map = plan.gainMap;
		if (!map) throw new Error('the fixture should have planned a gain map');

		const base = await assembleHeifImage(plan, fakeTileDecoder());
		expect([base.width, base.height]).toEqual([184, 124]);
		expect(misplaced(base, { tileSize: 64, columns: 3 }).slice(0, 3)).toEqual([]);

		const gain = await assembleHeifImage(map, fakeTileDecoder());
		expect([gain.width, gain.height]).toEqual([32, 32]);
		expect(misplaced(gain, { tileSize: 16, columns: 2 }).slice(0, 3)).toEqual([]);
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
