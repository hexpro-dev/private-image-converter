/**
 * A PNG encoder.
 *
 * The browser can already write PNG from a canvas, so this exists for the
 * things that cannot: writing 24 bit RGB when there is no alpha to carry,
 * writing an indexed file when the picture has few enough colours to fit one,
 * embedding the source ICC profile so a wide gamut photograph survives the
 * conversion, and running with no canvas at all, which is what lets a 48
 * megapixel image be written on a phone where a canvas that size cannot be
 * allocated.
 *
 * The chunk writer, the header, the filters and the deflate pass are exported
 * as well as used, because `apngEncode.ts` next door writes the same bytes into
 * `fdAT` chunks instead of `IDAT` ones and has no business owning a second copy
 * of the filter heuristic.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { exactPalette, quantise, type IndexedImage } from '../../raster/quantise.js';
import { crc32 } from './crc.js';
import { deflate } from './deflate.js';

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

/** IHDR. Compression, filtering and interlace have one legal value each here. */
export function pngHeaderChunk(
	width: number,
	height: number,
	bitDepth: number,
	colourType: number,
): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = bitDepth;
	header[9] = colourType;
	header[10] = 0; // deflate
	header[11] = 0; // adaptive filtering
	header[12] = 0; // no interlace
	return pngChunk('IHDR', header);
}

export function concatChunks(pieces: readonly Uint8Array[]): Uint8Array {
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

/**
 * The colour chunk, when one was asked for.
 *
 * At most one of the two. The profile is what the camera meant and every
 * reader understands it, so writing the compact tag beside it would only let
 * the two disagree with nothing to resolve them.
 */
export async function colourChunks(
	image: RasterImage,
	options: EncodeOptions,
): Promise<Uint8Array[]> {
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
		return [pngChunk('iCCP', payload)];
	}
	if (options.writeColourTag) {
		// cICP: colour primaries, transfer, matrix, full range flag. 12 is
		// Display P3, 1 is BT.709 which is what sRGB uses. Matrix 0 means the
		// samples are already RGB.
		const p3 = image.colourSpace === 'display-p3';
		return [pngChunk('cICP', Uint8Array.from([p3 ? 12 : 1, 13, 0, 1]))];
	}
	return [];
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

/**
 * Filter every scanline and deflate the lot.
 *
 * The rows are asked for one at a time rather than handed over as an array,
 * because on a 48 megapixel photograph the array would be a second copy of the
 * whole image alongside the buffer being filled. Two rows and the output is all
 * this holds beyond what the caller already had.
 */
async function filterAndDeflate(
	height: number,
	stride: number,
	bpp: number,
	fillRow: (y: number, row: Uint8Array) => void,
	adaptive = true,
): Promise<Uint8Array> {
	const raw = new Uint8Array((stride + 1) * height);
	const row = new Uint8Array(stride);
	let previous: Uint8Array | undefined;
	for (let y = 0; y < height; y += 1) {
		fillRow(y, row);
		if (!adaptive) {
			// The filter byte is already the zero the allocation left there.
			raw.set(row, y * (stride + 1) + 1);
			continue;
		}
		filterRow(row, previous, bpp, raw, y * (stride + 1));
		previous = previous ?? new Uint8Array(stride);
		previous.set(row);
	}
	return deflate(raw);
}

/**
 * A raster as the filtered, deflated bytes an IDAT or an fdAT carries.
 *
 * `channels` is 3 for colour type 2 and 4 for colour type 6. A raster that says
 * it has no alpha is written opaque even when its fourth bytes say otherwise,
 * which rescues the case that catches every encoder here: a buffer straight
 * from `createRaster` is all zeroes, and honouring that alpha would write an
 * image nobody can see.
 */
export async function compressedPixels(image: RasterImage, channels: number): Promise<Uint8Array> {
	const { width, height, data } = image;
	// One filter byte per row, then the row itself.
	const stride = width * channels;

	return filterAndDeflate(height, stride, channels, (y, row) => {
		const source = y * width * 4;
		if (channels === 4 && image.hasAlpha) {
			row.set(data.subarray(source, source + stride));
			return;
		}
		for (let x = 0; x < width; x += 1) {
			row[x * channels] = data[source + x * 4] as number;
			row[x * channels + 1] = data[source + x * 4 + 1] as number;
			row[x * channels + 2] = data[source + x * 4 + 2] as number;
			if (channels === 4) row[x * channels + 3] = 255;
		}
	});
}

/* ── Indexed output ───────────────────────────────────────────────────── */

/**
 * Whether every pixel is either fully opaque or fully invisible.
 *
 * The gate on writing an indexed file without being asked to. An indexed PNG
 * can carry a whole alpha per palette entry, but the palette builders here
 * collapse translucency to a single transparent entry, so a picture with a soft
 * edge in it would come back changed. Nobody asked for that, and a file that
 * quietly loses its anti-aliasing is worse than a larger one.
 */
function binaryAlphaOnly(image: RasterImage): boolean {
	const { data } = image;
	for (let i = 3; i < data.length; i += 4) {
		const alpha = data[i] as number;
		if (alpha !== 0 && alpha !== 255) return false;
	}
	return true;
}

/**
 * The palette to write, or undefined for an ordinary truecolour file.
 *
 * `options.palette` asks for quantisation, which throws colours away and is
 * never chosen on this reader's own initiative. Without it, a palette is only
 * used where it is exact, which is the case that matters: a screenshot, a logo,
 * a diagram and a pixel-art sprite all have a few hundred colours at most, and
 * an indexed file of one is a third the size at no cost whatsoever.
 */
function paletteFor(image: RasterImage, options: EncodeOptions): IndexedImage | undefined {
	// A raster that says it is opaque is treated as opaque, whatever its fourth
	// bytes hold, so that the indexed path agrees with the truecolour one.
	const alphaThreshold = image.hasAlpha ? 128 : 0;
	if (typeof options.palette === 'number' && options.palette > 0) {
		return quantise(image, { maxColours: options.palette, alphaThreshold });
	}
	// A wide gamut image with a profile attached is somebody carrying colour
	// carefully. Handing them back an indexed file, where every colour has been
	// snapped to a table, is a surprise in the middle of that. Asking for a
	// palette outright still gets one: an option that is accepted and ignored is
	// worse than one that does not exist.
	if (options.iccProfile && options.iccProfile.length > 0 && image.colourSpace === 'display-p3') {
		return undefined;
	}
	if (image.hasAlpha && !binaryAlphaOnly(image)) return undefined;
	return exactPalette(image, 256, alphaThreshold);
}

/**
 * Move the transparent entry to the front of the palette.
 *
 * `tRNS` for an indexed file is an alpha per entry, running from entry zero and
 * stopping wherever it likes, and everything past its end is opaque. Both
 * palette builders here put the transparent entry last, which would need a
 * table as long as the palette to reach it: 256 bytes of 255s to say one thing.
 * Swapping it to the front makes that table one byte.
 */
function transparentFirst(indexed: IndexedImage): IndexedImage {
	const { transparentIndex, colours } = indexed.palette;
	if (transparentIndex <= 0) return indexed;

	const swapped = Uint8Array.from(colours);
	for (let channel = 0; channel < 4; channel += 1) {
		swapped[channel] = colours[transparentIndex * 4 + channel] as number;
		swapped[transparentIndex * 4 + channel] = colours[channel] as number;
	}
	// Renumbered in place. Both palette builders allocate this array on the way
	// out, so it belongs to this file and to nobody else; copying it would be a
	// second buffer the size of the image for no reader's benefit.
	const indices = indexed.indices;
	for (let i = 0; i < indices.length; i += 1) {
		const index = indices[i] as number;
		if (index === 0) indices[i] = transparentIndex;
		else if (index === transparentIndex) indices[i] = 0;
	}
	return { ...indexed, palette: { colours: swapped, transparentIndex: 0 } };
}

/**
 * Bits per index, which is the smallest of the four PNG allows that fits.
 *
 * Sixteen colours in four bits halves the image data against eight, and two
 * colours in one bit divides it by eight. A black and white diagram is the case
 * this exists for, and it is common enough to be worth the packing loop.
 */
function bitsFor(entries: number): number {
	if (entries <= 2) return 1;
	if (entries <= 4) return 2;
	if (entries <= 16) return 4;
	return 8;
}

async function indexedFile(
	image: RasterImage,
	source: IndexedImage,
	colour: readonly Uint8Array[],
): Promise<Uint8Array> {
	const { width, height } = image;
	const indexed = transparentFirst(source);
	const { colours, transparentIndex } = indexed.palette;
	const entries = colours.length / 4;
	const bits = bitsFor(entries);

	const plte = new Uint8Array(entries * 3);
	for (let i = 0; i < entries; i += 1) {
		plte[i * 3] = colours[i * 4] as number;
		plte[i * 3 + 1] = colours[i * 4 + 1] as number;
		plte[i * 3 + 2] = colours[i * 4 + 2] as number;
	}

	const stride = Math.ceil((width * bits) / 8);
	const perByte = 8 / bits;
	const packRow = (y: number, row: Uint8Array): void => {
		// Cleared first, because the packing below sets bits into a shared
		// buffer and a row narrower than the last one would keep its tail.
		if (bits !== 8) row.fill(0);
		for (let x = 0; x < width; x += 1) {
			const index = indexed.indices[y * width + x] as number;
			if (bits === 8) {
				row[x] = index;
			} else {
				// The first pixel of a byte lives in its high bits, and a row
				// that does not fill its last byte leaves the rest of it zero.
				row[Math.floor(x / perByte)] |= index << (8 - bits * ((x % perByte) + 1));
			}
		}
	};

	const pieces: Uint8Array[] = [
		PNG_SIGNATURE,
		pngHeaderChunk(width, height, bits, 3),
		...colour,
		pngChunk('PLTE', plte),
	];
	if (transparentIndex >= 0) pieces.push(pngChunk('tRNS', Uint8Array.from([0])));
	// No filtering, which is what the specification recommends for an indexed
	// image and what measuring it agrees with. A filter predicts a sample from
	// its neighbours, and an index is not a sample: the difference between entry
	// 9 and entry 200 is a number about nothing, and deflate finds less to work
	// with in those differences than in the indices themselves. On a screenshot
	// the adaptive filters cost about a third of the file.
	pieces.push(pngChunk('IDAT', await filterAndDeflate(height, stride, 1, packRow, false)));
	pieces.push(pngChunk('IEND', new Uint8Array(0)));
	return concatChunks(pieces);
}

async function truecolourFile(
	image: RasterImage,
	colour: readonly Uint8Array[],
): Promise<Uint8Array> {
	const channels = image.hasAlpha ? 4 : 3;
	const colourType = image.hasAlpha ? 6 : 2;
	return concatChunks([
		PNG_SIGNATURE,
		pngHeaderChunk(image.width, image.height, 8, colourType),
		...colour,
		pngChunk('IDAT', await compressedPixels(image, channels)),
		pngChunk('IEND', new Uint8Array(0)),
	]);
}

export async function encodePng(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	const colour = await colourChunks(image, options);
	const indexed = paletteFor(image, options);

	if (!indexed) return truecolourFile(image, colour);
	// Asked for outright, so it is written whatever it costs.
	if (typeof options.palette === 'number') return indexedFile(image, indexed, colour);

	// Nobody asked, so the palette has to earn its place. A colour table is 3
	// bytes an entry of chunk that deflate never sees, and on a small or a very
	// flat picture that costs more than the narrower pixels save. Writing both
	// and keeping the smaller is the only way to know: deflate decides this, and
	// it does not answer questions about output it has not produced.
	//
	// Only an image that already has 256 colours or fewer gets this far, so the
	// second pass is over a screenshot or a logo rather than a photograph.
	const [asIndexed, asTruecolour] = await Promise.all([
		indexedFile(image, indexed, colour),
		truecolourFile(image, colour),
	]);
	return asIndexed.length < asTruecolour.length ? asIndexed : asTruecolour;
}
