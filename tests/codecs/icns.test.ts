import { describe, expect, it } from 'vitest';

import { decodeIcns, readIcnsDirectory } from '../../src/codecs/icns/decode.js';
import { encodeIcns } from '../../src/codecs/icns/encode.js';
import { decodePng } from '../../src/codecs/png/decode.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import { ConverterError, DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

function raster(width: number, height: number, hasAlpha = false): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	for (let i = 0; i < width * height; i += 1) {
		image.data[i * 4] = (i * 7) & 0xff;
		image.data[i * 4 + 1] = (i * 13) & 0xff;
		image.data[i * 4 + 2] = (i * 29) & 0xff;
		image.data[i * 4 + 3] = hasAlpha ? (i * 3) & 0xff : 255;
	}
	return image;
}

function pixelsOf(image: RasterImage): number[] {
	return Array.from(image.data);
}

interface RawEntry {
	readonly type: string;
	readonly payload: readonly number[] | Uint8Array;
	/** Overrides the length written into the entry header. For refusal tests. */
	readonly length?: number;
}

/**
 * Assemble a suite from field values rather than from the writer.
 *
 * The decoder has to read files this package did not write, so every fixture
 * here is built from the numbers in the format directly. One built by calling
 * the writer would only prove that the two agree with each other.
 */
function buildIcns(entries: readonly RawEntry[], declared?: number): Uint8Array {
	let total = 8;
	for (const entry of entries) total += 8 + entry.payload.length;

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	out.set([0x69, 0x63, 0x6e, 0x73], 0); // 'icns'
	view.setUint32(4, declared ?? total);

	let at = 8;
	for (const entry of entries) {
		for (let i = 0; i < 4; i += 1) out[at + i] = entry.type.charCodeAt(i);
		view.setUint32(at + 4, entry.length ?? 8 + entry.payload.length);
		out.set(entry.payload, at + 8);
		at += 8 + entry.payload.length;
	}
	return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** One literal run: a count byte of n - 1, then n bytes. n is 1 to 128. */
function literal(values: readonly number[]): number[] {
	return [values.length - 1, ...values];
}

/** One repeat run: a control byte of count + 125, then the byte. count is 3 to 130. */
function repeat(value: number, count: number): number[] {
	return [count + 125, value];
}

/** A whole plane spelled as literal runs, which is always legal and never shorter. */
function literalRuns(values: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < values.length; i += 128) out.push(...literal(values.slice(i, i + 128)));
	return out;
}

/** A run of one value, in as few chunks as the format allows. */
function flatRuns(value: number, count: number): number[] {
	const out: number[] = [];
	let left = count;
	while (left >= 3) {
		const take = Math.min(130, left);
		out.push(...repeat(value, take));
		left -= take;
	}
	if (left > 0) out.push(...literal(new Array<number>(left).fill(value)));
	return out;
}

const ARGB = [0x41, 0x52, 0x47, 0x42];

/** An ARGB payload: the marker, then alpha, red, green and blue as planes. */
function argbPayload(
	alpha: readonly number[],
	red: readonly number[],
	green: readonly number[],
	blue: readonly number[],
	marker = true,
): number[] {
	return [
		...(marker ? ARGB : []),
		...literalRuns(alpha),
		...literalRuns(red),
		...literalRuns(green),
		...literalRuns(blue),
	];
}

/** A 24 bit payload: red, green and blue as planes, with no alpha anywhere. */
function rlePayload(
	red: readonly number[],
	green: readonly number[],
	blue: readonly number[],
	padding = 0,
): number[] {
	return [
		...new Array<number>(padding).fill(0),
		...literalRuns(red),
		...literalRuns(green),
		...literalRuns(blue),
	];
}

/** A square of `side` pixels whose channels are a function of the index. */
function ramp(side: number, offset: number): number[] {
	return Array.from({ length: side * side }, (_, i) => (i * 5 + offset) & 0xff);
}

/** Bytes that pass a signature check without being a decodable image. */
function pngLike(width: number, height: number): Uint8Array {
	const out = new Uint8Array(32);
	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const view = new DataView(out.buffer);
	view.setUint32(8, 13);
	out.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
	view.setUint32(16, width);
	view.setUint32(20, height);
	return out;
}

const JP2_BOX = [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
const J2K_CODESTREAM = [0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f];

/** Catch the failure a call was expected to produce, and nothing else. */
function failureOf(run: () => unknown): ConverterError {
	try {
		run();
	} catch (error) {
		if (error instanceof ConverterError) return error;
		throw error;
	}
	throw new Error('expected a typed failure, and the call returned normally');
}

async function asyncFailureOf(run: () => Promise<unknown>): Promise<ConverterError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ConverterError) return error;
		throw error;
	}
	throw new Error('expected a typed failure, and the call resolved normally');
}

async function expectRefusal(bytes: Uint8Array, pattern: RegExp): Promise<void> {
	const error = await asyncFailureOf(() => decodeIcns(bytes));
	expect(error).toBeInstanceOf(DecodeFailedError);
	expect(error.code).toBe('decode/failed');
	expect(error.message).toMatch(pattern);
}

/* ── The directory ────────────────────────────────────────────────────── */

describe('readIcnsDirectory', () => {
	it('reads a single entry and its declared total', async () => {
		const png = await encodePng(raster(16, 16));
		const file = buildIcns([{ type: 'icp4', payload: png }]);
		const directory = readIcnsDirectory(file);

		expect(directory.declaredBytes).toBe(file.length);
		expect(directory.entries).toHaveLength(1);
		expect(directory.entries[0]?.type).toBe('icp4');
		expect(Array.from(directory.entries[0]?.payload ?? [])).toEqual(Array.from(png));
	});

	it('walks several entries and keeps them in file order', () => {
		const file = buildIcns([
			{ type: 'is32', payload: [1] },
			{ type: 's8mk', payload: [2, 3] },
			{ type: 'TOC ', payload: [4, 5, 6] },
		]);

		expect(readIcnsDirectory(file).entries.map((entry) => entry.type)).toEqual([
			'is32',
			's8mk',
			'TOC ',
		]);
	});

	it('hands back a view into the input rather than a copy', () => {
		const file = buildIcns([{ type: 'is32', payload: [9, 8, 7] }]);
		const entry = readIcnsDirectory(file).entries[0];

		expect(entry?.payload.buffer).toBe(file.buffer);
		expect(Array.from(entry?.payload ?? [])).toEqual([9, 8, 7]);
	});

	it('takes an entry size from the type when the payload carries none', () => {
		const file = buildIcns([{ type: 'ic07', payload: [0x00] }]);
		const entry = readIcnsDirectory(file).entries[0];

		expect(entry?.width).toBe(128);
		expect(entry?.height).toBe(128);
	});

	it('takes a PNG entry size from its own header rather than from the type', () => {
		// The two disagree only in a damaged or hand-made file, and the payload
		// is what would actually be decoded, so the payload wins.
		const file = buildIcns([{ type: 'ic07', payload: pngLike(40, 25) }]);
		const entry = readIcnsDirectory(file).entries[0];

		expect(entry?.width).toBe(40);
		expect(entry?.height).toBe(25);
	});

	it('sizes a PNG sitting in an entry type it has never heard of', () => {
		const file = buildIcns([{ type: 'zz99', payload: pngLike(36, 36) }]);
		const entry = readIcnsDirectory(file).entries[0];

		expect(entry?.kind).toBe('png');
		expect(entry?.width).toBe(36);
	});

	it('takes no size from a payload whose first chunk is not an IHDR', () => {
		// The signature is right and everything behind it is rubbish, so the two
		// numbers at offsets 16 and 20 are whatever the rubbish spells. These
		// numbers order the entries against each other, so reading them anyway
		// would let a broken entry push a whole picture down the list.
		const liar = new Uint8Array(32);
		liar.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		const view = new DataView(liar.buffer);
		view.setUint32(8, 4); // A four byte first chunk, which IHDR never is.
		view.setUint32(16, 4000);
		view.setUint32(20, 4000);
		const entry = readIcnsDirectory(buildIcns([{ type: 'zz99', payload: liar }])).entries[0];

		expect(entry?.kind).toBe('png');
		expect(entry?.width).toBe(0);
	});

	it('marks the retina spellings and leaves the unscaled ones alone', () => {
		const file = buildIcns([
			{ type: 'icp5', payload: pngLike(32, 32) },
			{ type: 'ic11', payload: pngLike(32, 32) },
			{ type: 'SB24', payload: pngLike(48, 48) },
		]);
		const entries = readIcnsDirectory(file).entries;

		expect(entries.map((entry) => entry.retina)).toEqual([false, true, true]);
	});

	it.each([
		['icp4', 16],
		['icp5', 32],
		['icp6', 64],
		['ic07', 128],
		['ic08', 256],
		['ic09', 512],
		['ic10', 1024],
		['ic11', 32],
		['ic12', 64],
		['ic13', 256],
		['ic14', 512],
		['ic04', 16],
		['ic05', 32],
		['icsb', 18],
		['sb24', 24],
		['SB24', 48],
		['is32', 16],
		['il32', 32],
		['ih32', 48],
		['it32', 128],
	])('knows that a %s entry is %i pixels square', (type, side) => {
		const file = buildIcns([{ type, payload: [0x00] }]);
		const entry = readIcnsDirectory(file).entries[0];

		expect(entry?.width).toBe(side);
		expect(entry?.height).toBe(side);
	});

	it.each([
		['s8mk', 16],
		['l8mk', 32],
		['h8mk', 48],
		['t8mk', 128],
	])('reads %s as an alpha mask of %i pixels square', (type, side) => {
		const entry = readIcnsDirectory(buildIcns([{ type, payload: [0] }])).entries[0];

		expect(entry?.kind).toBe('mask');
		expect(entry?.width).toBe(side);
	});

	it('classifies a PNG payload by its signature', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'ic07', payload: pngLike(128, 128) }]))
			.entries[0];

		expect(entry?.kind).toBe('png');
	});

	it('classifies a JPEG 2000 signature box', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'ic09', payload: JP2_BOX }])).entries[0];

		expect(entry?.kind).toBe('jpeg2000');
	});

	it('classifies a bare JPEG 2000 codestream, which has no container around it', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'ic09', payload: J2K_CODESTREAM }]))
			.entries[0];

		expect(entry?.kind).toBe('jpeg2000');
	});

	it('classifies an ARGB payload by its marker, whatever the type says', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'zz99', payload: ARGB }])).entries[0];

		expect(entry?.kind).toBe('argb');
	});

	it('classifies an ic04 with no marker as ARGB anyway, because that is what the type is', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'ic04', payload: [0, 1, 2] }])).entries[0];

		expect(entry?.kind).toBe('argb');
	});

	it('classifies is32 as run length coded colour', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'is32', payload: [0] }])).entries[0];

		expect(entry?.kind).toBe('rle24');
	});

	it('classifies an icp4 holding something other than a PNG as run length coded', () => {
		// A handful of writers put 24 bit run length data in the icp slots. The
		// payload is sniffed rather than assumed, so both readings work.
		const entry = readIcnsDirectory(buildIcns([{ type: 'icp4', payload: [0x08, 0xff] }]))
			.entries[0];

		expect(entry?.kind).toBe('rle24');
	});

	it('classifies a PNG in an ic04 as a PNG rather than as ARGB', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'ic04', payload: pngLike(16, 16) }]))
			.entries[0];

		expect(entry?.kind).toBe('png');
	});

	it.each(['ICON', 'ICN#', 'icm#', 'icm4', 'icm8', 'ics#', 'ics4', 'ics8', 'icl4', 'icl8', 'ich#'])(
		'classifies %s as one of the classic indexed icons',
		(type) => {
			const entry = readIcnsDirectory(buildIcns([{ type, payload: [0] }])).entries[0];

			expect(entry?.kind).toBe('indexed');
		},
	);

	it.each(['TOC ', 'icnV', 'info', 'name'])(
		'classifies %s as metadata rather than a picture',
		(type) => {
			const entry = readIcnsDirectory(buildIcns([{ type, payload: [0] }])).entries[0];

			expect(entry?.kind).toBe('metadata');
		},
	);

	it('classifies an entry it has never heard of as unknown, with no size', () => {
		const entry = readIcnsDirectory(buildIcns([{ type: 'slct', payload: [1, 2, 3] }])).entries[0];

		expect(entry?.kind).toBe('unknown');
		expect(entry?.width).toBe(0);
	});

	it('stops at the declared total and ignores whatever follows it', () => {
		// One suite in three thousand on a stock macOS install has bytes after
		// its declared end, and reading those as another entry invents one.
		const file = buildIcns([{ type: 'is32', payload: [1, 2, 3] }]);
		const padded = concat(file, Uint8Array.from([0x69, 0x63, 0x30, 0x37, 0, 0, 0, 9, 0]));
		const directory = readIcnsDirectory(padded);

		expect(directory.declaredBytes).toBe(file.length);
		expect(directory.entries.map((entry) => entry.type)).toEqual(['is32']);
	});
});

/* ── Refusing a malformed container ───────────────────────────────────── */

describe('readIcnsDirectory refusals', () => {
	function expectDirectoryRefusal(bytes: Uint8Array, pattern: RegExp): void {
		const error = failureOf(() => readIcnsDirectory(bytes));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toMatch(pattern);
	}

	it.each([0, 1, 4, 7])('rejects a file cut off at %i bytes', (length) => {
		const file = buildIcns([{ type: 'is32', payload: [1] }]);
		expectDirectoryRefusal(file.subarray(0, length), /eight byte header/);
	});

	it('rejects a file that does not start with icns', () => {
		const file = buildIcns([{ type: 'is32', payload: [1] }]);
		file[1] = 0x63 + 1;
		expectDirectoryRefusal(file, /"icns" signature/);
	});

	it('rejects a declared total shorter than the header itself', () => {
		const file = buildIcns([{ type: 'is32', payload: [1] }], 4);
		expectDirectoryRefusal(file, /total length of 4 bytes/);
	});

	it('rejects a declared total larger than the file', () => {
		const file = buildIcns([{ type: 'is32', payload: [1] }], 4096);
		expectDirectoryRefusal(file, /declares 4096 bytes .* so it is truncated/);
	});

	it('rejects a header with no entries after it', () => {
		expectDirectoryRefusal(buildIcns([]), /no entries at all/);
	});

	it.each([0, 1, 7])(
		'rejects an entry whose declared length of %i would never advance the walk',
		(length) => {
			const file = buildIcns([{ type: 'ic07', payload: [1, 2, 3], length }]);
			expectDirectoryRefusal(file, /"ic07" entry declares a length/);
		},
	);

	it('rejects an entry running past the declared total', () => {
		const file = buildIcns([{ type: 'is32', payload: [1, 2, 3], length: 400 }]);
		expectDirectoryRefusal(file, /"is32" entry runs past the end/);
	});

	it('rejects bytes left over inside the declared total', () => {
		const file = concat(buildIcns([{ type: 'is32', payload: [1, 2, 3] }]), new Uint8Array(5));
		new DataView(file.buffer).setUint32(4, file.length);
		expectDirectoryRefusal(file, /5 bytes left over/);
	});

	it('replaces an unprintable type with full stops rather than putting it on a screen', () => {
		// A handful of suites on a stock install carry entries whose type is
		// binary rubbish, and an error message is the one string that gets
		// screenshot into a bug report.
		const file = buildIcns([{ type: '', payload: [1], length: 2 }]);
		expectDirectoryRefusal(file, /"\.\.\.\." entry declares a length of 2/);
	});
});

/* ── PNG entries ──────────────────────────────────────────────────────── */

describe('decodeIcns with PNG entries', () => {
	it('decodes the picture out of a PNG entry', async () => {
		const source = raster(16, 16);
		const file = buildIcns([{ type: 'icp4', payload: await encodePng(source) }]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(source));
	});

	it('carries alpha through from the PNG', async () => {
		const source = raster(16, 16, true);
		const file = buildIcns([{ type: 'icp4', payload: await encodePng(source) }]);
		const image = await decodeIcns(file);

		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual(pixelsOf(source));
	});

	it('chooses the largest entry rather than the first', async () => {
		const small = await encodePng(raster(16, 16));
		const large = raster(64, 64);
		const file = buildIcns([
			{ type: 'icp4', payload: small },
			{ type: 'ic12', payload: await encodePng(large) },
			{ type: 'icp5', payload: await encodePng(raster(32, 32)) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(large));
	});

	it('prefers the unscaled spelling to the retina one at the same pixel size', async () => {
		// icp5 is a 32 point icon and ic11 is a 16 point icon drawn at twice the
		// scale. Both are 32 pixels; the first is the one somebody converting
		// the file meant.
		const unscaled = raster(32, 32);
		const file = buildIcns([
			{ type: 'ic11', payload: await encodePng(raster(32, 32, true)) },
			{ type: 'icp5', payload: await encodePng(unscaled) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(unscaled));
	});

	it('keeps the first entry when two unscaled ones are the same size', async () => {
		const first = raster(16, 16);
		const file = buildIcns([
			{ type: 'ic04', payload: await encodePng(first) },
			{ type: 'icp4', payload: await encodePng(raster(16, 16, true)) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(first));
	});

	it('takes the retina entry when it is the larger one', async () => {
		const retina = raster(64, 64);
		const file = buildIcns([
			{ type: 'icp5', payload: await encodePng(raster(32, 32)) },
			{ type: 'ic12', payload: await encodePng(retina) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(retina));
	});

	it('decodes a PNG sitting in an entry type it does not know', async () => {
		const source = raster(36, 36);
		const file = buildIcns([{ type: 'icsB', payload: await encodePng(source) }]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(source));
	});

	it('skips a metadata entry rather than trying to decode it', async () => {
		const source = raster(16, 16);
		const file = buildIcns([
			{ type: 'TOC ', payload: [0x69, 0x63, 0x70, 0x34, 0, 0, 0, 20] },
			{ type: 'icp4', payload: await encodePng(source) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(source));
	});

	it('names the entry when the PNG inside it is damaged, and keeps the reason', async () => {
		// A signature and a header chunk whose declared length runs past the end
		// of the payload, so the PNG decoder is the one that gives up.
		const error = await asyncFailureOf(() =>
			decodeIcns(buildIcns([{ type: 'icp4', payload: pngLike(16, 16) }])),
		);

		expect(error.message).toMatch(/PNG inside its "icp4" entry could not be read/);
		expect(error.cause).toBeInstanceOf(Error);
	});

	it('falls back to the size in the type when the PNG is too short to carry one', async () => {
		// Eight bytes of signature and nothing else: there is no header chunk to
		// read a size out of, so the slot's own size stands and the PNG decoder
		// is left to say what is wrong with it.
		const file = buildIcns([
			{ type: 'icp5', payload: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
		]);

		expect(readIcnsDirectory(file).entries[0]?.width).toBe(32);
		await expectRefusal(file, /PNG inside its "icp5" entry could not be read/);
	});

	it('refuses a PNG claiming a size no icon has, before decoding it', async () => {
		const file = buildIcns([{ type: 'ic10', payload: pngLike(60000, 60000) }]);
		await expectRefusal(file, /60000 by 60000 pixels, which is far larger than any icon/);
	});

	it('falls back to a smaller entry when the largest PNG will not decode', async () => {
		// A suite is one drawing stored several times over, so an entry that
		// will not unpack costs the file its best size and nothing else. A JPEG
		// 2000 in the same slot has always been stepped over; a damaged PNG has
		// no claim to worse treatment.
		const source = raster(32, 32);
		const file = buildIcns([
			{ type: 'icp5', payload: await encodePng(source) },
			{ type: 'ic09', payload: pngLike(512, 512) },
		]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(32);
		expect(pixelsOf(image)).toEqual(pixelsOf(source));
	});

	it('falls back past a PNG claiming a size no icon has', async () => {
		const file = buildIcns([
			{ type: 'icp5', payload: await encodePng(raster(32, 32)) },
			{ type: 'ic10', payload: pngLike(60000, 60000) },
		]);

		expect((await decodeIcns(file)).width).toBe(32);
	});

	it('falls back from a truncated ARGB entry to the sound PNG beside it', async () => {
		const flat = new Array<number>(32 * 32).fill(3);
		const source = raster(16, 16);
		const file = buildIcns([
			{ type: 'ic05', payload: argbPayload(flat, flat, flat, flat).slice(0, 40) },
			{ type: 'icp4', payload: await encodePng(source) },
		]);

		expect(pixelsOf(await decodeIcns(file))).toEqual(pixelsOf(source));
	});

	it('names the largest entry when every entry in the file fails', async () => {
		// The largest is the picture the caller asked for, so it is the one the
		// sentence should be about, whatever the ones below it went wrong with.
		const file = buildIcns([
			{ type: 'icp4', payload: pngLike(16, 16) },
			{ type: 'ic09', payload: pngLike(512, 512) },
		]);

		await expectRefusal(file, /PNG inside its "ic09" entry could not be read/);
	});
});

/* ── ARGB entries ─────────────────────────────────────────────────────── */

describe('decodeIcns with ARGB entries', () => {
	it('reads alpha, red, green and blue as four separate planes', async () => {
		const file = buildIcns([
			{
				type: 'ic04',
				payload: argbPayload(ramp(16, 0), ramp(16, 1), ramp(16, 2), ramp(16, 3)),
			},
		]);
		const image = await decodeIcns(file);
		const alpha = ramp(16, 0);
		const red = ramp(16, 1);

		expect(image.width).toBe(16);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([
			red[0] as number,
			ramp(16, 2)[0] as number,
			ramp(16, 3)[0] as number,
			alpha[0] as number,
		]);
		expect(image.data[255 * 4 + 3]).toBe(alpha[255] as number);
	});

	it('reads an ic05 with no ARGB marker in front of it', async () => {
		const flat = new Array<number>(1024).fill(7);
		const file = buildIcns([{ type: 'ic05', payload: argbPayload(flat, flat, flat, flat, false) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(32);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([7, 7, 7, 7]);
	});

	it('reads the sidebar size, which is 18 pixels square', async () => {
		const flat = new Array<number>(18 * 18).fill(200);
		const file = buildIcns([{ type: 'icsb', payload: argbPayload(flat, flat, flat, flat) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(18);
		expect(image.height).toBe(18);
	});

	it('expands a repeat run the way the format counts one', async () => {
		// A control byte of 128 or over repeats the byte after it that many
		// minus 125 times, so 0x80 is three and 0xff is a hundred and thirty.
		const pixels = 16 * 16;
		const payload = [
			...ARGB,
			...flatRuns(0xff, pixels),
			...repeat(0x10, 130),
			...flatRuns(0x20, pixels - 130),
			...flatRuns(0x30, pixels),
			...flatRuns(0x40, pixels),
		];
		const image = await decodeIcns(buildIcns([{ type: 'ic04', payload }]));

		expect(Array.from(image.data.subarray(0, 4))).toEqual([0x10, 0x30, 0x40, 0xff]);
		expect(Array.from(image.data.subarray(130 * 4, 130 * 4 + 4))).toEqual([0x20, 0x30, 0x40, 0xff]);
	});

	it('reports an opaque ARGB entry as opaque', async () => {
		const opaque = new Array<number>(256).fill(255);
		const flat = new Array<number>(256).fill(9);
		const file = buildIcns([{ type: 'ic04', payload: argbPayload(opaque, flat, flat, flat) }]);

		expect((await decodeIcns(file)).hasAlpha).toBe(false);
	});

	it('reports a translucent ARGB entry as having alpha', async () => {
		const alpha = new Array<number>(256).fill(255);
		alpha[9] = 0;
		const flat = new Array<number>(256).fill(9);
		const file = buildIcns([{ type: 'ic04', payload: argbPayload(alpha, flat, flat, flat) }]);

		expect((await decodeIcns(file)).hasAlpha).toBe(true);
	});

	it('refuses an ARGB stream that stops before the last plane', async () => {
		// Cut on a run boundary, so the stream simply ends rather than ending
		// in the middle of a run. Both are refused; they are different sentences.
		const flat = new Array<number>(256).fill(3);
		const payload = argbPayload(flat, flat, flat, flat);
		const file = buildIcns([{ type: 'ic04', payload: payload.slice(0, 4 + 258 * 3) }]);

		await expectRefusal(file, /ARGB runs of its "ic04" entry ends after 768 of the 1024 bytes/);
	});

	it('refuses an ARGB stream cut off in the middle of a run', async () => {
		const flat = new Array<number>(256).fill(3);
		const payload = argbPayload(flat, flat, flat, flat);
		const file = buildIcns([{ type: 'ic04', payload: payload.slice(0, payload.length - 200) }]);

		await expectRefusal(file, /literal run in the ARGB runs of its "ic04" entry runs past/);
	});
});

/* ── The classic 24 bit entries ───────────────────────────────────────── */

describe('decodeIcns with run length coded entries', () => {
	it('reads is32 as three colour planes and leaves it opaque with no mask', async () => {
		const red = ramp(16, 0);
		const green = ramp(16, 100);
		const blue = ramp(16, 200);
		const file = buildIcns([{ type: 'is32', payload: rlePayload(red, green, blue) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(16);
		expect(image.hasAlpha).toBe(false);
		expect(Array.from(image.data.subarray(0, 8))).toEqual([
			red[0] as number,
			green[0] as number,
			blue[0] as number,
			255,
			red[1] as number,
			green[1] as number,
			blue[1] as number,
			255,
		]);
	});

	it('reads il32, which is 32 pixels square', async () => {
		const plane = new Array<number>(1024).fill(60);
		const file = buildIcns([{ type: 'il32', payload: rlePayload(plane, plane, plane) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(32);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([60, 60, 60, 255]);
	});

	it('reads ih32, which is 48 pixels square', async () => {
		const plane = new Array<number>(48 * 48).fill(70);
		const file = buildIcns([{ type: 'ih32', payload: rlePayload(plane, plane, plane) }]);

		expect((await decodeIcns(file)).width).toBe(48);
	});

	it('skips the four padding bytes an it32 entry begins with', async () => {
		// Leaving them in front of the stream makes the first control byte a
		// literal run of one and shifts every plane along by a pixel.
		const pixels = 128 * 128;
		const red = new Array<number>(pixels).fill(11);
		const green = new Array<number>(pixels).fill(22);
		const blue = new Array<number>(pixels).fill(33);
		const file = buildIcns([{ type: 'it32', payload: rlePayload(red, green, blue, 4) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(128);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([11, 22, 33, 255]);
	});

	it('refuses an it32 entry too short to hold its own padding', async () => {
		const file = buildIcns([{ type: 'it32', payload: [0, 0] }]);
		await expectRefusal(file, /too short to hold the four padding bytes/);
	});

	it.each([
		['is32', 's8mk', 16, 0],
		['il32', 'l8mk', 32, 0],
		['ih32', 'h8mk', 48, 0],
		// The it32 pad belongs to the coded form, so its row carries one. It is
		// the largest of the classic sizes and the one most easily left out.
		['it32', 't8mk', 128, 4],
	])('takes the alpha of a %s entry from its %s mask', async (colour, mask, side, padding) => {
		const pixels = side * side;
		const plane = new Array<number>(pixels).fill(80);
		const alpha = new Array<number>(pixels).fill(255);
		alpha[0] = 0;
		alpha[1] = 128;
		const file = buildIcns([
			{ type: colour, payload: rlePayload(plane, plane, plane, padding) },
			{ type: mask, payload: alpha },
		]);
		const image = await decodeIcns(file);

		expect(image.hasAlpha).toBe(true);
		expect(image.data[3]).toBe(0);
		expect(image.data[7]).toBe(128);
		expect(image.data[11]).toBe(255);
	});

	it('finds the mask wherever it sits in the file', async () => {
		const plane = new Array<number>(256).fill(80);
		const alpha = new Array<number>(256).fill(64);
		const file = buildIcns([
			{ type: 's8mk', payload: alpha },
			{ type: 'TOC ', payload: [0] },
			{ type: 'is32', payload: rlePayload(plane, plane, plane) },
		]);

		expect((await decodeIcns(file)).data[3]).toBe(64);
	});

	it('refuses a mask that is shorter than the picture it covers', async () => {
		const plane = new Array<number>(256).fill(80);
		const file = buildIcns([
			{ type: 'is32', payload: rlePayload(plane, plane, plane) },
			{ type: 's8mk', payload: new Array<number>(100).fill(255) },
		]);

		await expectRefusal(file, /"s8mk" mask holds 100 bytes, and a 16 by 16 mask needs 256/);
	});

	it('reads an icp4 that holds run length data instead of a PNG', async () => {
		const plane = new Array<number>(256).fill(90);
		const file = buildIcns([{ type: 'icp4', payload: rlePayload(plane, plane, plane) }]);
		const image = await decodeIcns(file);

		expect(image.width).toBe(16);
		expect(Array.from(image.data.subarray(0, 4))).toEqual([90, 90, 90, 255]);
	});

	it('reads a literal run of the full 128 bytes', async () => {
		const values = Array.from({ length: 128 }, (_, i) => i);
		const rest = new Array<number>(128).fill(0);
		const payload = [
			...literal(values),
			...literalRuns(rest),
			...literalRuns(new Array<number>(256).fill(1)),
			...literalRuns(new Array<number>(256).fill(2)),
		];
		const image = await decodeIcns(buildIcns([{ type: 'is32', payload }]));

		expect(image.data[0]).toBe(0);
		expect(image.data[127 * 4]).toBe(127);
	});

	it('truncates a final run that overshoots the last plane', async () => {
		// Writers round the last run up. Refusing that would turn away files
		// every other reader opens, and the extra bytes describe nothing.
		const plane = new Array<number>(256).fill(5);
		const payload = [
			...literalRuns(plane),
			...literalRuns(plane),
			...literalRuns(plane.slice(0, 200)),
			...repeat(6, 130),
		];
		const image = await decodeIcns(buildIcns([{ type: 'is32', payload }]));

		expect(image.data[199 * 4 + 2]).toBe(5);
		expect(image.data[255 * 4 + 2]).toBe(6);
	});

	it('truncates a literal run that overshoots the last plane', async () => {
		const plane = new Array<number>(256).fill(5);
		const payload = [
			...literalRuns(plane),
			...literalRuns(plane),
			...literalRuns(plane.slice(0, 200)),
			...literal(new Array<number>(100).fill(6)),
		];
		const image = await decodeIcns(buildIcns([{ type: 'is32', payload }]));

		expect(image.data[255 * 4 + 2]).toBe(6);
	});

	it('refuses a stream that runs out before the planes are full', async () => {
		const plane = new Array<number>(256).fill(5);
		const file = buildIcns([{ type: 'is32', payload: literalRuns(plane) }]);

		await expectRefusal(file, /colour runs of its "is32" entry ends after 256 of the 768 bytes/);
	});

	it('refuses a literal run whose bytes are not all there', async () => {
		// A count of 128 literals with only two bytes behind it.
		const file = buildIcns([{ type: 'is32', payload: [127, 1, 2] }]);

		await expectRefusal(file, /literal run in the colour runs of its "is32" entry runs past/);
	});

	it('refuses a repeat with no byte after it to repeat', async () => {
		const file = buildIcns([{ type: 'is32', payload: [0xff] }]);

		await expectRefusal(file, /repeat in the colour runs of its "is32" entry has no byte/);
	});

	it('reads an uncompressed entry, which is what a length of four bytes a pixel means', async () => {
		// A few writers, Microsoft Office among them, store these entries as
		// interleaved ARGB with no compression at all. The alpha byte of that
		// form is zero throughout and the mask is what carries transparency.
		const payload: number[] = [];
		for (let i = 0; i < 256; i += 1) payload.push(0, 10 + i, 20, 30);
		const file = buildIcns([
			{ type: 'is32', payload },
			{ type: 's8mk', payload: new Array<number>(256).fill(200) },
		]);
		const image = await decodeIcns(file);

		expect(Array.from(image.data.subarray(0, 8))).toEqual([10, 20, 30, 200, 11, 20, 30, 200]);
	});

	it('leaves an uncompressed entry opaque when no mask sits beside it', async () => {
		const payload: number[] = [];
		for (let i = 0; i < 256; i += 1) payload.push(0, 40, 50, 60);
		const image = await decodeIcns(buildIcns([{ type: 'is32', payload }]));

		expect(Array.from(image.data.subarray(0, 4))).toEqual([40, 50, 60, 255]);
	});

	it('reads an uncompressed it32, which carries no padding in front of it', async () => {
		// The four zero bytes belong to the coded form of it32 and to nothing
		// else. The five suites inside Microsoft Office that hold this form are
		// exactly 128 by 128 by four bytes and begin `00 ff ff ff`, so taking
		// the padding off before testing the length leaves 65532 against 65536,
		// misses the test, and sends a picture that was never coded through the
		// unpacker, which does not fail: it produces noise.
		const pixels = 128 * 128;
		const payload = new Uint8Array(pixels * 4);
		for (let i = 0; i < pixels; i += 1) payload.set([0, 0xff, 20 + (i & 7), 30], i * 4);
		const image = await decodeIcns(buildIcns([{ type: 'it32', payload }]));

		expect(image.width).toBe(128);
		expect(Array.from(image.data.subarray(0, 8))).toEqual([0xff, 20, 30, 255, 0xff, 21, 30, 255]);
		expect(Array.from(image.data.subarray((pixels - 1) * 4, pixels * 4))).toEqual([
			0xff,
			20 + ((pixels - 1) & 7),
			30,
			255,
		]);
	});

	it('takes the alpha of an uncompressed it32 from its t8mk mask', async () => {
		// Which is the shape of the Office files: a raw it32 with a mask beside
		// it, because the alpha byte inside the entry is zero throughout.
		const pixels = 128 * 128;
		const payload = new Uint8Array(pixels * 4);
		for (let i = 0; i < pixels; i += 1) payload.set([0, 90, 100, 110], i * 4);
		const alpha = new Uint8Array(pixels).fill(255);
		alpha[0] = 0;
		const image = await decodeIcns(
			buildIcns([
				{ type: 'it32', payload },
				{ type: 't8mk', payload: alpha },
			]),
		);

		expect(image.hasAlpha).toBe(true);
		expect(Array.from(image.data.subarray(0, 8))).toEqual([90, 100, 110, 0, 90, 100, 110, 255]);
	});

	it('does not mistake a compressed entry of exactly three bytes a pixel for an uncompressed one', async () => {
		// An is32 that compresses down to exactly 768 bytes occurs on a stock
		// macOS install, so the uncompressed test has to be four bytes a pixel
		// and never three. The run stream below is built to land on 768 bytes:
		// five repeats costing ten bytes and producing sixteen, then 752 bytes
		// of literals in six runs costing 758.
		const expected: number[] = [];
		for (let i = 0; i < 16; i += 1)
			expected.push(i < 3 ? 1 : i < 6 ? 2 : i < 9 ? 3 : i < 12 ? 4 : 5);
		for (let i = 16; i < 768; i += 1) expected.push((i * 3) & 0xff);

		const payload = [
			...repeat(1, 3),
			...repeat(2, 3),
			...repeat(3, 3),
			...repeat(4, 3),
			...repeat(5, 4),
			...literalRuns(expected.slice(16)),
		];
		expect(payload.length).toBe(768);

		const image = await decodeIcns(buildIcns([{ type: 'is32', payload }]));
		expect(Array.from(image.data.subarray(0, 4))).toEqual([
			expected[0] as number,
			expected[256] as number,
			expected[512] as number,
			255,
		]);
		expect(image.data[15 * 4]).toBe(expected[15] as number);
	});
});

/* ── Refusing what it does not implement ──────────────────────────────── */

describe('decodeIcns refusals', () => {
	it('refuses a suite whose icons are all JPEG 2000, and names the entries', async () => {
		const file = buildIcns([
			{ type: 'ic08', payload: JP2_BOX },
			{ type: 'ic09', payload: JP2_BOX },
		]);

		await expectRefusal(
			file,
			/stored as JPEG 2000 \(ic08, ic09\), which this reader does not decode/,
		);
	});

	it('refuses the classic indexed icons by name', async () => {
		const file = buildIcns([
			{ type: 'icl8', payload: [0, 1, 2] },
			{ type: 'ICN#', payload: [0, 1, 2] },
		]);

		await expectRefusal(file, /classic indexed icons \(icl8, ICN#\).*system colour palettes/);
	});

	it('says JPEG 2000 first when a suite holds both, because that is the newer half', async () => {
		const file = buildIcns([
			{ type: 'icl8', payload: [0] },
			{ type: 'ic09', payload: JP2_BOX },
		]);

		await expectRefusal(file, /JPEG 2000/);
	});

	it('lists what it found when nothing in the file is a picture at all', async () => {
		const file = buildIcns([
			{ type: 'TOC ', payload: [0] },
			{ type: 'slct', payload: [1] },
		]);

		await expectRefusal(file, /no picture this reader can unpack: its entries are TOC , slct/);
	});

	it('names each type once, however many entries carry it', async () => {
		const file = buildIcns([
			{ type: 'icl8', payload: [0] },
			{ type: 'icl8', payload: [1] },
		]);

		await expectRefusal(file, /\(icl8\)/);
	});

	it('replaces an unprintable type in the list rather than putting it on a screen', async () => {
		const file = buildIcns([{ type: 'ýÙ/¨', payload: [1] }]);

		await expectRefusal(file, /its entries are \.\.\/\./);
	});
});

/* ── Writing ──────────────────────────────────────────────────────────── */

describe('encodeIcns', () => {
	it('writes the signature and a total length that matches the buffer', async () => {
		const out = await encodeIcns(raster(16, 16));
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

		expect(Array.from(out.subarray(0, 4))).toEqual([0x69, 0x63, 0x6e, 0x73]);
		expect(view.getUint32(4)).toBe(out.length);
	});

	it('writes each entry with a length that counts its own header', async () => {
		const out = await encodeIcns(raster(16, 16));
		const directory = readIcnsDirectory(out);
		const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

		expect(view.getUint32(12)).toBe(8 + (directory.entries[0]?.payload.length ?? 0));
	});

	it('writes every slot the source is large enough to fill', async () => {
		const out = await encodeIcns(raster(128, 128));

		expect(readIcnsDirectory(out).entries.map((entry) => entry.type)).toEqual([
			'icp4',
			'icp5',
			'ic11',
			'ic12',
			'ic07',
		]);
	});

	it('never claims a size larger than the source', async () => {
		// A 64 pixel drawing enlarged to 1024 is four blurred megapixels
		// claiming to be artwork, and macOS shows that claim at full size.
		const types = readIcnsDirectory(await encodeIcns(raster(64, 64))).entries.map((e) => e.type);

		expect(types).toEqual(['icp4', 'icp5', 'ic11', 'ic12']);
	});

	it('measures against the longer side, so a wide image still fills its slots', async () => {
		const types = readIcnsDirectory(await encodeIcns(raster(100, 40))).entries.map((e) => e.type);

		expect(types).toEqual(['icp4', 'icp5', 'ic11', 'ic12']);
	});

	it('still writes one entry for a source smaller than the smallest slot', async () => {
		// A suite with no entries in it is not a file anything will open.
		const directory = readIcnsDirectory(await encodeIcns(raster(8, 8)));

		expect(directory.entries.map((entry) => entry.type)).toEqual(['icp4']);
		expect(directory.entries[0]?.width).toBe(16);
	});

	it('writes a PNG into every entry', async () => {
		const directory = readIcnsDirectory(await encodeIcns(raster(64, 64)));

		expect(directory.entries.every((entry) => entry.kind === 'png')).toBe(true);
	});

	it('writes the same bytes into the two spellings of one size', async () => {
		const directory = readIcnsDirectory(await encodeIcns(raster(32, 32)));
		const unscaled = directory.entries.find((entry) => entry.type === 'icp5');
		const retina = directory.entries.find((entry) => entry.type === 'ic11');

		expect(Array.from(retina?.payload ?? [])).toEqual(Array.from(unscaled?.payload ?? []));
	});

	it('scales each entry to the size its type promises', async () => {
		const directory = readIcnsDirectory(await encodeIcns(raster(64, 64)));

		expect(directory.entries.map((entry) => entry.width)).toEqual([16, 32, 32, 64]);
	});

	it('fits a non-square source inside the square and pads it transparently', async () => {
		const out = await encodeIcns(raster(64, 32));
		const entry = readIcnsDirectory(out).entries.find((one) => one.type === 'ic12');
		const image = await decodePng(entry?.payload ?? new Uint8Array(0));

		expect(image.width).toBe(64);
		expect(image.height).toBe(64);
		// The top row is padding, and the middle row is picture.
		expect(image.data[3]).toBe(0);
		expect(image.data[(32 * 64 + 5) * 4 + 3]).toBe(255);
	});

	it('round trips a square source through its own reader', async () => {
		const source = raster(32, 32, true);
		const image = await decodeIcns(await encodeIcns(source));

		expect(image.width).toBe(32);
		expect(image.hasAlpha).toBe(true);
		expect(pixelsOf(image)).toEqual(pixelsOf(source));
	});

	it('returns the largest slot when its own file is read back', async () => {
		const image = await decodeIcns(await encodeIcns(raster(128, 128)));

		expect(image.width).toBe(128);
	});

	it('passes an ICC profile through to every entry', async () => {
		const profile = Uint8Array.from({ length: 40 }, (_, i) => i);
		const out = await encodeIcns(raster(16, 16), { iccProfile: profile });
		const payload = readIcnsDirectory(out).entries[0]?.payload ?? new Uint8Array(0);
		let found = false;
		for (let i = 0; i + 4 <= payload.length; i += 1) {
			if (
				payload[i] === 0x69 &&
				payload[i + 1] === 0x43 &&
				payload[i + 2] === 0x43 &&
				payload[i + 3] === 0x50
			) {
				found = true;
			}
		}

		expect(found).toBe(true);
	});

	it.each([
		[0, 16],
		[16, 0],
		[-1, 16],
		[1.5, 16],
	])('refuses an image measuring %s by %s', async (width, height) => {
		const image = { ...createRaster(1, 1), width, height };
		const error = await asyncFailureOf(() => encodeIcns(image));

		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.message).toMatch(/no width or no height/);
	});

	it('refuses a pixel buffer smaller than the size claims', async () => {
		const image = { ...createRaster(4, 4), width: 16, height: 16 };
		const error = await asyncFailureOf(() => encodeIcns(image));

		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.message).toMatch(/smaller than the width and height/);
	});
});
