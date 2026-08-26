import { describe, expect, it } from 'vitest';
import { iccIsWideGamut, planHeifImage } from '../../src/heif/image.js';
import { assembleHeifImage } from '../../src/heif/assemble.js';
import { HeifMalformedError, HeifUnsupportedFeatureError } from '../../src/errors.js';
import {
	ALPHA_AUX_TYPE_MIAF,
	DEPTH_AUX_TYPE,
	SAMPLE_GAIN_MAP_METADATA,
	ascii,
	buildHeif,
	concat,
	fakeTileDecoder,
	u32,
} from '../helpers/heif.js';

/** A colourant tag: its signature and its media-relative X, Y and Z. */
type Colourant = readonly [string, number, number, number];

/**
 * The three colourants of the profiles anybody actually ships.
 *
 * Every one of these is the published D50 adapted matrix of its profile,
 * typed out rather than produced by a library, so a test that says "Adobe RGB
 * is not Display P3" is comparing against Adobe RGB rather than against
 * whatever this package believes Adobe RGB to be.
 */
const DISPLAY_P3: readonly Colourant[] = [
	['rXYZ', 0.51512, 0.2416, -0.00105],
	['gXYZ', 0.29197, 0.69224, 0.04189],
	['bXYZ', 0.1571, 0.06606, 0.78407],
];
const SRGB: readonly Colourant[] = [
	['rXYZ', 0.43607, 0.22249, 0.01392],
	['gXYZ', 0.38515, 0.71687, 0.09708],
	['bXYZ', 0.14307, 0.06061, 0.7141],
];
const ADOBE_RGB: readonly Colourant[] = [
	['rXYZ', 0.60974, 0.31111, 0.01947],
	['gXYZ', 0.20528, 0.62567, 0.06087],
	['bXYZ', 0.14919, 0.06322, 0.74457],
];
const PROPHOTO: readonly Colourant[] = [
	['rXYZ', 0.7977, 0.28804, 0],
	['gXYZ', 0.13518, 0.71188, 0],
	['bXYZ', 0.03134, 0.00009, 0.82491],
];
const REC2020: readonly Colourant[] = [
	['rXYZ', 0.67345, 0.27903, -0.00194],
	['gXYZ', 0.16566, 0.67568, 0.02999],
	['bXYZ', 0.1251, 0.04529, 0.79683],
];

/** s15Fixed16, which is how an ICC profile stores a colourant component. */
function s15(value: number): Uint8Array {
	return u32(Math.round(value * 65536));
}

/**
 * Build an ICC profile carrying the given colourants.
 *
 * Assembled from the ICC layout by hand: a 128 byte header, the tag count, one
 * twelve byte entry per tag, then the tag data those entries point at. A
 * profile produced by a colour library would only prove this reader agrees
 * with that library.
 *
 * A `desc` tag goes in front of the colourants deliberately, because a real
 * profile has a dozen tags the predicate has no interest in and a fixture
 * where every tag matches never walks past one.
 */
function iccProfile(colourants: readonly Colourant[]): Uint8Array {
	const tags = [
		{ signature: 'desc', data: ascii('A profile written by hand\0') },
		...colourants.map(([signature, x, y, z]) => ({
			signature,
			data: concat([ascii('XYZ '), u32(0), s15(x), s15(y), s15(z)]),
		})),
	];

	const entries: Uint8Array[] = [];
	const payloads: Uint8Array[] = [];
	let at = 132 + tags.length * 12;
	for (const tag of tags) {
		entries.push(concat([ascii(tag.signature), u32(at), u32(tag.data.length)]));
		payloads.push(tag.data);
		at += tag.data.length;
	}
	return concat([new Uint8Array(128), u32(tags.length), ...entries, ...payloads]);
}

describe('colour', () => {
	it('reads Display P3 from an nclx block', () => {
		expect(planHeifImage(buildHeif({ primaries: 12 })).colourSpace).toBe('display-p3');
	});

	it('reads a wide gamut ICC profile as Display P3 and carries it through', () => {
		// The profile is carried rather than merely detected, because writing
		// the source profile into the output is what makes the conversion
		// lossless in colour rather than only in pixels.
		const plan = planHeifImage(buildHeif({ icc: iccProfile(DISPLAY_P3) }));
		expect(plan.colourSpace).toBe('display-p3');
		expect(plan.iccProfile).toBeDefined();
	});

	it('reads an sRGB ICC profile as sRGB', () => {
		// The other half of the same rule. Treating this as wide gamut and
		// converting would oversaturate an image that was already correct.
		expect(planHeifImage(buildHeif({ icc: iccProfile(SRGB) })).colourSpace).toBe('srgb');
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

describe('the wide gamut predicate', () => {
	it('recognises Display P3', () => {
		expect(iccIsWideGamut(iccProfile(DISPLAY_P3))).toBe(true);
	});

	it.each([
		['sRGB', SRGB],
		['Adobe RGB', ADOBE_RGB],
		['ProPhoto', PROPHOTO],
		['Rec.2020', REC2020],
	])('does not read %s as Display P3', (_label, colourants) => {
		// The regression this is here for: deciding from the red colourant
		// alone puts every one of the last three above any threshold that
		// admits P3, so those files were tagged P3 and their pixels converted
		// into a gamut their own profile denies. Only sRGB fails a red-only
		// test correctly, which is why a red-only test looked right.
		expect(iccIsWideGamut(iccProfile(colourants))).toBe(false);
		expect(planHeifImage(buildHeif({ icc: iccProfile(colourants) })).colourSpace).toBe('srgb');
	});

	it('refuses a profile with a P3 red and an Adobe RGB green', () => {
		// Nobody writes this file. It exists so that "all three" is tested as
		// all three rather than as "the first one that matched".
		const mixed: readonly Colourant[] = [
			DISPLAY_P3[0] as Colourant,
			ADOBE_RGB[1] as Colourant,
			DISPLAY_P3[2] as Colourant,
		];
		expect(iccIsWideGamut(iccProfile(mixed))).toBe(false);
	});

	it('refuses a profile that carries only the red colourant', () => {
		// A truncated or unusual profile is not P3 on the strength of the one
		// tag it happens to have, and false is the safe answer: the picture is
		// then left alone rather than converted.
		expect(iccIsWideGamut(iccProfile([DISPLAY_P3[0] as Colourant]))).toBe(false);
	});

	it('refuses a profile with no tags at all', () => {
		expect(iccIsWideGamut(iccProfile([]))).toBe(false);
	});

	it('stops at the end of a tag table that claims more entries than it has', () => {
		// The count is the file talking about itself and can be wrong. Walking
		// past the buffer throws a RangeError out of the DataView rather than
		// returning anything, so this reaching an answer at all is the check:
		// the four real tags are read, the imaginary ones are not.
		const profile = iccProfile(DISPLAY_P3);
		new DataView(profile.buffer, profile.byteOffset).setUint32(128, 400);
		expect(iccIsWideGamut(profile)).toBe(true);
	});

	it('refuses a profile whose colourant points past the end', () => {
		// The `desc` tag is written first, so the red colourant is the second
		// entry and its offset field sits twelve bytes into the table.
		const profile = iccProfile(DISPLAY_P3);
		new DataView(profile.buffer, profile.byteOffset).setUint32(132 + 12 + 4, 0xffff);
		expect(iccIsWideGamut(profile)).toBe(false);
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

describe('transparency', () => {
	it('plans the alpha plane beside the picture', () => {
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, alpha: {} }));
		expect(plan.hasAlphaAuxiliary).toBe(true);
		expect([plan.alphaAuxiliary?.width, plan.alphaAuxiliary?.height]).toEqual([
			plan.width,
			plan.height,
		]);
		expect(plan.alphaAuxiliary?.tiles).toHaveLength(1);
	});

	it('plans an alpha plane that is itself a grid', () => {
		// A tiled photograph stores its transparency tiled the same way, so the
		// plane goes through the same grid arithmetic as the picture rather
		// than through a second copy of it that could disagree.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, tileSize: 64, alpha: {} }));
		expect(plan.alphaAuxiliary?.tiles).toHaveLength(4);
		expect([plan.alphaAuxiliary?.width, plan.alphaAuxiliary?.height]).toEqual([120, 124]);
	});

	it('decodes the plane to the size of the picture it covers', async () => {
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, alpha: {} }));
		const alpha = plan.alphaAuxiliary;
		if (!alpha) throw new Error('the fixture should have planned an alpha plane');
		const image = await assembleHeifImage(alpha, fakeTileDecoder());
		expect([image.width, image.height]).toEqual([plan.displayWidth, plan.displayHeight]);
	});

	it('takes the MIAF urn as well as the HEVC one', () => {
		// A file carries one or the other depending on how old the writer is,
		// and nothing downstream can tell the difference.
		const plan = planHeifImage(
			buildHeif({ columns: 1, rows: 1, alpha: { auxType: ALPHA_AUX_TYPE_MIAF } }),
		);
		expect(plan.alphaAuxiliary).toBeDefined();
	});

	it('does not take a depth map for transparency', () => {
		// One digit apart in the urn, the same grey rectangle on screen, and a
		// substring match cannot tell them apart. Multiplying a photograph by
		// its depth map fades it out with distance and throws nothing.
		const plan = planHeifImage(
			buildHeif({ columns: 1, rows: 1, alpha: { auxType: DEPTH_AUX_TYPE } }),
		);
		expect(plan.hasAlphaAuxiliary).toBe(false);
		expect(plan.alphaAuxiliary).toBeUndefined();
	});

	it('ignores an auxiliary that never says what it is', () => {
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, alpha: { withoutAuxType: true } }));
		expect(plan.hasAlphaAuxiliary).toBe(false);
	});

	it('ignores an alpha plane auxiliary to some other item', () => {
		// A plane that covers something else belongs to that something else. A
		// reader searching by urn alone would take it and put it on the
		// photograph anyway.
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, alpha: { attachedTo: 99 } }));
		expect(plan.hasAlphaAuxiliary).toBe(false);
	});

	it('does not mistake the gain map for an alpha plane', () => {
		// Both hang off the photograph by `auxl`, both are hidden, both are
		// grey. The urn is the only thing that separates them, which is why it
		// is checked before the item is planned rather than after.
		const plan = planHeifImage(buildHeif({ gainMap: {} }));
		expect(plan.hasGainMap).toBe(true);
		expect(plan.hasAlphaAuxiliary).toBe(false);
	});

	it('reads a gain map and an alpha plane off the same photograph', () => {
		// What a screenshot of an HDR photograph looks like: three pictures in
		// the container, two of them accessories to the first.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, gainMap: {}, alpha: {} }));
		expect(plan.gainMap).toBeDefined();
		expect(plan.alphaAuxiliary).toBeDefined();
		expect(plan.tiles).toHaveLength(4);
	});

	it('turns the plane by its own rotation, so it still lines up', () => {
		// Both items carry the same `irot` in a real file, and the sizes are
		// compared after it has been applied. Comparing the stored sizes
		// instead would be right by accident here and wrong the moment a
		// portrait picture met a plane whose rotation was recorded differently.
		const plan = planHeifImage(buildHeif({ columns: 2, rows: 2, rotation: 90, alpha: {} }));
		expect(plan.alphaAuxiliary?.orientation).toEqual(plan.orientation);
		expect([plan.alphaAuxiliary?.displayWidth, plan.alphaAuxiliary?.displayHeight]).toEqual([
			plan.displayWidth,
			plan.displayHeight,
		]);
	});

	it.each([
		['wider than', { width: 200 }],
		['taller than', { height: 200 }],
	])('drops a plane %s the picture, and keeps the picture', (_label, size) => {
		// Coverage is stored at the picture's own size by every writer, so a
		// plane that is not that size means this is the wrong item or the file
		// disagrees with itself. Stretching it would put the holes in the
		// wrong places with nothing anywhere saying so.
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, alpha: size }));
		expect(plan.hasAlphaAuxiliary).toBe(true);
		expect(plan.alphaAuxiliary).toBeUndefined();
		expect(plan.tiles.length).toBeGreaterThan(0);
	});

	it.each([
		['is damaged', { withoutConfig: true }],
		['is a structure this reader refuses', { itemType: 'iovl' }],
	])('drops a plane that %s, and keeps the picture', (_label, alpha) => {
		// The same rule the gain map already follows, and for the same reason:
		// there is a regression in this package where a damaged accessory
		// refused the whole photograph, and a picture that comes back opaque is
		// a far better answer than one that does not come back.
		const plan = planHeifImage(buildHeif({ columns: 1, rows: 1, alpha }));
		expect(plan.hasAlphaAuxiliary).toBe(true);
		expect(plan.alphaAuxiliary).toBeUndefined();
		expect(plan.width).toBeGreaterThan(0);
		expect(plan.tiles.length).toBeGreaterThan(0);
	});

	it('reports nothing at all when the picture is opaque', () => {
		const plan = planHeifImage(buildHeif({}));
		expect(plan.hasAlphaAuxiliary).toBe(false);
		expect(plan.alphaAuxiliary).toBeUndefined();
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
