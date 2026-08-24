/**
 * A Photoshop reader, for PSD and for its large sibling PSB.
 *
 * A Photoshop file is a layer stack, and this reads none of it. What it reads
 * is the last of the four sections, the Image Data section, which holds the
 * flattened composite Photoshop writes so that the rest of the world can open
 * the file at all. That composite is the picture somebody who cannot open a PSD
 * is asking for; rebuilding it from the layers instead would mean implementing
 * blend modes, clipping groups, adjustment layers and smart objects, and would
 * still disagree with Photoshop about the result.
 *
 * What it reads: version 1 and version 2, depths 1, 8, 16 and 32, raw,
 * PackBits and both ZIP compressions, and the Bitmap, Greyscale, Indexed, RGB,
 * CMYK and Duotone colour modes. What it refuses by name: Lab and
 * Multichannel.
 *
 * Five things in this format are counterintuitive enough to be worth naming
 * before the code says them. Height is stored before width. Channels are whole
 * planes one after another rather than interleaved per pixel. CMYK is stored
 * inverted, so 255 means no ink. In Bitmap mode a set bit is black, which is
 * the reverse of what everybody assumes. And the composite is stored already
 * blended onto white rather than as the straight colour its alpha channel
 * belongs to, which `unmatte` divides back out.
 *
 * Every read is bounds checked, because these bytes came from a file somebody
 * else made. A truncated PSD must produce a sentence naming the structure it
 * stopped inside, not an undefined that turns into a black row later on.
 */

import { CodecUnavailableError, DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import { toneMap } from '../../raster/tonemap.js';
import type { RasterImage } from '../../types.js';
import { hasCompressionStream } from '../png/deflate.js';
import { ZipFormatError, inflateImageData } from './zip.js';

const DECODER_ID = 'psd-pure';

/** Signature, version, six reserved bytes, channels, height, width, depth, mode. */
const HEADER_BYTES = 26;

const MODE_BITMAP = 0;
const MODE_GREYSCALE = 1;
const MODE_INDEXED = 2;
const MODE_RGB = 3;
const MODE_CMYK = 4;
const MODE_MULTICHANNEL = 7;
const MODE_DUOTONE = 8;
const MODE_LAB = 9;

const COMPRESSION_RAW = 0;
const COMPRESSION_RLE = 1;
const COMPRESSION_ZIP = 2;
const COMPRESSION_ZIP_PREDICTED = 3;

/**
 * Photoshop's own ceilings on a side.
 *
 * Worth enforcing rather than treating as trivia: they are the only thing in
 * the header that catches a corrupt dimension before the arithmetic below turns
 * it into an allocation.
 */
const MAX_SIDE_PSD = 30000;
const MAX_SIDE_PSB = 300000;

/** The header's channel count is a 16 bit field, but the format stops at 56. */
const MAX_CHANNELS = 56;

/** The same ceiling the QOI, TGA and PNM readers use, for the same reason. */
const MAX_PIXELS = 400_000_000;

/**
 * The largest the image data section may unpack to.
 *
 * `MAX_PIXELS` bounds the picture but not the file's claim about how many bytes
 * describe it: 56 channels of 32 bit samples is 224 bytes a pixel, and a header
 * is free to say so. This is the ceiling on the buffer those samples unpack
 * into. No real Photoshop file comes near it, and past it the allocation itself
 * starts failing, which arrives as a RangeError rather than as a sentence.
 */
const MAX_IMAGE_DATA_BYTES = 2_000_000_000;

/**
 * The most PackBits can expand.
 *
 * Its best case is a run of 128 identical bytes written as two, so nothing a
 * row length table describes can honestly grow by more than 64 to 1.
 */
const MAX_PACKBITS_RATIO = 64;

/** The most a deflate stream can expand, which RFC 1951 fixes at 1032 to 1. */
const MAX_DEFLATE_RATIO = 1032;

/** Indexed colour tables are always this long: 256 reds, 256 greens, 256 blues. */
const INDEXED_PALETTE_BYTES = 768;

function fail(detail: string): never {
	throw new DecodeFailedError('psd', DECODER_ID, detail);
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

/**
 * Refuse a claim larger than the bytes present could produce, before allocating.
 *
 * A two byte change to a header turns a small file into a claim of gigabytes,
 * and the buffer for that is allocated long before the decoder runs out of
 * input and notices. `ratio` is the best case of the compression in question,
 * so this rejects only headers that are already lying.
 */
function requireExpansion(available: number, wanted: number, ratio: number, what: string): void {
	if (wanted > available * ratio) {
		fail(
			`its ${what} image data would unpack to ${wanted} bytes, which is more than the ${available} bytes left in the file could produce.`,
		);
	}
}

interface PsdHeader {
	/** True for a PSB, which widens one length field and both dimension limits. */
	readonly large: boolean;
	readonly channels: number;
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	readonly mode: number;
	/** Channels the colour mode itself uses. Anything past them is alpha. */
	readonly colourChannels: number;
	/** Bytes one row of one channel occupies before compression. */
	readonly rowBytes: number;
}

/** How many of the stored channels carry colour, or 0 for a mode we refuse. */
function colourChannelsOf(mode: number): number {
	switch (mode) {
		case MODE_BITMAP:
		case MODE_GREYSCALE:
		case MODE_INDEXED:
		case MODE_DUOTONE:
			return 1;
		case MODE_RGB:
			return 3;
		case MODE_CMYK:
			return 4;
		default:
			return 0;
	}
}

function refuseMode(mode: number): never {
	switch (mode) {
		case MODE_MULTICHANNEL:
			fail(
				'it is a multichannel image, which is a bag of separate ink plates with no colour meaning attached, and this reader does not implement it.',
			);
			break;
		case MODE_LAB:
			fail(
				'it is a Lab colour image, and converting Lab to a screen colour needs a white point this reader does not implement.',
			);
			break;
		default:
			fail(`it declares colour mode ${mode}, which the format does not define.`);
	}
}

function readHeader(bytes: Uint8Array, view: DataView): PsdHeader {
	requireBytes(bytes, 0, HEADER_BYTES, 'the end of its 26 byte header');
	if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) {
		fail('it does not start with the four byte "8BPS" signature every Photoshop file begins with.');
	}

	const version = view.getUint16(4, false);
	if (version !== 1 && version !== 2) {
		fail(`it declares format version ${version}, and only 1 (PSD) and 2 (PSB) exist.`);
	}
	const large = version === 2;

	// Six bytes the specification says must be zero. Checking costs nothing and
	// it is the difference between refusing a file that merely happens to start
	// with those four letters and confidently reading a picture out of it.
	for (let i = 6; i < 12; i += 1) {
		if (bytes[i] !== 0) fail('the six reserved bytes after its version number are not zero.');
	}

	const channels = view.getUint16(12, false);
	// Height first. Every other format in this package writes width first, and
	// reading these two the usual way round produces a transposed picture out of
	// a square-ish file and a bounds failure out of everything else.
	const height = view.getUint32(14, false);
	const width = view.getUint32(18, false);
	const depth = view.getUint16(22, false);
	const mode = view.getUint16(24, false);

	if (channels < 1 || channels > MAX_CHANNELS) {
		fail(`it declares ${channels} channels, and the format allows 1 to ${MAX_CHANNELS}.`);
	}
	if (width < 1 || height < 1) {
		fail('it declares a width or a height of zero.');
	}
	const maxSide = large ? MAX_SIDE_PSB : MAX_SIDE_PSD;
	if (width > maxSide || height > maxSide) {
		fail(
			`it is ${width} by ${height} pixels, past the ${maxSide} a ${large ? 'PSB' : 'PSD'} is allowed.`,
		);
	}
	if (width * height > MAX_PIXELS) {
		fail('it describes an image far larger than anything this tool will allocate for.');
	}
	if (depth !== 1 && depth !== 8 && depth !== 16 && depth !== 32) {
		fail(`it is ${depth} bits per channel, and the format defines only 1, 8, 16 and 32.`);
	}

	const colourChannels = colourChannelsOf(mode);
	if (colourChannels === 0) refuseMode(mode);

	if (mode === MODE_BITMAP) {
		if (depth !== 1) {
			fail(`it is a bitmap mode image at ${depth} bits per channel, and bitmap mode is one bit.`);
		}
		if (channels !== 1) {
			fail(
				`it is a bitmap mode image with ${channels} channels, and this reader reads only the single channel Photoshop writes for that mode.`,
			);
		}
	} else if (depth === 1) {
		fail('it is one bit per channel outside bitmap mode, which the format does not define.');
	}
	if (mode === MODE_INDEXED && depth !== 8) {
		fail(`it is an indexed image at ${depth} bits per channel, and an indexed image is eight.`);
	}
	if (mode === MODE_CMYK && depth === 32) {
		fail(
			'it is a 32 bit floating point CMYK image, which Photoshop does not write and this reader does not implement.',
		);
	}
	if (channels < colourChannels) {
		fail(`it declares ${channels} channels, where its colour mode needs ${colourChannels}.`);
	}

	// A one bit row is padded out to a whole byte; every other depth divides
	// evenly, so the ceiling only ever does anything in bitmap mode.
	const rowBytes = Math.ceil((width * depth) / 8);
	return { large, channels, width, height, depth, mode, colourChannels, rowBytes };
}

interface Sections {
	/**
	 * The colour table, present only for an indexed image.
	 *
	 * Its presence is what tells the assembly below that the stored channel
	 * holds indices rather than levels, so there is no second test to keep in
	 * step with this one.
	 */
	readonly palette?: Uint8Array;
	/** Where the Image Data section's compression word starts. */
	readonly imageDataAt: number;
}

/**
 * Read one section's length prefix.
 *
 * A PSB widens the Layer and Mask length to 64 bits and leaves the other two at
 * 32. Reading that one as 32 bits in a PSB lands the image data offset in the
 * middle of the layer stack, where the compression word is whatever two bytes
 * happen to be sitting there and the picture that comes out is noise.
 */
function readSectionLength(
	bytes: Uint8Array,
	view: DataView,
	at: number,
	wide: boolean,
	what: string,
): number {
	requireBytes(bytes, at, wide ? 8 : 4, `the length of its ${what} section`);
	if (!wide) return view.getUint32(at, false);
	// Combined from two 32 bit halves rather than read through BigInt. The value
	// is a file offset, so anything that does not fit in a safe integer is
	// already longer than any buffer, and the bounds check turns it into a
	// sentence rather than into a type error.
	return view.getUint32(at, false) * 0x100000000 + view.getUint32(at + 4, false);
}

function readSections(bytes: Uint8Array, view: DataView, header: PsdHeader): Sections {
	let at = HEADER_BYTES;

	const colourModeLength = readSectionLength(bytes, view, at, false, 'colour mode data');
	at += 4;
	requireBytes(bytes, at, colourModeLength, 'the end of its colour mode data section');
	let palette: Uint8Array | undefined;
	if (header.mode === MODE_INDEXED) {
		if (colourModeLength !== INDEXED_PALETTE_BYTES) {
			fail(
				`it is an indexed image whose colour mode data is ${colourModeLength} bytes, where a colour table is always ${INDEXED_PALETTE_BYTES}.`,
			);
		}
		palette = bytes.subarray(at, at + INDEXED_PALETTE_BYTES);
	}
	// Duotone parks its ink specification here, and nothing else uses this
	// section at all. The specification says a reader that does not reproduce
	// duotone inks should treat the image as greyscale, which is what happens
	// below, so the specification is skipped rather than parsed.
	at += colourModeLength;

	const resourcesLength = readSectionLength(bytes, view, at, false, 'image resources');
	at += 4;
	requireBytes(bytes, at, resourcesLength, 'the end of its image resources section');
	// Resolution, thumbnails, the ICC profile and a hundred other resource
	// blocks live in here. None of them is the picture.
	at += resourcesLength;

	const layerLength = readSectionLength(
		bytes,
		view,
		at,
		header.large,
		'layer and mask information',
	);
	at += header.large ? 8 : 4;
	requireBytes(bytes, at, layerLength, 'the end of its layer and mask information section');
	at += layerLength;

	requireBytes(bytes, at, 2, 'its image data section, which is where the flattened picture lives');
	return { palette, imageDataAt: at };
}

/**
 * PackBits, as PSD and TIFF both spell it.
 *
 * A control byte under 128 means the next n plus one bytes are literal; over
 * 128 it reads as a negative in a signed byte and means the next byte repeated
 * 257 minus n times. Exactly 128 is defined as a no-op, and it is the trap
 * here: treating it as either kind of packet writes a byte that is not in the
 * picture and puts every row after it one byte out of step.
 *
 * A row is required to decode to exactly its width. Photoshop writes them that
 * way, and letting a short row through would leave the tail of the row holding
 * whatever the previous row left in the buffer.
 */
function unpackBits(
	bytes: Uint8Array,
	from: number,
	end: number,
	target: Uint8Array,
	to: number,
	count: number,
): void {
	const stop = to + count;
	let at = from;
	let out = to;
	while (at < end) {
		const control = bytes[at] as number;
		at += 1;
		if (control === 128) continue;
		if (control < 128) {
			const length = control + 1;
			if (at + length > end) fail('a run length encoded row ends inside a literal run.');
			if (out + length > stop) {
				fail('a run length encoded row decodes to more bytes than its width holds.');
			}
			target.set(bytes.subarray(at, at + length), out);
			at += length;
			out += length;
			continue;
		}
		const length = 257 - control;
		if (at >= end) fail('a run length encoded row ends inside a repeated run.');
		if (out + length > stop) {
			fail('a run length encoded row decodes to more bytes than its width holds.');
		}
		target.fill(bytes[at] as number, out, out + length);
		at += 1;
		out += length;
	}
	if (out !== stop) fail('a run length encoded row decodes to fewer bytes than its width needs.');
}

function readRle(
	bytes: Uint8Array,
	view: DataView,
	header: PsdHeader,
	from: number,
	total: number,
): Uint8Array {
	const { height, channels, rowBytes, large } = header;
	// One count for every row of every channel, in the same order the planes
	// follow, and four bytes each in a PSB where a PSD spends two.
	const rows = height * channels;
	const countBytes = large ? 4 : 2;
	requireBytes(bytes, from, rows * countBytes, 'the end of the table of row lengths it promises');

	let at = from + rows * countBytes;
	requireExpansion(bytes.length - at, total, MAX_PACKBITS_RATIO, 'run length encoded');

	const out = new Uint8Array(total);
	let written = 0;
	for (let row = 0; row < rows; row += 1) {
		const count = large
			? view.getUint32(from + row * 4, false)
			: view.getUint16(from + row * 2, false);
		requireBytes(bytes, at, count, `the end of row ${row} of its image data`);
		unpackBits(bytes, at, at + count, out, written, rowBytes);
		at += count;
		written += rowBytes;
	}
	return out;
}

/**
 * Undo the horizontal delta a ZIP with prediction applies.
 *
 * The delta runs along a row and restarts at each one, and rows here means
 * every row of every channel, because the planes are stored end to end and the
 * compressor saw them as one tall image.
 */
function undoPrediction(planes: Uint8Array, header: PsdHeader): void {
	const { width, height, channels, depth, rowBytes } = header;
	const rows = height * channels;

	if (depth === 16) {
		for (let row = 0; row < rows; row += 1) {
			const base = row * rowBytes;
			let previous = ((planes[base] as number) << 8) | (planes[base + 1] as number);
			for (let x = 1; x < width; x += 1) {
				const at = base + x * 2;
				const value =
					(previous + (((planes[at] as number) << 8) | (planes[at + 1] as number))) & 0xffff;
				planes[at] = value >>> 8;
				planes[at + 1] = value & 0xff;
				previous = value;
			}
		}
		return;
	}

	for (let row = 0; row < rows; row += 1) {
		const base = row * rowBytes;
		for (let i = 1; i < rowBytes; i += 1) {
			planes[base + i] = ((planes[base + i] as number) + (planes[base + i - 1] as number)) & 0xff;
		}
	}
	if (depth !== 32) return;

	// A 32 bit row is not four bytes per pixel in order. The delta ran across
	// the whole row of bytes, and those bytes are stored in four groups: every
	// pixel's first byte, then every pixel's second, and so on. It is TIFF's
	// floating point predictor, and it exists because the exponent byte of a
	// smooth gradient barely changes while the mantissa bytes are noise, so
	// separating them is the difference between compressing and not.
	const row = new Uint8Array(rowBytes);
	for (let r = 0; r < rows; r += 1) {
		const base = r * rowBytes;
		row.set(planes.subarray(base, base + rowBytes));
		for (let x = 0; x < width; x += 1) {
			for (let b = 0; b < 4; b += 1) {
				planes[base + x * 4 + b] = row[b * width + x] as number;
			}
		}
	}
}

async function readZip(
	bytes: Uint8Array,
	header: PsdHeader,
	from: number,
	total: number,
	predicted: boolean,
): Promise<Uint8Array> {
	if (predicted && header.depth === 1) {
		fail(
			'it uses ZIP compression with prediction on a one bit image, which the format has no delta for and this reader does not implement.',
		);
	}
	requireExpansion(bytes.length - from, total, MAX_DEFLATE_RATIO, 'ZIP compressed');
	if (!hasCompressionStream()) {
		throw new CodecUnavailableError(
			'DecompressionStream',
			'This browser is too old to read a ZIP compressed Photoshop file here. It needs decompression built in, which arrived in Safari 16.4 and has been in Chrome and Firefox for longer.',
		);
	}

	// One stream at a time, because the section is not reliably one of them.
	// The writers that put ZIP here write a stream per channel plane, laid end
	// to end with no length in front of any of them, and the platform's
	// decompressor reads the second one as corruption at the end of the first.
	// `inflateImageData` measures each stream before handing it over, which is
	// also what lets a file with padding after its picture decode.
	let inflated: Uint8Array;
	try {
		inflated = await inflateImageData(bytes, from, total, header.channels);
	} catch (error) {
		if (error instanceof ZipFormatError) fail(error.message);
		throw new DecodeFailedError(
			'psd',
			DECODER_ID,
			'its ZIP compressed image data could not be unpacked.',
			{ cause: error },
		);
	}
	if (inflated.length < total) {
		fail(
			`its ZIP compressed image data unpacked to ${inflated.length} bytes, where its dimensions need ${total}.`,
		);
	}

	const planes = inflated.subarray(0, total);
	if (predicted) undoPrediction(planes, header);
	return planes;
}

/** Every channel plane, end to end, at the file's own depth. */
async function readPlanes(
	bytes: Uint8Array,
	view: DataView,
	header: PsdHeader,
	at: number,
): Promise<Uint8Array> {
	const compression = view.getUint16(at, false);
	const from = at + 2;
	const total = header.rowBytes * header.height * header.channels;
	if (total > MAX_IMAGE_DATA_BYTES) {
		fail(
			`its ${header.channels} channels at ${header.depth} bits come to ${total} bytes, which is more than this reader will hold at once.`,
		);
	}

	switch (compression) {
		case COMPRESSION_RAW:
			requireBytes(bytes, from, total, 'the end of its uncompressed image data');
			return bytes.subarray(from, from + total);
		case COMPRESSION_RLE:
			return readRle(bytes, view, header, from, total);
		case COMPRESSION_ZIP:
		case COMPRESSION_ZIP_PREDICTED:
			return readZip(bytes, header, from, total, compression === COMPRESSION_ZIP_PREDICTED);
		default:
			fail(
				`its image data declares compression method ${compression}, which the format does not define.`,
			);
	}
}

/**
 * Fill in the alpha channel.
 *
 * Anything past the channels the colour mode uses is alpha, and for a flattened
 * file that is where Photoshop puts the composite's own transparency. Channels
 * past the first one are spot colours and separations, which are not part of
 * the composite, so they are read past rather than blended in.
 */
function fillAlpha(header: PsdHeader, planes: Uint8Array, target: Uint8ClampedArray): void {
	const pixels = header.width * header.height;
	if (header.channels === header.colourChannels) {
		for (let i = 0; i < pixels; i += 1) target[i * 4 + 3] = 255;
		return;
	}
	const step = header.depth === 16 ? 2 : 1;
	const base = header.colourChannels * header.rowBytes * header.height;
	for (let i = 0; i < pixels; i += 1) {
		target[i * 4 + 3] = planes[base + i * step] as number;
	}
}

/**
 * Take the white back out of a sample that was stored blended onto it.
 *
 * The composite Photoshop writes is not the straight colour this package's
 * rasters hold. It is that colour already blended onto white, with the
 * transparency alongside it in its own channel, which is why a transparent
 * area of a Photoshop file reads as pure white rather than as nothing. Handing
 * those bytes back as straight alpha lightens every soft edge, and then
 * flattening the result onto a background blends the white in a second time.
 *
 * Two things make this readable off a file rather than assumed. Every fully
 * transparent pixel of a Photoshop document is exactly 255 in all three
 * channels, and the mean colour of each alpha level runs in a straight line
 * towards white as the alpha falls, which no straight alpha image does.
 *
 * ImageMagick does the same division, and its `psd:alpha-unblend=off` exists
 * for the files this is wrong about: ImageMagick's own writer stores the
 * composite straight, and those come out darker at a soft edge for the same
 * reason a Photoshop file came out lighter without it. Photoshop's files are
 * what a Photoshop reader is for, so this is the side to be wrong on, and
 * macOS ImageIO choosing the other side is why the two disagree about a logo.
 */
function unmatte(level: number, alpha: number): number {
	// Nothing was blended in at full coverage, and where there is no coverage
	// there is nothing to take back out either: the stored matte is all that
	// was ever there, so it stays, which is also where ImageMagick leaves it.
	if (alpha === 255 || alpha === 0) return level;
	const straight = ((level - 255) * 255) / alpha + 255;
	// A composite further from white than its own coverage allows is not a
	// blend of anything, and the division sends it below zero. Only the floor
	// needs checking: a stored level is never above white, so the division can
	// only ever move it down from there.
	return straight < 0 ? 0 : straight;
}

function assembleBitmap(header: PsdHeader, planes: Uint8Array): RasterImage {
	const { width, height, rowBytes } = header;
	const out = createRaster(width, height, 'srgb', false);
	const target = out.data;
	for (let y = 0; y < height; y += 1) {
		const row = y * rowBytes;
		for (let x = 0; x < width; x += 1) {
			// A set bit is black. Bitmap mode counts ink rather than light, which
			// is the reverse of every other mode in this format and of every other
			// one bit format in this package except Netpbm's P1 and P4. Getting it
			// backwards produces a negative, which reads as a deliberate effect
			// rather than as a bug.
			const bit = ((planes[row + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
			const level = bit === 1 ? 0 : 255;
			const at = (y * width + x) * 4;
			target[at] = level;
			target[at + 1] = level;
			target[at + 2] = level;
		}
	}
	// No division to undo here whatever the alpha says: the header check refuses
	// a bitmap mode file that carries more than the one channel Photoshop
	// writes, so this is always opaque.
	fillAlpha(header, planes, target);
	return out;
}

function assembleIndexed(header: PsdHeader, planes: Uint8Array, palette: Uint8Array): RasterImage {
	const { width, height } = header;
	const pixels = width * height;
	const out = createRaster(width, height, 'srgb', false);
	const target = out.data;
	// Before the colour rather than after it, because a matted composite has to
	// be divided by its own coverage and every path below wants it in hand.
	fillAlpha(header, planes, target);
	for (let i = 0; i < pixels; i += 1) {
		// The table is three runs of 256 rather than 256 triples: every red, then
		// every green, then every blue. Reading it interleaved produces the right
		// picture seen through coloured glass, which looks like a colour
		// management problem rather than like a parsing one.
		const index = planes[i] as number;
		const at = i * 4;
		const alpha = target[at + 3] as number;
		target[at] = unmatte(palette[index] as number, alpha);
		target[at + 1] = unmatte(palette[256 + index] as number, alpha);
		target[at + 2] = unmatte(palette[512 + index] as number, alpha);
	}
	return out;
}

function assembleBytes(header: PsdHeader, planes: Uint8Array): RasterImage {
	const { width, height, depth, mode, rowBytes } = header;
	const pixels = width * height;
	const planeBytes = rowBytes * height;
	// A 16 bit sample is taken as its high byte, which is a plain truncation
	// rather than a rescale. The two differ by less than one part in 255 and
	// only at the very top of the range, and the alternative costs a multiply
	// and a divide on every sample of a file that is already twice the size.
	const step = depth === 16 ? 2 : 1;
	const out = createRaster(width, height, 'srgb', false);
	const target = out.data;
	// Before the colour rather than after it: a matted composite is divided by
	// its own coverage, and in CMYK that has to happen on the four plates
	// before they multiply together rather than on the colour they produce.
	fillAlpha(header, planes, target);

	switch (mode) {
		case MODE_RGB: {
			const green = planeBytes;
			const blue = planeBytes * 2;
			for (let i = 0; i < pixels; i += 1) {
				const from = i * step;
				const at = i * 4;
				const alpha = target[at + 3] as number;
				target[at] = unmatte(planes[from] as number, alpha);
				target[at + 1] = unmatte(planes[green + from] as number, alpha);
				target[at + 2] = unmatte(planes[blue + from] as number, alpha);
			}
			break;
		}
		case MODE_CMYK: {
			const magenta = planeBytes;
			const yellow = planeBytes * 2;
			const black = planeBytes * 3;
			for (let i = 0; i < pixels; i += 1) {
				const from = i * step;
				const at = i * 4;
				// No inversion appears here and the code is right anyway. Photoshop
				// stores CMYK inverted, so a stored 255 is no ink, and the usual
				// conversion inverts each channel to turn ink into light. The two
				// inversions cancel and the stored bytes multiply together
				// directly. Writing out the inversion as well produces a negative.
				// Paper white is where a CMYK composite is matted, and paper white
				// is a stored 255 on every plate, so the same division undoes it.
				const alpha = target[at + 3] as number;
				const key = unmatte(planes[black + from] as number, alpha);
				target[at] = (unmatte(planes[from] as number, alpha) * key) / 255;
				target[at + 1] = (unmatte(planes[magenta + from] as number, alpha) * key) / 255;
				target[at + 2] = (unmatte(planes[yellow + from] as number, alpha) * key) / 255;
			}
			break;
		}
		default: {
			// Greyscale, and duotone with it. A duotone file is stored as one grey
			// channel and nothing else; the inks that colour it live in the colour
			// mode data, and the specification itself says a reader that does not
			// reproduce them should treat the image as greyscale.
			for (let i = 0; i < pixels; i += 1) {
				const at = i * 4;
				const level = unmatte(planes[i * step] as number, target[at + 3] as number);
				target[at] = level;
				target[at + 1] = level;
				target[at + 2] = level;
			}
			break;
		}
	}

	return out;
}

/**
 * The 32 bit path, where a sample is linear light rather than a level.
 *
 * Handing those numbers straight to an eight bit raster would clip everything
 * above 1 to white and leave the rest of the picture in the bottom of the
 * range. `toneMap` meters the picture the way a camera does instead, and what
 * that costs is said in the tone mapper rather than hidden here.
 */
function assembleFloat(header: PsdHeader, planes: Uint8Array): RasterImage {
	const { width, height, mode, channels, colourChannels, rowBytes } = header;
	const pixels = width * height;
	const planeBytes = rowBytes * height;
	const hasAlpha = channels > colourChannels;
	const outChannels: 3 | 4 = hasAlpha ? 4 : 3;
	const source = new Float32Array(pixels * outChannels);
	const view = new DataView(planes.buffer, planes.byteOffset, planes.byteLength);

	if (mode === MODE_RGB) {
		for (let i = 0; i < pixels; i += 1) {
			const from = i * 4;
			const to = i * outChannels;
			source[to] = view.getFloat32(from, false);
			source[to + 1] = view.getFloat32(planeBytes + from, false);
			source[to + 2] = view.getFloat32(planeBytes * 2 + from, false);
		}
	} else {
		for (let i = 0; i < pixels; i += 1) {
			const level = view.getFloat32(i * 4, false);
			const to = i * outChannels;
			source[to] = level;
			source[to + 1] = level;
			source[to + 2] = level;
		}
	}
	if (hasAlpha) {
		const base = colourChannels * planeBytes;
		for (let i = 0; i < pixels; i += 1) {
			const to = i * outChannels;
			// White is 1 in linear light, so the division `unmatte` does on a byte
			// is the same one written out here against a ceiling of 1 instead of
			// 255. Only the floor is enforced: a 32 bit file holds light above
			// diffuse white on purpose, and clamping the top would be the clipping
			// the tone mapper exists to avoid.
			const alpha = view.getFloat32(base + i * 4, false);
			source[to + 3] = alpha;
			if (alpha > 0 && alpha < 1) {
				for (let k = 0; k < 3; k += 1) {
					const straight = ((source[to + k] as number) - 1) / alpha + 1;
					source[to + k] = straight < 0 ? 0 : straight;
				}
			}
		}
	}

	return toneMap(source, width, height, outChannels);
}

function assemble(
	header: PsdHeader,
	planes: Uint8Array,
	palette: Uint8Array | undefined,
): RasterImage {
	if (palette) return assembleIndexed(header, planes, palette);
	if (header.mode === MODE_BITMAP) return assembleBitmap(header, planes);
	if (header.depth === 32) return assembleFloat(header, planes);
	return assembleBytes(header, planes);
}

/**
 * Read the flattened composite out of a PSD or a PSB.
 *
 * Asynchronous because two of the four compression methods are deflate, and the
 * only deflate here is the platform's, which is a stream. The result is always
 * tagged sRGB: a Photoshop file can carry an ICC profile among its image
 * resources and its CMYK numbers are not sRGB at all, but nothing here reads a
 * profile, and claiming a colour space this reader has not measured would be
 * worse than saying plainly what the numbers are being treated as.
 */
export async function decodePsd(bytes: Uint8Array): Promise<RasterImage> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = readHeader(bytes, view);
	const { palette, imageDataAt } = readSections(bytes, view, header);
	const planes = await readPlanes(bytes, view, header, imageDataAt);
	const image = assemble(header, planes, palette);
	return { ...image, hasAlpha: detectAlpha(image) };
}
