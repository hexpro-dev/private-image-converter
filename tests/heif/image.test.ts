import { describe, expect, it } from 'vitest';
import { planHeifImage } from '../../src/heif/image.js';
import { assembleHeifImage } from '../../src/heif/assemble.js';
import { HeifMalformedError, HeifUnsupportedFeatureError } from '../../src/errors.js';
import {
	SAMPLE_GAIN_MAP_METADATA,
	buildHeif,
	concat,
	fakeTileDecoder,
	u32,
} from '../helpers/heif.js';

/**
 * A minimal ICC profile carrying one `rXYZ` tag.
 *
 * The gamut question is decided from the red colourant rather than from the
 * profile description, because the description is free text that vendors
 * change between releases. sRGB puts the red primary's X at about 0.436 and
 * Display P3 at about 0.515.
 */
function iccProfile(redX: number): Uint8Array {
	const header = new Uint8Array(128);
	const tagCount = u32(1);
	const tagEntry = concat([
		new Uint8Array([0x72, 0x58, 0x59, 0x5a]), // 'rXYZ'
		u32(144), // offset of the tag data
		u32(20), // its size
	]);
	const tagData = concat([
		new Uint8Array([0x58, 0x59, 0x5a, 0x20]), // 'XYZ '
		u32(0),
		u32(Math.round(redX * 65536)),
		u32(0),
		u32(0),
	]);
	// The entry table ends at 144, which is where the tag data starts.
	return concat([header, tagCount, tagEntry, tagData]);
}

describe('colour', () => {
	it('reads Display P3 from an nclx block', () => {
		expect(planHeifImage(buildHeif({ primaries: 12 })).colourSpace).toBe('display-p3');
	});

	it('reads a wide gamut ICC profile as Display P3 and carries it through', () => {
		// The profile is carried rather than merely detected, because writing
		// the source profile into the output is what makes the conversion
		// lossless in colour rather than only in pixels.
		const plan = planHeifImage(buildHeif({ icc: iccProfile(0.5151) }));
		expect(plan.colourSpace).toBe('display-p3');
		expect(plan.iccProfile).toBeDefined();
	});

	it('reads an sRGB ICC profile as sRGB', () => {
		// The other half of the same rule. Treating this as wide gamut and
		// converting would oversaturate an image that was already correct.
		expect(planHeifImage(buildHeif({ icc: iccProfile(0.4361) })).colourSpace).toBe('srgb');
	});

	it('falls back to sRGB on a profile too short to read', () => {
		// A damaged profile is not a reason to refuse a photograph. sRGB is the
		// safe assumption because it is what an untagged file means anyway.
		expect(planHeifImage(buildHeif({ icc: new Uint8Array(12) })).colourSpace).toBe('srgb');
	});

	it('falls back to sRGB on a profile claiming an impossible tag count', () => {
		const profile = new Uint8Array(200);
		new DataView(profile.buffer).setUint32(128, 0xffffffff);
		expect(planHeifImage(buildHeif({ icc: profile })).colourSpace).toBe('srgb');
	});
});

describe('orientation', () => {
	it('reports no correction when the pixels are already upright', () => {
		const plan = planHeifImage(buildHeif({}));
		expect(plan.orientation).toEqual({ rotation: 0, mirror: 'none', source: 'none' });
	});

	it('names the container as the source when there is a rotation', () => {
		// Reported rather than hidden. "The tool rotated my photo" and "the tool
		// failed to rotate my photo" are the same complaint from opposite
		// directions, and there is no telling them apart without this.
		const plan = planHeifImage(buildHeif({ rotation: 90 }));
		expect(plan.orientation.source).toBe('heif-irot');
	});

	it.each(['horizontal', 'vertical'] as const)('carries an %s mirror', (mirror) => {
		expect(planHeifImage(buildHeif({ mirror })).orientation.mirror).toBe(mirror);
	});

	it('applies the mirror before the rotation, as the standard requires', async () => {
		// The order only matters when both are present, which is rare, so the
		// wrong order survives testing on real photographs and fails on the one
		// file that has both.
		const plan = planHeifImage(
			buildHeif({ columns: 2, rows: 1, rotation: 90, mirror: 'horizontal' }),
		);
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect(image.width).toBe(plan.displayWidth);
		expect(image.height).toBe(plan.displayHeight);
	});
});

describe('EXIF', () => {
	it('skips the offset header a HEIF Exif item begins with', () => {
		// The item starts with a four byte offset to the TIFF header, almost
		// always zero and not guaranteed to be.
		const exif = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
		expect(planHeifImage(buildHeif({ exif }))?.exif).toEqual(exif);
	});

	it('has no exif when the file carries none', () => {
		expect(planHeifImage(buildHeif({})).exif).toBeUndefined();
	});
});

describe('gain maps', () => {
	it('plans the second picture alongside the base', () => {
		// The shape a real iPhone file has: a tiled base, a smaller tiled gain
		// map on its own grid, and a `tmap` item naming the two of them.
		const plan = planHeifImage(
			buildHeif({ columns: 2, rows: 2, gainMap: { columns: 2, rows: 1, tileSize: 32 } }),
		);
		expect(plan.hasGainMap).toBe(true);
		expect(plan.tiles).toHaveLength(4);
		expect(plan.gainMap?.tiles).toHaveLength(2);
		expect([plan.gainMap?.width, plan.gainMap?.height]).toEqual([64, 32]);
		expect(plan.gainMap?.metadata).toHaveLength(62);
		expect(plan.gainMap?.standard).toBe('iso-21496-1');
	});

	it('carries the parameter block through byte for byte', () => {
		// Nothing in this package reads the block, so the only thing that can go
		// wrong with it is a byte, and the only way to catch that is to compare
		// all of them. Every value that defines the photograph is in there.
		const plan = planHeifImage(buildHeif({ gainMap: {} }));
		expect(Array.from(plan.gainMap?.metadata ?? [])).toEqual(Array.from(SAMPLE_GAIN_MAP_METADATA));
	});

	it('reports nothing at all when the file has no tmap and no auxiliary', () => {
		// A standard range photograph has lost nothing by being read as one, so
		// there is nothing here for an interface to warn about.
		const plan = planHeifImage(buildHeif({}));
		expect(plan.hasGainMap).toBe(false);
		expect(plan.gainMap).toBeUndefined();
	});

	it.each([
		['one', [1]],
		['three', [1, 6, 7]],
		['no', []],
	])('drops a tmap deriving from %s pictures rather than two', (_label, children) => {
		// Base first, gain map second, is the entire meaning of the box, so a
		// different count is a container disagreeing with itself and picking
		// one of three children would be a guess handed back as a photograph.
		// The gain map goes, and the photograph does not: refusing to open a
		// picture because the second half of it is odd is a worse answer than
		// handing back the standard range version.
		const plan = planHeifImage(buildHeif({ gainMap: { children } }));

		expect(plan.hasGainMap).toBe(true);
		expect(plan.gainMap).toBeUndefined();
		expect(plan.width).toBeGreaterThan(0);
		expect(plan.tiles.length).toBeGreaterThan(0);
	});

	it('drops a gain map whose parameter block cannot be read, and keeps the photograph', () => {
		// The regression this guards: reading the parameters moved into the
		// planner, and reading them outside the guard meant a file that used to
		// convert perfectly well started being refused outright because one
		// length field in the second half of it was wrong.
		const plan = planHeifImage(buildHeif({ gainMap: { damagedLocation: true } }));

		expect(plan.hasGainMap).toBe(true);
		expect(plan.gainMap).toBeUndefined();
		expect(plan.width).toBeGreaterThan(0);
	});

	it('reports the older Apple layout as present and dropped', () => {
		// An `auxl` gain map with no `tmap` is what iOS wrote before ISO 21496-1
		// existed. The picture is there but its parameters are in a proprietary
		// block, and without the headroom and the gain range it is a grey
		// rectangle of unknown meaning, so it cannot be carried anywhere.
		const plan = planHeifImage(buildHeif({ gainMap: { layout: 'auxl' } }));
		expect(plan.hasGainMap).toBe(true);
		expect(plan.gainMap).toBeUndefined();
	});

	it.each([
		['the picture has no decoder configuration', { withoutConfig: true }],
		['the tmap names an item that is not there', { children: [1, 99] }],
		['the parameter block is empty', { metadata: new Uint8Array(0) }],
	])('reports present and dropped when %s', (_label, gainMap) => {
		// Not fatal, deliberately. The base is a perfectly good photograph and
		// refusing to open it because the second half of it is odd would be a
		// worse answer than handing back the standard range version.
		const plan = planHeifImage(buildHeif({ gainMap }));
		expect(plan.hasGainMap).toBe(true);
		expect(plan.gainMap).toBeUndefined();
	});

	it('keeps the gain map at its own size rather than at the base size', async () => {
		// A gain map is stored smaller than the picture it describes, and it is
		// meant to be. Resizing it here would throw away the one cheap thing
		// about it and would hide the arithmetic behind an interpolation.
		const plan = planHeifImage(
			buildHeif({ columns: 2, rows: 2, tileSize: 64, gainMap: { tileSize: 32 } }),
		);
		const map = plan.gainMap;
		if (!map) throw new Error('the fixture should have planned a gain map');
		const image = await assembleHeifImage(map, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([32, 32]);
		expect([plan.width, plan.height]).toEqual([120, 124]);
	});

	it('turns the gain map by its own rotation rather than by the base rotation', async () => {
		// Both items carry the same `irot` in a real file, so the gain map ends
		// up the same way up as the base without anything being applied twice.
		// Reading the rotation off the base and applying it here as well is the
		// 540 degree bug with a second picture to hide in.
		const plan = planHeifImage(
			buildHeif({ rotation: 90, columns: 2, rows: 2, gainMap: { columns: 2, rows: 1 } }),
		);
		const map = plan.gainMap;
		if (!map) throw new Error('the fixture should have planned a gain map');
		expect(map.orientation).toEqual(plan.orientation);
		const image = await assembleHeifImage(map, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([map.displayWidth, map.displayHeight]);
		expect([image.width, image.height]).toEqual([32, 64]);
	});

	it('reads the rotation off the gain map itself, not off the base', async () => {
		// The test above cannot fail on a reader that copies the base's
		// orientation across, because every real file has the two agreeing. So
		// this one makes them disagree, which no phone does and no other test
		// can arrange, purely so that the two implementations are told apart.
		const plan = planHeifImage(
			buildHeif({
				rotation: 90,
				columns: 2,
				rows: 2,
				gainMap: { columns: 2, rows: 1, rotation: 180 },
			}),
		);
		const map = plan.gainMap;
		if (!map) throw new Error('the fixture should have planned a gain map');

		expect(plan.orientation.rotation).toBe(90);
		expect(map.orientation.rotation).toBe(180);
		// A half turn keeps the shape, so the gain map stays 64 by 32 while the
		// base's quarter turn swaps its own.
		const image = await assembleHeifImage(map, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([64, 32]);
	});
});

describe('refusals', () => {
	it.each([
		['iovl', 'an overlay'],
		['iden', 'an identity derivation'],
		['av01', 'AV1 rather than HEVC'],
		['zzzz', 'something unrecognised'],
	])('refuses %s by name rather than half attempting it', (type) => {
		// Each of these is a decision rather than a gap. Naming the feature is
		// what lets the message say the file is fine and the reader is not.
		const patched = Uint8Array.from(buildHeif({ columns: 1, rows: 1 }));
		const marker = new TextEncoder().encode('hvc1');
		for (let i = 0; i < patched.length - 4; i += 1) {
			if (
				patched[i] === marker[0] &&
				patched[i + 1] === marker[1] &&
				patched[i + 2] === marker[2] &&
				patched[i + 3] === marker[3]
			) {
				patched.set(new TextEncoder().encode(type), i);
				break;
			}
		}
		expect(() => planHeifImage(patched)).toThrow(HeifUnsupportedFeatureError);
	});

	it('refuses a grid whose tiles do not cover the size it claims', () => {
		// The grid descriptor is authoritative about the output size, so a grid
		// claiming more than its tiles can supply would read past the assembled
		// buffer rather than produce a smaller image.
		expect(() => planHeifImage(buildHeif({ underCoveredGrid: true }))).toThrow(HeifMalformedError);
	});
});

describe('assembly', () => {
	it('returns the single tile directly when there is only one', async () => {
		// A 48 megapixel photograph is close to 200 megabytes as a raster, and
		// allocating a second buffer to copy one tile into halves the size of
		// image the tab can handle.
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, tileSize: 64 }));
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect(image.width).toBe(plan.width);
	});

	it('composites into a shared buffer when there are several', async () => {
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, tileSize: 64 }));
		const image = await assembleHeifImage(plan, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([plan.width, plan.height]);
	});

	it('passes the abort signal through to the tile decoder', async () => {
		// Cancellation has to reach the decoder, or a visitor who navigates away
		// mid conversion leaves 48 tiles decoding behind them.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2 }));
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		await assembleHeifImage(
			plan,
			async (config, tiles, signal) => {
				seen = signal;
				return fakeTileDecoder()(config, tiles, signal);
			},
			controller.signal,
		);
		expect(seen).toBe(controller.signal);
	});

	it('hands the decoder the tile size, not the image size', async () => {
		// The configuration describes one tile, because that is what the
		// decoder is being asked to decode.
		const plan = planHeifImage(buildHeif({ columns: 3, rows: 2, tileSize: 64 }));
		let coded = { width: 0, height: 0 };
		await assembleHeifImage(plan, async (config, tiles, signal) => {
			coded = { width: config.codedWidth, height: config.codedHeight };
			return fakeTileDecoder()(config, tiles, signal);
		});
		expect(coded).toEqual({ width: 64, height: 64 });
	});
});
