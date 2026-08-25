/**
 * Every format, through `convert`, the way somebody actually uses it.
 *
 * The per-codec suites build their inputs from the specification and check the
 * pixels. This one checks the wiring instead: that the format is registered at
 * all, that the sniffer recognises what the encoder wrote, that the decoder
 * chosen for it is the one the ladder says, and that a picture survives the
 * trip out and back. Every one of those has been broken at least once by an
 * encoder and a decoder that were each correct on their own.
 *
 * The pictures here go out through this package and come back through it,
 * which proves consistency rather than correctness. Correctness is the other
 * suites' job, and several of them check against files ImageMagick wrote.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert.js';
import { installDefaultCodecs, resetDefaultCodecs } from '../src/defaults.js';
import { clearRegistry, readableFormats, writableFormats } from '../src/registry.js';
import { emptyCapabilities } from '../src/detect/capabilities.js';
import { encodePng } from '../src/codecs/png/encode.js';
import { encodeGif } from '../src/codecs/gif/encode.js';
import { decodePng } from '../src/codecs/png/decode.js';
import { decodeApng } from '../src/codecs/png/apng.js';
import { createRaster } from '../src/raster/image.js';
import { sniffFormat } from '../src/detect/sniff.js';
import type { Animation, FormatId, RasterImage } from '../src/types.js';

/**
 * The environment every case here runs in.
 *
 * No canvas, no image bitmap, no video decoder: only `CompressionStream`,
 * which Node has. So every path exercised below is a pure one, which is the
 * point. A browser adds rungs above these; it never takes one away.
 */
const PURE_ONLY = emptyCapabilities({ compressionStream: true });

/** A small picture with flat regions, sharp edges and a handful of colours. */
function swatch(width = 16, height = 12, alpha = false): RasterImage {
	const image = createRaster(width, height, 'srgb', alpha);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			image.data[at] = x < width / 2 ? 220 : 30;
			image.data[at + 1] = y < height / 2 ? 200 : 40;
			image.data[at + 2] = (x + y) % 2 === 0 ? 180 : 60;
			image.data[at + 3] = alpha && x < 2 ? 0 : 255;
		}
	}
	return image;
}

/** A continuous ramp, which is what makes a quantiser show its working. */
function ramp(width = 32, height = 8): RasterImage {
	const image = createRaster(width, height, 'srgb', false);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			image.data[at] = Math.round((x / (width - 1)) * 255);
			image.data[at + 1] = Math.round((y / (height - 1)) * 255);
			image.data[at + 2] = 128;
			image.data[at + 3] = 255;
		}
	}
	return image;
}

/**
 * The largest per-channel difference between two pictures.
 *
 * The colour under a fully transparent pixel is skipped, on purpose. An
 * indexed format has one transparent entry and no way to remember what colour
 * was underneath it, so a picture round tripped through GIF or XPM comes back
 * with black where it had an invisible colour. That is not a loss of anything
 * anybody can see, and counting it would make every one of these cases look
 * lossy when only the visible half is what the format promised to keep.
 */
function maxChannelDelta(a: RasterImage, b: RasterImage): number {
	let worst = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		const alphaDelta = Math.abs((a.data[i + 3] as number) - (b.data[i + 3] as number));
		if (alphaDelta > worst) worst = alphaDelta;
		if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue;
		for (let channel = 0; channel < 3; channel += 1) {
			const delta = Math.abs((a.data[i + channel] as number) - (b.data[i + channel] as number));
			if (delta > worst) worst = delta;
		}
	}
	return worst;
}

interface FormatCase {
	readonly format: FormatId;
	/**
	 * The largest per-channel difference a round trip may show.
	 *
	 * Zero for anything that stores what it was given. Everything above zero is
	 * a format that cannot, and the number says which kind of loss: a palette,
	 * a shared exponent, or one bit per pixel.
	 */
	readonly tolerance: number;
	/** True when the format has no alpha channel and has to flatten one away. */
	readonly flattens?: boolean;
	/** The decoder the ladder should pick for it with no browser present. */
	readonly decoderId: string;
	readonly why?: string;
}

const CASES: readonly FormatCase[] = [
	{ format: 'png', tolerance: 0, decoderId: 'png-pure' },
	{ format: 'apng', tolerance: 0, decoderId: 'apng-pure' },
	{ format: 'qoi', tolerance: 0, decoderId: 'qoi-pure' },
	{ format: 'bmp', tolerance: 0, decoderId: 'bmp-pure' },
	{ format: 'tga', tolerance: 0, decoderId: 'tga-pure' },
	{ format: 'farbfeld', tolerance: 0, decoderId: 'farbfeld-pure' },
	{ format: 'tiff', tolerance: 0, decoderId: 'tiff-pure' },
	{ format: 'ras', tolerance: 0, decoderId: 'ras-pure' },
	{ format: 'pnm', tolerance: 0, decoderId: 'pnm-pure' },
	{
		format: 'gif',
		tolerance: 0,
		why: 'the swatch has six colours, so the palette is exact and nothing is lost',
		decoderId: 'gif-pure',
	},
	{
		format: 'pcx',
		tolerance: 0,
		flattens: true,
		why: 'PCX has no alpha at all, so a transparent column is composited away first',
		decoderId: 'pcx-pure',
	},
	{
		format: 'xpm',
		tolerance: 0,
		why: 'XPM writes an exact palette for a picture with few enough colours',
		decoderId: 'xpm-pure',
	},
];

describe('a picture through every format that can hold one', () => {
	it.each(CASES.map((entry) => [entry.format, entry] as const))(
		'writes and reads back a %s',
		async (_format, entry) => {
			clearRegistry();
			resetDefaultCodecs();
			installDefaultCodecs();

			const source = swatch(16, 12, !entry.flattens);
			const png = await encodePng(source);

			const written = await convert(png, { to: entry.format }, PURE_ONLY);
			expect(written.report.from, 'the source is read as a PNG').toBe('png');
			expect(written.report.to).toBe(entry.format);
			// The sniffer has to recognise what our own encoder wrote, or the
			// file is one nothing else will open either.
			expect(sniffFormat(written.bytes), `${entry.format} is recognised from its own bytes`).toBe(
				entry.format,
			);

			const back = await convert(written.bytes, { to: 'png' }, PURE_ONLY);
			expect(back.report.decoderId, `${entry.format} decoder`).toBe(entry.decoderId);
			expect(back.report.width).toBe(16);
			expect(back.report.height).toBe(12);

			const decoded = await decodePng(back.bytes);
			expect(maxChannelDelta(source, decoded), entry.why ?? entry.format).toBeLessThanOrEqual(
				entry.tolerance,
			);
		},
	);
});

describe('the formats that cannot hold the picture exactly', () => {
	it('quantises a ramp into a GIF and says nothing about it that is untrue', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const source = ramp(64, 16);
		const written = await convert(await encodePng(source), { to: 'gif' }, PURE_ONLY);
		const back = await decodePng((await convert(written.bytes, { to: 'png' }, PURE_ONLY)).bytes);
		expect(back.width).toBe(64);
		expect(back.height).toBe(16);
		// Dithered, so individual pixels move a long way while the picture as a
		// whole stays where it was. The mean is the honest measure of that and
		// the maximum is not.
		let total = 0;
		for (let i = 0; i < source.data.length; i += 1) {
			total += Math.abs((source.data[i] as number) - (back.data[i] as number));
		}
		expect(total / source.data.length).toBeLessThan(12);
	});

	it('writes an XBM as one bit and reads it back as ink and nothing', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const source = swatch(16, 12, false);
		const written = await convert(await encodePng(source), { to: 'xbm' }, PURE_ONLY);
		expect(sniffFormat(written.bytes)).toBe('xbm');
		const back = await decodePng((await convert(written.bytes, { to: 'png' }, PURE_ONLY)).bytes);
		// Every pixel is either opaque black or fully transparent. Anything else
		// would mean the reader invented a grey that one bit cannot hold.
		for (let i = 0; i < back.data.length; i += 4) {
			const alpha = back.data[i + 3] as number;
			expect(alpha === 0 || alpha === 255).toBe(true);
			if (alpha === 255) {
				expect([back.data[i], back.data[i + 1], back.data[i + 2]]).toEqual([0, 0, 0]);
			}
		}
	});

	it('writes an HDR and comes back close enough to be the same picture', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const source = ramp(32, 8);
		const written = await convert(await encodePng(source), { to: 'hdr' }, PURE_ONLY);
		expect(sniffFormat(written.bytes)).toBe('hdr');
		const back = await decodePng((await convert(written.bytes, { to: 'png' }, PURE_ONLY)).bytes);
		expect(back.width).toBe(32);
		// Radiance stores a shared exponent and the reader meters the result
		// back to a display, so this is a photographic round trip rather than a
		// lossless one. What matters is that the picture survives it.
		expect(maxChannelDelta(source, back)).toBeLessThan(48);
	});

	it('writes an Apple icon suite, which is square whatever the source was', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		// Not in the table above because an icon suite has square slots and a
		// 16 by 12 picture has to be letterboxed into one. That is the format
		// working, not the converter losing something.
		const source = swatch(32, 32, true);
		const written = await convert(await encodePng(source), { to: 'icns' }, PURE_ONLY);
		expect(sniffFormat(written.bytes)).toBe('icns');
		const back = await convert(written.bytes, { to: 'png' }, PURE_ONLY);
		expect(back.report.decoderId).toBe('icns-pure');
		expect([back.report.width, back.report.height]).toEqual([32, 32]);
		expect(maxChannelDelta(source, await decodePng(back.bytes))).toBe(0);
	});

	it('builds an icon at every size the source can honestly fill', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const source = swatch(64, 64, true);
		const written = await convert(await encodePng(source), { to: 'ico' }, PURE_ONLY);
		expect(sniffFormat(written.bytes)).toBe('ico');
		// 64, 48, 32 and 16, and nothing above the source, because an icon that
		// claims 256 and holds a blurred 64 is worse than one that admits to 64.
		expect(written.bytes[4]).toBe(4);
		const back = await convert(written.bytes, { to: 'png' }, PURE_ONLY);
		expect(back.report.width).toBe(64);
	});
});

describe('an animation through the formats that can carry one', () => {
	/** Three frames of flat colour, which makes a dropped or reordered one obvious. */
	function flashes(): Animation {
		const colours = [
			[220, 40, 40],
			[40, 200, 60],
			[50, 60, 210],
		];
		return {
			loopCount: 0,
			frames: colours.map((colour, index) => {
				const image = createRaster(8, 8, 'srgb', false);
				for (let i = 0; i < 64; i += 1) {
					image.data[i * 4] = colour[0] as number;
					image.data[i * 4 + 1] = colour[1] as number;
					image.data[i * 4 + 2] = colour[2] as number;
					image.data[i * 4 + 3] = 255;
				}
				return { image, delayMs: 100 + index * 20 };
			}),
		};
	}

	async function animatedGif(): Promise<Uint8Array> {
		const animation = flashes();
		return encodeGif(animation.frames[0]?.image as RasterImage, { animation });
	}

	it('carries every frame from a GIF into an APNG', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const result = await convert(await animatedGif(), { to: 'apng' }, PURE_ONLY);
		expect(result.report.from).toBe('gif');
		expect(result.report.frames).toBe(3);
		expect(result.report.droppedFrames).toBeUndefined();

		const decoded = await decodeApng(result.bytes);
		expect(decoded.animation.frames).toHaveLength(3);
		expect(decoded.animation.frames.map((frame) => frame.delayMs)).toEqual([100, 120, 140]);
		expect([
			decoded.animation.frames[2]?.image.data[0],
			decoded.animation.frames[2]?.image.data[1],
			decoded.animation.frames[2]?.image.data[2],
		]).toEqual([50, 60, 210]);
	});

	it('carries every frame back from an APNG into a GIF', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const apng = await convert(await animatedGif(), { to: 'apng' }, PURE_ONLY);
		const gif = await convert(apng.bytes, { to: 'gif' }, PURE_ONLY);
		expect(gif.report.from).toBe('apng');
		expect(gif.report.frames).toBe(3);
		expect(sniffFormat(gif.bytes)).toBe('gif');
	});

	it('says so when the target cannot hold the frames', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const result = await convert(await animatedGif(), { to: 'png' }, PURE_ONLY);
		expect(result.report.frames).toBeUndefined();
		expect(result.report.droppedFrames, 'a dropped animation is reported, not hidden').toBe(true);
		// The frame kept is the first one, which is the picture somebody
		// expects to see rather than an arbitrary one.
		const still = await decodePng(result.bytes);
		expect([still.data[0], still.data[1], still.data[2]]).toEqual([220, 40, 40]);
	});

	it('takes one frame when asked to, without calling it a loss', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const result = await convert(await animatedGif(), { to: 'apng', frames: 'first' }, PURE_ONLY);
		expect(result.report.frames).toBeUndefined();
		// Still reported: the animation was in the file and is not in the
		// output, and the person who asked for that still deserves to see it
		// confirmed rather than to wonder.
		expect(result.report.droppedFrames).toBe(true);
	});

	it('does not report frames for a GIF that only ever had one', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const still = await encodeGif(swatch(8, 8, false));
		const result = await convert(still, { to: 'apng' }, PURE_ONLY);
		expect(result.report.frames).toBeUndefined();
		expect(result.report.droppedFrames).toBeUndefined();
	});
});

describe('what the package offers without a browser', () => {
	it('reads everything that needs nothing from the platform', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const readable = await readableFormats(PURE_ONLY);
		for (const format of [
			'png',
			'apng',
			'gif',
			'bmp',
			'ico',
			'tiff',
			'psd',
			'dds',
			'hdr',
			'exr',
			'pcx',
			'icns',
			'ras',
			'xbm',
			'xpm',
			'qoi',
			'tga',
			'pnm',
			'farbfeld',
		] as const) {
			expect(readable.has(format), `${format} readable`).toBe(true);
		}
	});

	it('writes everything it can write without one', async () => {
		clearRegistry();
		resetDefaultCodecs();
		installDefaultCodecs();
		const writable = await writableFormats(PURE_ONLY);
		for (const format of [
			'png',
			'apng',
			'gif',
			'bmp',
			'ico',
			'icns',
			'tiff',
			'hdr',
			'exr',
			'pcx',
			'ras',
			'xbm',
			'xpm',
			'qoi',
			'tga',
			'pnm',
			'farbfeld',
		] as const) {
			expect(writable.has(format), `${format} writable`).toBe(true);
		}
		// Read only, every one of them for a different reason. PSD and DDS
		// because writing one badly is worse than not writing it, raw because
		// there is nothing to write back into, SVG because pixels do not become
		// a drawing, HEIC and JPEG XL because nothing in a browser will encode
		// either. AVIF is absent from both lists on purpose: it is writable,
		// but only where there is an AV1 encoder, and there is none here.
		for (const format of ['psd', 'dds', 'raw', 'svg', 'heic', 'jxl'] as const) {
			expect(writable.has(format), `${format} writable`).toBe(false);
		}
	});
});
