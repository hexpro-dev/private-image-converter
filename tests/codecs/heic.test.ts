/**
 * The HEIC ladder, with the platform taken out of it.
 *
 * Neither rung can run under Node as it ships: one needs `VideoDecoder` and
 * the other needs `createImageBitmap`. Both are built by a factory that takes
 * the platform call as a seam, so what runs here is the shipped decoder with
 * exactly one substitution, and everything around the codec, the ladder's
 * decisions, the second decode pass, the gain map reporting, is the real
 * thing.
 */

import { describe, expect, it } from 'vitest';
import {
	createHeicNativeDecoder,
	createHeicWebCodecsDecoder,
} from '../../src/codecs/heic/index.js';
import { emptyCapabilities } from '../../src/detect/capabilities.js';
import { ImageTooLargeError, UnsupportedHereError } from '../../src/errors.js';
import type { DecodeContext, RasterImage } from '../../src/types.js';
import { SAMPLE_GAIN_MAP_METADATA, buildHeif, fakeTileDecoder } from '../helpers/heif.js';

const HDR = buildHeif({ columns: 2, rows: 2, tileSize: 64, gainMap: { columns: 2, rows: 1 } });
const SDR = buildHeif({ columns: 2, rows: 2, tileSize: 64 });

function context(overrides: Partial<DecodeContext> = {}): DecodeContext {
	return { capabilities: emptyCapabilities(), maxPixels: 100_000_000, ...overrides };
}

/** A stand-in for Safari's own decoder, which returns one finished picture. */
function fakeNativeDecode(width = 124, height = 120) {
	return async (): Promise<RasterImage> => ({
		data: new Uint8ClampedArray(width * height * 4),
		width,
		height,
		colourSpace: 'srgb',
		hasAlpha: false,
	});
}

function webCodecs(seams: Parameters<typeof createHeicWebCodecsDecoder>[0] = {}) {
	return createHeicWebCodecsDecoder({
		decodeTiles: fakeTileDecoder,
		supports: async () => true,
		...seams,
	});
}

describe('the two rungs disagree about HDR', () => {
	it('reads the gain map on the rung that reads the container', async () => {
		const output = await webCodecs().decode(HDR, context());
		expect(output.gainMap).toBeDefined();
		expect(output.gainMap?.standard).toBe('iso-21496-1');
		expect(output.droppedGainMap).toBe(false);
	});

	it('drops it on the rung that cannot reach it', async () => {
		// `createImageBitmap` returns the composited picture and takes no
		// argument that asks for an auxiliary item, so this is not a gap to
		// close later. The file is HDR and this path has lost that.
		const output = await createHeicNativeDecoder({ decodeImage: fakeNativeDecode() }).decode(
			HDR,
			context(),
		);
		expect(output.gainMap).toBeUndefined();
		expect(output.droppedGainMap).toBe(true);
	});

	it('says nothing either way about a standard range photograph', async () => {
		// Nothing was lost, so there is nothing for an interface to warn about.
		const fromContainer = await webCodecs().decode(SDR, context());
		const fromBrowser = await createHeicNativeDecoder({ decodeImage: fakeNativeDecode() }).decode(
			SDR,
			context(),
		);
		expect(fromContainer.droppedGainMap).toBe(false);
		expect(fromBrowser.droppedGainMap).toBe(false);
		expect(fromContainer.gainMap).toBeUndefined();
	});

	it('reports a drop when the file has a gain map this reader cannot resolve', async () => {
		// The older Apple layout: a gain map picture with no parameter block. The
		// difference between "there was no HDR here" and "there was, and it is
		// gone" is the whole reason the flag exists.
		const older = buildHeif({ gainMap: { layout: 'auxl' } });
		const output = await webCodecs().decode(older, context());
		expect(output.gainMap).toBeUndefined();
		expect(output.droppedGainMap).toBe(true);
	});
});

describe('the gain map that comes back', () => {
	it('carries the parameter block byte for byte', async () => {
		// Carried and never parsed, so a byte is the only thing that can be
		// wrong with it and comparing all of them is the only way to see that.
		const output = await webCodecs().decode(HDR, context());
		expect(Array.from(output.gainMap?.metadata ?? [])).toEqual(
			Array.from(SAMPLE_GAIN_MAP_METADATA),
		);
	});

	it('keeps its own dimensions rather than the base ones', async () => {
		// Stretching it to match would throw away the one cheap thing about a
		// gain map and would hide the arithmetic behind an interpolation.
		const output = await webCodecs().decode(HDR, context());
		expect([output.image.width, output.image.height]).toEqual([120, 124]);
		expect([output.gainMap?.image.width, output.gainMap?.image.height]).toEqual([64, 32]);
	});

	it('does not count as a tile of the base', async () => {
		// The tile count reaches the interface as "this took 4 decodes". Adding
		// the gain map's tiles to it would report a number that matches nothing
		// the person can see.
		const output = await webCodecs().decode(HDR, context());
		expect(output.tiles).toBe(4);
	});
});

describe('the cost of the second pass', () => {
	it('skips it when the caller says the gain map is not wanted', async () => {
		// A caller writing a JPEG has no use for one. The gain map is half the
		// base's size in each direction on every phone file measured, so the
		// second pass is roughly a quarter of the work rather than a second
		// helping of it, which is still worth not doing. Saying so is still a
		// drop, because the file had HDR and the output will not.
		let passes = 0;
		const output = await webCodecs({
			decodeTiles: () => {
				passes += 1;
				return fakeTileDecoder();
			},
		}).decode(HDR, { ...context(), gainMap: false } as DecodeContext);
		expect(passes).toBe(1);
		expect(output.gainMap).toBeUndefined();
		expect(output.droppedGainMap).toBe(true);
	});

	it('gives the gain map a decoder of its own', async () => {
		// A `VideoDecoder` is configured once with a description and a coded
		// size it then expects every chunk to match. The gain map is its own
		// item with its own `hvcC`, so sharing one decoder would mean
		// reconfiguring it partway through a stream.
		let passes = 0;
		await webCodecs({
			decodeTiles: () => {
				passes += 1;
				return fakeTileDecoder();
			},
		}).decode(HDR, context());
		expect(passes).toBe(2);
	});

	it('still returns the photograph when only the gain map fails to decode', async () => {
		// The gain map is a separate stream that hardware is entitled to refuse
		// on its own. Refusing the whole photograph over it would refuse a file
		// this browser has just shown it can read.
		let first = true;
		const output = await webCodecs({
			decodeTiles: () => {
				if (first) {
					first = false;
					return fakeTileDecoder();
				}
				return async () => {
					throw new Error('no decode block for monochrome');
				};
			},
		}).decode(HDR, context());
		expect(output.image.width).toBe(120);
		expect(output.gainMap).toBeUndefined();
		expect(output.droppedGainMap).toBe(true);
	});

	it('lets an abort through rather than treating it as a missing gain map', async () => {
		// Somebody asked for this and the caller is waiting to hear that it
		// happened. Swallowing it would report a successful conversion of a file
		// nobody waited for.
		const controller = new AbortController();
		const decoder = webCodecs({
			decodeTiles: () => async (config, tiles, signal) => {
				// Aborts partway through the base, so the gain map's pass is the one
				// that finds the signal already set, which is where a swallowed
				// abort would hide.
				if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
				controller.abort();
				return fakeTileDecoder()(config, tiles, signal);
			},
		});
		await expect(decoder.decode(HDR, context({ signal: controller.signal }))).rejects.toThrow(
			'Aborted',
		);
	});
});

describe('the ladder around it', () => {
	it('offers the native rung only where the browser decodes HEIC', async () => {
		const decoder = createHeicNativeDecoder({ available: () => true });
		expect(await decoder.available(emptyCapabilities())).toBe(false);
		expect(
			await decoder.available(emptyCapabilities({ nativeDecode: new Set(['image/heic']) })),
		).toBe(true);
	});

	it('offers the WebCodecs rung only where the probe found an HEVC decoder', async () => {
		expect(await webCodecs().available(emptyCapabilities())).toBe(false);
		expect(await webCodecs().available(emptyCapabilities({ hevcVideoDecoder: true }))).toBe(true);
	});

	it('asks about this file rather than trusting the capability probe', async () => {
		// The probe asks about a representative still-picture profile, and a
		// given file may use another. Declining here is what lets a caller fall
		// through to a rung that can read it.
		const decoder = webCodecs({ supports: async () => false });
		await expect(decoder.decode(HDR, context())).rejects.toThrow(UnsupportedHereError);
	});

	it.each([
		['the container reader', () => webCodecs()],
		['the browser', () => createHeicNativeDecoder({ decodeImage: fakeNativeDecode() })],
	])('refuses an image past the ceiling on %s', async (_label, make) => {
		await expect(make().decode(HDR, context({ maxPixels: 16 }))).rejects.toThrow(
			ImageTooLargeError,
		);
	});

	it('reports the rotation it applied, and the browser reports none', async () => {
		// Safari has already turned the picture, so claiming a rotation here
		// would turn it a second time. Both halves look correct in isolation and
		// the result is 540 degrees.
		const turned = buildHeif({ columns: 2, rows: 2, rotation: 90 });
		const fromContainer = await webCodecs().decode(turned, context());
		const fromBrowser = await createHeicNativeDecoder({ decodeImage: fakeNativeDecode() }).decode(
			turned,
			context(),
		);
		expect(fromContainer.orientation).toEqual({
			rotation: 90,
			mirror: 'none',
			source: 'heif-irot',
		});
		expect(fromBrowser.orientation).toEqual({ rotation: 0, mirror: 'none', source: 'decoder' });
	});
});
