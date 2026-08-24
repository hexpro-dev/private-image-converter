import { describe, expect, it } from 'vitest';
import { planHeifImage } from '../../src/heif/image.js';
import { assembleHeifImage } from '../../src/heif/assemble.js';
import { HeifMalformedError, HeifUnsupportedFeatureError } from '../../src/errors.js';
import { buildHeif, concat, fakeTileDecoder, u32 } from '../helpers/heif.js';

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
	it('notices one and still decodes the standard range base', () => {
		// Refusing the file would refuse every HDR photograph a recent iPhone
		// takes, which is all of them.
		const plan = planHeifImage(buildHeif({ gainMap: true }));
		expect(plan.hasGainMap).toBe(true);
		expect(plan.tiles.length).toBeGreaterThan(0);
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
