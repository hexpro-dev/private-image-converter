import { describe, expect, it } from 'vitest';

import { encodeIco } from '../../src/codecs/ico/encode.js';
import { decodeIco, readIcoDirectory } from '../../src/codecs/ico/decode.js';
import { encodePng } from '../../src/codecs/png/encode.js';
import {
	ConverterError,
	DecodeFailedError,
	EncodeFailedError,
	ImageTooLargeError,
	UnsupportedHereError,
} from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';

/* ── Helpers ──────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes that pass the writer's signature check without being a real image. */
function pngLike(length: number, filler = 0xab): Uint8Array {
	const out = new Uint8Array(Math.max(length, PNG_SIGNATURE.length));
	out.fill(filler);
	out.set(PNG_SIGNATURE, 0);
	return out;
}

/** Catch the failure a call was expected to produce, and nothing else. */
function failureOf(fn: () => unknown): ConverterError {
	try {
		fn();
	} catch (error) {
		if (error instanceof ConverterError) return error;
		throw error;
	}
	throw new Error('expected a typed failure, and the call returned normally');
}

interface RawEntry {
	readonly width: number;
	readonly height: number;
	readonly payload: Uint8Array;
	readonly bitCount?: number;
}

/** Assemble a container by hand, so payloads that the writer would refuse can be tested. */
function buildIco(entries: readonly RawEntry[], type = 1): Uint8Array {
	const directoryBytes = 6 + entries.length * 16;
	let total = directoryBytes;
	for (const entry of entries) total += entry.payload.length;

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true);
	view.setUint16(2, type, true);
	view.setUint16(4, entries.length, true);

	let offset = directoryBytes;
	entries.forEach((entry, index) => {
		const at = 6 + index * 16;
		out[at] = entry.width === 256 ? 0 : entry.width;
		out[at + 1] = entry.height === 256 ? 0 : entry.height;
		view.setUint16(at + 4, 1, true);
		view.setUint16(at + 6, entry.bitCount ?? 32, true);
		view.setUint32(at + 8, entry.payload.length, true);
		view.setUint32(at + 12, offset, true);
		out.set(entry.payload, offset);
		offset += entry.payload.length;
	});
	return out;
}

interface DibSpec {
	readonly width: number;
	/** What the header claims, doubled or not, positive or negative. */
	readonly declaredHeight: number;
	readonly bitCount: number;
	/** Unpadded row bytes, top row first. Padding to the four byte stride is added here. */
	readonly rows: readonly (readonly number[])[];
	readonly palette?: readonly (readonly [number, number, number])[];
	/** One flag per pixel, top row first. True means transparent. */
	readonly mask?: readonly (readonly boolean[])[];
	readonly topDown?: boolean;
	readonly compression?: number;
	readonly colourCount?: number;
}

function buildDib(spec: DibSpec): Uint8Array {
	const palette = spec.palette ?? [];
	const maskRows = spec.mask ?? [];
	const stride = Math.ceil((spec.width * spec.bitCount) / 32) * 4;
	const maskStride = Math.ceil(spec.width / 32) * 4;
	const pixelStart = 40 + palette.length * 4;
	const maskStart = pixelStart + stride * spec.rows.length;

	const out = new Uint8Array(maskStart + maskStride * maskRows.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 40, true);
	view.setInt32(4, spec.width, true);
	view.setInt32(8, spec.declaredHeight, true);
	view.setUint16(12, 1, true);
	view.setUint16(14, spec.bitCount, true);
	view.setUint32(16, spec.compression ?? 0, true);
	view.setUint32(20, stride * spec.rows.length, true);
	view.setUint32(32, spec.colourCount ?? palette.length, true);

	palette.forEach((colour, index) => {
		const at = 40 + index * 4;
		out[at] = colour[2];
		out[at + 1] = colour[1];
		out[at + 2] = colour[0];
	});

	// A bottom-up bitmap stores its last row first, which is the normal case.
	const rows = spec.topDown ? spec.rows : [...spec.rows].reverse();
	rows.forEach((row, index) => out.set(Uint8Array.from(row), pixelStart + index * stride));

	const masks = spec.topDown ? maskRows : [...maskRows].reverse();
	masks.forEach((row, index) => {
		const at = maskStart + index * maskStride;
		row.forEach((transparent, x) => {
			if (!transparent) return;
			const byte = at + (x >> 3);
			out[byte] = (out[byte] as number) | (0x80 >> (x & 7));
		});
	});
	return out;
}

function pixels(bytes: Uint8ClampedArray): number[] {
	return Array.from(bytes);
}

/* ── Writing the directory ────────────────────────────────────────────── */

describe('encodeIco', () => {
	it('writes the six byte header and the sixteen byte entry the specification defines', () => {
		const png = pngLike(10);
		const ico = encodeIco([{ width: 16, height: 16, png }]);

		expect(ico.length).toBe(6 + 16 + 10);

		// ICONDIR is reserved 0, type 1, count 1. ICONDIRENTRY is width, height,
		// palette size, reserved, planes 1, depth 32, then the payload's length
		// and its offset, all little endian.
		expect(Array.from(ico.subarray(0, 22))).toEqual([
			0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 16, 16, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x0a, 0x00,
			0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
		]);

		// The same bytes again as the fields they are, so a failure above says
		// which field moved rather than only that something did.
		const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
		expect(view.getUint16(0, true)).toBe(0); // reserved
		expect(view.getUint16(2, true)).toBe(1); // type: 1 is an icon
		expect(view.getUint16(4, true)).toBe(1); // image count
		expect(ico[6]).toBe(16); // width
		expect(ico[7]).toBe(16); // height
		expect(ico[8]).toBe(0); // palette size
		expect(ico[9]).toBe(0); // reserved
		expect(view.getUint16(10, true)).toBe(1); // colour planes
		expect(view.getUint16(12, true)).toBe(32); // bits per pixel
		expect(view.getUint32(14, true)).toBe(10); // payload length
		expect(view.getUint32(18, true)).toBe(22); // payload offset, just past the directory

		expect(Array.from(ico.subarray(22))).toEqual(Array.from(png));
	});

	it('writes 256 as a zero byte, because a side does not fit in eight bits', () => {
		const ico = encodeIco([{ width: 256, height: 256, png: pngLike(8) }]);
		expect(ico[6]).toBe(0);
		expect(ico[7]).toBe(0);
	});

	it('keeps odd sides literal', () => {
		const ico = encodeIco([{ width: 17, height: 33, png: pngLike(8) }]);
		expect(ico[6]).toBe(17);
		expect(ico[7]).toBe(33);
	});

	it('writes a single pixel icon', () => {
		const ico = encodeIco([{ width: 1, height: 1, png: pngLike(9) }]);
		expect(ico[6]).toBe(1);
		expect(ico[7]).toBe(1);
		expect(ico.length).toBe(6 + 16 + 9);
	});

	it('lays several images out in the order given, each at its declared offset', () => {
		const small = pngLike(12, 0x11);
		const medium = pngLike(20, 0x22);
		const large = pngLike(31, 0x33);
		const ico = encodeIco([
			{ width: 16, height: 16, png: small },
			{ width: 32, height: 32, png: medium },
			{ width: 256, height: 256, png: large },
		]);

		const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
		expect(view.getUint16(4, true)).toBe(3);
		expect(ico.length).toBe(6 + 48 + 12 + 20 + 31);

		const expected = [
			{ side: 16, payload: small },
			{ side: 32, payload: medium },
			{ side: 0, payload: large },
		];
		let offset = 6 + 48;
		expected.forEach((entry, index) => {
			const at = 6 + index * 16;
			expect(ico[at]).toBe(entry.side);
			expect(ico[at + 1]).toBe(entry.side);
			expect(view.getUint32(at + 8, true)).toBe(entry.payload.length);
			expect(view.getUint32(at + 12, true)).toBe(offset);
			expect(Array.from(ico.subarray(offset, offset + entry.payload.length))).toEqual(
				Array.from(entry.payload),
			);
			offset += entry.payload.length;
		});
	});

	it('refuses a side above 256, which the directory cannot express', () => {
		const error = failureOf(() => encodeIco([{ width: 257, height: 16, png: pngLike(8) }]));
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.code).toBe('encode/failed');
		expect(error.message).toContain('256');
		expect(error.message.endsWith('.')).toBe(true);
	});

	it('refuses a height above 256 as well as a width', () => {
		const error = failureOf(() => encodeIco([{ width: 16, height: 512, png: pngLike(8) }]));
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.message).toContain('height');
	});

	it('refuses a side that is zero or not a whole number', () => {
		expect(failureOf(() => encodeIco([{ width: 0, height: 16, png: pngLike(8) }]))).toBeInstanceOf(
			EncodeFailedError,
		);
		expect(
			failureOf(() => encodeIco([{ width: 16.5, height: 16, png: pngLike(8) }])),
		).toBeInstanceOf(EncodeFailedError);
	});

	it('refuses an icon with no images in it', () => {
		const error = failureOf(() => encodeIco([]));
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.code).toBe('encode/failed');
	});

	it('refuses a payload that is not a PNG, because it copies rather than encodes', () => {
		const notPng = Uint8Array.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
		const error = failureOf(() => encodeIco([{ width: 16, height: 16, png: notPng }]));
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.message).toContain('PNG signature');
	});

	it('refuses a payload too short to hold a signature', () => {
		const stub = Uint8Array.from([0x89, 0x50, 0x4e]);
		const error = failureOf(() => encodeIco([{ width: 16, height: 16, png: stub }]));
		expect(error).toBeInstanceOf(EncodeFailedError);
		expect(error.message).toContain('too short');
	});
});

/* ── Reading the directory back ───────────────────────────────────────── */

describe('readIcoDirectory', () => {
	it('returns the payloads a written icon went in with, byte for byte', () => {
		const first = pngLike(13, 0x5a);
		const second = pngLike(27, 0xa5);
		const directory = readIcoDirectory(
			encodeIco([
				{ width: 16, height: 16, png: first },
				{ width: 48, height: 48, png: second },
			]),
		);

		expect(directory.kind).toBe('icon');
		expect(directory.entries.length).toBe(2);
		expect(directory.entries.map((entry) => entry.width)).toEqual([16, 48]);
		expect(directory.entries.map((entry) => entry.height)).toEqual([16, 48]);
		expect(directory.entries.map((entry) => entry.payloadKind)).toEqual(['png', 'png']);
		expect(directory.entries.map((entry) => entry.bitCount)).toEqual([32, 32]);
		expect(Array.from(directory.entries[0]?.payload ?? [])).toEqual(Array.from(first));
		expect(Array.from(directory.entries[1]?.payload ?? [])).toEqual(Array.from(second));
	});

	it('carries a real PNG through the container unchanged', async () => {
		// An odd width and an odd height, so a stride mistake anywhere in the
		// chain would show up as a length difference rather than as a shuffle.
		const raster = createRaster(3, 5, 'srgb', true);
		for (let i = 0; i < raster.data.length; i += 1) raster.data[i] = (i * 7) % 251;
		const png = await encodePng(raster);

		const directory = readIcoDirectory(encodeIco([{ width: 3, height: 5, png }]));
		const entry = directory.entries[0];
		expect(entry?.payloadKind).toBe('png');
		expect(Array.from(entry?.payload ?? [])).toEqual(Array.from(png));
	});

	it('reads a zero side byte back as 256', () => {
		const directory = readIcoDirectory(encodeIco([{ width: 256, height: 256, png: pngLike(8) }]));
		expect(directory.entries[0]?.width).toBe(256);
		expect(directory.entries[0]?.height).toBe(256);
	});

	it('recognises a cursor, which shares the container', () => {
		const directory = readIcoDirectory(
			buildIco([{ width: 32, height: 32, payload: pngLike(16) }], 2),
		);
		expect(directory.kind).toBe('cursor');
	});

	it('rejects a file too short to hold the header', () => {
		const error = failureOf(() => readIcoDirectory(Uint8Array.from([0, 0, 1])));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.code).toBe('decode/failed');
		expect(error.message.length).toBeGreaterThan(20);
		expect(error.message.endsWith('.')).toBe(true);
	});

	it('rejects an empty input rather than returning nothing', () => {
		expect(failureOf(() => readIcoDirectory(new Uint8Array(0)))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects a non-zero reserved field', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		bytes[0] = 9;
		const error = failureOf(() => readIcoDirectory(bytes));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toContain('reserved');
	});

	it('rejects a type that is neither icon nor cursor', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		bytes[2] = 7;
		expect(failureOf(() => readIcoDirectory(bytes))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects a directory that claims no images', () => {
		const bytes = Uint8Array.from([0, 0, 1, 0, 0, 0]);
		expect(failureOf(() => readIcoDirectory(bytes))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects a count larger than the file can hold', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(4, 500, true);
		const error = failureOf(() => readIcoDirectory(bytes));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toContain('500');
	});

	it('rejects an entry whose payload runs past the end of the file', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(14, 4096, true);
		expect(failureOf(() => readIcoDirectory(bytes))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects an entry that points back into the directory', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(18, 4, true);
		expect(failureOf(() => readIcoDirectory(bytes))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects an entry that declares no bytes', () => {
		const bytes = encodeIco([{ width: 16, height: 16, png: pngLike(8) }]);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(14, 0, true);
		expect(failureOf(() => readIcoDirectory(bytes))).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects a file truncated part way through a payload', () => {
		const whole = encodeIco([{ width: 16, height: 16, png: pngLike(64) }]);
		const cut = whole.subarray(0, whole.length - 5);
		expect(failureOf(() => readIcoDirectory(cut))).toBeInstanceOf(DecodeFailedError);
	});
});

/* ── Unpacking the bitmap form ────────────────────────────────────────── */

describe('decodeIco', () => {
	it('unpacks a 32 bit bitmap bottom up, keeping alpha exactly', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 4, // doubled, to make room for the mask
			bitCount: 32,
			rows: [
				[0, 0, 255, 255, 0, 255, 0, 128],
				[255, 0, 0, 255, 255, 255, 255, 0],
			],
			mask: [
				[false, false],
				[false, false],
			],
		});
		const image = decodeIco(buildIco([{ width: 2, height: 2, payload: dib }]));

		expect(image.width).toBe(2);
		expect(image.height).toBe(2);
		expect(image.colourSpace).toBe('srgb');
		expect(image.hasAlpha).toBe(true);
		expect(pixels(image.data)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 0,
		]);
	});

	it('unpacks a single pixel', () => {
		const dib = buildDib({
			width: 1,
			declaredHeight: 2,
			bitCount: 1,
			palette: [
				[9, 9, 9],
				[200, 100, 50],
			],
			rows: [[0x80]],
			mask: [[false]],
		});
		const image = decodeIco(buildIco([{ width: 1, height: 1, payload: dib, bitCount: 1 }]));

		expect(image.width).toBe(1);
		expect(image.height).toBe(1);
		expect(image.hasAlpha).toBe(false);
		expect(pixels(image.data)).toEqual([200, 100, 50, 255]);
	});

	it('pads a 24 bit row out to four bytes at an odd width', () => {
		const dib = buildDib({
			width: 3,
			declaredHeight: 2,
			bitCount: 24,
			// Nine bytes of pixels in a twelve byte row, which is where a stride
			// mistake would shift every row after the first.
			rows: [[30, 20, 10, 60, 50, 40, 90, 80, 70]],
			mask: [[false, true, false]],
		});
		const image = decodeIco(buildIco([{ width: 3, height: 1, payload: dib, bitCount: 24 }]));

		expect(image.hasAlpha).toBe(true);
		expect(pixels(image.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 255]);
	});

	it('unpacks an eight bit palette at an odd width and height', () => {
		const dib = buildDib({
			width: 3,
			declaredHeight: 4,
			bitCount: 8,
			palette: [
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
				[1, 2, 3],
			],
			rows: [
				[0, 1, 2],
				[3, 3, 0],
			],
			mask: [
				[false, false, false],
				[false, false, true],
			],
		});
		const image = decodeIco(buildIco([{ width: 3, height: 2, payload: dib, bitCount: 8 }]));

		expect(image.hasAlpha).toBe(true);
		expect(pixels(image.data)).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255, 1, 2, 3, 255, 255, 0, 0, 0,
		]);
	});

	it('takes the palette size from the depth when the header leaves it at zero', () => {
		const palette: [number, number, number][] = [];
		for (let i = 0; i < 16; i += 1) palette.push([i * 10, i * 10 + 1, i * 10 + 2]);
		const dib = buildDib({
			width: 3,
			declaredHeight: 1,
			bitCount: 4,
			palette,
			colourCount: 0,
			// High nibble first: indices 1, 2 and 15.
			rows: [[0x12, 0xf0]],
		});
		const image = decodeIco(buildIco([{ width: 3, height: 1, payload: dib, bitCount: 4 }]));

		expect(image.hasAlpha).toBe(false);
		expect(pixels(image.data)).toEqual([10, 11, 12, 255, 20, 21, 22, 255, 150, 151, 152, 255]);
	});

	it('falls back to the mask when a 32 bit bitmap leaves its alpha channel at zero', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 2,
			bitCount: 32,
			rows: [[10, 20, 30, 0, 40, 50, 60, 0]],
			mask: [[true, false]],
		});
		const image = decodeIco(buildIco([{ width: 2, height: 1, payload: dib }]));

		expect(image.hasAlpha).toBe(true);
		expect(pixels(image.data)).toEqual([30, 20, 10, 0, 60, 50, 40, 255]);
	});

	it('treats a 32 bit bitmap with neither alpha nor mask as opaque, not invisible', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 1,
			bitCount: 32,
			rows: [[10, 20, 30, 0, 40, 50, 60, 0]],
		});
		const image = decodeIco(buildIco([{ width: 2, height: 1, payload: dib }]));

		expect(image.hasAlpha).toBe(false);
		expect(pixels(image.data)).toEqual([30, 20, 10, 255, 60, 50, 40, 255]);
	});

	it('reads a top-down bitmap in the order it is stored', () => {
		const dib = buildDib({
			width: 1,
			declaredHeight: -2,
			bitCount: 24,
			topDown: true,
			rows: [
				[3, 2, 1],
				[6, 5, 4],
			],
		});
		const image = decodeIco(buildIco([{ width: 1, height: 2, payload: dib, bitCount: 24 }]));

		expect(image.height).toBe(2);
		expect(pixels(image.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	it('picks the largest image in the file', () => {
		const small = buildDib({
			width: 1,
			declaredHeight: 2,
			bitCount: 24,
			rows: [[1, 1, 1]],
			mask: [[false]],
		});
		const large = buildDib({
			width: 2,
			declaredHeight: 4,
			bitCount: 32,
			rows: [
				[0, 0, 255, 255, 0, 255, 0, 128],
				[255, 0, 0, 255, 255, 255, 255, 0],
			],
			mask: [
				[false, false],
				[false, false],
			],
		});
		const image = decodeIco(
			buildIco([
				{ width: 1, height: 1, payload: small, bitCount: 24 },
				{ width: 2, height: 2, payload: large },
			]),
		);

		expect(image.width).toBe(2);
		expect(image.height).toBe(2);
	});

	it('says so rather than guessing when the largest image is an embedded PNG', () => {
		const error = failureOf(() =>
			decodeIco(encodeIco([{ width: 32, height: 32, png: pngLike(40) }])),
		);
		expect(error).toBeInstanceOf(UnsupportedHereError);
		expect(error.code).toBe('decode/unsupported-here');
		expect(error.message).toContain('PNG');
	});

	it('refuses a depth the icon format does not define', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 1,
			bitCount: 16,
			rows: [[0, 0, 0, 0]],
		});
		const error = failureOf(() => decodeIco(buildIco([{ width: 2, height: 1, payload: dib }])));
		expect(error).toBeInstanceOf(UnsupportedHereError);
		expect(error.message).toContain('16 bits');
	});

	it('refuses a run-length compressed bitmap', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 1,
			bitCount: 8,
			palette: [
				[1, 1, 1],
				[2, 2, 2],
			],
			compression: 1,
			rows: [[0, 1]],
		});
		const error = failureOf(() => decodeIco(buildIco([{ width: 2, height: 1, payload: dib }])));
		expect(error).toBeInstanceOf(UnsupportedHereError);
		expect(error.message).toContain('compressed');
	});

	it('rejects a payload too short to hold a bitmap header', () => {
		const stub = new Uint8Array(12);
		const error = failureOf(() => decodeIco(buildIco([{ width: 2, height: 2, payload: stub }])));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toContain('40');
	});

	it('rejects a bitmap whose pixels are truncated', () => {
		const dib = buildDib({
			width: 8,
			declaredHeight: 16,
			bitCount: 32,
			rows: Array.from({ length: 8 }, () => new Array<number>(32).fill(0x40)),
			mask: Array.from({ length: 8 }, () => new Array<boolean>(8).fill(false)),
		});
		const cut = dib.subarray(0, 60);
		const error = failureOf(() => decodeIco(buildIco([{ width: 8, height: 8, payload: cut }])));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toContain('stop short');
		expect(error.message.endsWith('.')).toBe(true);
	});

	it('rejects a bitmap header that claims an impossible length', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 1,
			bitCount: 32,
			rows: [[0, 0, 0, 255, 0, 0, 0, 255]],
		});
		new DataView(dib.buffer, dib.byteOffset, dib.byteLength).setUint32(0, 12, true);
		expect(
			failureOf(() => decodeIco(buildIco([{ width: 2, height: 1, payload: dib }]))),
		).toBeInstanceOf(DecodeFailedError);
	});

	it('rejects a pixel that indexes past the end of the palette', () => {
		const dib = buildDib({
			width: 1,
			declaredHeight: 2,
			bitCount: 8,
			palette: [
				[1, 1, 1],
				[2, 2, 2],
			],
			rows: [[5]],
			mask: [[false]],
		});
		const error = failureOf(() => decodeIco(buildIco([{ width: 1, height: 1, payload: dib }])));
		expect(error).toBeInstanceOf(DecodeFailedError);
		expect(error.message).toContain('palette colour 5');
	});

	it('rejects a bitmap with no pixels in it', () => {
		const dib = buildDib({
			width: 2,
			declaredHeight: 1,
			bitCount: 32,
			rows: [[0, 0, 0, 0, 0, 0, 0, 0]],
		});
		new DataView(dib.buffer, dib.byteOffset, dib.byteLength).setInt32(4, 0, true);
		expect(
			failureOf(() => decodeIco(buildIco([{ width: 2, height: 1, payload: dib }]))),
		).toBeInstanceOf(DecodeFailedError);
	});

	it('refuses a header that asks for an allocation far larger than any icon', () => {
		// One bit per pixel expands thirty-two fold on the way to RGBA, so this
		// is the shape of input that turns a small file into a huge buffer.
		const width = 16_777_217;
		const stride = Math.ceil(width / 32) * 4;
		const payload = new Uint8Array(48 + stride);
		const view = new DataView(payload.buffer);
		view.setUint32(0, 40, true);
		view.setInt32(4, width, true);
		view.setInt32(8, 1, true);
		view.setUint16(12, 1, true);
		view.setUint16(14, 1, true);
		view.setUint32(32, 2, true);

		const error = failureOf(() => decodeIco(buildIco([{ width: 256, height: 1, payload }])));
		expect(error).toBeInstanceOf(ImageTooLargeError);
		expect(error.code).toBe('input/too-large');
	});
});
