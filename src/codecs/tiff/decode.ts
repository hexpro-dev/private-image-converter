/**
 * A TIFF reader.
 *
 * TIFF is not a format so much as a filing system for pixels. A file is a
 * header, a chain of directories, and blocks of samples wherever the writer
 * felt like putting them; almost nothing about the layout is fixed. Two bytes
 * at the front decide the byte order of every number after them, a directory
 * entry holds its value inline when it fits in four bytes and an offset when
 * it does not, and the picture itself may be in strips or in tiles, one plane
 * or several, at six different sample depths, under seven different
 * compression schemes, in any of five colour interpretations.
 *
 * That is why nothing in a browser reads one, and it is why this exists:
 * scanners, microscopes, GIS tools and print shops all emit TIFF and nothing
 * else, and everything downstream of them assumes a desktop.
 *
 * What it reads: classic TIFF in both byte orders; strips and tiles; chunky
 * and planar; 1, 2, 4, 8, 16 and 32 bit samples, unsigned, signed or IEEE
 * floating point; WhiteIsZero, BlackIsZero, RGB, palette, transparency mask
 * and CMYK; no compression, PackBits, LZW, Deflate, and all three CCITT
 * bilevel schemes including two dimensional Group 3 and Group 4; horizontal
 * differencing; associated and unassociated alpha; and the orientation tag,
 * because a decoder here hands back an image that is already the right way up.
 *
 * What it refuses, each by name: BigTIFF, the JPEG compressions, JPEG 2000,
 * LZMA, Zstd, WebP, YCbCr and the three Lab interpretations, the floating
 * point predictor, and CCITT's uncompressed mode.
 *
 * There are two ways out of it. `decodeTiff` hands back eight bit pixels, which
 * is what almost every TIFF holds. `decodeTiffFloat` hands back the light a
 * floating point TIFF stored, so that one on its way to OpenEXR is not reduced
 * here and expanded again there, and it refuses everything else on sight. The
 * note above it is worth reading before touching either of those refusals: both
 * of them exist because the alternative is a picture that is quietly wrong
 * rather than an error anybody would notice.
 *
 * Every read is bounds checked. These bytes came from a stranger's scanner,
 * and a directory that points past the end of the file has to produce a
 * sentence rather than an undefined that becomes a black band two hundred
 * lines later.
 */

import { CodecUnavailableError, DecodeFailedError } from '../../errors.js';
import { createFloat, detectFloatAlpha } from '../../raster/float.js';
import { applyOrientation, createRaster, detectAlpha } from '../../raster/image.js';
import { halfToFloat, toneMap } from '../../raster/tonemap.js';
import type { FloatImage, Mirror, RasterImage, Rotation } from '../../types.js';
import { inflate } from '../png/deflate.js';
import { decodeCcitt, type CcittKind } from './ccitt.js';
import { decodeLzw } from './lzw.js';
import { unpackBits } from './packbits.js';
import { undoHorizontalDifferencing } from './predictor.js';

const DECODER_ID = 'tiff-pure';

/**
 * The largest image this reader will allocate for.
 *
 * The same ceiling its neighbours use, but it carries more weight here than it
 * does in any of them. Every other reader in this package is bounded by the
 * file it was handed: a hundred byte PNM cannot honestly describe a gigapixel.
 * A TIFF can, because its samples are compressed and its dimensions are just
 * two numbers in a directory, so this check is the only thing between a
 * malicious eight byte edit and a four gigabyte allocation.
 */
const MAX_PIXELS = 400_000_000;

/**
 * The most memory this reader will spend holding an image's samples.
 *
 * Separate from the pixel ceiling because a pixel is not a fixed size here: a
 * 400 megapixel bilevel scan is 400 MB of samples and the same picture in
 * sixteen bit CMYK with two spot channels is nine times that. The raster it
 * becomes is counted by `MAX_PIXELS`; this counts what it takes to get there.
 */
const MAX_SAMPLE_BYTES = 0x80000000;

/** Directories to follow before concluding the chain is a loop by another means. */
const MAX_DIRECTORIES = 64;

/**
 * Samples per pixel this reader will carry.
 *
 * Six is the most any interpretation here needs (CMYK with two extra
 * channels). The limit is well above that and far below the 65535 the field
 * could hold, because every sample is another buffer entry per pixel.
 */
const MAX_SAMPLES_PER_PIXEL = 16;

/* ── Tags ─────────────────────────────────────────────────────────────── */

const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_FILL_ORDER = 266;
const TAG_STRIP_OFFSETS = 273;
const TAG_ORIENTATION = 274;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PLANAR_CONFIGURATION = 284;
const TAG_T4_OPTIONS = 292;
const TAG_T6_OPTIONS = 293;
const TAG_PREDICTOR = 317;
const TAG_COLOUR_MAP = 320;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_INK_SET = 332;
const TAG_EXTRA_SAMPLES = 338;
const TAG_SAMPLE_FORMAT = 339;
const TAG_ICC_PROFILE = 34675;

const COMPRESSION_NONE = 1;
const COMPRESSION_MODIFIED_HUFFMAN = 2;
const COMPRESSION_GROUP_3 = 3;
const COMPRESSION_GROUP_4 = 4;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_PACKBITS = 32773;
/** Deflate again, under the number Adobe used before it was registered. */
const COMPRESSION_DEFLATE_OLD = 32946;

const PHOTOMETRIC_WHITE_IS_ZERO = 0;
const PHOTOMETRIC_BLACK_IS_ZERO = 1;
const PHOTOMETRIC_RGB = 2;
const PHOTOMETRIC_PALETTE = 3;
const PHOTOMETRIC_MASK = 4;
const PHOTOMETRIC_CMYK = 5;

const SAMPLE_FORMAT_UNSIGNED = 1;
const SAMPLE_FORMAT_SIGNED = 2;
const SAMPLE_FORMAT_FLOAT = 3;

function fail(detail: string): never {
	throw new DecodeFailedError('tiff', DECODER_ID, detail);
}

/* ── The file, and reading numbers out of it ──────────────────────────── */

interface Reader {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	readonly littleEndian: boolean;
}

/**
 * The one place a length is compared against the buffer.
 *
 * Every read goes through it, which is what keeps a truncated file naming the
 * structure it stopped inside rather than reading undefined and carrying on.
 */
function requireBytes(reader: Reader, at: number, count: number, what: string): void {
	if (!(at >= 0) || !(count >= 0) || at + count > reader.bytes.length) {
		fail(`it ends before ${what}.`);
	}
}

function readFileHeader(bytes: Uint8Array): Reader {
	if (bytes.length < 8) fail('it is too short to hold even a TIFF header.');
	const little = bytes[0] === 0x49 && bytes[1] === 0x49;
	const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
	if (!little && !big) {
		fail('it does not begin with the II or MM byte order mark every TIFF starts with.');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint16(2, little);
	if (version === 43) {
		fail(
			'it is a BigTIFF (version 43), whose 64 bit offsets and different directory layout this reader does not implement.',
		);
	}
	if (version !== 42) {
		fail(`its version number is ${version}, and a TIFF carries 42 there.`);
	}
	return { bytes, view, littleEndian: little };
}

/** One directory entry, kept as where its values are rather than as the values. */
interface Field {
	/** Carried so that a value that cannot be read can name the tag it belongs to. */
	readonly tag: number;
	readonly type: number;
	readonly count: number;
	/** Absolute offset of the first value, inline or otherwise. */
	readonly at: number;
}

type Directory = ReadonlyMap<number, Field>;

/**
 * Bytes per value, indexed by field type.
 *
 * All twelve of them, in order: byte, ASCII, short, long, rational, then the
 * signed five and the two floating point ones the 6.0 specification added.
 * Zero means a type this file has invented, which is not fatal on its own:
 * unknown tags carrying unknown types are ignored, and only a tag this reader
 * needs turns one into a refusal.
 */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

function readDirectory(reader: Reader, at: number): { fields: Map<number, Field>; next: number } {
	requireBytes(reader, at, 2, 'the entry count of one of its directories');
	const { view, littleEndian } = reader;
	const count = view.getUint16(at, littleEndian);
	requireBytes(reader, at + 2, count * 12 + 4, 'the end of one of its directories');

	const fields = new Map<number, Field>();
	for (let i = 0; i < count; i += 1) {
		const entry = at + 2 + i * 12;
		const tag = view.getUint16(entry, littleEndian);
		const type = view.getUint16(entry + 2, littleEndian);
		const values = view.getUint32(entry + 4, littleEndian);
		const size = TYPE_SIZES[type] ?? 0;
		// A value of four bytes or fewer is written into the entry itself. The
		// rest of the four bytes are undefined, not zero, so nothing may be
		// inferred from them.
		//
		// Where the offset points is not checked here. A directory carries
		// whatever the writer's other tools left in it, and a private tag whose
		// offset is rubbish is a tag this reader never opens: refusing the file
		// over it throws away pixels that are entirely intact, which is what
		// libtiff, ImageMagick and Pillow all decline to do. The check moves to
		// `valueOf`, where a value is actually read.
		let valuesAt = entry + 8;
		if (size > 0 && values * size > 4) valuesAt = view.getUint32(entry + 8, littleEndian);
		fields.set(tag, { tag, type, count: values, at: valuesAt });
	}
	return { fields, next: view.getUint32(at + 2 + count * 12, littleEndian) };
}

/**
 * Follow the directory chain.
 *
 * A TIFF may hold several pages, and the last field of each directory is the
 * offset of the next. The chain is bounded twice over: a file that points back
 * at a directory it has already read is refused rather than walked forever,
 * and a file that produces an honest chain of thousands of pages is cut off,
 * because only one of them is ever decoded.
 */
function readDirectoryChain(reader: Reader): Directory[] {
	const directories: Directory[] = [];
	const seen = new Set<number>();
	let at = reader.view.getUint32(4, reader.littleEndian);

	while (at !== 0 && directories.length < MAX_DIRECTORIES) {
		if (seen.has(at)) {
			fail('its directory chain points back at a directory it has already read.');
		}
		seen.add(at);
		const { fields, next } = readDirectory(reader, at);
		directories.push(fields);
		at = next;
	}
	if (directories.length === 0) fail('it carries no image directory at all.');
	return directories;
}

function valueOf(reader: Reader, field: Field, index: number): number {
	const size = TYPE_SIZES[field.type] ?? 0;
	if (size === 0) {
		fail(`one of the fields it needs is of type ${field.type}, which TIFF does not define.`);
	}
	const { view, littleEndian: le } = reader;
	const at = field.at + index * size;
	// Checked here rather than while the directory was parsed, so that only a
	// tag this reader reads can refuse the file for being out of bounds.
	requireBytes(reader, at, size, `the values of its tag ${field.tag}`);
	switch (field.type) {
		case 3:
			return view.getUint16(at, le);
		case 4:
			return view.getUint32(at, le);
		case 5: {
			// A rational is two longs. A zero denominator is not an error in a
			// file, only in the arithmetic, so it reads as zero.
			const denominator = view.getUint32(at + 4, le);
			return denominator === 0 ? 0 : view.getUint32(at, le) / denominator;
		}
		case 6:
			return view.getInt8(at);
		case 8:
			return view.getInt16(at, le);
		case 9:
			return view.getInt32(at, le);
		case 10: {
			const denominator = view.getInt32(at + 4, le);
			return denominator === 0 ? 0 : view.getInt32(at, le) / denominator;
		}
		case 11:
			return view.getFloat32(at, le);
		case 12:
			return view.getFloat64(at, le);
		default:
			// Byte, ASCII and undefined all read as one unsigned byte.
			return view.getUint8(at);
	}
}

/** A tag's first value, or `fallback` when the file does not carry the tag. */
function scalar(reader: Reader, directory: Directory, tag: number, fallback: number): number {
	const field = directory.get(tag);
	if (!field || field.count < 1) return fallback;
	return valueOf(reader, field, 0);
}

/** A tag's values, at most `limit` of them. */
function list(reader: Reader, directory: Directory, tag: number, limit: number): number[] {
	const field = directory.get(tag);
	if (!field) return [];
	const count = Math.min(field.count, limit);
	const out: number[] = [];
	for (let i = 0; i < count; i += 1) out.push(valueOf(reader, field, i));
	return out;
}

/** A whole number from a field that may legally have been written as a float. */
function whole(value: number, what: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
		fail(`its ${what} is not a number a TIFF can hold.`);
	}
	return Math.round(value);
}

/* ── Choosing a page ──────────────────────────────────────────────────── */

/**
 * The first full size page.
 *
 * Bit 0 of NewSubfileType marks a directory as a reduced resolution copy of
 * another one, which is how a scanner or a mapping tool stores its thumbnail
 * and its overview pyramid. Taking the first directory blindly hands back the
 * thumbnail of a GIS file, which is a picture, so nothing looks wrong.
 */
function choosePage(reader: Reader, directories: readonly Directory[]): Directory {
	for (const directory of directories) {
		const kind = scalar(reader, directory, TAG_NEW_SUBFILE_TYPE, 0);
		if ((kind & 1) === 0) return directory;
	}
	// Every page says it is a reduced copy of something that is not in the
	// file. Reading the first is better than refusing a file that does have
	// pixels in it.
	return directories[0] as Directory;
}

/* ── The page, as this reader needs it ────────────────────────────────── */

interface Page {
	/** The byte order of every multi-byte sample, taken from the file header. */
	readonly littleEndian: boolean;
	readonly width: number;
	readonly height: number;
	readonly bits: number;
	readonly samplesPerPixel: number;
	readonly sampleFormat: number;
	readonly photometric: number;
	readonly compression: number;
	readonly planar: number;
	readonly predictor: number;
	readonly fillOrder: number;
	readonly orientation: number;
	readonly ccittOptions: number;
	/** Palette entries as RGB triples, already scaled to eight bits. */
	readonly colourMap?: Uint8Array;
	/** Which sample carries alpha, or -1 when the image is opaque. */
	readonly alphaIndex: number;
	/** True when the colour samples were multiplied by alpha before storage. */
	readonly associatedAlpha: boolean;
	readonly tiled: boolean;
	readonly tileWidth: number;
	readonly tileHeight: number;
	readonly rowsPerStrip: number;
	readonly offsets: readonly number[];
	readonly counts: readonly number[];
}

function refuseCompression(compression: number): never {
	switch (compression) {
		case 6:
			fail('it uses the old style JPEG compression (6), which this reader does not unpack.');
			break;
		case 7:
			fail('it uses JPEG compression (7), which this reader does not unpack.');
			break;
		case 32771:
			fail(
				'it uses CCITT modified Huffman padded to word boundaries (32771), which this reader does not implement.',
			);
			break;
		case 34712:
			fail('it uses JPEG 2000 compression (34712), which this reader does not unpack.');
			break;
		case 34925:
			fail('it uses LZMA compression (34925), which this reader does not implement.');
			break;
		case 50000:
			fail('it uses Zstandard compression (50000), which this reader does not implement.');
			break;
		case 50001:
			fail('it uses WebP compression (50001), which this reader does not unpack.');
			break;
		default:
			fail(`it declares compression method ${compression}, which this reader does not know.`);
	}
}

function refusePhotometric(photometric: number): never {
	switch (photometric) {
		case 6:
			fail('its samples are YCbCr, which this reader does not convert.');
			break;
		case 8:
			fail('its samples are CIELab, which this reader does not convert.');
			break;
		case 9:
			fail('its samples are ICCLab, which this reader does not convert.');
			break;
		case 10:
			fail('its samples are ITULab, which this reader does not convert.');
			break;
		default:
			fail(
				`it declares photometric interpretation ${photometric}, which this reader does not know.`,
			);
	}
}

/** The colour samples an interpretation spends before any extra ones. */
function colourSamplesOf(photometric: number): number {
	if (photometric === PHOTOMETRIC_RGB) return 3;
	if (photometric === PHOTOMETRIC_CMYK) return 4;
	return 1;
}

function readColourMap(reader: Reader, directory: Directory, bits: number): Uint8Array {
	const entries = 1 << bits;
	const field = directory.get(TAG_COLOUR_MAP);
	if (!field) fail('it is palettised but carries no colour map.');
	if (field.count < entries * 3) {
		fail(
			`its colour map holds ${field.count} values, and a ${bits} bit palette needs ${entries * 3}.`,
		);
	}

	// Three runs, all the reds and then all the greens and then all the blues,
	// rather than triples. Reading it as triples produces an image in the right
	// shapes and the wrong colours, which is easy to miss on a photograph.
	const raw = new Uint16Array(entries * 3);
	for (let i = 0; i < entries * 3; i += 1) raw[i] = valueOf(reader, field, i) & 0xffff;

	// The values are sixteen bit, and a full intensity entry is 65535. Enough
	// writers put eight bit values in the field instead that libtiff carries
	// the same rescue: if nothing in the map exceeds 255, the writer meant
	// eight bits, because a real sixteen bit map of a visible image would be
	// almost entirely black.
	let eightBit = true;
	for (let i = 0; i < raw.length; i += 1) {
		if ((raw[i] as number) > 255) {
			eightBit = false;
			break;
		}
	}

	const map = new Uint8Array(entries * 3);
	for (let i = 0; i < entries; i += 1) {
		for (let channel = 0; channel < 3; channel += 1) {
			const value = raw[channel * entries + i] as number;
			map[i * 3 + channel] = eightBit ? value : value >> 8;
		}
	}
	return map;
}

function readPage(reader: Reader, directory: Directory): Page {
	const width = whole(scalar(reader, directory, TAG_IMAGE_WIDTH, 0), 'width');
	const height = whole(scalar(reader, directory, TAG_IMAGE_LENGTH, 0), 'height');
	if (width < 1 || height < 1) {
		fail('its image directory does not give both a width and a height.');
	}
	// Before anything is allocated, and before any of the arithmetic below can
	// overflow into a number that no longer means what it says.
	if (width * height > MAX_PIXELS) {
		fail('it describes an image far larger than anything this tool will allocate for.');
	}

	const samplesPerPixel = whole(
		scalar(reader, directory, TAG_SAMPLES_PER_PIXEL, 1),
		'samples per pixel',
	);
	if (samplesPerPixel < 1 || samplesPerPixel > MAX_SAMPLES_PER_PIXEL) {
		fail(`it stores ${samplesPerPixel} samples per pixel, which is more than this reader reads.`);
	}

	const depths = list(reader, directory, TAG_BITS_PER_SAMPLE, MAX_SAMPLES_PER_PIXEL);
	const bits = depths.length === 0 ? 1 : whole(depths[0] as number, 'bit depth');
	for (const depth of depths) {
		if (depth !== bits) {
			fail(
				`its samples are ${bits} and ${whole(depth, 'bit depth')} bits deep, and this reader needs every sample in a pixel to be the same depth.`,
			);
		}
	}
	if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8 && bits !== 16 && bits !== 32) {
		fail(`its samples are ${bits} bits deep, which is not a depth this reader knows.`);
	}

	// A sample never takes less than a byte here: the packed depths are
	// unpacked into one byte each on the way in, because a palette index and a
	// two bit grey both have to survive as a number rather than as a fraction
	// of a byte.
	if (width * height * samplesPerPixel * Math.max(1, bits / 8) > MAX_SAMPLE_BYTES) {
		fail('its samples alone would need more memory than this reader will ask for.');
	}

	const sampleFormat = whole(
		scalar(reader, directory, TAG_SAMPLE_FORMAT, SAMPLE_FORMAT_UNSIGNED),
		'sample format',
	);
	if (sampleFormat === 5 || sampleFormat === 6) {
		fail('its samples are complex numbers, which are a measurement rather than a picture.');
	}
	const float = sampleFormat === SAMPLE_FORMAT_FLOAT;
	if (float && bits !== 16 && bits !== 32) {
		fail(`its samples are ${bits} bit floating point, which is not a size this reader knows.`);
	}

	const compression = whole(
		scalar(reader, directory, TAG_COMPRESSION, COMPRESSION_NONE),
		'compression',
	);
	const known =
		compression === COMPRESSION_NONE ||
		compression === COMPRESSION_MODIFIED_HUFFMAN ||
		compression === COMPRESSION_GROUP_3 ||
		compression === COMPRESSION_GROUP_4 ||
		compression === COMPRESSION_LZW ||
		compression === COMPRESSION_DEFLATE ||
		compression === COMPRESSION_DEFLATE_OLD ||
		compression === COMPRESSION_PACKBITS;
	if (!known) refuseCompression(compression);

	const bilevel =
		compression === COMPRESSION_MODIFIED_HUFFMAN ||
		compression === COMPRESSION_GROUP_3 ||
		compression === COMPRESSION_GROUP_4;
	if (bilevel && (bits !== 1 || samplesPerPixel !== 1)) {
		fail('it is CCITT compressed but does not describe one bit per pixel, which cannot be coded.');
	}

	// A fax has no photometric tag more often than it has one, and CCITT codes
	// runs of white first, so zero means white there. Everywhere else the
	// sensible reading of a missing tag is the one that matches the sample
	// count.
	const photometricFallback = bilevel
		? PHOTOMETRIC_WHITE_IS_ZERO
		: samplesPerPixel >= 3
			? PHOTOMETRIC_RGB
			: PHOTOMETRIC_BLACK_IS_ZERO;
	const photometric = whole(
		scalar(reader, directory, TAG_PHOTOMETRIC, photometricFallback),
		'photometric interpretation',
	);
	if (photometric > PHOTOMETRIC_CMYK) refusePhotometric(photometric);

	const colours = colourSamplesOf(photometric);
	if (samplesPerPixel < colours) {
		fail(
			`it declares ${samplesPerPixel} samples per pixel, which is fewer than its colour interpretation spends.`,
		);
	}
	if (photometric === PHOTOMETRIC_CMYK) {
		const inkSet = scalar(reader, directory, TAG_INK_SET, 1);
		if (inkSet !== 1) {
			fail('its separated samples are not CMYK inks, which this reader cannot convert.');
		}
	}
	if (
		float &&
		photometric !== PHOTOMETRIC_WHITE_IS_ZERO &&
		photometric !== PHOTOMETRIC_BLACK_IS_ZERO &&
		photometric !== PHOTOMETRIC_RGB
	) {
		fail(
			'it holds floating point samples under a palette or ink interpretation, which have no meaning together.',
		);
	}

	let colourMap: Uint8Array | undefined;
	if (photometric === PHOTOMETRIC_PALETTE) {
		if (bits > 8) {
			fail(
				`it is palettised at ${bits} bits per sample, which needs a colour map this reader will not build.`,
			);
		}
		if (samplesPerPixel !== 1) {
			fail('it is palettised with more than one sample per pixel, which has no meaning.');
		}
		colourMap = readColourMap(reader, directory, bits);
	}
	if (photometric === PHOTOMETRIC_MASK && (bits !== 1 || samplesPerPixel !== 1)) {
		fail('it is a transparency mask that is not one bit per pixel, which has no meaning.');
	}

	const planar = whole(
		scalar(reader, directory, TAG_PLANAR_CONFIGURATION, 1),
		'planar configuration',
	);
	if (planar !== 1 && planar !== 2) {
		fail(`it declares planar configuration ${planar}, and TIFF defines only 1 and 2.`);
	}

	const predictor = whole(scalar(reader, directory, TAG_PREDICTOR, 1), 'predictor');
	if (predictor === 3) {
		fail('it uses the floating point predictor (3), which this reader does not implement.');
	}
	if (predictor !== 1 && predictor !== 2) {
		fail(`it declares predictor ${predictor}, which this reader does not know.`);
	}
	if (predictor === 2 && bits < 8) {
		fail(
			`it applies horizontal differencing to ${bits} bit samples, which the format does not define.`,
		);
	}

	const fillOrder = whole(scalar(reader, directory, TAG_FILL_ORDER, 1), 'fill order');
	if (fillOrder !== 1 && fillOrder !== 2) {
		fail(`it declares fill order ${fillOrder}, and TIFF defines only 1 and 2.`);
	}

	const rawOrientation = whole(scalar(reader, directory, TAG_ORIENTATION, 1), 'orientation');
	// Out of range means the writer left the field uninitialised, which is
	// common enough that refusing the file over it would be perverse.
	const orientation = rawOrientation >= 1 && rawOrientation <= 8 ? rawOrientation : 1;

	// The first extra sample is the alpha channel, when there is one. A file
	// with a fourth sample and no ExtraSamples tag at all is taken to mean
	// unassociated alpha, which is what every reader assumes and what every
	// writer that omits the tag meant.
	//
	// A tag whose value is 0 is a different thing. Zero is "unspecified data":
	// the writer saying the channel is there and is not coverage, which is what
	// `-define tiff:alpha=unspecified` produces. Reading it as alpha turns
	// whatever that channel happens to hold into transparency, so a picture
	// whose fourth channel starts near zero goes invisible down one edge.
	// ImageMagick and Pillow both drop the channel, and so does this.
	const extras = list(reader, directory, TAG_EXTRA_SAMPLES, MAX_SAMPLES_PER_PIXEL);
	const unspecified = extras.length > 0 && extras[0] === 0;
	const hasExtra = samplesPerPixel > colours && photometric !== PHOTOMETRIC_PALETTE && !unspecified;
	const alphaIndex = photometric === PHOTOMETRIC_MASK ? 0 : hasExtra ? colours : -1;
	const associatedAlpha = hasExtra && extras[0] === 1;

	const tiled = directory.has(TAG_TILE_OFFSETS) || directory.has(TAG_TILE_WIDTH);
	const planes = planar === 2 ? samplesPerPixel : 1;
	const planeSamples = planar === 2 ? 1 : samplesPerPixel;

	let tileWidth = 0;
	let tileHeight = 0;
	let rowsPerStrip = 0;
	let regions = 0;
	if (tiled) {
		tileWidth = whole(scalar(reader, directory, TAG_TILE_WIDTH, 0), 'tile width');
		tileHeight = whole(scalar(reader, directory, TAG_TILE_LENGTH, 0), 'tile height');
		if (tileWidth < 1 || tileHeight < 1) {
			fail('it is tiled but does not give both a tile width and a tile height.');
		}
		regions = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
	} else {
		// The default is one strip holding the whole image, which is what the
		// field's absence means and also what a value larger than the image
		// means.
		rowsPerStrip = whole(scalar(reader, directory, TAG_ROWS_PER_STRIP, height), 'rows per strip');
		if (rowsPerStrip < 1) fail('it declares zero rows per strip, so it has no strips.');
		rowsPerStrip = Math.min(rowsPerStrip, height);
		regions = Math.ceil(height / rowsPerStrip);
	}

	const required = regions * planes;
	const offsetTag = tiled ? TAG_TILE_OFFSETS : TAG_STRIP_OFFSETS;
	const countTag = tiled ? TAG_TILE_BYTE_COUNTS : TAG_STRIP_BYTE_COUNTS;
	const offsets = list(reader, directory, offsetTag, required);
	if (offsets.length < required) {
		fail(
			`it has ${offsets.length} ${tiled ? 'tile' : 'strip'} offsets where its own dimensions need ${required}.`,
		);
	}

	let counts = list(reader, directory, countTag, required);
	if (counts.length < required) {
		// A single uncompressed strip with no byte count is a real shape, and
		// the count is exactly the rows it holds. Anything compressed has to
		// say how long it is, because nothing else in the file does.
		if (compression !== COMPRESSION_NONE) {
			fail(
				`it gives ${counts.length} ${tiled ? 'tile' : 'strip'} lengths where it needs ${required}.`,
			);
		}
		const perRow = Math.ceil(((tiled ? tileWidth : width) * planeSamples * bits) / 8);
		// Worked out per region rather than once, because the last strip of a
		// plane holds only the rows that are left. A tile is always whole, even
		// where it hangs over the edge.
		counts = Array.from({ length: required }, (_, i) => {
			const index = i % regions;
			const rows = tiled ? tileHeight : Math.min(rowsPerStrip, height - index * rowsPerStrip);
			return perRow * rows;
		});
	}

	return {
		littleEndian: reader.littleEndian,
		width,
		height,
		bits,
		samplesPerPixel,
		sampleFormat,
		photometric,
		compression,
		planar,
		predictor,
		fillOrder,
		orientation,
		ccittOptions: scalar(
			reader,
			directory,
			compression === COMPRESSION_GROUP_4 ? TAG_T6_OPTIONS : TAG_T4_OPTIONS,
			0,
		),
		colourMap,
		alphaIndex,
		associatedAlpha,
		tiled,
		tileWidth,
		tileHeight,
		rowsPerStrip,
		offsets,
		counts,
	};
}

/* ── Samples ──────────────────────────────────────────────────────────── */

type SampleArray = Uint8Array | Uint16Array | Uint32Array | Float32Array;

/** Reverse the bits of every byte, which is what FillOrder 2 means. */
function reverseBits(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.length);
	for (let i = 0; i < source.length; i += 1) {
		let byte = source[i] as number;
		byte = ((byte & 0xf0) >> 4) | ((byte & 0x0f) << 4);
		byte = ((byte & 0xcc) >> 2) | ((byte & 0x33) << 2);
		out[i] = ((byte & 0xaa) >> 1) | ((byte & 0x55) << 1);
	}
	return out;
}

async function expandRegion(
	reader: Reader,
	page: Page,
	at: number,
	length: number,
	columns: number,
	rows: number,
	expected: number,
): Promise<Uint8Array> {
	requireBytes(reader, at, length, 'the end of one of its strips');
	let raw = reader.bytes.subarray(at, at + length);
	// Reversed before anything is decompressed, which is where libtiff does it
	// too. It only ever matters for a fax, where the scanner wrote the bits
	// from the other end of the byte.
	if (page.fillOrder === 2) raw = reverseBits(raw);

	switch (page.compression) {
		case COMPRESSION_MODIFIED_HUFFMAN:
		case COMPRESSION_GROUP_3:
		case COMPRESSION_GROUP_4: {
			const kind: CcittKind =
				page.compression === COMPRESSION_GROUP_4
					? 'group-4'
					: page.compression === COMPRESSION_GROUP_3
						? 'group-3'
						: 'modified-huffman';
			return decodeCcitt(raw, { kind, columns, rows, options: page.ccittOptions });
		}
		case COMPRESSION_LZW:
			return decodeLzw(raw, expected);
		case COMPRESSION_PACKBITS:
			return unpackBits(raw, expected);
		case COMPRESSION_DEFLATE:
		case COMPRESSION_DEFLATE_OLD: {
			// A zlib stream opens with two bytes: the low nibble of the first is
			// the compression method, which is always 8, and the two together are
			// a multiple of 31. Checking it here rather than letting the platform
			// find out turns a strip of rubbish into a sentence, and it is the
			// only failure of these two that a reader can name with any
			// confidence.
			if (raw.length < 2 || ((raw[0] as number) & 0x0f) !== 8) {
				fail('one of its deflate compressed strips does not begin with a zlib header.');
			}
			if ((((raw[0] as number) << 8) | (raw[1] as number)) % 31 !== 0) {
				fail('one of its deflate compressed strips has a zlib header that fails its own check.');
			}
			let out: Uint8Array;
			try {
				out = await inflate(raw);
			} catch (error) {
				// A browser with no DecompressionStream is a different problem
				// from a file that is not a zlib stream, and only one of them is
				// the file's fault.
				if (error instanceof CodecUnavailableError) throw error;
				fail('one of its deflate compressed strips could not be expanded.');
			}
			if (out.length < expected) {
				fail('one of its deflate compressed strips expands to less than its rows hold.');
			}
			return out;
		}
		default: {
			if (raw.length < expected) {
				fail('one of its strips is shorter than the rows it is supposed to hold.');
			}
			// Copied only when the predictor is about to rewrite it, because the
			// bytes underneath belong to whoever handed us the file.
			return page.predictor === 2 ? raw.slice(0, expected) : raw.subarray(0, expected);
		}
	}
}

/** Where one strip or tile sits, and how its rows are laid out. */
interface Region {
	readonly x: number;
	readonly y: number;
	readonly columns: number;
	readonly rows: number;
	readonly bytesPerRow: number;
	/** The sample this region fills for a planar file, or -1 for a chunky one. */
	readonly plane: number;
}

const UNPACK_PACKED = 0;
const UNPACK_BYTE = 1;
const UNPACK_UINT16 = 2;
const UNPACK_UINT32 = 3;
const UNPACK_HALF = 4;
const UNPACK_FLOAT = 5;

function unpackMode(page: Page): number {
	if (page.sampleFormat === SAMPLE_FORMAT_FLOAT) {
		return page.bits === 16 ? UNPACK_HALF : UNPACK_FLOAT;
	}
	if (page.bits === 32) return UNPACK_UINT32;
	if (page.bits === 16) return UNPACK_UINT16;
	return page.bits === 8 ? UNPACK_BYTE : UNPACK_PACKED;
}

/**
 * Copy one decompressed region into the whole image's samples.
 *
 * Tiles are stored padded out to whole tiles, so the last column and the last
 * row of tiles hang over the edge of the image by design. They are cropped
 * here rather than refused, exactly as a HEIF grid is: refusing them would
 * refuse every tiled image whose width is not a multiple of the tile width,
 * which is most of them.
 */
function unpack(source: Uint8Array, target: SampleArray, page: Page, region: Region): void {
	const { width, height, bits, samplesPerPixel: total } = page;
	const planeSamples = region.plane < 0 ? total : 1;
	const first = region.plane < 0 ? 0 : region.plane;
	const rows = Math.min(region.rows, height - region.y);
	const columns = Math.min(region.columns, width - region.x);
	const mode = unpackMode(page);
	const mask = (1 << bits) - 1;
	const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	// Samples wider than a byte are in the file's byte order, which is the one
	// its first two bytes declared and has nothing to do with this machine's.
	const little = page.littleEndian;

	for (let row = 0; row < rows; row += 1) {
		const rowAt = row * region.bytesPerRow;
		let to = ((region.y + row) * width + region.x) * total + first;
		for (let x = 0; x < columns; x += 1) {
			for (let sample = 0; sample < planeSamples; sample += 1) {
				const index = x * planeSamples + sample;
				let value: number;
				switch (mode) {
					case UNPACK_PACKED: {
						// One, two and four bit samples are packed from the top of
						// each byte down, and every row starts on a fresh byte.
						const bitAt = index * bits;
						const byte = source[rowAt + (bitAt >> 3)] as number;
						value = (byte >> (8 - bits - (bitAt & 7))) & mask;
						break;
					}
					case UNPACK_BYTE:
						value = source[rowAt + index] as number;
						break;
					case UNPACK_UINT16:
						value = view.getUint16(rowAt + index * 2, little);
						break;
					case UNPACK_UINT32:
						value = view.getUint32(rowAt + index * 4, little);
						break;
					case UNPACK_HALF:
						value = halfToFloat(view.getUint16(rowAt + index * 2, little));
						break;
					default:
						value = view.getFloat32(rowAt + index * 4, little);
						break;
				}
				target[to + sample] = value;
			}
			to += total;
		}
	}
}

function allocateSamples(page: Page, count: number): SampleArray {
	try {
		if (page.sampleFormat === SAMPLE_FORMAT_FLOAT) return new Float32Array(count);
		if (page.bits === 32) return new Uint32Array(count);
		if (page.bits === 16) return new Uint16Array(count);
		return new Uint8Array(count);
	} catch {
		fail('there is not enough memory here to hold an image that size.');
	}
}

async function readSamples(reader: Reader, page: Page): Promise<SampleArray> {
	const { width, height, bits, samplesPerPixel } = page;
	const samples = allocateSamples(page, width * height * samplesPerPixel);
	const planes = page.planar === 2 ? samplesPerPixel : 1;
	const planeSamples = page.planar === 2 ? 1 : samplesPerPixel;

	const across = page.tiled ? Math.ceil(width / page.tileWidth) : 1;
	const regionColumns = page.tiled ? page.tileWidth : width;
	const perPlane = page.tiled
		? across * Math.ceil(height / page.tileHeight)
		: Math.ceil(height / page.rowsPerStrip);
	const bytesPerRow = Math.ceil((regionColumns * planeSamples * bits) / 8);

	for (let plane = 0; plane < planes; plane += 1) {
		for (let index = 0; index < perPlane; index += 1) {
			const x = page.tiled ? (index % across) * page.tileWidth : 0;
			const y = page.tiled
				? Math.floor(index / across) * page.tileHeight
				: index * page.rowsPerStrip;
			// A tile is always whole, even where it hangs over the edge. A strip
			// is only as tall as the rows it actually holds.
			const rows = page.tiled ? page.tileHeight : Math.min(page.rowsPerStrip, height - y);
			const region: Region = {
				x,
				y,
				columns: regionColumns,
				rows,
				bytesPerRow,
				plane: page.planar === 2 ? plane : -1,
			};

			const at = plane * perPlane + index;
			const expected = bytesPerRow * rows;
			const data = await expandRegion(
				reader,
				page,
				whole(page.offsets[at] as number, 'strip offset'),
				whole(page.counts[at] as number, 'strip length'),
				regionColumns,
				rows,
				expected,
			);
			if (page.predictor === 2) {
				undoHorizontalDifferencing(
					data,
					regionColumns,
					rows,
					planeSamples,
					bits,
					reader.littleEndian,
				);
			}
			unpack(data, samples, page, region);
		}
	}
	return samples;
}

/* ── Samples to pixels ────────────────────────────────────────────────── */

/**
 * Scale raw samples onto the 0 to 255 a raster holds.
 *
 * Signed samples are biased rather than clamped: the sign bit is flipped,
 * which turns the most negative value into 0 and the most positive into 255
 * with one exclusive or and no branch. Sixteen and thirty-two bit samples are
 * reduced by taking their top byte, which is what every viewer does and is
 * indistinguishable from dividing at eight bit output.
 */
function normalise(samples: Uint8Array | Uint16Array | Uint32Array, page: Page): Uint8Array {
	const signed = page.sampleFormat === SAMPLE_FORMAT_SIGNED;
	if (page.bits === 8 && !signed) return samples as Uint8Array;

	const out = new Uint8Array(samples.length);
	const sign = signed ? 1 << (page.bits - 1) : 0;
	const shift = page.bits === 32 ? 24 : page.bits === 16 ? 8 : 0;
	const scale = 255 / ((1 << page.bits) - 1);
	for (let i = 0; i < samples.length; i += 1) {
		const value = ((samples[i] as number) ^ sign) >>> 0;
		out[i] = shift > 0 ? value >>> shift : Math.round(value * scale);
	}
	return out;
}

function paletteRaster(samples: Uint8Array | Uint16Array | Uint32Array, page: Page): RasterImage {
	const { width, height } = page;
	const map = page.colourMap as Uint8Array;
	// No bounds check on the index below. The map is built with an entry for
	// every value the sample depth can hold, and a sample was masked to that
	// depth as it was unpacked, so an index outside the map cannot be reached
	// from any file, valid or otherwise.
	const out = createRaster(width, height, 'srgb', false);
	const target = out.data;
	for (let i = 0; i < width * height; i += 1) {
		const index = samples[i] as number;
		target[i * 4] = map[index * 3] as number;
		target[i * 4 + 1] = map[index * 3 + 1] as number;
		target[i * 4 + 2] = map[index * 3 + 2] as number;
		target[i * 4 + 3] = 255;
	}
	return out;
}

function integerRaster(samples: Uint8Array | Uint16Array | Uint32Array, page: Page): RasterImage {
	if (page.photometric === PHOTOMETRIC_PALETTE) return paletteRaster(samples, page);

	const values = normalise(samples, page);
	const { width, height, samplesPerPixel: total, photometric, alphaIndex } = page;
	const out = createRaster(width, height, 'srgb', alphaIndex >= 0);
	const target = out.data;

	for (let i = 0; i < width * height; i += 1) {
		const at = i * total;
		let red: number;
		let green: number;
		let blue: number;
		if (photometric === PHOTOMETRIC_RGB) {
			red = values[at] as number;
			green = values[at + 1] as number;
			blue = values[at + 2] as number;
		} else if (photometric === PHOTOMETRIC_CMYK) {
			// Ink coverage rather than light: 255 means the plate lays down as
			// much of that ink as it can, and black ink darkens whatever the
			// other three left behind.
			const black = 255 - (values[at + 3] as number);
			red = ((255 - (values[at] as number)) * black) / 255;
			green = ((255 - (values[at + 1] as number)) * black) / 255;
			blue = ((255 - (values[at + 2] as number)) * black) / 255;
		} else if (photometric === PHOTOMETRIC_MASK) {
			// A mask has no colour of its own. Its one sample is coverage, which
			// the alpha branch below reads.
			red = 0;
			green = 0;
			blue = 0;
		} else {
			red = values[at] as number;
			green = red;
			blue = red;
		}

		let alpha = 255;
		if (alphaIndex >= 0) {
			alpha = values[at + alphaIndex] as number;
			if (page.associatedAlpha) {
				// Associated alpha means the colours were multiplied down when
				// the file was written. A raster here is straight alpha, so it
				// has to be divided back out, and a pixel with no coverage has
				// no colour to recover.
				if (alpha === 0) {
					red = 0;
					green = 0;
					blue = 0;
				} else if (alpha < 255) {
					red = Math.min(255, Math.round((red * 255) / alpha));
					green = Math.min(255, Math.round((green * 255) / alpha));
					blue = Math.min(255, Math.round((blue * 255) / alpha));
				}
			}
		}

		target[i * 4] = red;
		target[i * 4 + 1] = green;
		target[i * 4 + 2] = blue;
		target[i * 4 + 3] = alpha;
	}
	return out;
}

/** A float that is already a displayable fraction, scaled to the 0 to 255 a raster holds. */
function fromUnitFloat(value: number): number {
	if (!(value > 0)) return 0;
	return value >= 1 ? 255 : Math.round(value * 255);
}

/**
 * Turn floating point colour into a raster without metering it.
 *
 * For a file whose samples already sit between 0 and 1, where the number is the
 * fraction of full intensity rather than a quantity of light.
 */
function displayRaster(
	source: Float32Array,
	width: number,
	height: number,
	channels: 3 | 4,
): RasterImage {
	const out = createRaster(width, height, 'srgb', channels === 4);
	const target = out.data;
	for (let i = 0; i < width * height; i += 1) {
		const at = i * channels;
		target[i * 4] = fromUnitFloat(source[at] as number);
		target[i * 4 + 1] = fromUnitFloat(source[at + 1] as number);
		target[i * 4 + 2] = fromUnitFloat(source[at + 2] as number);
		target[i * 4 + 3] = channels === 4 ? fromUnitFloat(source[at + 3] as number) : 255;
	}
	return out;
}

/** Floating point samples, gathered three or four to a pixel, and what they are. */
interface FloatSamples {
	/** `channels` floats per pixel, with associated alpha already divided out. */
	readonly source: Float32Array;
	readonly channels: 3 | 4;
	/**
	 * True when no colour sample passes 1.
	 *
	 * The whole test for whether the file holds a picture or a measurement.
	 * `floatRaster` below says why the answer matters that much.
	 */
	readonly bounded: boolean;
}

/**
 * Gather the samples a float page holds into contiguous channels.
 *
 * Separate from `floatRaster` only because `decodeTiffFloat` has to reach the
 * same verdict about the same numbers. Two copies of the ceiling test would be
 * two chances to disagree about what a file is, and the two readings of a
 * display referred picture are several stops apart.
 */
function gatherFloat(samples: Float32Array, page: Page): FloatSamples {
	const { width, height, samplesPerPixel: total, alphaIndex } = page;
	const channels = alphaIndex >= 0 ? 4 : 3;
	const source = new Float32Array(width * height * channels);
	const grey = page.photometric !== PHOTOMETRIC_RGB;
	// Measured on the samples as stored, before any alpha is divided back out,
	// because it is the file that is scene referred or not. Dividing by a small
	// alpha can lift a displayable colour above 1 on its own.
	let bounded = true;

	for (let i = 0; i < width * height; i += 1) {
		const from = i * total;
		const to = i * channels;
		const red = samples[from] as number;
		source[to] = red;
		source[to + 1] = grey ? red : (samples[from + 1] as number);
		source[to + 2] = grey ? red : (samples[from + 2] as number);
		// A NaN fails this too, and tone mapping is the branch that already
		// deals with one.
		if (!(source[to] <= 1) || !(source[to + 1] <= 1) || !(source[to + 2] <= 1)) bounded = false;
		if (channels === 4) {
			const alpha = samples[from + alphaIndex] as number;
			source[to + 3] = alpha;
			if (page.associatedAlpha && alpha > 0) {
				source[to] /= alpha;
				source[to + 1] /= alpha;
				source[to + 2] /= alpha;
			}
		}
	}
	return { source, channels, bounded };
}

/**
 * Floating point samples to pixels.
 *
 * A float TIFF out of a renderer or a height model has no ceiling at 1, so the
 * exposure has to be chosen from the picture rather than assumed. That work
 * lives in `toneMap`, shared with the Radiance and OpenEXR readers, so all
 * three agree about what a bright sky should look like at eight bits.
 *
 * Unlike Radiance and OpenEXR, though, a float TIFF is more often not that.
 * ImageMagick and GDAL both write ordinary display pictures this way, where the
 * samples are the eight bit values over 255 and nothing exceeds 1. Metering
 * those against middle grey re-exposes a picture that was never scene referred,
 * which is why a `-depth 32 -define quantum:format=floating-point` copy of a
 * photograph comes back several stops brighter than the photograph. So the
 * ceiling decides: anything above 1 is light and is tone mapped, and a file
 * bounded by 1 is a picture and is scaled straight across, which is what every
 * other reader does with it.
 */
function floatRaster(samples: Float32Array, page: Page): RasterImage {
	const { source, channels, bounded } = gatherFloat(samples, page);
	const { width, height } = page;
	if (bounded) return displayRaster(source, width, height, channels);
	return toneMap(source, width, height, channels).image;
}

/* ── Orientation ──────────────────────────────────────────────────────── */

/**
 * What the orientation tag asks for, as a mirror and a turn.
 *
 * Tag 274 is the same field EXIF calls Orientation and counts the same way,
 * which is clockwise, while this package counts anticlockwise. So value 6,
 * "the top of the subject is at the right hand side", is a three quarter turn
 * here and not a quarter turn. Getting that backwards only shows on a
 * photograph taken sideways, which is most of them.
 */
function orientationOf(value: number): { rotation: Rotation; mirror: Mirror } {
	switch (value) {
		case 2:
			return { rotation: 0, mirror: 'horizontal' };
		case 3:
			return { rotation: 180, mirror: 'none' };
		case 4:
			return { rotation: 0, mirror: 'vertical' };
		case 5:
			return { rotation: 90, mirror: 'horizontal' };
		case 6:
			return { rotation: 270, mirror: 'none' };
		case 7:
			return { rotation: 270, mirror: 'horizontal' };
		case 8:
			return { rotation: 90, mirror: 'none' };
		default:
			return { rotation: 0, mirror: 'none' };
	}
}

/**
 * The same turn, applied to light.
 *
 * `applyOrientation` in `raster/image.ts` already does this and cannot be
 * borrowed: it takes a `RasterImage`, whose buffer is bytes, and rounding light
 * to eight bits to turn it sideways would throw away the entire reason the
 * float path exists. So this is that function's two passes, in that order,
 * over a `Float32Array`.
 *
 * Mirror first and rotate second, which is the order ISO/IEC 23008-12 gives for
 * `imir` and `irot` and the order the byte path uses. Swapping them is
 * indistinguishable for the six orientations that carry only one of the two,
 * and wrong for the two that carry both, so a suite built from the easy six
 * would pass either way.
 */
function orientFloat(image: FloatImage, tag: number): FloatImage {
	const { rotation, mirror } = orientationOf(tag);
	const { width, height } = image;
	let data = image.data;

	if (mirror !== 'none') {
		const flipped = new Float32Array(data.length);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const sx = mirror === 'horizontal' ? width - 1 - x : x;
				const sy = mirror === 'vertical' ? height - 1 - y : y;
				const from = (sy * width + sx) * 4;
				const to = (y * width + x) * 4;
				flipped[to] = data[from] as number;
				flipped[to + 1] = data[from + 1] as number;
				flipped[to + 2] = data[from + 2] as number;
				flipped[to + 3] = data[from + 3] as number;
			}
		}
		data = flipped;
	}
	if (rotation === 0) return { ...image, data };

	const turned = rotation === 90 || rotation === 270;
	const out = createFloat(
		turned ? height : width,
		turned ? width : height,
		image.colourSpace,
		image.hasAlpha,
	);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let tx: number;
			let ty: number;
			switch (rotation) {
				case 90:
					// Anticlockwise: the right hand column becomes the top row.
					tx = y;
					ty = width - 1 - x;
					break;
				case 180:
					tx = width - 1 - x;
					ty = height - 1 - y;
					break;
				default:
					tx = height - 1 - y;
					ty = x;
					break;
			}
			const from = (y * width + x) * 4;
			const to = (ty * out.width + tx) * 4;
			out.data[to] = data[from] as number;
			out.data[to + 1] = data[from + 1] as number;
			out.data[to + 2] = data[from + 2] as number;
			out.data[to + 3] = data[from + 3] as number;
		}
	}
	return out;
}

/* ── Entry points ─────────────────────────────────────────────────────── */

/**
 * Read a TIFF file.
 *
 * Asynchronous because Deflate compressed TIFFs are common and the only
 * deflate available with no dependency is `DecompressionStream`, which is a
 * stream. Everything else in here is synchronous work behind one await.
 */
export async function decodeTiff(bytes: Uint8Array): Promise<RasterImage> {
	const reader = readFileHeader(bytes);
	const directories = readDirectoryChain(reader);
	const page = readPage(reader, choosePage(reader, directories));
	const samples = await readSamples(reader, page);

	let image =
		samples instanceof Float32Array ? floatRaster(samples, page) : integerRaster(samples, page);

	// WhiteIsZero is applied last and to the finished pixels, so that it is one
	// pass over one buffer whatever the samples were on the way in. A fax, a
	// signed sixteen bit scan and a floating point height model all reach it
	// the same way.
	if (page.photometric === PHOTOMETRIC_WHITE_IS_ZERO) {
		const target = image.data;
		for (let i = 0; i < target.length; i += 4) {
			target[i] = 255 - (target[i] as number);
			target[i + 1] = 255 - (target[i + 1] as number);
			target[i + 2] = 255 - (target[i + 2] as number);
		}
	}

	image = applyOrientation(image, { ...orientationOf(page.orientation), source: 'exif' });
	return { ...image, hasAlpha: detectAlpha(image) };
}

/**
 * Read a TIFF as light.
 *
 * The counterpart to `decodeTiff` for the files that hold a measurement rather
 * than a picture of one, so that a float TIFF on its way to OpenEXR keeps the
 * range it was written with instead of being reduced to eight bits here and
 * expanded back out there.
 *
 * Two of the refusals below are the whole design, and both send the file down
 * the byte ladder in `convert`, which reads it correctly today. Weakening
 * either is worse than not having this function at all.
 *
 * The first is the sample format, read out of the directory before any of the
 * real work. `convert` runs the light ladder first and unconditionally for
 * every decoder that offers one, so an ordinary integer TIFF arrives here on
 * its way to a PNG. Discovering that after the strips had been expanded would
 * decompress and unpack every scanline of it twice.
 *
 * The second is the ceiling at 1, and it is the same test `floatRaster` makes,
 * from the same function, for the reason set out there: ImageMagick and GDAL
 * both write ordinary display pictures as float TIFFs whose samples are the
 * eight bit values over 255. `toneMap` meters log average luminance against
 * 0.18 with no shortcut for a bounded image, so handing one of those on as a
 * `FloatImage` re-exposes a photograph that was never scene referred and it
 * arrives at the PNG several stops bright. The byte ladder scales it straight
 * across instead, which is what every other reader of that file does.
 *
 * Asynchronous for the same reason `decodeTiff` is: Deflate compressed float
 * TIFFs are what GDAL writes by default, and the only deflate available with no
 * dependency is a stream.
 */
export async function decodeTiffFloat(bytes: Uint8Array): Promise<FloatImage> {
	const reader = readFileHeader(bytes);
	const directory = choosePage(reader, readDirectoryChain(reader));

	// Before `readPage`, which is cheap, and long before `readSamples`, which
	// is not.
	const format = scalar(reader, directory, TAG_SAMPLE_FORMAT, SAMPLE_FORMAT_UNSIGNED);
	if (format !== SAMPLE_FORMAT_FLOAT) {
		fail('its samples are integers rather than IEEE floating point, so there is no light in it.');
	}

	const page = readPage(reader, directory);
	if (page.photometric === PHOTOMETRIC_WHITE_IS_ZERO) {
		// The byte path inverts the finished pixels, which works because it has
		// a ceiling of 255 to subtract them from. Unbounded light has none, and
		// inventing one would be choosing an exposure inside a reader.
		fail(
			'its floating point samples are inverted by WhiteIsZero, which needs a ceiling to mean anything.',
		);
	}

	// `readPage` has already refused every combination that would not produce
	// floats here: the format is IEEE, the depth is 16 or 32, and the
	// interpretation is grey or RGB.
	const samples = (await readSamples(reader, page)) as Float32Array;
	const { source, channels, bounded } = gatherFloat(samples, page);
	if (bounded) {
		fail('its floating point samples never pass 1, so it is a display picture rather than light.');
	}

	const { width, height } = page;
	const image = createFloat(width, height, 'srgb', channels === 4);
	const target = image.data;
	for (let i = 0; i < width * height; i += 1) {
		const from = i * channels;
		const to = i * 4;
		target[to] = source[from] as number;
		target[to + 1] = source[from + 1] as number;
		target[to + 2] = source[from + 2] as number;
		// A `FloatImage` always carries four channels, and the fourth is
		// coverage rather than light. Fully covered is the honest reading of a
		// file that stored no alpha at all.
		target[to + 3] = channels === 4 ? (source[from + 3] as number) : 1;
	}

	const oriented = orientFloat(image, page.orientation);
	return { ...oriented, hasAlpha: detectFloatAlpha(oriented) };
}

/**
 * The ICC profile a TIFF carries, if it carries one.
 *
 * Separate from the decode because a raster has a colour space and not a
 * profile, and the decision about what to do with a profile belongs to
 * whatever is doing the converting rather than to a reader of bytes. Returns
 * nothing rather than throwing: a file whose profile cannot be read is still a
 * file whose pixels can.
 */
export function readTiffIccProfile(bytes: Uint8Array): Uint8Array | undefined {
	try {
		const reader = readFileHeader(bytes);
		const directory = choosePage(reader, readDirectoryChain(reader));
		const field = directory.get(TAG_ICC_PROFILE);
		if (!field || field.count < 1) return undefined;
		requireBytes(reader, field.at, field.count, 'the end of its ICC profile');
		return bytes.slice(field.at, field.at + field.count);
	} catch {
		return undefined;
	}
}
