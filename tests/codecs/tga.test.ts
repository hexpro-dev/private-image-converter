import { describe, expect, it } from 'vitest';

import { decodeTga } from '../../src/codecs/tga/decode.js';
import { encodeTga } from '../../src/codecs/tga/encode.js';
import { sniffFormat } from '../../src/detect/sniff.js';
import { DecodeFailedError, EncodeFailedError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import type { RasterImage } from '../../src/types.js';

const HEADER_BYTES = 18;
const FOOTER_BYTES = 26;

type Pixel = readonly [number, number, number, number];

function build(
	width: number,
	height: number,
	pixel: (x: number, y: number) => Pixel,
	hasAlpha = false,
): RasterImage {
	const image = createRaster(width, height, 'srgb', hasAlpha);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a] = pixel(x, y);
			const at = (y * width + x) * 4;
			image.data[at] = r;
			image.data[at + 1] = g;
			image.data[at + 2] = b;
			image.data[at + 3] = a;
		}
	}
	return image;
}

interface HeaderFields {
	readonly idLength?: number;
	readonly colourMapType?: number;
	readonly colourMapLength?: number;
	readonly colourMapEntryBits?: number;
}

function header(
	imageType: number,
	width: number,
	height: number,
	depth: number,
	descriptor: number,
	fields: HeaderFields = {},
): number[] {
	const mapLength = fields.colourMapLength ?? 0;
	return [
		fields.idLength ?? 0,
		fields.colourMapType ?? 0,
		imageType,
		0,
		0,
		mapLength & 0xff,
		(mapLength >> 8) & 0xff,
		fields.colourMapEntryBits ?? 0,
		0,
		0,
		0,
		0,
		width & 0xff,
		(width >> 8) & 0xff,
		height & 0xff,
		(height >> 8) & 0xff,
		depth,
		descriptor,
	];
}

function file(...parts: number[][]): Uint8Array {
	return Uint8Array.from(parts.flat());
}

/** Walk the packet stream, asserting that no packet crosses a row boundary. */
function walkPackets(bytes: Uint8Array, width: number, height: number, channels: number): void {
	let at = HEADER_BYTES;
	for (let y = 0; y < height; y += 1) {
		let filled = 0;
		while (filled < width) {
			const packet = bytes[at] as number;
			at += 1;
			const count = (packet & 0x7f) + 1;
			filled += count;
			at += (packet & 0x80) !== 0 ? channels : count * channels;
		}
		expect(filled).toBe(width);
	}
	expect(at).toBe(bytes.length - FOOTER_BYTES);
}

function pixels(image: RasterImage): number[] {
	return Array.from(image.data);
}

describe('encodeTga header', () => {
	it('writes the 18 bytes the specification lays out, in order', () => {
		const bytes = encodeTga(build(3, 2, () => [10, 20, 30, 255]));
		expect(Array.from(bytes.subarray(0, HEADER_BYTES))).toEqual([
			0, // image id length
			0, // colour map type: none
			10, // image type: run length encoded truecolour
			0,
			0, // colour map first entry index
			0,
			0, // colour map length
			0, // colour map entry size
			0,
			0, // x origin
			0,
			0, // y origin
			3,
			0, // width, little endian
			2,
			0, // height, little endian
			24, // pixel depth
			0x20, // descriptor: no alpha bits, top down
		]);
	});

	it('sets eight alpha bits and a depth of 32 when the raster has alpha', () => {
		const bytes = encodeTga(build(1, 1, () => [1, 2, 3, 128], true));
		expect(bytes[16]).toBe(32);
		expect(bytes[17]).toBe(0x28);
	});

	it('writes dimensions as little endian 16 bit fields', () => {
		const bytes = encodeTga(build(300, 258, () => [0, 0, 0, 255]));
		expect(Array.from(bytes.subarray(12, 16))).toEqual([300 & 0xff, 1, 2, 1]);
	});
});

describe('encodeTga footer', () => {
	it('ends with the 26 byte version 2 footer', () => {
		const bytes = encodeTga(build(2, 2, () => [0, 0, 0, 255]));
		const footer = bytes.subarray(bytes.length - FOOTER_BYTES);
		// Both section offsets are zero, which is how absence is recorded.
		expect(Array.from(footer.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(new TextDecoder().decode(footer.subarray(8, 25))).toBe('TRUEVISION-XFILE.');
		expect(footer[25]).toBe(0);
	});

	it('produces a file the format sniffer recognises', () => {
		expect(sniffFormat(encodeTga(build(4, 3, () => [9, 9, 9, 255])))).toBe('tga');
	});
});

describe('encodeTga run length encoding', () => {
	it('collapses a run into one packet, blue channel first', () => {
		const bytes = encodeTga(build(4, 1, () => [10, 20, 30, 255]));
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x83, 30, 20, 10,
		]);
		expect(bytes.length).toBe(HEADER_BYTES + 4 + FOOTER_BYTES);
	});

	it('writes distinct pixels as one literal packet', () => {
		const bytes = encodeTga(build(3, 1, (x) => [x, x + 10, x + 20, 255]));
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x02, 20, 10, 0, 21, 11, 1, 22, 12, 2,
		]);
	});

	it('breaks a literal packet where a run starts', () => {
		// One literal, then three of the same, then one more literal.
		const row: Pixel[] = [
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[2, 2, 2, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
		];
		const bytes = encodeTga(build(5, 1, (x) => row[x] as Pixel));
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x00, 1, 1, 1, 0x82, 2, 2, 2, 0x00, 3, 3, 3,
		]);
	});

	it('never lets a packet cross a scanline', () => {
		const bytes = encodeTga(build(2, 2, () => [7, 7, 7, 255]));
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x81, 7, 7, 7, 0x81, 7, 7, 7,
		]);
		walkPackets(bytes, 2, 2, 3);
	});

	it('splits a run longer than 128 pixels', () => {
		const bytes = encodeTga(build(300, 1, () => [5, 6, 7, 255]));
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0xff, 7, 6, 5, 0xff, 7, 6, 5, 0xab, 7, 6, 5,
		]);
	});

	it('splits a literal packet longer than 128 pixels', () => {
		const bytes = encodeTga(build(200, 1, (x) => [x & 0xff, 0, x & 0xff, 255]));
		const body = bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES);
		expect(body[0]).toBe(0x7f);
		expect(body[1 + 128 * 3]).toBe(0x47);
		expect(body.length).toBe(2 + 200 * 3);
	});

	it('keeps packets inside rows on an image with mixed content', () => {
		const image = build(13, 11, (x, y) => {
			const t = (x * 7 + y * 13) % 11;
			return t < 4 ? [200, 30, 60, 255] : [t * 20, (x * 9) % 256, (y * 23) % 256, 255];
		});
		walkPackets(encodeTga(image), 13, 11, 3);
	});

	it('makes a flat image far smaller than its uncompressed size', () => {
		const bytes = encodeTga(build(64, 64, () => [200, 100, 50, 255]));
		expect(bytes.length).toBeLessThan(HEADER_BYTES + 64 * 64 * 3 + FOOTER_BYTES);
		expect(bytes.length).toBe(HEADER_BYTES + 64 * 4 + FOOTER_BYTES);
	});
});

describe('tga round trip', () => {
	it('carries a 1 by 1 image through unchanged', () => {
		const image = build(1, 1, () => [12, 34, 56, 255]);
		const decoded = decodeTga(encodeTga(image));
		expect(decoded.width).toBe(1);
		expect(decoded.height).toBe(1);
		expect(pixels(decoded)).toEqual([12, 34, 56, 255]);
		expect(decoded.hasAlpha).toBe(false);
	});

	it.each([
		[1, 7],
		[7, 1],
		[3, 3],
		[13, 11],
		[17, 2],
		[2, 17],
	])('is lossless at %i by %i', (width, height) => {
		const image = build(width, height, (x, y) => [
			(x * 37) % 256,
			(y * 53) % 256,
			(x * y * 7) % 256,
			255,
		]);
		const decoded = decodeTga(encodeTga(image));
		expect(decoded.width).toBe(width);
		expect(decoded.height).toBe(height);
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('keeps the alpha channel exactly', () => {
		const image = build(5, 3, (x, y) => [x * 20, y * 30, 40, (x * 50 + y) % 256], true);
		const decoded = decodeTga(encodeTga(image));
		expect(decoded.hasAlpha).toBe(true);
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('reports no alpha when every pixel of an alpha raster is opaque', () => {
		const image = build(4, 2, (x) => [x, 0, 0, 255], true);
		const decoded = decodeTga(encodeTga(image));
		expect(decoded.hasAlpha).toBe(false);
		expect(pixels(decoded)).toEqual(pixels(image));
	});

	it('survives an image whose rows are individually flat', () => {
		const image = build(9, 5, (_x, y) => [y * 10, y * 10, y * 10, 255]);
		expect(pixels(decodeTga(encodeTga(image)))).toEqual(pixels(image));
	});

	it('comes back as sRGB, because TGA cannot record a colour space', () => {
		const wide = createRaster(2, 2, 'display-p3', false);
		expect(decodeTga(encodeTga(wide)).colourSpace).toBe('srgb');
	});
});

describe('encodeTga alpha handling', () => {
	it('composites onto white when asked for a 24 bit file', () => {
		const image = build(2, 1, (x) => (x === 0 ? [0, 0, 0, 128] : [255, 0, 0, 255]), true);
		const bytes = encodeTga(image, { alpha: false });
		expect(bytes[16]).toBe(24);
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x01, 127, 127, 127, 0, 0, 255,
		]);
	});

	it('honours a background colour when flattening', () => {
		const image = build(1, 1, () => [0, 0, 0, 128], true);
		const bytes = encodeTga(image, { alpha: false, background: [0, 0, 0] });
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x00, 0, 0, 0,
		]);
	});

	it('writes opaque alpha for a raster that says its alpha means nothing', () => {
		// hasAlpha false with zeroed alpha bytes is an ordinary intermediate
		// raster. Copying those bytes into a 32 bit file would make it invisible.
		const image: RasterImage = {
			data: Uint8ClampedArray.from([9, 8, 7, 0]),
			width: 1,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		const bytes = encodeTga(image, { alpha: true });
		expect(Array.from(bytes.subarray(HEADER_BYTES, bytes.length - FOOTER_BYTES))).toEqual([
			0x00, 7, 8, 9, 255,
		]);
		const decoded = decodeTga(bytes);
		expect(decoded.hasAlpha).toBe(false);
		expect(pixels(decoded)).toEqual([9, 8, 7, 255]);
	});

	it('ignores quality, which a lossless format has nothing to spend it on', () => {
		const image = build(4, 4, (x, y) => [x, y, 0, 255]);
		expect(Array.from(encodeTga(image, { quality: 0.1 }))).toEqual(
			Array.from(encodeTga(image, { quality: 1 })),
		);
	});
});

describe('encodeTga refusals', () => {
	it('refuses an image with no pixels', () => {
		expect(() => encodeTga(createRaster(0, 4))).toThrow(EncodeFailedError);
		expect(() => encodeTga(createRaster(4, 0))).toThrow(EncodeFailedError);
	});

	it('refuses a side that will not fit the 16 bit field', () => {
		const wide: RasterImage = {
			data: new Uint8ClampedArray(4),
			width: 70_000,
			height: 1,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodeTga(wide)).toThrow(/16 bits/);
	});

	it('refuses a raster shorter than its own dimensions', () => {
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: false,
		};
		expect(() => encodeTga(short)).toThrow(EncodeFailedError);
		expect(() => encodeTga(short)).toThrow(/shorter than the width and height/);
	});

	it('refuses a short raster before flattening can pad it out', () => {
		// Flattening allocates from the width and height, so a check placed after
		// it would see a full sized buffer and write the padding as picture.
		const short: RasterImage = {
			data: new Uint8ClampedArray(8),
			width: 4,
			height: 4,
			colourSpace: 'srgb',
			hasAlpha: true,
		};
		expect(() => encodeTga(short, { alpha: false })).toThrow(/shorter than the width and height/);
	});
});

describe('decodeTga on files this encoder does not write', () => {
	it('reads uncompressed truecolour stored bottom row first', () => {
		const bytes = file(
			header(2, 2, 2, 24, 0x00),
			// Bottom row of the image comes first in the file.
			[0, 255, 0, 255, 255, 255],
			[0, 0, 255, 255, 0, 0],
		);
		const decoded = decodeTga(bytes);
		expect(pixels(decoded)).toEqual([
			255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255,
		]);
		expect(decoded.hasAlpha).toBe(false);
	});

	it('reads uncompressed 8 bit greyscale', () => {
		const decoded = decodeTga(file(header(3, 3, 1, 8, 0x20), [0, 128, 255]));
		expect(pixels(decoded)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
	});

	it('reads run length encoded greyscale', () => {
		const decoded = decodeTga(file(header(11, 3, 1, 8, 0x20), [0x82, 77]));
		expect(pixels(decoded)).toEqual([77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255]);
	});

	it('reads 16 bit pixels, using the attribute bit as alpha when the descriptor says so', () => {
		// Full red with the attribute bit set, then full blue with it clear.
		const decoded = decodeTga(file(header(2, 2, 1, 16, 0x21), [0x00, 0xfc, 0x1f, 0x00]));
		expect(pixels(decoded)).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
		expect(decoded.hasAlpha).toBe(true);
	});

	it('widens five bit samples so the maximum lands on 255', () => {
		const decoded = decodeTga(file(header(2, 1, 1, 15, 0x20), [0xff, 0x7f]));
		expect(pixels(decoded)).toEqual([255, 255, 255, 255]);
	});

	it('treats the top bit of a 15 bit pixel as unused rather than as alpha', () => {
		const decoded = decodeTga(file(header(2, 1, 1, 15, 0x20), [0x00, 0x00]));
		expect(pixels(decoded)).toEqual([0, 0, 0, 255]);
		expect(decoded.hasAlpha).toBe(false);
	});

	it('steps over the image id field', () => {
		const bytes = file(header(2, 1, 1, 24, 0x20, { idLength: 3 }), [0x41, 0x42, 0x43], [1, 2, 3]);
		expect(pixels(decodeTga(bytes))).toEqual([3, 2, 1, 255]);
	});

	it('steps over a colour table a truecolour image never uses', () => {
		const bytes = file(
			header(2, 1, 1, 24, 0x20, {
				colourMapType: 1,
				colourMapLength: 2,
				colourMapEntryBits: 24,
			}),
			[9, 9, 9, 8, 8, 8],
			[1, 2, 3],
		);
		expect(pixels(decodeTga(bytes))).toEqual([3, 2, 1, 255]);
	});

	it('honours the right to left descriptor bit', () => {
		const decoded = decodeTga(file(header(2, 2, 1, 24, 0x30), [1, 1, 1, 2, 2, 2]));
		expect(pixels(decoded)).toEqual([2, 2, 2, 255, 1, 1, 1, 255]);
	});

	it('reads a run packet that crosses a row boundary', () => {
		// Not something this encoder writes, but real files contain them.
		const decoded = decodeTga(file(header(10, 2, 2, 24, 0x20), [0x83, 4, 5, 6]));
		expect(pixels(decoded)).toEqual([6, 5, 4, 255, 6, 5, 4, 255, 6, 5, 4, 255, 6, 5, 4, 255]);
	});

	it('treats an all zero alpha channel as an unwritten one', () => {
		const bytes = file(header(2, 2, 1, 32, 0x28), [1, 2, 3, 0, 4, 5, 6, 0]);
		const decoded = decodeTga(bytes);
		expect(decoded.hasAlpha).toBe(false);
		expect(pixels(decoded)).toEqual([3, 2, 1, 255, 6, 5, 4, 255]);
	});
});

describe('decodeTga refusals', () => {
	it('refuses a file too short to hold a header', () => {
		expect(() => decodeTga(new Uint8Array(17))).toThrow(DecodeFailedError);
		expect(() => decodeTga(new Uint8Array(0))).toThrow(/18 byte header/);
	});

	it('refuses a header with a zero side', () => {
		expect(() => decodeTga(file(header(2, 0, 4, 24, 0x20)))).toThrow(/width or a height of zero/);
		expect(() => decodeTga(file(header(2, 4, 0, 24, 0x20)))).toThrow(DecodeFailedError);
	});

	it('refuses uncompressed pixel data that stops short', () => {
		const bytes = file(header(2, 4, 4, 24, 0x20), [1, 2, 3]);
		expect(() => decodeTga(bytes)).toThrow(DecodeFailedError);
		expect(() => decodeTga(bytes)).toThrow(/bytes short/);
	});

	it('refuses a literal packet missing its pixels', () => {
		expect(() => decodeTga(file(header(10, 4, 1, 24, 0x20), [0x03, 1, 2, 3]))).toThrow(
			/literal packet/,
		);
	});

	it('refuses a repeated packet missing the pixel it repeats', () => {
		expect(() => decodeTga(file(header(10, 4, 1, 24, 0x20), [0x81, 1, 2, 3, 0x81, 9]))).toThrow(
			/repeated packet/,
		);
	});

	it('refuses a packet stream that ends mid image', () => {
		expect(() => decodeTga(file(header(10, 4, 1, 24, 0x20), [0x81, 1, 2, 3]))).toThrow(
			/ends before every row/,
		);
	});

	it('refuses a packet claiming more pixels than the image holds', () => {
		expect(() => decodeTga(file(header(10, 2, 1, 24, 0x20), [0x83, 1, 2, 3]))).toThrow(
			/more pixels than the image/,
		);
	});

	it('refuses a compressed stream that cannot possibly fill the image', () => {
		// The bound is arithmetic rather than a guess: 8 bytes of packets can
		// stand for at most 256 pixels at three bytes each.
		const bytes = file(header(10, 1000, 1000, 24, 0x20), [0x80, 1, 2, 3, 0x80, 4, 5, 6]);
		expect(() => decodeTga(bytes)).toThrow(/too short to describe an image of that size/);
	});

	it('refuses a header describing more pixels than it will allocate for', () => {
		expect(() => decodeTga(file(header(10, 40_000, 40_000, 32, 0x28)))).toThrow(
			/far larger than anything/,
		);
	});

	it('refuses an image id that runs past the end of the file', () => {
		expect(() => decodeTga(file(header(2, 1, 1, 24, 0x20, { idLength: 200 })))).toThrow(
			/past the end of the file/,
		);
	});

	it('refuses colour mapped files by name', () => {
		for (const imageType of [1, 9]) {
			expect(() => decodeTga(file(header(imageType, 1, 1, 8, 0x20, { colourMapType: 1 })))).toThrow(
				/colour table/,
			);
		}
	});

	it('refuses the Huffman compressed types by name', () => {
		for (const imageType of [32, 33]) {
			expect(() => decodeTga(file(header(imageType, 1, 1, 8, 0x20)))).toThrow(/Huffman/);
		}
	});

	it('refuses an image type the format does not define', () => {
		expect(() => decodeTga(file(header(5, 1, 1, 24, 0x20)))).toThrow(/image type of 5/);
	});

	it('refuses a pixel depth the format does not define', () => {
		expect(() => decodeTga(file(header(2, 1, 1, 48, 0x20)))).toThrow(/pixel depth of 48/);
	});

	it('refuses 16 bit greyscale by name', () => {
		expect(() => decodeTga(file(header(3, 1, 1, 16, 0x20)))).toThrow(/16 bit greyscale/);
	});

	it('throws a typed error rather than crashing on truncated input at every length', () => {
		const whole = encodeTga(build(6, 5, (x, y) => [x * 11, y * 13, 7, 255]));
		// Every prefix short of the complete packet stream is missing pixels, so
		// every one of them has to name the problem rather than return a raster
		// with holes in it.
		for (let length = 0; length < whole.length - FOOTER_BYTES; length += 1) {
			const cut = whole.subarray(0, length);
			expect(() => decodeTga(cut)).toThrow(DecodeFailedError);
			// A sentence, ending in a full stop, with no undefined in it.
			expect(() => decodeTga(cut)).toThrow(/^That TGA file could not be read: .+\.$/);
		}
	});
});
