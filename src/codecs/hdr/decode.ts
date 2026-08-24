/**
 * A Radiance HDR reader, for the pictures Radiance calls RGBE.
 *
 * A Radiance picture is scene referred: a sample is a measurement of light
 * with no ceiling, so a lamp in the frame is a hundred times the value of the
 * paper it is lighting rather than the same white. Four bytes carry a pixel,
 * three mantissas and one exponent they share, which buys about eight decades
 * of range for the cost of a truecolour image and is the whole reason the
 * format outlived its own renderer.
 *
 * That shared exponent is also why this reader hands back floating point light
 * and lets `toneMap` decide what a screen should show. Turning the numbers
 * into bytes here would bake in an exposure with nothing to say what it was,
 * and every choice available is wrong for some picture: see `raster/tonemap.ts`.
 *
 * What it reads: the `#?RADIANCE` and `#?RGBE` signatures, a header of any
 * length ending in a blank line, `FORMAT=32-bit_rle_rgbe`, `EXPOSURE=`
 * accumulated across as many lines as the file repeats it, `PRIMARIES=` when
 * it names Display P3, and all four resolution lines whose scanlines run along
 * a row. Pixels arrive in the three encodings that occur: new run length
 * encoding, the older per pixel repeat marker, and no compression at all.
 *
 * What it refuses by name: the XYZE colour format, resolution lines whose
 * scanlines run down columns, and the `GAMMA`, `COLORCORR` and `PIXASPECT`
 * corrections when they are set to anything other than the value that means
 * "nothing was applied".
 *
 * `PRIMARIES` is the one header line that is read and then quietly not obeyed.
 * Radiance's own default primaries are not sRGB's, but `ColourSpace` has two
 * members and neither of them is "Radiance", so a file that names anything
 * other than Display P3 is treated as sRGB. The error that introduces is a
 * shift in saturated greens of a few percent; refusing the file over it would
 * reject almost every Radiance picture ever written.
 */

import { DecodeFailedError } from '../../errors.js';
import { toneMap } from '../../raster/tonemap.js';
import type { ColourSpace, RasterImage } from '../../types.js';

const DECODER_ID = 'hdr-pure';

const NEWLINE = 0x0a;

/**
 * How far the blank line that ends the header is allowed to be.
 *
 * Radiance headers hold a line per rendering option and a `VIEW=` line that
 * can run to a few hundred characters, so the limit has to be generous. It
 * exists so that a file which is not a picture at all, but happens to open
 * with `#?RADIANCE`, is refused after 64 kilobytes rather than after scanning
 * however many gigabytes it turns out to be.
 */
const MAX_HEADER_BYTES = 65536;

/**
 * The largest picture this decoder will allocate for.
 *
 * Lower than the ceiling the byte-per-channel readers use, because a pixel
 * here costs twelve bytes of float on the way to four bytes of raster. The
 * resolution line is two decimal numbers with nothing to corroborate them, and
 * the run length encoding is dense enough that a twenty byte tail can honestly
 * describe a scanline of sixteen million pixels, so the count has to be
 * refused on its own terms before anything is allocated.
 */
const MAX_PIXELS = 100_000_000;

/**
 * The widths the new run length encoding is legal for.
 *
 * Outside this range a scanline is written flat, and a flat scanline can begin
 * with the bytes 2 and 2, so the check for a compressed scanline has to be
 * gated on the width or a narrow picture is misread as compressed.
 */
const MIN_RLE_WIDTH = 8;
const MAX_RLE_WIDTH = 0x7fff;

/** How close a correction factor has to sit to 1 to mean "nothing was applied". */
const UNITY_TOLERANCE = 1e-3;

/** Display P3's primaries and white point, in the order a `PRIMARIES` line writes them. */
const P3_PRIMARIES = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329];

/**
 * How far a chromaticity may sit from Display P3's and still be called P3.
 *
 * Loose enough to catch a writer that rounded to three decimal places, tight
 * enough that sRGB's primaries, whose green is 0.30 against P3's 0.265, are
 * nowhere near it.
 */
const PRIMARIES_TOLERANCE = 0.005;

/** A decimal number as a header line spells one. No hex, no infinity, no NaN. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * `{+|-}{X|Y} count {+|-}{X|Y} count`, the only shape a resolution line has.
 *
 * Loose about the spacing between the four fields, because Radiance's own
 * reader scans them rather than matching a line, and strict about the digits,
 * which stop well short of a count anything here would agree to allocate for.
 */
const RESOLUTION = /^([-+][XY])\s+(\d{1,9})\s+([-+][XY])\s+(\d{1,9})$/;

/**
 * 2 raised to (e - 136), for every exponent byte a pixel can carry.
 *
 * The 136 is the format's bias of 128 plus the 8 bits of the mantissa's own
 * scale, so a sample is `(mantissa + 0.5) * EXPONENT_SCALE[e]`. Precomputed
 * because the alternative is three calls to `Math.pow` per pixel, which on a
 * twenty megapixel render is most of the decode.
 */
const EXPONENT_SCALE = new Float64Array(256);
for (let exponent = 1; exponent < 256; exponent += 1) {
	EXPONENT_SCALE[exponent] = 2 ** (exponent - 136);
}

function fail(detail: string, options?: ErrorOptions): never {
	throw new DecodeFailedError('hdr', DECODER_ID, detail, options);
}

interface Cursor {
	at: number;
}

/**
 * A header line as text, one byte to one character.
 *
 * No decoding of any kind: a header line is only ever compared against a known
 * key or parsed as a number, and neither of those cares what a byte above 127
 * was meant to spell. Nothing from here reaches a message, so there is nothing
 * for a stranger's bytes to escape into.
 *
 * Trailing whitespace goes, which is also how a file written on Windows loses
 * the carriage return before its line feed.
 */
function ascii(bytes: Uint8Array, from: number, to: number): string {
	let text = '';
	for (let at = from; at < to; at += 1) text += String.fromCharCode(bytes[at] as number);
	return text.trimEnd();
}

function readLine(bytes: Uint8Array, cursor: Cursor): string {
	let at = cursor.at;
	const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
	while (at < limit && (bytes[at] as number) !== NEWLINE) at += 1;
	if (at >= MAX_HEADER_BYTES) {
		fail('its header has no blank line ending it in the first 65536 bytes.');
	}
	if (at >= bytes.length) {
		fail('the file ends inside its header, before the line giving its size.');
	}
	const text = ascii(bytes, cursor.at, at);
	cursor.at = at + 1;
	return text;
}

/**
 * Every whitespace separated number in a header value, or undefined.
 *
 * Undefined rather than a partial list when any token is not a number, because
 * every caller here treats a header line it cannot parse as a line it does not
 * understand, and a half read `PRIMARIES` is worse than an unread one.
 */
function parseNumbers(value: string): number[] | undefined {
	const parts = value.split(/\s+/).filter((part) => part.length > 0);
	const out: number[] = [];
	for (const part of parts) {
		if (!NUMBER.test(part)) return undefined;
		out.push(Number(part));
	}
	return out;
}

/** True when every number in `values` sits within `tolerance` of 1. */
function isUnity(values: number[] | undefined, count: number): boolean {
	if (values === undefined || values.length !== count) return false;
	return values.every((value) => Math.abs(value - 1) <= UNITY_TOLERANCE);
}

function isDisplayP3(values: number[]): boolean {
	return values.every(
		(value, i) => Math.abs(value - (P3_PRIMARIES[i] as number)) <= PRIMARIES_TOLERANCE,
	);
}

interface HdrHeader {
	readonly width: number;
	readonly height: number;
	/** The first scanline stored is the bottom row of the picture. */
	readonly flipY: boolean;
	/** Each scanline runs right to left. */
	readonly flipX: boolean;
	/**
	 * Every `EXPOSURE` in the header multiplied together.
	 *
	 * Cumulative because the lines are a record of what was done to the picture
	 * rather than a single setting: each tool that changed the exposure appended
	 * its own factor, so a picture brightened twice carries two lines and the
	 * samples were multiplied by both. Dividing by the product is what recovers
	 * the light that was measured.
	 */
	readonly exposure: number;
	readonly colourSpace: ColourSpace;
	/** Where the first scanline starts. */
	readonly pixelsAt: number;
}

function readHeader(bytes: Uint8Array): HdrHeader {
	if (bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x3f) {
		fail('it does not begin with the "#?" that opens every Radiance picture.');
	}
	const cursor: Cursor = { at: 0 };
	const signature = readLine(bytes, cursor).toUpperCase();
	if (!signature.includes('RADIANCE') && !signature.includes('RGBE')) {
		fail('its first line names neither RADIANCE nor RGBE, so it is not a Radiance picture.');
	}

	let exposure = 1;
	let colourSpace: ColourSpace = 'srgb';

	for (;;) {
		const line = readLine(bytes, cursor);
		// The blank line is the end of the header. Everything after it is the
		// resolution line and then pixels.
		if (line === '') break;
		// A comment can say anything, including something that looks like a key,
		// so it is skipped before any of them are tested.
		if (line.startsWith('#')) continue;

		if (line.startsWith('FORMAT=')) {
			const format = line.slice('FORMAT='.length).trim();
			if (format === '32-bit_rle_xyze') {
				fail(
					'it is in the XYZE format (FORMAT=32-bit_rle_xyze), which stores CIE XYZ rather than red, green and blue, and this reader does not convert it.',
				);
			}
			if (format !== '32-bit_rle_rgbe') {
				fail(
					'it declares a FORMAT other than 32-bit_rle_rgbe, which is the only one this reader knows.',
				);
			}
		} else if (line.startsWith('EXPOSURE=')) {
			const numbers = parseNumbers(line.slice('EXPOSURE='.length).trim());
			const value = numbers?.length === 1 ? (numbers[0] as number) : Number.NaN;
			if (!(value > 0) || !Number.isFinite(value)) {
				fail('it declares an EXPOSURE that is not a positive number.');
			}
			exposure *= value;
		} else if (line.startsWith('GAMMA=')) {
			if (!isUnity(parseNumbers(line.slice('GAMMA='.length).trim()), 1)) {
				fail(
					'it declares a GAMMA other than 1, meaning its samples have already been corrected, and this reader does not undo that.',
				);
			}
		} else if (line.startsWith('COLORCORR=')) {
			if (!isUnity(parseNumbers(line.slice('COLORCORR='.length).trim()), 3)) {
				fail(
					'it carries a COLORCORR line, a per channel correction already applied to its samples, and this reader does not undo it.',
				);
			}
		} else if (line.startsWith('PIXASPECT=')) {
			if (!isUnity(parseNumbers(line.slice('PIXASPECT='.length).trim()), 1)) {
				fail(
					'it declares a PIXASPECT other than 1, meaning its pixels are not square, and this reader does not resample them.',
				);
			}
		} else if (line.startsWith('PRIMARIES=')) {
			// Not an error when it is anything else, and not always meaningful
			// either: ImageMagick writes eight zeroes here for every picture it
			// converts, which name no colour space at all.
			const numbers = parseNumbers(line.slice('PRIMARIES='.length).trim());
			if (numbers?.length === 8 && isDisplayP3(numbers)) colourSpace = 'display-p3';
		}
		// Anything else is a line this reader has no use for: VIEW, SOFTWARE, the
		// rendering parameters, and whatever the next tool decides to append.
	}

	// A product of positive numbers stays positive, but enough of them overflow
	// to infinity or collapse to zero, and dividing by either turns the whole
	// picture into infinities or zeroes rather than failing.
	if (!(exposure > 0) || !Number.isFinite(exposure)) {
		fail('its EXPOSURE lines multiply out to a number nothing can be divided by.');
	}

	const resolution = RESOLUTION.exec(readLine(bytes, cursor).trim());
	if (resolution === null) {
		fail('the line after its header is not a size such as "-Y 512 +X 512".');
	}
	const first = resolution[1] as string;
	const second = resolution[3] as string;
	if (first[1] === second[1]) {
		fail('the line giving its size names the same axis twice.');
	}
	if (first[1] === 'X') {
		// The first axis is the one scanlines advance along, so a line starting
		// with X stores the picture in columns. Four of the eight combinations do
		// this, everything writes one of the other four, and treating a
		// transposed picture as an ordinary one hands back a diagonal smear.
		fail(
			`it stores its scanlines down columns (${first} before ${second} on the line giving its size), which this reader does not transpose.`,
		);
	}

	const height = Number(resolution[2] as string);
	const width = Number(resolution[4] as string);
	if (width < 1 || height < 1) {
		fail(`it describes a picture ${width} pixels wide and ${height} pixels tall.`);
	}
	if (width * height > MAX_PIXELS) {
		fail('it describes a picture far larger than anything this tool will allocate for.');
	}
	// Every scanline costs at least four bytes under all three encodings, so a
	// file with fewer than that per row is lying about its height and there is
	// no reason to allocate for what it claims.
	if (bytes.length - cursor.at < height * 4) {
		fail(`it holds less pixel data than the ${height} scanlines it describes would take.`);
	}

	return {
		width,
		height,
		// Radiance counts Y upwards, so -Y starts at the top of the picture and
		// works down, which is the order a raster is stored in. +Y is the other
		// way round and has to be flipped.
		flipY: first === '+Y',
		flipX: second === '-X',
		exposure,
		colourSpace,
		pixelsAt: cursor.at,
	};
}

/**
 * Read one new-style run length encoded scanline into `scan`.
 *
 * The four channels are stored one after another rather than interleaved,
 * which is the change that made this encoding worth having: an exponent that
 * holds still across a row compresses to two bytes, where interleaved RGBE
 * would break the run on every pixel.
 */
function readNewRle(bytes: Uint8Array, cursor: Cursor, width: number, scan: Uint8Array): void {
	for (let channel = 0; channel < 4; channel += 1) {
		let x = 0;
		while (x < width) {
			if (cursor.at >= bytes.length) {
				fail('the pixel data ends inside a compressed scanline.');
			}
			const code = bytes[cursor.at] as number;
			cursor.at += 1;

			if (code > 128) {
				// Over 128 is a run. Exactly 128 is not: it is a literal of 128
				// bytes, which is the longest one, and reading it as a run of zero
				// would stall on a file Radiance itself writes.
				const count = code - 128;
				if (x + count > width) {
					fail('a run in a compressed scanline reaches past the end of its row.');
				}
				if (cursor.at >= bytes.length) {
					fail('a run in a compressed scanline is missing the value it repeats.');
				}
				const value = bytes[cursor.at] as number;
				cursor.at += 1;
				for (let i = 0; i < count; i += 1) {
					scan[x * 4 + channel] = value;
					x += 1;
				}
				continue;
			}

			if (code === 0) {
				fail('a compressed scanline holds a literal run of no bytes, which would never end.');
			}
			if (x + code > width) {
				fail('a literal run in a compressed scanline reaches past the end of its row.');
			}
			if (cursor.at + code > bytes.length) {
				fail('the pixel data ends inside a literal run.');
			}
			for (let i = 0; i < code; i += 1) {
				scan[x * 4 + channel] = bytes[cursor.at] as number;
				cursor.at += 1;
				x += 1;
			}
		}
	}
}

/**
 * Read one scanline in the original encoding into `scan`.
 *
 * Four bytes a pixel, except that a pixel reading 255, 255, 255 is not a pixel
 * at all: its fourth byte is a count of how many times the pixel before it
 * repeats. A picture with no such marker in it is an uncompressed picture, so
 * this is also the path a flat file takes, and the ambiguity is real: a genuine
 * pixel whose three mantissas are all 255 cannot be written in this encoding.
 *
 * The shift is the part nobody implements. Consecutive markers are the same
 * count carried eight bits further up each time, so 255 followed by another
 * marker of 255 is a repeat of 255 plus 65280 rather than of 510. Reading the
 * second marker as another plain count leaves the rest of the row short by
 * tens of thousands of pixels, which shows up as a picture that shears.
 */
function readOldRle(bytes: Uint8Array, cursor: Cursor, width: number, scan: Uint8Array): void {
	let x = 0;
	let shift = 0;

	while (x < width) {
		if (cursor.at + 4 > bytes.length) {
			fail('the pixel data ends inside a scanline.');
		}
		const r = bytes[cursor.at] as number;
		const g = bytes[cursor.at + 1] as number;
		const b = bytes[cursor.at + 2] as number;
		const e = bytes[cursor.at + 3] as number;
		cursor.at += 4;

		if (r === 255 && g === 255 && b === 255) {
			if (x === 0) {
				fail('a scanline begins with a repeat marker, which has no pixel before it to repeat.');
			}
			// Multiplied rather than shifted: four markers in a row put the shift
			// at 32, where JavaScript's `<<` wraps back to a shift of zero and the
			// count comes out plausible instead of enormous.
			const count = e * 2 ** shift;
			if (count > width - x) {
				fail('a repeat marker in a scanline reaches past the end of its row.');
			}
			const from = (x - 1) * 4;
			for (let i = 0; i < count; i += 1) {
				scan[x * 4] = scan[from] as number;
				scan[x * 4 + 1] = scan[from + 1] as number;
				scan[x * 4 + 2] = scan[from + 2] as number;
				scan[x * 4 + 3] = scan[from + 3] as number;
				x += 1;
			}
			shift += 8;
			continue;
		}

		scan[x * 4] = r;
		scan[x * 4 + 1] = g;
		scan[x * 4 + 2] = b;
		scan[x * 4 + 3] = e;
		x += 1;
		shift = 0;
	}
}

function readScanline(bytes: Uint8Array, cursor: Cursor, width: number, scan: Uint8Array): void {
	const compressible = width >= MIN_RLE_WIDTH && width <= MAX_RLE_WIDTH;
	if (compressible && cursor.at + 4 <= bytes.length) {
		const r = bytes[cursor.at] as number;
		const g = bytes[cursor.at + 1] as number;
		const b = bytes[cursor.at + 2] as number;
		// 2, 2 with the top bit of the third byte clear is the header. With that
		// bit set the four bytes are an ordinary pixel whose red and green
		// mantissas happen to be 2, which is why the test is not just for 2, 2.
		if (r === 2 && g === 2 && (b & 0x80) === 0) {
			const declared = (b << 8) | (bytes[cursor.at + 3] as number);
			if (declared !== width) {
				fail('a compressed scanline declares a length that is not the width of the picture.');
			}
			cursor.at += 4;
			readNewRle(bytes, cursor, width, scan);
			return;
		}
	}
	readOldRle(bytes, cursor, width, scan);
}

/** Linear light, three floats a pixel, with the top row first. */
export interface HdrFloatImage {
	readonly data: Float32Array;
	readonly width: number;
	readonly height: number;
	/** The cumulative `EXPOSURE` the header declared, already divided out of `data`. */
	readonly exposure: number;
	readonly colourSpace: ColourSpace;
}

/**
 * Read a Radiance picture as the linear light it holds.
 *
 * Separate from `decodeHdr` because the two answer different questions. This
 * one is the file: a caller measuring luminance, or converting to another high
 * dynamic range format, needs the samples and not somebody's idea of an
 * exposure. `decodeHdr` is the picture, for a screen.
 */
export function decodeHdrFloat(bytes: Uint8Array): HdrFloatImage {
	const header = readHeader(bytes);
	const { width, height, flipX, flipY, exposure } = header;
	const cursor: Cursor = { at: header.pixelsAt };

	let data: Float32Array;
	try {
		data = new Float32Array(width * height * 3);
	} catch (cause) {
		fail('there is not enough memory here for a picture that size.', { cause });
	}

	const scan = new Uint8Array(width * 4);
	// The samples were multiplied by the exposure when the picture was written,
	// so recovering the light divides by it. One reciprocal rather than a
	// division per sample.
	const gain = 1 / exposure;

	for (let scanline = 0; scanline < height; scanline += 1) {
		readScanline(bytes, cursor, width, scan);
		const y = flipY ? height - 1 - scanline : scanline;

		for (let p = 0; p < width; p += 1) {
			const e = scan[p * 4 + 3] as number;
			// A zero exponent means the pixel is black, and it is a reserved value
			// rather than a very small one: running the arithmetic on it would
			// give 2 to the power of -136, which is not zero, so every unlit pixel
			// in the picture would carry a faint value that nothing put there.
			if (e === 0) continue;
			const scale = (EXPONENT_SCALE[e] as number) * gain;
			const x = flipX ? width - 1 - p : p;
			const to = (y * width + x) * 3;
			// The half is what the Radiance sources add, and it is not rounding:
			// a mantissa stands for the range between itself and the next one up,
			// so the value it means is in the middle of that range. Leaving it out
			// darkens every picture by a fraction of a percent, and takes a
			// channel that should be a fifth of a stop above zero down to zero.
			data[to] = ((scan[p * 4] as number) + 0.5) * scale;
			data[to + 1] = ((scan[p * 4 + 1] as number) + 0.5) * scale;
			data[to + 2] = ((scan[p * 4 + 2] as number) + 0.5) * scale;
		}
	}

	return { data, width, height, exposure, colourSpace: header.colourSpace };
}

/**
 * Read a Radiance picture as something a screen can show.
 *
 * The tone map meters the picture the way a camera would and rolls the
 * highlights off, so the result is a photograph of the scene rather than the
 * measurement the file holds. There is no alpha channel in the format and
 * nothing here invents one.
 */
export function decodeHdr(bytes: Uint8Array): RasterImage {
	const light = decodeHdrFloat(bytes);
	return toneMap(light.data, light.width, light.height, 3, { colourSpace: light.colourSpace });
}
