/**
 * A PNG encoder.
 *
 * The browser can already write PNG from a canvas, so this exists for the
 * things that cannot: writing 24 bit RGB when there is no alpha to carry,
 * writing an indexed file when the picture has few enough colours to fit one,
 * embedding the source ICC profile so a wide gamut photograph survives the
 * conversion, carrying the source EXIF, which a canvas drops on the floor, and
 * running with no canvas at all, which is what lets a 48 megapixel image be
 * written on a phone where a canvas that size cannot be allocated.
 *
 * The chunk writer, the header, the filters and the deflate pass are exported
 * as well as used, because `apngEncode.ts` next door writes the same bytes into
 * `fdAT` chunks instead of `IDAT` ones and has no business owning a second copy
 * of the filter heuristic.
 */

import type { EncodeOptions, RasterImage } from '../../types.js';
import { exactPalette, quantise, type IndexedImage } from '../../raster/quantise.js';
import { crc32 } from './crc.js';
import { deflate, openDeflate } from './deflate.js';

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
 * The EXIF chunk, when there is a payload to write.
 *
 * `eXIf` holds the EXIF block from its TIFF header onwards, with no `Exif\0\0`
 * in front of it. That six byte prefix belongs to JPEG's APP1 segment and to
 * nothing else, and a reader handed it here sees a TIFF byte order mark of
 * `Ex` and gives up on the whole chunk, which is a metadata loss nobody
 * notices until a photograph arrives somewhere with no date on it. Every
 * source in this package hands over the payload already stripped, so the bytes
 * go in as they are.
 *
 * The orientation tag is not touched. `convert` has already rewritten it to 1,
 * because the decoders here return upright pixels, and rotating the same
 * photograph twice is the one failure this chunk can cause on its own.
 *
 * An empty payload writes nothing, for the same reason an empty ICC profile
 * does: a zero length ancillary chunk is a thing every reader has to step over
 * and no reader can use.
 */
export function exifChunks(options: EncodeOptions): Uint8Array[] {
	if (!options.exif || options.exif.length === 0) return [];
	return [pngChunk('eXIf', options.exif)];
}

/**
 * The absolute value of a byte read as a signed one, for all 256 of them.
 *
 * The filter heuristic sums these over a row, once per candidate, which is
 * five reads of an unpredictable branch per byte on a photograph. A table is
 * one load from a line that never leaves L1.
 */
const SIGNED_MAGNITUDE = Uint8Array.from({ length: 256 }, (_, byte) =>
	byte < 128 ? byte : 256 - byte,
);

/**
 * Filter one scanline five ways and keep the cheapest.
 *
 * The heuristic is the one the PNG specification itself suggests: treat the
 * filtered bytes as signed, sum their absolute values, take the smallest.
 * Trying all five typically saves a fifth of the file, which is a good trade
 * when the alternative is shipping a deflate implementation to do better.
 *
 * All five are scored in one pass and only the winner is written, which is the
 * whole reason this reads the way it does. The obvious shape, filtering the
 * row five times into five buffers and copying the best one out, reads each
 * neighbour five times and allocates five row buffers per scanline: on a
 * 4000 by 3000 photograph that is fifteen thousand allocations and 180 MB of
 * zeroing, and on a picture that compresses well it was most of the encode
 * rather than a part of it. Nothing here allocates at all.
 *
 * Two things must not be tidied.
 *
 * Ties go to the lower filter number, which is what the strictly less than
 * comparisons below produce, taken in order. A `<=` in any of them rewrites
 * every flat row from None to Paeth and quietly changes the bytes this
 * encoder has always written, for no gain: the scores are equal, so the file
 * is not smaller.
 *
 * `previous` is a real buffer even for the first scanline, where it is the
 * zeroes the specification says sit above the top of the image. Passing
 * `undefined` there would mean a test for it inside the inner loop, on every
 * byte of every row, to describe a row that is not special.
 */
function filterRow(
	row: Uint8Array,
	previous: Uint8Array,
	bpp: number,
	out: Uint8Array,
	outOffset: number,
): void {
	const width = row.length;
	let none = 0;
	let sub = 0;
	let up = 0;
	let average = 0;
	let paeth = 0;

	// The leading pixel, which has nothing to its left. The specification says
	// to treat the bytes before the start of a row as zero, so `left` and
	// `upLeft` are both zero here, and Paeth then predicts the byte above for
	// every value that byte can take. Work it through: the gradient is `up`
	// itself, which sits at distance `up` from both of the zeroes and at zero
	// from `up`, so `up` wins outright whenever it is not zero, and where it is
	// zero the predictor falls back to `left`, which is the same zero. Sharing
	// one score between the two filters here is arithmetic, not an
	// approximation, and dropping it changes which filter wins a tie.
	for (let i = 0; i < bpp; i += 1) {
		const raw = row[i] as number;
		const above = previous[i] as number;
		const fromAbove = SIGNED_MAGNITUDE[(raw - above) & 0xff] as number;
		none += SIGNED_MAGNITUDE[raw] as number;
		sub += SIGNED_MAGNITUDE[raw] as number;
		up += fromAbove;
		average += SIGNED_MAGNITUDE[(raw - (above >> 1)) & 0xff] as number;
		paeth += fromAbove;
	}

	for (let i = bpp; i < width; i += 1) {
		const raw = row[i] as number;
		const left = row[i - bpp] as number;
		const above = previous[i] as number;
		const aboveLeft = previous[i - bpp] as number;

		none += SIGNED_MAGNITUDE[raw] as number;
		sub += SIGNED_MAGNITUDE[(raw - left) & 0xff] as number;
		up += SIGNED_MAGNITUDE[(raw - above) & 0xff] as number;
		average += SIGNED_MAGNITUDE[(raw - ((left + above) >> 1)) & 0xff] as number;

		// Paeth: pick whichever neighbour the gradient predicts.
		const p = left + above - aboveLeft;
		const dl = Math.abs(p - left);
		const du = Math.abs(p - above);
		const dul = Math.abs(p - aboveLeft);
		const predictor = dl <= du && dl <= dul ? left : du <= dul ? above : aboveLeft;
		paeth += SIGNED_MAGNITUDE[(raw - predictor) & 0xff] as number;
	}

	let best = 0;
	let score = none;
	if (sub < score) {
		best = 1;
		score = sub;
	}
	if (up < score) {
		best = 2;
		score = up;
	}
	if (average < score) {
		best = 3;
		score = average;
	}
	if (paeth < score) best = 4;

	out[outOffset] = best;
	const at = outOffset + 1;
	switch (best) {
		case 0:
			out.set(row, at);
			return;
		case 1:
			for (let i = 0; i < bpp; i += 1) out[at + i] = row[i] as number;
			for (let i = bpp; i < width; i += 1)
				out[at + i] = ((row[i] as number) - (row[i - bpp] as number)) & 0xff;
			return;
		case 2:
			for (let i = 0; i < width; i += 1)
				out[at + i] = ((row[i] as number) - (previous[i] as number)) & 0xff;
			return;
		case 3:
			for (let i = 0; i < bpp; i += 1)
				out[at + i] = ((row[i] as number) - ((previous[i] as number) >> 1)) & 0xff;
			for (let i = bpp; i < width; i += 1)
				out[at + i] =
					((row[i] as number) - (((row[i - bpp] as number) + (previous[i] as number)) >> 1)) & 0xff;
			return;
		default:
			// The leading pixel again, where Paeth and Up agree. See above.
			for (let i = 0; i < bpp; i += 1)
				out[at + i] = ((row[i] as number) - (previous[i] as number)) & 0xff;
			for (let i = bpp; i < width; i += 1) {
				const left = row[i - bpp] as number;
				const above = previous[i] as number;
				const aboveLeft = previous[i - bpp] as number;
				const p = left + above - aboveLeft;
				const dl = Math.abs(p - left);
				const du = Math.abs(p - above);
				const dul = Math.abs(p - aboveLeft);
				const predictor = dl <= du && dl <= dul ? left : du <= dul ? above : aboveLeft;
				out[at + i] = ((row[i] as number) - predictor) & 0xff;
			}
			return;
	}
}

/**
 * Roughly how much filtered data to hand the compressor at a time.
 *
 * Small enough that a 48 megapixel encode never holds a meaningful fraction of
 * its own output, large enough that the per-write cost of the stream is noise.
 * The row bounds matter more than the byte target on the shapes that are
 * awkward: a one pixel wide column would otherwise write a few bytes at a
 * time, and a very wide panorama would allocate a batch far past the point of
 * the exercise.
 */
const BATCH_TARGET_BYTES = 1 << 20;
const MIN_BATCH_ROWS = 16;
const MAX_BATCH_ROWS = 64;

function batchRows(rowBytes: number, height: number): number {
	const wanted = Math.floor(BATCH_TARGET_BYTES / rowBytes);
	return Math.max(1, Math.min(height, MAX_BATCH_ROWS, Math.max(MIN_BATCH_ROWS, wanted)));
}

/**
 * Filter every scanline and deflate the lot.
 *
 * The rows are asked for one at a time rather than handed over as an array,
 * because on a 48 megapixel photograph the array would be a second copy of the
 * whole image alongside the buffer being filled.
 *
 * They go to the compressor a batch at a time for the same reason. Filtering
 * the whole image first and compressing it in one call held about 140 MB for a
 * 48 megapixel RGB file, on top of the raster the caller still had and the
 * output being collected, and that peak is what a phone runs out of memory on.
 * A batch is around a megabyte.
 *
 * Each batch is a fresh buffer, and this is the trap: `write` resolving does
 * not mean the compressor has read the bytes. Refilling one scratch buffer for
 * the next batch corrupts the middle of the file with no error anywhere. See
 * `openDeflate`.
 *
 * The two row buffers are swapped rather than copied, so `previous` is
 * whichever one the last scanline was built in. That works because `fillRow`
 * writes every byte of the row it is handed. A future caller that fills a row
 * only partly, expecting the rest to be whatever it wrote last time, would
 * read the row before last instead.
 */
async function filterAndDeflate(
	height: number,
	stride: number,
	bpp: number,
	fillRow: (y: number, row: Uint8Array) => void,
	adaptive = true,
): Promise<Uint8Array> {
	const sink = openDeflate();
	const rowBytes = stride + 1;
	const perBatch = batchRows(rowBytes, height);

	let row = new Uint8Array(stride);
	let previous = new Uint8Array(stride);
	let batch = new Uint8Array(rowBytes * perBatch);
	let held = 0;

	for (let y = 0; y < height; y += 1) {
		if (held === perBatch) {
			await sink.write(batch);
			batch = new Uint8Array(rowBytes * perBatch);
			held = 0;
		}
		fillRow(y, row);
		const at = held * rowBytes;
		if (adaptive) {
			filterRow(row, previous, bpp, batch, at);
			const spent = previous;
			previous = row;
			row = spent;
		} else {
			// The filter byte is already the zero the allocation left there.
			batch.set(row, at + 1);
		}
		held += 1;
	}

	// Whatever the last batch holds, which for a height that divides evenly is
	// a full one, and for a height of zero is nothing at all.
	await sink.write(batch.subarray(0, held * rowBytes));
	return sink.finish();
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
	ancillary: readonly Uint8Array[],
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
		...ancillary,
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
	ancillary: readonly Uint8Array[],
): Promise<Uint8Array> {
	const channels = image.hasAlpha ? 4 : 3;
	const colourType = image.hasAlpha ? 6 : 2;
	return concatChunks([
		PNG_SIGNATURE,
		pngHeaderChunk(image.width, image.height, 8, colourType),
		...ancillary,
		pngChunk('IDAT', await compressedPixels(image, channels)),
		pngChunk('IEND', new Uint8Array(0)),
	]);
}

export async function encodePng(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	// Everything that goes between IHDR and the image data. The order is the
	// order it is written in, and both of these belong in front of PLTE and
	// IDAT: eXIf may not sit between IDAT chunks, and the specification asks
	// for it before the first one.
	const ancillary = [...(await colourChunks(image, options)), ...exifChunks(options)];
	const indexed = paletteFor(image, options);

	if (!indexed) return truecolourFile(image, ancillary);
	// Asked for outright, so it is written whatever it costs.
	if (typeof options.palette === 'number') return indexedFile(image, indexed, ancillary);

	// Nobody asked, so the palette has to earn its place. A colour table is 3
	// bytes an entry of chunk that deflate never sees, and on a small or a very
	// flat picture that costs more than the narrower pixels save. Writing both
	// and keeping the smaller is the only way to know: deflate decides this, and
	// it does not answer questions about output it has not produced.
	//
	// Only an image that already has 256 colours or fewer gets this far, so the
	// second pass is over a screenshot or a logo rather than a photograph.
	const [asIndexed, asTruecolour] = await Promise.all([
		indexedFile(image, indexed, ancillary),
		truecolourFile(image, ancillary),
	]);
	return asIndexed.length < asTruecolour.length ? asIndexed : asTruecolour;
}
