/**
 * An OpenEXR reader.
 *
 * EXR is what a renderer or a compositor writes and what almost nothing else
 * opens: linear light in floating point with no ceiling, an arbitrary set of
 * named channels, and six compression schemes of its own invention. This reads
 * the scan line based half of the format, which is what everything writes
 * unless it was asked for tiles, and refuses the rest of the family by name.
 *
 * What it reads: version 2 scan line files, UINT, HALF and FLOAT channels in
 * any mixture, NONE, RLE, ZIPS and ZIP compression, a data window anywhere on
 * the plane placed inside the display window that says where the image is,
 * both line orders, and a luminance-only file as grey. What it refuses: tiled,
 * deep and multi-part files, a version field carrying bits the format does not
 * define, PIZ, PXR24, B44, B44A, DWAA and DWAB compression, subsampled
 * channels, the luminance and chroma layout, which is subsampling under another
 * name, and pixels that are not square.
 *
 * Four things here produce a plausible looking picture rather than an error
 * when they are got wrong, and each is commented where it happens: the image is
 * the display window rather than the data window, channels are stored in
 * alphabetical order rather than in the order anybody wants to read them, a
 * compressed block carries a byte predictor and an interleave that both have to
 * be undone and in that order, and a block whose compressed form came out no
 * smaller than the pixels is stored raw.
 *
 * Every read is bounds checked, because these bytes came from a file somebody
 * else made. A truncated EXR must name the structure it stopped inside, not
 * hand back a black band where a scanline should have been, and a compressed
 * block is inflated under the ceiling its own scanlines set, so a small file
 * that declares a gigabyte behind one of them is refused rather than allocated
 * for.
 */

import { CodecUnavailableError, DecodeFailedError } from '../../errors.js';
import { blit, createRaster, crop, detectAlpha } from '../../raster/image.js';
import { halfToFloat, toneMap } from '../../raster/tonemap.js';
import type { ColourSpace, RasterImage } from '../../types.js';

const DECODER_ID = 'exr-pure';

/** 20000630 written as a little endian int32, which is what these four bytes spell. */
const MAGIC = [0x76, 0x2f, 0x31, 0x01];

const VERSION = 2;
/** Bit 9 of the version field. Tiles are a different file, not a variation. */
const FLAG_TILED = 0x200;
/** Bit 10. Attribute and channel names may run to 255 bytes instead of 31. */
const FLAG_LONG_NAMES = 0x400;
/** Bit 11. Deep files hold a variable number of samples per pixel. */
const FLAG_DEEP = 0x800;
/** Bit 12. A multi-part file is several images with one header each. */
const FLAG_MULTI_PART = 0x1000;
/**
 * Every bit the version field is allowed to carry: the version number in the
 * low byte and the four flags above it. Everything else is reserved, and
 * reserved means the next storage layout somebody standardises, not spare
 * room. This is the same mask libOpenEXR's own `isSupportedVersion` applies.
 */
const VERSION_MASK = 0xff | FLAG_TILED | FLAG_LONG_NAMES | FLAG_DEEP | FLAG_MULTI_PART;

const UINT = 0;
const HALF = 1;
const FLOAT = 2;

const NONE = 0;
const RLE = 1;
const ZIPS = 2;
const ZIP = 3;

/**
 * Compression methods by number, in the order the specification assigns them.
 *
 * Used for the refusals, so that a file this reader will not open is turned
 * away by the name its writer would recognise rather than by a number nobody
 * has memorised.
 */
const COMPRESSION_NAMES = [
	'NONE',
	'RLE',
	'ZIPS',
	'ZIP',
	'PIZ',
	'PXR24',
	'B44',
	'B44A',
	'DWAA',
	'DWAB',
];

/**
 * Scanlines per chunk, indexed by compression method.
 *
 * The difference between ZIPS and ZIP is only this number: ZIPS deflates one
 * scanline at a time so a reader can seek to any row, ZIP deflates sixteen at
 * once and compresses better for it.
 */
const LINES_PER_BLOCK = [1, 1, 1, 16];

const INCREASING_Y = 0;
const DECREASING_Y = 1;
const RANDOM_Y = 2;

/**
 * The largest image this reader will allocate for.
 *
 * Higher than anything sensible and far below a header that is lying. The
 * intermediate here is four floats a pixel, sixteen bytes, so a hundred
 * megapixels is already more memory than a browser tab is going to give us;
 * the point of the ceiling is that a header claiming sixty thousand pixels
 * square is refused before the allocator is asked, rather than after. The
 * converter applies its own `maxPixels` on top of this, and this one exists so
 * the decoder is safe to call on its own.
 */
const MAX_PIXELS = 100_000_000;

/** Where a channel's samples go in the interleaved float buffer. */
const SKIP = -1;
const LUMINANCE = 4;

function fail(detail: string, options?: ErrorOptions): never {
	throw new DecodeFailedError('exr', DECODER_ID, detail, options);
}

/**
 * The one place a length is compared against the buffer.
 *
 * Funnelling every read through this is what keeps the failure mode honest: a
 * short file names the structure it stopped inside instead of reading undefined
 * and carrying on.
 */
function requireBytes(bytes: Uint8Array, at: number, count: number, what: string): void {
	if (at < 0 || count < 0 || at + count > bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

function viewOf(block: Uint8Array): DataView {
	return new DataView(block.buffer, block.byteOffset, block.byteLength);
}

/* ── The header ───────────────────────────────────────────────────────── */

interface Cursor {
	at: number;
}

/**
 * Read a null terminated name.
 *
 * The length limit is the format's own, and it is the version field that says
 * which one applies. Enforcing it is what stops a header with no terminator in
 * it from being scanned to the end of a hundred megabyte file one character at
 * a time.
 */
function readName(
	bytes: Uint8Array,
	cursor: Cursor,
	end: number,
	limit: number,
	what: string,
): string {
	let text = '';
	for (;;) {
		if (cursor.at >= end) fail(`it ends inside ${what}.`);
		const byte = bytes[cursor.at] as number;
		cursor.at += 1;
		if (byte === 0) return text;
		if (text.length >= limit) {
			fail(`${what} is longer than the ${limit} bytes this file's header allows.`);
		}
		text += String.fromCharCode(byte);
	}
}

interface Attribute {
	readonly type: string;
	/** Where the value starts, as an index into the whole file. */
	readonly at: number;
	readonly size: number;
}

/**
 * Read the attribute list, which ends at an empty name.
 *
 * Attributes this reader does not understand are skipped by their declared
 * size rather than parsed, which is the whole point of the design: a file
 * carrying a camera's transformation matrix, a render's sample counts and half
 * a page of comments reads exactly as fast as one carrying none of it.
 */
function readAttributes(
	bytes: Uint8Array,
	view: DataView,
	cursor: Cursor,
	limit: number,
): Map<string, Attribute> {
	const attributes = new Map<string, Attribute>();
	for (;;) {
		const name = readName(bytes, cursor, bytes.length, limit, 'an attribute name');
		if (name === '') return attributes;
		const type = readName(bytes, cursor, bytes.length, limit, 'an attribute type');
		requireBytes(bytes, cursor.at, 4, 'the size of one of its attributes');
		const size = view.getUint32(cursor.at, true);
		cursor.at += 4;
		requireBytes(bytes, cursor.at, size, 'the end of one of its attributes');
		// First one wins. The format forbids a repeated attribute, and keeping
		// the first means a file that repeats one cannot quietly change the
		// meaning of a header a reader has already acted on.
		if (!attributes.has(name)) attributes.set(name, { type, at: cursor.at, size });
		cursor.at += size;
	}
}

function attributeOf(
	attributes: Map<string, Attribute>,
	name: string,
	type: string,
	size?: number,
): Attribute {
	const found = attributes.get(name);
	if (!found) fail(`it has no ${name} attribute, and every EXR header must carry one.`);
	if (found.type !== type) fail(`its ${name} attribute is not the ${type} it has to be.`);
	if (size !== undefined && found.size !== size) {
		fail(`its ${name} attribute is not the ${size} bytes long it has to be.`);
	}
	return found;
}

interface Box {
	readonly xMin: number;
	readonly yMin: number;
	readonly xMax: number;
	readonly yMax: number;
}

function readBox(view: DataView, attribute: Attribute): Box {
	return {
		xMin: view.getInt32(attribute.at, true),
		yMin: view.getInt32(attribute.at + 4, true),
		xMax: view.getInt32(attribute.at + 8, true),
		yMax: view.getInt32(attribute.at + 12, true),
	};
}

/* ── Channels ─────────────────────────────────────────────────────────── */

interface ExrChannel {
	readonly name: string;
	readonly pixelType: number;
	readonly sampleBytes: number;
	readonly xSampling: number;
	readonly ySampling: number;
}

/**
 * Read the channel list.
 *
 * Each entry is a name, a four byte pixel type, one byte of pLinear, three
 * reserved bytes and then two four byte sampling rates: sixteen bytes after the
 * name, not fifteen. The reserved run is three bytes because the C++ writer
 * pads the bool out to the next int, and a reader that allows two reads every
 * sampling rate one byte low, which looks like a subsampled file rather than
 * like the off-by-one it is.
 */
function readChannels(
	bytes: Uint8Array,
	view: DataView,
	attribute: Attribute,
	limit: number,
): ExrChannel[] {
	const end = attribute.at + attribute.size;
	const cursor: Cursor = { at: attribute.at };
	const channels: ExrChannel[] = [];

	for (;;) {
		const name = readName(bytes, cursor, end, limit, 'a channel name');
		if (name === '') break;
		if (cursor.at + 16 > end) fail('its channel list ends inside a channel description.');
		const pixelType = view.getInt32(cursor.at, true);
		const xSampling = view.getInt32(cursor.at + 8, true);
		const ySampling = view.getInt32(cursor.at + 12, true);
		cursor.at += 16;

		if (pixelType !== UINT && pixelType !== HALF && pixelType !== FLOAT) {
			fail(`one of its channels is pixel type ${pixelType}, which is not one that exists.`);
		}
		// The sampling rates are carried rather than acted on here, because
		// which of two refusals a subsampled file deserves depends on the whole
		// list. See `refuseUnreadableLayout`.
		channels.push({
			name,
			pixelType,
			sampleBytes: pixelType === HALF ? 2 : 4,
			xSampling,
			ySampling,
		});
	}

	if (channels.length === 0) fail('its channel list is empty.');
	return channels;
}

/**
 * Turn away the channel layouts this reader cannot make a picture from.
 *
 * The order of the two checks is the whole point of the function. A luminance
 * and chroma file is the ordinary output of `RgbaOutputFile` with `WRITE_YCA`,
 * and every one of them stores RY and BY at sampling 2 2, so a sampling check
 * that ran first would catch every real one of them and name the mechanism
 * rather than the layout somebody chose. The layout is the thing a person can
 * act on: it is a choice their writer made and can unmake.
 */
function refuseUnreadableLayout(channels: readonly ExrChannel[]): void {
	const names = new Set(channels.map((channel) => channel.name));
	if (names.has('Y') && (names.has('RY') || names.has('BY'))) {
		fail(
			'it stores luminance and chroma (Y with RY and BY) rather than red, green and blue, which this reader does not implement.',
		);
	}
	for (const channel of channels) {
		if (channel.xSampling !== 1 || channel.ySampling !== 1) {
			fail(
				'it subsamples one of its channels, storing fewer samples than pixels, and reading that needs a resampler this reader does not have.',
			);
		}
	}
}

/**
 * Decide where each channel's samples go.
 *
 * The order of this array is the order the channel list gave, which is the
 * order the pixels are stored in, and for a valid file that is alphabetical:
 * A, then B, then G, then R. Reading them in the order somebody wants them is
 * the single most common way to write an EXR reader that produces a picture
 * with its red and blue swapped, so nothing here sorts or assumes. The list is
 * the layout.
 */
function targetsFor(channels: readonly ExrChannel[]): { targets: number[]; alpha: boolean } {
	const names = new Set(channels.map((channel) => channel.name));

	const colour = names.has('R') || names.has('G') || names.has('B');
	const luminance = !colour && names.has('Y');
	if (!colour && !luminance) {
		// A render often keeps its beauty pass in a named layer, where the
		// channels are "diffuse.R" and friends and there is no bare R at all.
		// Choosing a layer is a decision this reader has no way to make.
		if (channels.some((channel) => channel.name.includes('.'))) {
			fail(
				'its colour is inside named layers rather than in plain R, G and B channels, and this reader has no way to choose a layer.',
			);
		}
		fail('it has no R, G, B or Y channel, so there is nothing in it to make a picture from.');
	}

	const targets = channels.map((channel) => {
		switch (channel.name) {
			case 'R':
				return 0;
			case 'G':
				return 1;
			case 'B':
				return 2;
			case 'A':
				return 3;
			case 'Y':
				// Y is the picture only where there is no colour to be had. A
				// file carrying both is carrying a luminance pass alongside its
				// beauty pass, and painting that over the colour would come out
				// grey for no reason a person could see from the outside.
				return luminance ? LUMINANCE : SKIP;
			default:
				return SKIP;
		}
	});

	return { targets, alpha: names.has('A') };
}

/* ── Compression ──────────────────────────────────────────────────────── */

function refuseCompression(compression: number): never {
	const name = COMPRESSION_NAMES[compression];
	if (name === undefined) {
		fail(`it declares compression method ${compression}, which this reader does not know.`);
	}
	fail(`it uses ${name} compression, which this reader does not implement.`);
}

/**
 * OpenEXR's own run length encoding, which is not anybody else's.
 *
 * The count is signed. A negative count is minus the number of literal bytes
 * that follow, and a count of zero or more means the next byte repeats that
 * many times plus one. The asymmetry is real: minus three is three literals,
 * three is four copies. Reading it as symmetric shifts every run after the
 * first by a byte, which comes out as diagonal streaks rather than as an error.
 */
function rleUncompress(source: Uint8Array, expected: number): Uint8Array {
	const out = new Uint8Array(expected);
	let from = 0;
	let to = 0;

	while (from < source.length) {
		// Sign extended through a 24 bit shift, because the buffer is unsigned.
		const count = (((source[from] as number) << 24) >> 24) | 0;
		from += 1;

		if (count < 0) {
			const literals = -count;
			if (from + literals > source.length) {
				fail('one of its run length compressed blocks ends inside a run of literal bytes.');
			}
			if (to + literals > expected) {
				fail(
					'one of its run length compressed blocks unpacks to more bytes than its scanlines hold.',
				);
			}
			out.set(source.subarray(from, from + literals), to);
			from += literals;
			to += literals;
		} else {
			const run = count + 1;
			if (from >= source.length) {
				fail('one of its run length compressed blocks ends before the byte it repeats.');
			}
			if (to + run > expected) {
				fail(
					'one of its run length compressed blocks unpacks to more bytes than its scanlines hold.',
				);
			}
			out.fill(source[from] as number, to, to + run);
			from += 1;
			to += run;
		}
	}

	if (to !== expected) {
		fail('one of its run length compressed blocks unpacks to fewer bytes than its scanlines need.');
	}
	return out;
}

/**
 * Undo the byte predictor.
 *
 * Each stored byte is the difference from the one before it, offset by 128 and
 * wrapped, so the sum is taken in the same modular arithmetic the writer used.
 * Masking rather than clamping is the whole trick: a difference that overflowed
 * on the way in has to overflow the same way on the way out.
 */
function unpredict(buffer: Uint8Array): void {
	for (let i = 1; i < buffer.length; i += 1) {
		buffer[i] = ((buffer[i - 1] as number) + (buffer[i] as number) - 128) & 0xff;
	}
}

/**
 * Undo the interleave.
 *
 * The first half of the buffer holds the even numbered output bytes and the
 * second half the odd ones, which is what puts the high byte of every half
 * float next to the high byte of its neighbour and is most of why deflate can
 * do anything with floating point pixels at all. The split is rounded up, so an
 * odd length block keeps its last byte in the first half.
 */
function deinterleave(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.length);
	const half = Math.ceil(source.length / 2);
	let even = 0;
	let odd = half;
	for (let i = 0; i < source.length; i += 2) {
		out[i] = source[even] as number;
		even += 1;
		if (i + 1 < source.length) {
			out[i + 1] = source[odd] as number;
			odd += 1;
		}
	}
	return out;
}

/**
 * Inflate one block, stopping the moment it outgrows the scanlines it covers.
 *
 * The platform's deflate is driven directly here rather than through the shared
 * `inflate` in the PNG codec, for one reason: this call site knows exactly how
 * many bytes the block holds before it starts, and a length checked after the
 * fact is checked too late. Deflate is a thousand to one on zeroes, so a one
 * megabyte EXR whose single block declares a gigabyte is a file somebody can
 * write in a minute, and a reader that collects the gigabyte first and compares
 * afterwards does not refuse it, it takes the tab down with it. The ceiling is
 * the output buffer itself: it is allocated at the size the block can hold, and
 * a chunk that would not fit ends the read.
 *
 * The write and the close are neither awaited nor left dangling. Awaiting the
 * write deadlocks on any block larger than the stream's internal queue, because
 * the loop below is what drains it; leaving them bare turns every refusal into
 * a pair of unhandled rejections, since both reject once the stream is
 * cancelled or errored and nobody is holding either promise.
 */
async function inflateBlock(stored: Uint8Array, expected: number): Promise<Uint8Array> {
	if (typeof DecompressionStream !== 'function') {
		throw new CodecUnavailableError(
			'DecompressionStream',
			'This browser is too old to read a compressed OpenEXR file here. It needs decompression built in, which arrived in Safari 16.4 and has been in Chrome and Firefox for longer.',
		);
	}

	const ignore = (): void => {};
	const stream = new DecompressionStream('deflate');
	const writer = stream.writable.getWriter();
	// `BufferSource` requires an `ArrayBuffer` backed view, while a plain
	// `Uint8Array` is declared over `ArrayBufferLike`. These bytes are never
	// shared, so the cast states what is already true.
	void writer.write(stored as unknown as BufferSource).catch(ignore);
	void writer.close().catch(ignore);

	const reader = stream.readable.getReader();
	const out = new Uint8Array(expected);
	let at = 0;
	for (;;) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try {
			chunk = await reader.read();
		} catch (error) {
			fail('one of its ZIP compressed blocks could not be decompressed.', { cause: error });
		}
		if (chunk.done) break;
		if (at + chunk.value.length > expected) {
			void reader.cancel().catch(ignore);
			fail('one of its compressed scanline blocks unpacks to more bytes than its scanlines hold.');
		}
		out.set(chunk.value, at);
		at += chunk.value.length;
	}
	if (at !== expected) {
		fail('one of its compressed scanline blocks unpacks to fewer bytes than its scanlines need.');
	}
	return out;
}

/**
 * Return one scanline block as plain pixel bytes.
 *
 * The size check is not a sanity test, it is the format: a compressor whose
 * output came out no smaller than the input is not used at all and the pixels
 * are written as they are, with the stored size being the only record of that.
 * Real files hit this constantly, because a row of a render with any grain in
 * it does not compress, and a reader that always inflates reads noise.
 */
async function uncompressBlock(
	stored: Uint8Array,
	compression: number,
	expected: number,
): Promise<Uint8Array> {
	if (stored.length > expected) {
		fail('one of its scanline blocks holds more bytes than the scanlines it covers can take.');
	}
	if (stored.length === expected) return stored;
	if (compression === NONE) {
		fail('one of its uncompressed scanline blocks is shorter than its scanlines need.');
	}

	// Both unpackers below return exactly `expected` bytes or refuse the file,
	// so there is no length to check afterwards and nothing to allocate past it.
	const raw =
		compression === RLE ? rleUncompress(stored, expected) : await inflateBlock(stored, expected);
	// Both steps, in this order. The predictor was applied to the interleaved
	// buffer on the way in, so undoing the interleave first would take the
	// differences of bytes that were never differenced against each other and
	// produce a picture of noise that still has roughly the right colours in it.
	unpredict(raw);
	return deinterleave(raw);
}

/* ── Colour ───────────────────────────────────────────────────────────── */

/** Rec. 709 primaries and D65, which is what an EXR means when it says nothing. */
const REC709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];
const DISPLAY_P3 = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329];

function matches(view: DataView, at: number, primaries: readonly number[]): boolean {
	for (let i = 0; i < primaries.length; i += 1) {
		// A tenth of a percent. The values are written as 32 bit floats, so 0.64
		// arrives as 0.6399999857 and an exact comparison never matches.
		if (Math.abs(view.getFloat32(at + i * 4, true) - (primaries[i] as number)) > 0.001) {
			return false;
		}
	}
	return true;
}

/**
 * What the numbers in the file are numbers of.
 *
 * The chromaticities attribute is usually absent, and its absence means Rec.
 * 709, whose primaries are sRGB's. When it is present it has to be believed:
 * an ACES file carries the same pixel values with a far wider set of primaries
 * behind them, and reading those as sRGB is not slightly wrong, it is a green
 * cast over the whole picture. There is no transform here for an arbitrary set,
 * so anything that is neither of the two this package can name is refused.
 */
function readColourSpace(view: DataView, attributes: Map<string, Attribute>): ColourSpace {
	const chromaticities = attributes.get('chromaticities');
	if (!chromaticities) return 'srgb';
	if (chromaticities.type !== 'chromaticities' || chromaticities.size !== 32) {
		fail('its chromaticities attribute is not the eight floats it has to be.');
	}
	if (matches(view, chromaticities.at, REC709)) return 'srgb';
	if (matches(view, chromaticities.at, DISPLAY_P3)) return 'display-p3';
	fail(
		'it names colour primaries that are neither Rec. 709 nor Display P3, and this reader has no transform to bring those to either.',
	);
}

/**
 * Refuse a file whose pixels are not square.
 *
 * An anamorphic render carries a pixelAspectRatio of 2, meaning every pixel is
 * twice as wide as it is tall, and a reader that ignores the attribute hands
 * back a picture squeezed to half its width with nothing on it to say so. There
 * is no resampler here, and the sibling Radiance reader refuses the same thing
 * for the same reason, so the two agree about a fact both formats record.
 *
 * The attribute is missing from plenty of files that a tool other than a
 * renderer wrote, and missing means square. Compared with a tolerance rather
 * than exactly, because a writer that computed the ratio from a rational can
 * land a bit either side of 1 and still mean square, and written so that a NaN
 * is refused rather than passed.
 */
function refuseNonSquarePixels(view: DataView, attributes: Map<string, Attribute>): void {
	const attribute = attributes.get('pixelAspectRatio');
	if (!attribute) return;
	if (attribute.type !== 'float' || attribute.size !== 4) {
		fail('its pixelAspectRatio attribute is not the single float it has to be.');
	}
	if (!(Math.abs(view.getFloat32(attribute.at, true) - 1) <= 0.001)) {
		fail(
			'it declares a pixelAspectRatio other than 1, meaning its pixels are not square, and this reader does not resample them.',
		);
	}
}

/* ── Pixels ───────────────────────────────────────────────────────────── */

function sampleAt(view: DataView, at: number, pixelType: number): number {
	if (pixelType === HALF) return halfToFloat(view.getUint16(at, true));
	if (pixelType === FLOAT) return view.getFloat32(at, true);
	// A UINT channel is taken as the number it is rather than divided by
	// 4294967295. The tone mapper meters the whole picture, so a uniform scale
	// on every channel is invisible either way, and the one case where the
	// choice shows is a file mixing an integer channel with a floating point
	// one, where the file's own numbers are the only thing to go on. Dividing
	// would also turn an object identifier channel, which is what UINT is
	// mostly used for, into an image of solid black.
	return view.getUint32(at, true);
}

/**
 * Replace the samples that are not numbers, and say whether the rest of the
 * picture is already inside the range a display can show.
 *
 * Both of the values being replaced here are ordinary things to find in a
 * render: a NaN comes out of an alpha channel divided by itself, and an
 * infinity out of a light divided by zero. Neither is a measurement of light,
 * and leaving one in place does not produce a bright pixel, it produces a black
 * frame. The tone mapper meters on the log average of the luminance, a single
 * infinity takes that average to infinity, the exposure it computes from it is
 * zero, and every pixel in the file comes out at nothing. So an infinity is
 * brought down to the brightest thing that is really in the picture, which is
 * where a viewer shows it, a NaN is taken as no light at all, and a NaN in the
 * alpha channel is taken as opaque rather than as a hole in the image.
 *
 * Alpha is not part of the range question: it is coverage rather than light,
 * and a file whose alpha strays outside 0 to 1 is still a finished frame
 * everywhere that matters.
 */
function sanitise(samples: Float32Array, channels: 3 | 4): boolean {
	let display = true;
	let largest = 0;
	let broken = false;

	for (let i = 0; i < samples.length; i += 1) {
		const value = samples[i] as number;
		const colour = channels === 3 || i % 4 !== 3;
		if (!Number.isFinite(value)) {
			broken = true;
			if (colour) display = false;
			continue;
		}
		if (!colour) continue;
		if (value > largest) largest = value;
		if (value < 0 || value > 1) display = false;
	}

	if (broken) {
		// Nothing finite and lit in the whole picture leaves nothing to stand in
		// for the infinity, and a frame of black with one hot pixel in it is a
		// real thing to be handed. White is the honest stand-in there.
		const ceiling = largest > 0 ? largest : 1;
		for (let i = 0; i < samples.length; i += 1) {
			const value = samples[i] as number;
			if (Number.isFinite(value)) continue;
			const colour = channels === 3 || i % 4 !== 3;
			if (!colour) samples[i] = 1;
			else samples[i] = value > 0 ? ceiling : 0;
		}
	}
	return display;
}

/**
 * Put the decoded pixels where the file says the image is.
 *
 * The data window is where the pixels are; the display window is the image. A
 * render with overscan stores rows outside the frame for a blur to reach into,
 * and a crop region render stores only the tile that was re-rendered, and in
 * both the frame is the display window. Handing back the data window instead
 * gives a picture of the wrong size sitting in the wrong place, which is
 * exactly the kind of wrong that looks right: an eight by six crop out of a
 * forty by thirty frame decodes to a perfectly good eight by six picture.
 *
 * Both windows agree in almost every file, and that case returns the pixels
 * untouched. Where they do not, what is inside the frame but outside the data
 * window was never rendered: it is filled with the background the Technical
 * Introduction asks for, black, left transparent where the file has an alpha
 * channel for it to be transparent in, because a frame whose alpha says nothing
 * was there is more use to whoever composites it than a black border to key.
 *
 * Done after the tone mapping rather than before, so the exposure is metered
 * from the pixels the file actually has. Metering across the background would
 * darken a crop region render in proportion to how much of the frame it covers.
 */
function place(pixels: RasterImage, data: Box, display: Box, alpha: boolean): RasterImage {
	if (
		data.xMin === display.xMin &&
		data.yMin === display.yMin &&
		data.xMax === display.xMax &&
		data.yMax === display.yMax
	) {
		return pixels;
	}

	const out = createRaster(
		display.xMax - display.xMin + 1,
		display.yMax - display.yMin + 1,
		pixels.colourSpace,
		alpha,
	);
	// A fresh raster is transparent black, which is the background for a file
	// with an alpha channel and half of one for a file without: opaque is what
	// keeps an RGB render from acquiring an alpha channel it never had.
	if (!alpha) {
		for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
	}

	const xMin = Math.max(data.xMin, display.xMin);
	const yMin = Math.max(data.yMin, display.yMin);
	const xMax = Math.min(data.xMax, display.xMax);
	const yMax = Math.min(data.yMax, display.yMax);
	// A data window entirely off the frame is a legal file and an empty picture.
	if (xMax < xMin || yMax < yMin) return out;

	// Cropped before it is blitted rather than blitted with a negative offset,
	// which is what an overscan render needs: its pixels start above and to the
	// left of the frame, so the part that lands in it is not the part it starts
	// with.
	const inside = crop(pixels, xMin - data.xMin, yMin - data.yMin, xMax - xMin + 1, yMax - yMin + 1);
	blit(out, inside, xMin - display.xMin, yMin - display.yMin);
	return out;
}

/* ── Entry point ──────────────────────────────────────────────────────── */

/**
 * Read a scan line based OpenEXR file.
 *
 * Asynchronous because ZIP and ZIPS are deflate, and the only deflate here is
 * the platform's own `DecompressionStream`. A NONE or RLE file never waits on
 * anything, but one signature for the format is better than two.
 */
export async function decodeExr(bytes: Uint8Array): Promise<RasterImage> {
	requireBytes(bytes, 0, 8, 'the end of its magic number and version field');
	for (let i = 0; i < MAGIC.length; i += 1) {
		if (bytes[i] !== MAGIC[i]) fail('it does not start with the four byte OpenEXR magic number.');
	}

	const view = viewOf(bytes);
	const versionField = view.getUint32(4, true);
	const version = versionField & 0xff;
	if (version !== VERSION) {
		fail(`it is version ${version}, and this reader implements version 2.`);
	}
	// A reserved bit is the next storage layout, not spare room, and reading a
	// file that has one set as scanlines would produce a plausible wrong
	// picture the same way reading a tiled one would. libOpenEXR refuses these
	// outright, down to declining to open the file, and so does this.
	if ((versionField & ~VERSION_MASK) !== 0) {
		fail(
			'its version field sets bits the format does not define, so it was written to a version of OpenEXR this reader cannot know the shape of.',
		);
	}
	// Three separate files wear the same magic number. Each holds its pixels in
	// a shape this reader has no code for, and reading any of them as scanlines
	// walks straight off the end of the offset table into whatever follows.
	if ((versionField & FLAG_TILED) !== 0) {
		fail('it is a tiled OpenEXR file, which this reader does not implement.');
	}
	if ((versionField & FLAG_DEEP) !== 0) {
		fail(
			'it holds deep pixels, with a varying number of samples behind each one, which this reader does not implement.',
		);
	}
	if ((versionField & FLAG_MULTI_PART) !== 0) {
		fail(
			'it is a multi-part OpenEXR file, holding several images at once, which this reader does not implement.',
		);
	}
	const nameLimit = (versionField & FLAG_LONG_NAMES) !== 0 ? 255 : 31;

	const cursor: Cursor = { at: 8 };
	const attributes = readAttributes(bytes, view, cursor, nameLimit);

	const compression = bytes[attributeOf(attributes, 'compression', 'compression', 1).at] as number;
	if (compression !== NONE && compression !== RLE && compression !== ZIPS && compression !== ZIP) {
		refuseCompression(compression);
	}

	const lineOrder = bytes[attributeOf(attributes, 'lineOrder', 'lineOrder', 1).at] as number;
	if (lineOrder === RANDOM_Y) {
		fail(
			'its scanlines are stored in no particular order, which only a tiled file may do and which this reader does not implement.',
		);
	}
	if (lineOrder !== INCREASING_Y && lineOrder !== DECREASING_Y) {
		fail(`it declares line order ${lineOrder}, which is not one that exists.`);
	}

	// The display window is the image and the data window is where the pixels
	// are. Both are read: the picture that comes out of here is the size of the
	// first with the second placed inside it, which is what `place` is for.
	const displayWindow = readBox(view, attributeOf(attributes, 'displayWindow', 'box2i', 16));
	if (displayWindow.xMax < displayWindow.xMin || displayWindow.yMax < displayWindow.yMin) {
		fail('its display window ends before it begins.');
	}
	const dataWindow = readBox(view, attributeOf(attributes, 'dataWindow', 'box2i', 16));
	if (dataWindow.xMax < dataWindow.xMin || dataWindow.yMax < dataWindow.yMin) {
		fail('its data window ends before it begins.');
	}
	// Inclusive at both ends, so a window from 0 to 0 is one pixel wide and a
	// file whose window is 0 to 1919 is 1920 across.
	const width = dataWindow.xMax - dataWindow.xMin + 1;
	const height = dataWindow.yMax - dataWindow.yMin + 1;
	if (width * height > MAX_PIXELS) {
		fail('its data window describes an image far larger than this reader will allocate for.');
	}
	// Checked separately, because the display window is what gets allocated at
	// the end and nothing ties its size to the data window's: a one pixel data
	// window inside a sixty thousand square frame is a small file that asks for
	// an enormous raster.
	if (
		(displayWindow.xMax - displayWindow.xMin + 1) * (displayWindow.yMax - displayWindow.yMin + 1) >
		MAX_PIXELS
	) {
		fail('its display window describes an image far larger than this reader will allocate for.');
	}

	const channels = readChannels(
		bytes,
		view,
		attributeOf(attributes, 'channels', 'chlist'),
		nameLimit,
	);
	refuseUnreadableLayout(channels);
	const { targets, alpha } = targetsFor(channels);
	const colourSpace = readColourSpace(view, attributes);
	refuseNonSquarePixels(view, attributes);

	let bytesPerLine = 0;
	for (const channel of channels) bytesPerLine += width * channel.sampleBytes;

	const linesPerBlock = LINES_PER_BLOCK[compression] as number;
	const blocks = Math.ceil(height / linesPerBlock);
	requireBytes(bytes, cursor.at, blocks * 8, 'the end of its scanline offset table');
	const tableAt = cursor.at;
	// Every block costs at least its own eight byte header, so a table claiming
	// more blocks than the rest of the file could possibly hold is refused here
	// rather than after the raster has been allocated for it.
	if (bytes.length - (tableAt + blocks * 8) < blocks * 8) {
		fail('its offset table claims more scanline blocks than the rest of the file could hold.');
	}

	const outChannels: 3 | 4 = alpha ? 4 : 3;
	const samples = new Float32Array(width * height * outChannels);
	const seen = new Uint8Array(blocks);

	for (let block = 0; block < blocks; block += 1) {
		const low = view.getUint32(tableAt + block * 8, true);
		const high = view.getUint32(tableAt + block * 8 + 4, true);
		const offset = high * 0x100000000 + low;
		requireBytes(bytes, offset, 8, 'the start of one of its scanline blocks');

		// The y coordinate stored with the block is what places it, rather than
		// its position in the file. That is what honours a decreasing line
		// order without a second code path: a bottom-to-top file hands over the
		// same blocks in the opposite order, each still saying which rows it
		// holds, and each lands where it belongs.
		const y = view.getInt32(offset, true);
		const size = view.getUint32(offset + 4, true);
		requireBytes(bytes, offset + 8, size, 'the end of one of its scanline blocks');
		if (y < dataWindow.yMin || y > dataWindow.yMax) {
			fail('one of its scanline blocks sits outside the data window it belongs to.');
		}
		const index = (y - dataWindow.yMin) / linesPerBlock;
		if (!Number.isInteger(index)) {
			fail('one of its scanline blocks starts partway through the run of rows a block covers.');
		}
		if (seen[index] === 1) fail('two of its scanline blocks claim the same rows.');
		seen[index] = 1;

		const lines = Math.min(linesPerBlock, dataWindow.yMax - y + 1);
		const stored = bytes.subarray(offset + 8, offset + 8 + size);
		const pixels = await uncompressBlock(stored, compression, lines * bytesPerLine);
		const blockView = viewOf(pixels);

		let at = 0;
		for (let line = 0; line < lines; line += 1) {
			const row = (y - dataWindow.yMin + line) * width * outChannels;
			for (let i = 0; i < channels.length; i += 1) {
				const channel = channels[i] as ExrChannel;
				const target = targets[i] as number;
				if (target !== SKIP) {
					for (let x = 0; x < width; x += 1) {
						const value = sampleAt(blockView, at + x * channel.sampleBytes, channel.pixelType);
						const to = row + x * outChannels;
						if (target === LUMINANCE) {
							samples[to] = value;
							samples[to + 1] = value;
							samples[to + 2] = value;
						} else {
							samples[to + target] = value;
						}
					}
				}
				at += width * channel.sampleBytes;
			}
		}
	}

	// Which of the two answers is right is a property of the file rather than a
	// preference, so the file is asked. An EXR whose colour never leaves 0 to 1
	// has already had somebody's display transform applied to it, by a
	// compositor writing a final frame or by a converter promoting an eight bit
	// image, and rolling its highlights off a second time flattens a picture
	// that has none left to roll off. Anything above 1 is scene referred, where
	// 1 is a white surface and the lamp in the same frame is in the thousands,
	// and clipping that turns every window and every highlight into a flat white
	// shape. Both mistakes look like a bad photograph rather than like an error.
	const clip = sanitise(samples, outChannels);
	const pixels = toneMap(samples, width, height, outChannels, { clip, colourSpace });
	const image = place(pixels, dataWindow, displayWindow, alpha);

	// An alpha channel that is 1 everywhere is an opaque image, whatever the
	// channel list says. Saying so lets an encoder write the cheaper form. It
	// also picks up the other direction: a crop region render out of a file with
	// an alpha channel is transparent everywhere it was not rendered.
	return { ...image, hasAlpha: detectAlpha(image) };
}
