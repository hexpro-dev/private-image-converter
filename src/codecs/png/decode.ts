/**
 * A PNG decoder.
 *
 * Browsers decode PNG natively and faster than this will, so in a tab the
 * native path wins and this never runs. It exists so that the encoder can be
 * checked against something other than itself in a test that has no browser,
 * and so that 16 bit files survive a conversion instead of being quietly
 * rounded to 8 by a canvas.
 */

import { DecodeFailedError } from '../../errors.js';
import type { ColourSpace, RasterImage } from '../../types.js';
import { createRaster } from '../../raster/image.js';
import { inflate } from './deflate.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fail(detail: string): never {
	throw new DecodeFailedError('png', 'png-pure', detail);
}

interface Header {
	width: number;
	height: number;
	bitDepth: number;
	colourType: number;
	interlace: number;
}

/** Channels carried in the file for each colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

function unfilter(
	raw: Uint8Array,
	width: number,
	height: number,
	bpp: number,
	stride: number,
): Uint8Array {
	const out = new Uint8Array(stride * height);
	let source = 0;
	for (let y = 0; y < height; y += 1) {
		const type = raw[source] as number;
		source += 1;
		const row = y * stride;
		const previous = row - stride;
		for (let i = 0; i < stride; i += 1) {
			const value = raw[source + i] as number;
			const left = i >= bpp ? (out[row + i - bpp] as number) : 0;
			const up = y > 0 ? (out[previous + i] as number) : 0;
			const upLeft = y > 0 && i >= bpp ? (out[previous + i - bpp] as number) : 0;
			let restored: number;
			switch (type) {
				case 0:
					restored = value;
					break;
				case 1:
					restored = value + left;
					break;
				case 2:
					restored = value + up;
					break;
				case 3:
					restored = value + ((left + up) >> 1);
					break;
				case 4:
					restored = value + paeth(left, up, upLeft);
					break;
				default:
					fail(`a scanline used filter type ${type}, which does not exist`);
			}
			out[row + i] = restored & 0xff;
		}
		source += stride;
	}
	void width;
	return out;
}

/** Read a sample of `depth` bits at sample index `index` from a packed row. */
function sampleAt(row: Uint8Array, index: number, depth: number): number {
	if (depth === 8) return row[index] as number;
	if (depth === 16) return ((row[index * 2] as number) << 8) | (row[index * 2 + 1] as number);
	const perByte = 8 / depth;
	const byte = row[Math.floor(index / perByte)] as number;
	const shift = 8 - depth * ((index % perByte) + 1);
	return (byte >> shift) & ((1 << depth) - 1);
}

export async function decodePng(bytes: Uint8Array): Promise<RasterImage> {
	for (let i = 0; i < SIGNATURE.length; i += 1) {
		if (bytes[i] !== SIGNATURE[i]) fail('it does not start with a PNG signature');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let header: Header | undefined;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	let colourSpace: ColourSpace = 'srgb';
	const idat: Uint8Array[] = [];

	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset);
		if (offset + 12 + length > bytes.length) fail('a chunk ran past the end of the file');
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + 4 + i] as number);
		const body = bytes.subarray(offset + 8, offset + 8 + length);

		switch (type) {
			case 'IHDR':
				header = {
					width: view.getUint32(offset + 8),
					height: view.getUint32(offset + 12),
					bitDepth: bytes[offset + 16] as number,
					colourType: bytes[offset + 17] as number,
					interlace: bytes[offset + 20] as number,
				};
				break;
			case 'PLTE':
				palette = body;
				break;
			case 'tRNS':
				transparency = body;
				break;
			case 'IDAT':
				idat.push(body);
				break;
			case 'cICP':
				// Colour primaries 12 is SMPTE EG 432-1, which is Display P3.
				if (body[0] === 12) colourSpace = 'display-p3';
				break;
			case 'IEND':
				offset = bytes.length;
				break;
			default:
				break;
		}
		offset += 12 + length;
	}

	if (!header) fail('it has no header chunk');
	if (idat.length === 0) fail('it has no image data');
	if (header.interlace !== 0) {
		fail('it is an interlaced PNG, which this reader does not implement');
	}
	if (!CHANNELS[header.colourType]) {
		fail(`it uses colour type ${header.colourType}, which does not exist`);
	}
	if (header.colourType === 3 && !palette) fail('it is palettised but carries no palette');

	let total = 0;
	for (const part of idat) total += part.length;
	const joined = new Uint8Array(total);
	let at = 0;
	for (const part of idat) {
		joined.set(part, at);
		at += part.length;
	}

	const { width, height, bitDepth, colourType } = header;
	const channels = CHANNELS[colourType] as number;
	const bitsPerPixel = channels * bitDepth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

	const inflated = await inflate(joined);
	if (inflated.length < (stride + 1) * height) {
		fail('the compressed image data is shorter than the header says it should be');
	}
	const pixels = unfilter(inflated, width, height, bpp, stride);

	const maximum = (1 << bitDepth) - 1;
	const out = createRaster(width, height, colourSpace, false);
	let hasAlpha = false;

	for (let y = 0; y < height; y += 1) {
		const row = pixels.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < width; x += 1) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 255;
			const base = x * channels;

			if (colourType === 3) {
				const index = sampleAt(row, x, bitDepth);
				const entry = index * 3;
				r = (palette as Uint8Array)[entry] ?? 0;
				g = (palette as Uint8Array)[entry + 1] ?? 0;
				b = (palette as Uint8Array)[entry + 2] ?? 0;
				a = transparency?.[index] ?? 255;
			} else {
				const scale = (value: number): number =>
					bitDepth === 8 ? value : Math.round((value * 255) / maximum);
				if (colourType === 0 || colourType === 4) {
					const grey = scale(sampleAt(row, base, bitDepth));
					r = grey;
					g = grey;
					b = grey;
					if (colourType === 4) a = scale(sampleAt(row, base + 1, bitDepth));
				} else {
					r = scale(sampleAt(row, base, bitDepth));
					g = scale(sampleAt(row, base + 1, bitDepth));
					b = scale(sampleAt(row, base + 2, bitDepth));
					if (colourType === 6) a = scale(sampleAt(row, base + 3, bitDepth));
				}
			}

			if (a !== 255) hasAlpha = true;
			const target = (y * width + x) * 4;
			out.data[target] = r;
			out.data[target + 1] = g;
			out.data[target + 2] = b;
			out.data[target + 3] = a;
		}
	}

	return { ...out, hasAlpha };
}
