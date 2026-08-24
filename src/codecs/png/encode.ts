/**
 * A PNG encoder.
 *
 * The browser can already write PNG from a canvas, so this exists for the
 * things that cannot: writing 24 bit RGB when there is no alpha to carry,
 * embedding the source ICC profile so a wide gamut photograph survives the
 * conversion, and running with no canvas at all, which is what lets a 48
 * megapixel image be written on a phone where a canvas that size cannot be
 * allocated.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { crc32 } from './crc.js';
import { deflate } from './deflate.js';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

/**
 * Filter one scanline five ways and keep the cheapest.
 *
 * The heuristic is the one the PNG specification itself suggests: treat the
 * filtered bytes as signed, sum their absolute values, take the smallest.
 * Trying all five costs five passes over a row and typically saves a fifth of
 * the file, which is a good trade when the alternative is shipping a deflate
 * implementation to do better.
 */
function filterRow(
	row: Uint8Array,
	previous: Uint8Array | undefined,
	bpp: number,
	out: Uint8Array,
	outOffset: number,
): void {
	const width = row.length;
	const candidates: Uint8Array[] = [];
	const scores: number[] = [];

	for (let type = 0; type < 5; type += 1) {
		const filtered = new Uint8Array(width);
		let score = 0;
		for (let i = 0; i < width; i += 1) {
			const raw = row[i] as number;
			const left = i >= bpp ? (row[i - bpp] as number) : 0;
			const up = previous ? (previous[i] as number) : 0;
			const upLeft = previous && i >= bpp ? (previous[i - bpp] as number) : 0;

			let value: number;
			switch (type) {
				case 0:
					value = raw;
					break;
				case 1:
					value = raw - left;
					break;
				case 2:
					value = raw - up;
					break;
				case 3:
					value = raw - ((left + up) >> 1);
					break;
				default: {
					// Paeth: pick whichever neighbour the gradient predicts.
					const p = left + up - upLeft;
					const dl = Math.abs(p - left);
					const du = Math.abs(p - up);
					const dul = Math.abs(p - upLeft);
					const predictor = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
					value = raw - predictor;
					break;
				}
			}
			const byte = value & 0xff;
			filtered[i] = byte;
			score += byte < 128 ? byte : 256 - byte;
		}
		candidates.push(filtered);
		scores.push(score);
	}

	let best = 0;
	for (let type = 1; type < 5; type += 1) {
		if ((scores[type] as number) < (scores[best] as number)) best = type;
	}
	out[outOffset] = best;
	out.set(candidates[best] as Uint8Array, outOffset + 1);
}

export async function encodePng(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	const { width, height, data } = image;
	const channels = image.hasAlpha ? 4 : 3;
	const colourType = image.hasAlpha ? 6 : 2;

	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = colourType;
	header[10] = 0; // deflate
	header[11] = 0; // adaptive filtering
	header[12] = 0; // no interlace

	// One filter byte per row, then the row itself.
	const stride = width * channels;
	const raw = new Uint8Array((stride + 1) * height);
	const row = new Uint8Array(stride);
	let previous: Uint8Array | undefined;

	for (let y = 0; y < height; y += 1) {
		const source = y * width * 4;
		if (channels === 4) {
			row.set(data.subarray(source, source + stride));
		} else {
			for (let x = 0; x < width; x += 1) {
				row[x * 3] = data[source + x * 4] as number;
				row[x * 3 + 1] = data[source + x * 4 + 1] as number;
				row[x * 3 + 2] = data[source + x * 4 + 2] as number;
			}
		}
		filterRow(row, previous, channels, raw, y * (stride + 1));
		previous = previous ?? new Uint8Array(stride);
		previous.set(row);
	}

	const pieces: Uint8Array[] = [SIGNATURE, chunk('IHDR', header)];

	if (options.iccProfile && options.iccProfile.length > 0) {
		// iCCP: a null terminated name, a compression method byte, then the
		// zlib compressed profile.
		const name = new TextEncoder().encode('ICC profile');
		const compressed = await deflate(options.iccProfile);
		const payload = new Uint8Array(name.length + 2 + compressed.length);
		payload.set(name, 0);
		payload[name.length] = 0;
		payload[name.length + 1] = 0;
		payload.set(compressed, name.length + 2);
		pieces.push(chunk('iCCP', payload));
	} else if (options.writeColourTag) {
		// cICP: colour primaries, transfer, matrix, full range flag. 12 is
		// Display P3, 1 is BT.709 which is what sRGB uses. Matrix 0 means the
		// samples are already RGB.
		const p3 = image.colourSpace === 'display-p3';
		pieces.push(chunk('cICP', Uint8Array.from([p3 ? 12 : 1, 13, 0, 1])));
	}

	pieces.push(chunk('IDAT', await deflate(raw)));
	pieces.push(chunk('IEND', new Uint8Array(0)));

	let total = 0;
	for (const piece of pieces) total += piece.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const piece of pieces) {
		out.set(piece, at);
		at += piece.length;
	}
	return out;
}
