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
import type { HeicDecodeOutput } from '../../src/codecs/heic/index.js';
import { emptyCapabilities } from '../../src/detect/capabilities.js';
import { CancelledError, ImageTooLargeError, UnsupportedHereError } from '../../src/errors.js';
import type { TileDecoder } from '../../src/heif/assemble.js';
import type { DecodeContext, RasterImage } from '../../src/types.js';
import { SAMPLE_GAIN_MAP_METADATA, buildHeif, fakeTileDecoder } from '../helpers/heif.js';

const HDR = buildHeif({ columns: 2, rows: 2, tileSize: 64, gainMap: { columns: 2, rows: 1 } });
const SDR = buildHeif({ columns: 2, rows: 2, tileSize: 64 });
/** A sticker: one picture, and an alpha plane the same size hung off it. */
const TRANSPARENT = buildHeif({ columns: 1, rows: 1, tileSize: 64, alpha: {} });

function context(overrides: Partial<DecodeContext> = {}): DecodeContext {
	return { capabilities: emptyCapabilities(), maxPixels: 100_000_000, ...overrides };
}

/** A tile decoder that paints every pixel of every tile the same colour. */
function flatTileDecoder(red: number, green: number, blue: number): TileDecoder {
	return async (_config, tiles) =>
		tiles.map((tile) => {
			const data = new Uint8ClampedArray(tile.width * tile.height * 4);
			for (let i = 0; i < data.length; i += 4) {
				data[i] = red;
				data[i + 1] = green;
				data[i + 2] = blue;
				data[i + 3] = 255;
			}
			return {
				data,
				width: tile.width,
				height: tile.height,
				colourSpace: 'srgb' as const,
				hasAlpha: false,
			};
		});
}

/**
 * Hand out a different decoder to each pass, in the order they are asked for.
 *
 * The picture, then the alpha plane, then the gain map. Each pass builds its
 * own decoder, which is the seam that lets a test say "the second stream is
 * the one that fails" without the first knowing anything about it.
 */
function decodersInOrder(...decoders: readonly TileDecoder[]): () => TileDecoder {
	let index = 0;
	return () => decoders[Math.min(index++, decoders.length - 1)] as TileDecoder;
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
		// nobody waited for. The abort lands during the gain map's own pass, so
		// the failure that comes back is a plain decode failure and the signal
		// is the only thing that says why it really happened.
		const controller = new AbortController();
		const decoder = webCodecs({
			decodeTiles: decodersInOrder(fakeTileDecoder(), async () => {
				controller.abort();
				throw new Error('the decoder gave up');
			}),
		});
		await expect(decoder.decode(HDR, context({ signal: controller.signal }))).rejects.toThrow(
			CancelledError,
		);
	});

	it('passes a cancellation from the gain map pass straight out', async () => {
		// What the shipped tile decoder throws once it notices the signal. It
		// is already the right answer, so the layer above must not turn it into
		// a gain map that merely failed to decode.
		const controller = new AbortController();
		const decoder = webCodecs({
			decodeTiles: decodersInOrder(fakeTileDecoder(), async () => {
				throw new CancelledError();
			}),
		});
		await expect(decoder.decode(HDR, context({ signal: controller.signal }))).rejects.toThrow(
			CancelledError,
		);
	});
});

describe('transparency', () => {
	it('puts the auxiliary plane on the photograph as its alpha channel', async () => {
		// The plane is monochrome, so its red, green and blue come back equal
		// and any of them is the coverage. This fixture makes them differ on
		// purpose, which no real file does, so that a reader taking the green
		// or the blue is told apart from one taking the red.
		const output: HeicDecodeOutput = await webCodecs({
			decodeTiles: decodersInOrder(flatTileDecoder(10, 20, 30), flatTileDecoder(64, 200, 90)),
		}).decode(TRANSPARENT, context());

		expect(Array.from(output.image.data.slice(0, 4))).toEqual([10, 20, 30, 64]);
		expect(output.image.hasAlpha).toBe(true);
		expect(output.droppedAlpha).toBe(false);
	});

	it('gives the alpha plane a decoder of its own', async () => {
		// The plane is a separate item with its own `hvcC`, and a decoder is
		// configured once and then expects every chunk to match. Sharing one
		// would mean reconfiguring it in the middle of a stream.
		let passes = 0;
		await webCodecs({
			decodeTiles: () => {
				passes += 1;
				return fakeTileDecoder();
			},
		}).decode(TRANSPARENT, context());
		expect(passes).toBe(2);
	});

	it('still returns the photograph when only the plane fails to decode', async () => {
		// A monochrome stream is exactly the profile some hardware has no
		// decode block for. Refusing the sticker because its holes would not
		// decode would refuse a picture the browser has just read.
		const output: HeicDecodeOutput = await webCodecs({
			decodeTiles: decodersInOrder(fakeTileDecoder(), async () => {
				throw new Error('no decode block for monochrome');
			}),
		}).decode(TRANSPARENT, context());

		expect(output.image.width).toBeGreaterThan(0);
		expect(output.image.hasAlpha).toBe(false);
		expect(output.droppedAlpha).toBe(true);
	});

	it('reports the drop, and spends nothing, when the plane is the wrong size', async () => {
		// The planner refuses a plane that does not measure the same as the
		// picture, so there is nothing left to decode and the second pass never
		// happens. The interface is still owed the sentence.
		let passes = 0;
		const output: HeicDecodeOutput = await webCodecs({
			decodeTiles: () => {
				passes += 1;
				return fakeTileDecoder();
			},
		}).decode(buildHeif({ columns: 1, rows: 1, alpha: { width: 200 } }), context());

		expect(passes).toBe(1);
		expect(output.droppedAlpha).toBe(true);
	});

	it('says nothing either way about a photograph with no transparency in it', async () => {
		const output: HeicDecodeOutput = await webCodecs().decode(SDR, context());
		expect(output.droppedAlpha).toBe(false);
		expect(output.image.hasAlpha).toBe(false);
	});

	it('leaves the plane to the browser on the rung that has already had it', async () => {
		// Safari composites the alpha into the bitmap it returns, so there is
		// nothing to attach and nothing was lost. Claiming a drop here would be
		// a warning about something that did not happen.
		const output: HeicDecodeOutput = await createHeicNativeDecoder({
			decodeImage: fakeNativeDecode(56, 60),
		}).decode(TRANSPARENT, context());
		expect(output.droppedAlpha).toBeUndefined();
	});

	it('lets a cancellation during the alpha pass through', async () => {
		const controller = new AbortController();
		const decoder = webCodecs({
			decodeTiles: decodersInOrder(fakeTileDecoder(), async () => {
				throw new CancelledError();
			}),
		});
		await expect(
			decoder.decode(TRANSPARENT, context({ signal: controller.signal })),
		).rejects.toThrow(CancelledError);
	});

	it('reads an aborted signal as a cancellation, whatever the plane threw', async () => {
		// A decoder that stops because it was cancelled reports whatever it
		// feels like reporting, so the signal is the authority on why the pass
		// failed rather than the error that came out of it.
		const controller = new AbortController();
		const decoder = webCodecs({
			decodeTiles: decodersInOrder(fakeTileDecoder(), async () => {
				controller.abort();
				throw new Error('the decoder gave up');
			}),
		});
		await expect(
			decoder.decode(TRANSPARENT, context({ signal: controller.signal })),
		).rejects.toThrow(CancelledError);
	});
});

describe('cancellation', () => {
	it.each([
		['the container reader', () => webCodecs()],
		['the browser', () => createHeicNativeDecoder({ decodeImage: fakeNativeDecode() })],
	])('stops %s before it decodes anything', async (_label, make) => {
		// Checked at each phase boundary rather than once at the top. Reading
		// the container of a 48 megapixel photograph is not free, and neither
		// is the encode that would follow a decode nobody is waiting for.
		const controller = new AbortController();
		controller.abort();
		await expect(make().decode(HDR, context({ signal: controller.signal }))).rejects.toThrow(
			CancelledError,
		);
	});

	it('never builds a decoder for a conversion that has already been stopped', async () => {
		const controller = new AbortController();
		controller.abort();
		let passes = 0;
		const decoder = webCodecs({
			decodeTiles: () => {
				passes += 1;
				return fakeTileDecoder();
			},
		});
		await expect(decoder.decode(HDR, context({ signal: controller.signal }))).rejects.toThrow(
			CancelledError,
		);
		expect(passes).toBe(0);
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
