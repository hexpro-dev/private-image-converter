/**
 * A PNG decoder.
 *
 * Browsers decode PNG natively and faster than this will, so in a tab the
 * native path wins and this never runs. It exists so that the encoder can be
 * checked against something other than itself in a test that has no browser,
 * and so that 16 bit files survive a conversion instead of being quietly
 * rounded to 8 by a canvas.
 *
 * The chunk walk, the header and the pixel pass are exported as well as used
 * here. An APNG is an ordinary PNG carrying extra chunks, and each of its
 * frames is an ordinary PNG image at its own size, so `apng.ts` next door
 * composes frames and reads none of the bytes itself. One implementation of
 * the scanline filters rather than two that drift apart.
 */

import { DecodeFailedError } from '../../errors.js';
import type { ColourSpace, RasterImage } from '../../types.js';
import { createRaster } from '../../raster/image.js';
import { inflate } from './deflate.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The largest image this reader will allocate a raster for.
 *
 * A header is four bytes of width and four of height, so a file of a hundred
 * bytes can claim sixty thousand by sixty thousand and ask for fourteen
 * gigabytes. The claim is refused here, before anything is allocated, rather
 * than surfacing as a RangeError out of the allocator with nothing to say.
 * The converter applies its own `maxPixels` on top of this; this exists so
 * that the decoder is safe to call on its own.
 */
const MAX_PIXELS = 400_000_000;

/**
 * How a reader refuses.
 *
 * Passed in rather than fixed, because this machinery reads both a PNG and the
 * frames of an APNG, and the two have to name different formats: somebody who
 * dropped in an animation should not be told their PNG is broken.
 */
export type PngRefusal = (detail: string) => never;

function fail(detail: string): never {
	throw new DecodeFailedError('png', 'png-pure', detail);
}

/** The five fields of IHDR this reader acts on. */
export interface PngHeader {
	readonly width: number;
	readonly height: number;
	readonly bitDepth: number;
	readonly colourType: number;
	readonly interlace: number;
}

export interface PngChunk {
	readonly type: string;
	/** The chunk's payload, as a view into the file rather than a copy. */
	readonly body: Uint8Array;
}

/** Channels carried in the file for each colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The bit depths each colour type is allowed to use.
 *
 * Not pedantry: a depth of 3 makes `8 / depth` fractional and the sample
 * unpacker below reads bits that overlap each other, and a depth of 16 with a
 * palette would index a table that cannot have that many entries. Both produce
 * a picture rather than an error, which is the failure worth refusing.
 */
const DEPTHS: Record<number, readonly number[]> = {
	0: [1, 2, 4, 8, 16],
	2: [8, 16],
	3: [1, 2, 4, 8],
	4: [8, 16],
	6: [8, 16],
};

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
	height: number,
	bpp: number,
	stride: number,
	refuse: PngRefusal,
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
					refuse(`a scanline used filter type ${type}, which does not exist.`);
			}
			out[row + i] = restored & 0xff;
		}
		source += stride;
	}
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

/**
 * Every chunk in the file, in order, stopping at IEND.
 *
 * Stopping there matters. Files arrive with things appended: a second image, a
 * signature block, the tail of whatever the file used to be. IEND is the end of
 * the PNG, and a reader that keeps walking treats four bytes of somebody else's
 * data as a chunk length.
 */
export function readPngChunks(bytes: Uint8Array, refuse: PngRefusal): PngChunk[] {
	for (let i = 0; i < SIGNATURE.length; i += 1) {
		if (bytes[i] !== SIGNATURE[i]) refuse('it does not start with a PNG signature.');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: PngChunk[] = [];
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset);
		// The declared length is what a crafted file lies about, so it is
		// checked against the buffer before it is used to take a subarray.
		if (offset + 12 + length > bytes.length) refuse('a chunk ran past the end of the file.');
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + 4 + i] as number);
		chunks.push({ type, body: bytes.subarray(offset + 8, offset + 8 + length) });
		if (type === 'IEND') break;
		offset += 12 + length;
	}
	return chunks;
}

/** Parse an IHDR payload. Whether the values make sense is `checkPngHeader`. */
export function readPngHeader(body: Uint8Array, refuse: PngRefusal): PngHeader {
	if (body.length < 13) refuse('its header chunk is too short to hold the image description.');
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	return {
		width: view.getUint32(0),
		height: view.getUint32(4),
		bitDepth: body[8] as number,
		colourType: body[9] as number,
		interlace: body[12] as number,
	};
}

/**
 * Refuse a header this reader cannot honour, before anything is allocated.
 *
 * Separate from the parse so that a file with no image data at all is told
 * that, rather than being told about a field it never got to use.
 */
export function checkPngHeader(header: PngHeader, refuse: PngRefusal): void {
	const { width, height, bitDepth, colourType, interlace } = header;
	if (interlace !== 0) {
		refuse('it is an interlaced PNG, which this reader does not implement.');
	}
	if (!CHANNELS[colourType]) {
		refuse(`it uses colour type ${colourType}, which does not exist.`);
	}
	if (!(DEPTHS[colourType] as readonly number[]).includes(bitDepth)) {
		refuse(`it uses ${bitDepth} bits per sample with colour type ${colourType}, which no PNG may.`);
	}
	if (width < 1 || height < 1) {
		refuse('it declares a width or a height of zero, so there is no image in it.');
	}
	if (width * height > MAX_PIXELS) {
		refuse('it declares more pixels than this reader will allocate for.');
	}
}

/**
 * What one image inside a PNG is, beyond the bytes that carry it.
 *
 * The dimensions are separate from the header because an APNG frame is smaller
 * than the canvas it lands on while sharing the header's depth, colour type and
 * palette. Everything else about reading it is identical, which is the reason
 * this is one function and not two.
 */
export interface PngImagePlan {
	readonly width: number;
	readonly height: number;
	readonly bitDepth: number;
	readonly colourType: number;
	readonly palette?: Uint8Array;
	readonly transparency?: Uint8Array;
	readonly colourSpace: ColourSpace;
}

/** The one colour a `tRNS` singles out, in samples rather than in bytes. */
interface ColourKey {
	readonly red: number;
	readonly green: number;
	readonly blue: number;
}

/**
 * The colour a `tRNS` chunk marks as transparent, for a file with no alpha.
 *
 * Colour types 0 and 2 carry no alpha channel, so transparency arrives as one
 * colour singled out: a pixel matching it exactly is fully transparent, and
 * every other pixel is opaque. It is what a file uses to let a background show
 * through without paying for a fourth channel, and it is how an APNG frame says
 * "leave this part of the canvas alone".
 *
 * The samples are stored as 16 bit fields whatever the depth of the image, and
 * they are compared before scaling: a key of 1 in a one bit greyscale file
 * would otherwise be looked for as 255 among samples that only ever hold 0 or
 * 1, and nothing would ever match.
 *
 * A chunk too short for its colour type is ignored rather than refused. The
 * picture is still there to be read, and one badly written ancillary chunk is a
 * poor reason to hand somebody nothing.
 */
function colourKey(colourType: number, transparency?: Uint8Array): ColourKey | undefined {
	if (!transparency) return undefined;
	const sample = (at: number): number =>
		((transparency[at] as number) << 8) | (transparency[at + 1] as number);
	if (colourType === 0) {
		if (transparency.length < 2) return undefined;
		const grey = sample(0);
		return { red: grey, green: grey, blue: grey };
	}
	if (colourType === 2) {
		if (transparency.length < 6) return undefined;
		return { red: sample(0), green: sample(2), blue: sample(4) };
	}
	// Colour types 4 and 6 carry their own alpha and the specification forbids a
	// tRNS beside them. Colour type 3's tRNS is a table of alphas read per
	// index, which is a lookup rather than a comparison.
	return undefined;
}

/**
 * The reader's half of a compression stream, typed.
 *
 * `DecompressionStream` is declared with an untyped readable, so the chunks
 * arrive as `any` unless the stream is read through a shape that says what they
 * are. The same statement in `deflate.ts` covers the writer's half.
 */
interface ByteReadable {
	readonly writable: WritableStream<BufferSource>;
	readonly readable: ReadableStream<Uint8Array>;
}

/**
 * Inflate, dropping a stream that expands past what the image can hold.
 *
 * Deflate runs to about a thousand to one, so a megabyte of file can ask for a
 * gigabyte of memory. Every size refusal above reads the header, and the header
 * is not what the allocation follows: a file declaring a single pixel can carry
 * an `IDAT` that inflates to half a gigabyte, and a decoder that measures the
 * result only once it is in memory has already lost the tab it was protecting.
 * So the output is counted as it arrives and the stream is dropped the moment
 * it passes the one filter byte and one stride per row the picture is made of.
 * Anything beyond that is data no PNG image needs.
 *
 * A failure inside the stream is a damaged file rather than a bug, and it
 * surfaces as this reader's own refusal: what `DecompressionStream` throws is a
 * bare `TypeError` carrying an empty message, which tells the person holding
 * the file nothing at all.
 */
async function inflateWithin(
	compressed: Uint8Array,
	limit: number,
	refuse: PngRefusal,
): Promise<Uint8Array> {
	// `inflate` owns the message for a platform with no decompression in it at
	// all, and throws it before it reads a byte.
	if (typeof DecompressionStream !== 'function') return inflate(compressed);

	const stream: ByteReadable = new DecompressionStream('deflate');
	const writer = stream.writable.getWriter();
	// Not awaited, for the reason `deflate.ts` gives: the reader below is what
	// consumes the chunk, so awaiting the write here deadlocks on anything
	// larger than the stream's internal queue. The rejections are taken rather
	// than left, because a damaged stream fails the write as well as the read
	// and an unhandled rejection ends a Node process by default.
	void writer.write(compressed as unknown as BufferSource).catch(() => {});
	void writer.close().catch(() => {});

	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let over = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) {
				over = true;
				break;
			}
			chunks.push(value);
		}
	} catch {
		// Refused out here rather than inside the loop, so that the refusal
		// below is not swallowed by this catch and renamed.
		refuse('its compressed image data could not be decompressed, so it is damaged.');
	}
	if (over) {
		void reader.cancel().catch(() => {});
		refuse('the compressed image data expands to more than the width and the height call for.');
	}

	return joinChunkData(chunks);
}

/**
 * Inflate, unfilter and expand one image to straight RGBA.
 *
 * `compressed` is the zlib stream an IDAT holds, or the same stream carried by
 * an APNG frame's fdAT chunks with their sequence numbers already removed.
 */
export async function decodePngImage(
	compressed: Uint8Array,
	plan: PngImagePlan,
	refuse: PngRefusal,
): Promise<RasterImage> {
	const { width, height, bitDepth, colourType, palette, transparency, colourSpace } = plan;
	const channels = CHANNELS[colourType] as number;
	const bitsPerPixel = channels * bitDepth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	// Bytes per pixel, rounded up to one: the filters look back a whole pixel,
	// and anything narrower than a byte looks back exactly one byte.
	const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

	const needed = (stride + 1) * height;
	const inflated = await inflateWithin(compressed, needed, refuse);
	// Checked before unfiltering rather than after, so a short stream is a
	// sentence rather than an image whose bottom half is black.
	if (inflated.length < needed) {
		refuse('the compressed image data is shorter than the width and the height call for.');
	}
	const pixels = unfilter(inflated, height, bpp, stride, refuse);

	const key = colourKey(colourType, transparency);
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
				// A palette index is a lookup and not a sample, so it is never
				// scaled. Scaling it the way a greyscale sample is scaled turns
				// index 1 of a four entry table into index 85.
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
					// The sample is kept as it was read as well as scaled, so that
					// the colour key is compared against the file's own numbers
					// rather than against eight bit ones.
					const sample = sampleAt(row, base, bitDepth);
					const grey = scale(sample);
					r = grey;
					g = grey;
					b = grey;
					if (colourType === 4) a = scale(sampleAt(row, base + 1, bitDepth));
					else if (key && sample === key.red) a = 0;
				} else {
					const red = sampleAt(row, base, bitDepth);
					const green = sampleAt(row, base + 1, bitDepth);
					const blue = sampleAt(row, base + 2, bitDepth);
					r = scale(red);
					g = scale(green);
					b = scale(blue);
					if (colourType === 6) a = scale(sampleAt(row, base + 3, bitDepth));
					else if (key && red === key.red && green === key.green && blue === key.blue) {
						a = 0;
					}
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

/** Join the payloads of the IDAT or fdAT chunks that carry one image. */
export function joinChunkData(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const joined = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}
	return joined;
}

export async function decodePng(bytes: Uint8Array): Promise<RasterImage> {
	const chunks = readPngChunks(bytes, fail);

	let header: PngHeader | undefined;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	let colourSpace: ColourSpace = 'srgb';
	const idat: Uint8Array[] = [];

	for (const { type, body } of chunks) {
		switch (type) {
			case 'IHDR':
				header = readPngHeader(body, fail);
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
			default:
				break;
		}
	}

	if (!header) fail('it has no header chunk.');
	if (idat.length === 0) fail('it has no image data.');
	checkPngHeader(header, fail);
	if (header.colourType === 3 && !palette) fail('it is palettised but carries no palette.');

	return decodePngImage(
		joinChunkData(idat),
		{
			width: header.width,
			height: header.height,
			bitDepth: header.bitDepth,
			colourType: header.colourType,
			palette,
			transparency,
			colourSpace,
		},
		fail,
	);
}
