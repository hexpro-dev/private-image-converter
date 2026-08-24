/**
 * Finding the JPEG a camera has already rendered inside its own raw file.
 *
 * This is not a raw developer, and being plain about that matters more than
 * anything else in this file. Nothing here demosaics a sensor, applies a white
 * balance, reads a colour matrix or touches a single photosite. What it finds
 * is the JPEG the camera rendered itself, the picture its own screen showed on
 * playback, stored inside the raw file at whatever size the camera chose.
 * Somebody who asks to turn a CR2 into a JPEG wants the photograph they took,
 * and that is exactly what this hands back. Developing the sensor data would
 * produce a different picture, one this tool has no opinions to offer about,
 * and the difference is worth saying out loud rather than leaving somebody to
 * work out from a result that does not match their editor's.
 *
 * The JPEG is not decoded here either. It comes back as bytes for the
 * platform's own decoder, which is the fastest JPEG decoder on the machine and
 * is already sitting in the browser.
 *
 * There are three ways in, because the vendors never agreed on one:
 *
 *  1. A TIFF directory walk, which covers DNG, NEF, ARW, PEF, SRW, 3FR, IIQ,
 *     ERF, DCR, KDC, ORF, RW2 and CR2. Almost every raw format is a TIFF with
 *     vendor tags bolted on.
 *  2. Fujifilm's RAF, which is not a TIFF at all and states the offset and the
 *     length of its preview in its own fixed header.
 *  3. A scan of the whole buffer for JPEG streams. This is the fallback that
 *     makes CR3 work, and Panasonic's JpgFromRaw, and whatever a manufacturer
 *     invents next.
 *
 * All three run and the largest picture wins, because the directory walk finds
 * a 160 by 120 thumbnail as readily as it finds a full size preview and a
 * caller asked for the photograph rather than for the first JPEG in the file.
 * Ties go to the earlier search, which is what makes the source of a preview
 * that two searches both found the structured one rather than the coincidence.
 *
 * "Largest" has a trap in it that is worth stating here rather than leaving in
 * the code. A compressed DNG or CR2 stores its sensor data as a lossless JPEG,
 * with an SOI, a frame header giving the full sensor dimensions and an EOI, so
 * it is both a valid JPEG stream and the largest picture in the file. Nothing
 * in any browser decodes lossless JPEG. Only SOF0, SOF1 and SOF2 are offered
 * as previews, and meeting one of the other frame modes is how this reader
 * recognises that it is looking at the raw data itself and says so.
 *
 * Refused by name, in the message: BigTIFF, whose 64 bit directories are not
 * walked; lossless, differential and arithmetic coded frames, which is where
 * the sensor data lives; a stream whose tables were left behind in a TIFF
 * JPEGTables tag; and a frame whose height arrives in a DNL marker rather than
 * in its header. Vendor private tags are not read either, and are covered in
 * the note on the TIFF search below.
 *
 * Every read is bounds checked, and every walk is bounded in work as well as
 * in reach: these files are tens of megabytes of somebody else's bytes, and a
 * directory that points at itself or a thousand stream starts that all point
 * at the same chain of segments both turn a linear read into a hung tab.
 */

import { DecodeFailedError } from '../../errors.js';

const DECODER_ID = 'raw-preview';

/** A JPEG a camera rendered and stored inside its own raw file. */
export interface RawPreview {
	/** A complete JPEG, ready for the platform decoder. */
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
	/** Which of the three searches produced it. */
	readonly source: 'ifd' | 'raf' | 'scan';
}

/**
 * The largest preview this reader will offer.
 *
 * Nothing is allocated from these numbers, so this is not a guard against an
 * allocation bomb. It is a guard against passing on a frame header that claims
 * sixty thousand by sixty thousand, which is a crafted file rather than a
 * camera, and which would otherwise be refused several layers further on where
 * the reason is much harder to see.
 */
const MAX_PREVIEW_PIXELS = 400_000_000;

/**
 * How many image file directories the TIFF search will visit.
 *
 * A raw file has a handful: IFD0, the sub-directories holding the previews and
 * the sensor data, IFD1, and the Exif directory. Hundreds of them describe
 * something other than a photograph, and every directory costs a pass over its
 * entries, which a crafted file can point all at the same place.
 */
const MAX_DIRECTORIES = 64;

/**
 * How many sub-directory offsets one directory may hand on. See MAX_DIRECTORIES.
 *
 * Counted over the whole directory rather than over one SubIFDs tag, which is
 * the difference between a bound and the appearance of one. A tag lists at most
 * this many offsets, but nothing stops a directory from carrying a SubIFDs tag
 * for every twelve bytes of the file, and a cap that counts one tag at a time
 * lets a crafted 188 KiB file queue half a million offsets.
 */
const MAX_SUB_IFDS = 32;

function fail(detail: string): never {
	throw new DecodeFailedError('raw', DECODER_ID, detail);
}

/* ── The state of one search ──────────────────────────────────────────── */

/**
 * The work one search may do, counted in marker steps, entropy bytes and
 * directory entries.
 *
 * Walking a JPEG is linear in its own length, so a real file spends about one
 * step per byte and never comes near this. It exists because the scan starts a
 * walk at every 0xFF 0xD8 0xFF in the buffer, and a file can be built where
 * every one of those points at the same long chain of segments, which turns a
 * linear scan into a quadratic one. The directory walk spends from the same
 * budget, because a directory may declare sixty five thousand entries and a
 * file may point sixty four directories at the same entries. Running out stops
 * the search rather than failing it: whatever was found before the budget ran
 * down is still a preview, and a photograph is not refused because of what
 * follows it.
 */
interface Budget {
	steps: number;
}

/**
 * What the search saw on its way to finding nothing.
 *
 * Only read when there is no preview to return. The general refusal is true of
 * every file that reaches it, but "this is a BigTIFF and I do not walk those"
 * is a much more useful sentence than "I found nothing", and the difference
 * costs one boolean.
 */
interface Search extends Budget {
	/** A complete JPEG stream whose size no frame header ever gave. */
	sizeless: boolean;
	/** The frame header of a complete stream in a mode nothing here can use. */
	undecodableFrame?: number;
	/** A complete stream carrying neither of the tables needed to decode it. */
	abbreviated: boolean;
	/** The size a complete stream claimed, when nothing could be that size. */
	oversized?: readonly [number, number];
	/** The file is a BigTIFF, whose 64 bit directories this reader does not walk. */
	bigTiff: boolean;
	/** A directory claimed more entries than the file has room for. */
	truncated: boolean;
}

/** One JPEG stream found inside the file, before the largest is chosen. */
interface Candidate {
	readonly start: number;
	/** One past the last byte of the stream, which is the byte after its EOI. */
	readonly end: number;
	readonly width: number;
	readonly height: number;
	readonly source: RawPreview['source'];
}

/* ── JPEG marker walking ──────────────────────────────────────────────── */

const MARKER = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DAC = 0xcc;
/** TEM, a standalone marker with no payload that may appear between segments. */
const TEM = 0x01;
/** 0xFF 0x00 is how entropy coded data spells a literal 0xFF byte. */
const STUFFING = 0x00;

/**
 * The last frame header a browser will decode.
 *
 * SOF0 is baseline, SOF1 extended sequential and SOF2 progressive, all Huffman
 * coded, and those three are the whole of what a browser reads. Everything
 * above is lossless, differential or arithmetic coded, and this matters here
 * far more than it would in an ordinary JPEG reader: a DNG and a CR2 store
 * their sensor data as lossless JPEG, complete with an SOI, a frame header
 * giving the full sensor dimensions and an EOI. A scan that took the largest
 * JPEG in the file without looking at the frame mode would return the sensor
 * data of a compressed raw file every time, and it would be the largest
 * picture in the file, and nothing could decode it.
 */
const LAST_DECODABLE_FRAME = 0xc2;

/**
 * Whether a marker is one of SOF0 to SOF15, which carry the frame dimensions.
 *
 * The run from 0xC0 to 0xCF has three holes in it: DHT at 0xC4, JPG at 0xC8
 * and DAC at 0xCC. Reading a Huffman table as a frame header takes two bytes
 * of a code length table for the width, which is a plausible number rather
 * than an error, so the holes matter.
 */
function isFrameHeader(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== DHT && marker !== 0xc8 && marker !== DAC;
}

/** What to call a frame mode nothing here can use, for the refusal. */
function frameMode(marker: number): string {
	// SOF3, SOF7, SOF11 and SOF15 are the four lossless modes, and the first of
	// them is what a compressed DNG or CR2 wraps its sensor data in.
	if (marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf) return 'lossless';
	if (marker >= 0xc9) return 'arithmetic coded';
	return 'differential';
}

/**
 * The article that belongs in front of a frame mode's name.
 *
 * `arithmetic coded` is the one that takes `an`, and the refusal is a sentence
 * somebody reads.
 */
function article(mode: string): string {
	return /^[aeiou]/.test(mode) ? 'an' : 'a';
}

/** RST0 to RST7, which interrupt entropy coded data and carry no payload. */
function isRestart(marker: number): boolean {
	return marker >= 0xd0 && marker <= 0xd7;
}

interface Walk {
	/** True when the stream ran all the way to its own EOI marker. */
	readonly complete: boolean;
	/** One past the last byte reached: after the EOI when complete. */
	readonly end: number;
	/** From the first frame header. Zero when none was reached. */
	readonly width: number;
	readonly height: number;
	/** The marker byte of the first frame header, or zero when none was reached. */
	readonly frame: number;
	/**
	 * Whether the stream carries the tables needed to decode it.
	 *
	 * A quantisation table and either a Huffman or an arithmetic conditioning
	 * table. A TIFF may store those once in a JPEGTables tag and leave every
	 * strip without them, and such a strip still begins 0xFF 0xD8, still has a
	 * frame header and still ends 0xFF 0xD9. Handing one to a decoder produces
	 * an error from somewhere much further away than here.
	 */
	readonly tables: boolean;
}

/**
 * Step over entropy coded data to the marker that ends it.
 *
 * The one part of a JPEG that has to be read a byte at a time, because the
 * compressed data has no length: it runs until a marker, and a 0xFF inside it
 * is written as 0xFF 0x00 so that it cannot be mistaken for one. Searching for
 * the two bytes of an EOI instead of walking this is the mistake that makes a
 * scanner return a truncated file, because 0xFF 0xD9 occurs inside the
 * compressed data of most photographs.
 *
 * Returns the position of the 0xFF of the next marker, or the end of the
 * buffer when the data ran out first.
 */
function skipEntropy(bytes: Uint8Array, from: number, budget: Budget): number {
	let at = from;
	while (at + 1 < bytes.length) {
		if (budget.steps <= 0) return bytes.length;
		budget.steps -= 1;
		if (bytes[at] !== MARKER) {
			at += 1;
			continue;
		}
		const next = bytes[at + 1] as number;
		if (next === STUFFING) {
			at += 2;
			continue;
		}
		// A run of 0xFF bytes is padding in front of the marker that follows it.
		if (next === MARKER) {
			at += 1;
			continue;
		}
		// A restart marker sits inside the entropy data rather than ending it.
		if (isRestart(next)) {
			at += 2;
			continue;
		}
		return at;
	}
	return bytes.length;
}

/**
 * Walk a JPEG from its SOI to its EOI, segment by segment.
 *
 * `stopAtFrame` returns as soon as the dimensions are known, for a caller that
 * wants the size and nothing else. `complete` stays false in that case: the
 * walk has proved nothing about the rest of the stream, and saying it had
 * would let an unterminated file be offered as a preview.
 */
function walkJpeg(bytes: Uint8Array, start: number, budget: Budget, stopAtFrame = false): Walk {
	let width = 0;
	let height = 0;
	let frame = 0;
	let quantisation = false;
	let coding = false;
	const give = (complete: boolean, end: number): Walk => ({
		complete,
		end,
		width,
		height,
		frame,
		tables: quantisation && coding,
	});

	if (start + 2 > bytes.length || bytes[start] !== MARKER || bytes[start + 1] !== SOI) {
		return give(false, start);
	}
	let at = start + 2;

	while (at + 1 < bytes.length) {
		if (budget.steps <= 0) return give(false, at);
		budget.steps -= 1;

		if (bytes[at] !== MARKER) return give(false, at);
		const marker = bytes[at + 1] as number;

		// Any number of 0xFF bytes may pad the gap before a marker.
		if (marker === MARKER) {
			at += 1;
			continue;
		}
		// 0xFF 0x00 belongs to entropy coded data. Meeting one where a marker
		// belongs means this is not the structure we thought it was.
		if (marker === STUFFING) return give(false, at);
		// A second SOI is the start of another stream rather than part of this
		// one. Treating it as part of this one is how a scanner ends up
		// returning a thumbnail with a whole second picture glued to the back.
		if (marker === SOI) return give(false, at);
		if (marker === EOI) return give(true, at + 2);
		if (marker === TEM || isRestart(marker)) {
			at += 2;
			continue;
		}

		if (at + 4 > bytes.length) return give(false, at);
		const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
		// The length counts its own two bytes, so anything below two would put
		// the next marker before this one and the walk would never advance.
		if (length < 2) return give(false, at);
		const segmentEnd = at + 2 + length;
		if (segmentEnd > bytes.length) return give(false, at);

		if (marker === DQT) quantisation = true;
		if (marker === DHT || marker === DAC) coding = true;

		// Only the first frame header counts. A progressive JPEG has one SOF2
		// and then several scans; a hierarchical one has several frames, and the
		// first is the one the whole picture is.
		if (isFrameHeader(marker) && frame === 0) {
			// A frame header is a precision byte, the height, the width and a
			// component count, so eight bytes including the length itself is the
			// least it can be and still say how large the picture is.
			if (length < 8) return give(false, at);
			frame = marker;
			height = ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number);
			width = ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
			if (stopAtFrame) return give(false, segmentEnd);
		}

		at = marker === SOS ? skipEntropy(bytes, segmentEnd, budget) : segmentEnd;
	}
	return give(false, at);
}

/**
 * The dimensions a JPEG's frame header gives, without decoding it.
 *
 * Undefined when the bytes are not a JPEG, when the file ends before its frame
 * header, or when that header gives a zero. A zero height means the real
 * height arrives later in a DNL marker, which this does not follow, and
 * reporting a zero would be worse than reporting nothing.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const walk = walkJpeg(bytes, 0, { steps: bytes.length * 4 + 4096 }, true);
	if (walk.width < 1 || walk.height < 1) return undefined;
	return { width: walk.width, height: walk.height };
}

/* ── Candidates ───────────────────────────────────────────────────────── */

/**
 * Walk the stream at `start` and offer it as a preview if it is one.
 *
 * The one place a stream is validated, so that everything this module returns
 * has been through the same tests whichever search found it. Beginning
 * 0xFF 0xD8 and ending at its own 0xFF 0xD9 is what a complete walk means, and
 * the rest is checked here: a frame header giving a real size, in a mode a
 * browser decodes, with the tables to decode it, at a size a camera produces.
 *
 * Each refusal leaves a note behind rather than throwing, because a file whose
 * first stream is its sensor data usually has a preview later on, and because
 * a file that ends up with nothing can then say which of these it was.
 */
function candidateAt(
	bytes: Uint8Array,
	start: number,
	source: RawPreview['source'],
	search: Search,
): Candidate | undefined {
	const walk = walkJpeg(bytes, start, search);
	if (!walk.complete) return undefined;
	if (walk.width < 1 || walk.height < 1) {
		search.sizeless = true;
		return undefined;
	}
	if (walk.frame > LAST_DECODABLE_FRAME) {
		search.undecodableFrame ??= walk.frame;
		return undefined;
	}
	if (!walk.tables) {
		search.abbreviated = true;
		return undefined;
	}
	if (walk.width * walk.height > MAX_PREVIEW_PIXELS) {
		search.oversized ??= [walk.width, walk.height];
		return undefined;
	}
	return { start, end: walk.end, width: walk.width, height: walk.height, source };
}

/* ── 1. The TIFF directory walk ───────────────────────────────────────── */

const TAG_COMPRESSION = 0x0103;
const TAG_STRIP_OFFSETS = 0x0111;
const TAG_STRIP_BYTE_COUNTS = 0x0117;
const TAG_SUB_IFDS = 0x014a;
const TAG_JPEG_OFFSET = 0x0201;
const TAG_JPEG_LENGTH = 0x0202;
const TAG_EXIF_IFD = 0x8769;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
/**
 * Type 13, IFD, which is a LONG whose value is the offset of a directory.
 *
 * Identical to a LONG on the wire, and the type TIFF Technical Note 1 and the
 * DNG specification both give for SubIFDs alongside LONG. A reader that takes
 * only LONG walks past the sub-directories of a file written to the letter of
 * the specification, and libtiff writes exactly that file.
 */
const TYPE_IFD = 13;

/** Compression 6 is the old JPEG mode and 7 the new one. Both mean a whole JPEG. */
const COMPRESSION_JPEG_OLD = 6;
const COMPRESSION_JPEG_NEW = 7;

/**
 * One field's value, when it is a single SHORT, LONG or IFD.
 *
 * A value of four bytes or fewer lives in the entry itself, left justified,
 * rather than at an offset, which is the detail every hand written TIFF reader
 * gets wrong once. All three of the types here fit, so none of them is
 * followed.
 *
 * A count other than one is refused rather than read for its first element. A
 * StripOffsets with eleven entries is an image in eleven strips, not a JPEG,
 * and offering the first of them would hand back a slice of a picture.
 *
 * Zero doubles as "nothing usable here", which costs nothing: no offset in a
 * TIFF may be zero, and a length of zero describes no bytes.
 */
function scalar(
	view: DataView,
	little: boolean,
	entry: number,
	type: number,
	count: number,
): number {
	if (count !== 1) return 0;
	if (type === TYPE_SHORT) return view.getUint16(entry + 8, little);
	if (type === TYPE_LONG || type === TYPE_IFD) return view.getUint32(entry + 8, little);
	return 0;
}

/**
 * The offsets a SubIFDs tag lists, whether it holds one inline or points at many.
 *
 * `room` is what the directory has left to give, so that a file carrying
 * thousands of these tags pays for reading the first thirty two offsets rather
 * than for reading thirty two of them per tag.
 */
function subIfdOffsets(
	bytes: Uint8Array,
	view: DataView,
	little: boolean,
	entry: number,
	type: number,
	count: number,
	room: number,
): number[] {
	if (type !== TYPE_LONG && type !== TYPE_IFD) return [];
	if (room < 1) return [];
	if (count === 1) return [view.getUint32(entry + 8, little)];
	const wanted = Math.min(count, room);
	const at = view.getUint32(entry + 8, little);
	if (at + wanted * 4 > bytes.length) return [];
	const out: number[] = [];
	for (let i = 0; i < wanted; i += 1) out.push(view.getUint32(at + i * 4, little));
	return out;
}

/**
 * Take a directory's word for where a JPEG is, then measure it.
 *
 * The declared length is checked against the file and then not used as the end
 * of the stream, because it is a claim rather than a measurement: cameras pad
 * a preview out to a sector boundary and count the padding, and one or two
 * count the JPEG without its EOI. The marker walk is what says where the
 * stream ends. A zero offset or a zero length is how a directory says it has
 * no preview, so both fall out here as well.
 */
function offer(
	bytes: Uint8Array,
	at: number,
	length: number,
	search: Search,
	into: Candidate[],
): void {
	// Nothing can live before the end of a TIFF header, so an offset below
	// eight is a missing tag or a lie either way.
	if (at < 8 || length < 1 || at + length > bytes.length) return;
	const candidate = candidateAt(bytes, at, 'ifd', search);
	if (candidate) into.push(candidate);
}

/**
 * Read one image file directory, collecting previews and sub-directories.
 *
 * Returns the offsets of the directories this one points at rather than
 * recursing, so that a file which points a directory at itself cannot put this
 * into an infinite loop. The caller keeps the set of offsets already visited.
 */
function readDirectory(
	bytes: Uint8Array,
	view: DataView,
	little: boolean,
	start: number,
	search: Search,
	into: Candidate[],
): number[] {
	const entries = view.getUint16(start, little);
	const entriesEnd = start + 2 + entries * 12;
	if (entriesEnd > bytes.length) {
		// Noted rather than thrown. Another directory may still hold a preview,
		// and a file that turns out to hold none says this instead of the
		// general refusal.
		search.truncated = true;
		return [];
	}

	// One rule for every sub-directory this entry loop offers, so that a
	// directory carrying a thousand SubIFDs tags hands on no more than a
	// directory carrying one. See MAX_SUB_IFDS.
	const children: number[] = [];
	const follow = (child: number): void => {
		if (children.length < MAX_SUB_IFDS) children.push(child);
	};

	let compression = 0;
	let jpegAt = 0;
	let jpegLength = 0;
	let stripAt = 0;
	let stripLength = 0;

	for (let i = 0; i < entries; i += 1) {
		// Charged for one by one. Reading an entry is cheap, and a file that
		// declares sixty five thousand of them and points every directory it has
		// at the same ones is a hung tab rather than a camera.
		if (search.steps <= 0) break;
		search.steps -= 1;

		const entry = start + 2 + i * 12;
		const tag = view.getUint16(entry, little);
		const type = view.getUint16(entry + 2, little);
		// The number of values in the field, which for everything read here has
		// to be one.
		const count = view.getUint32(entry + 4, little);
		switch (tag) {
			case TAG_COMPRESSION:
				compression = scalar(view, little, entry, type, count);
				break;
			case TAG_STRIP_OFFSETS:
				stripAt = scalar(view, little, entry, type, count);
				break;
			case TAG_STRIP_BYTE_COUNTS:
				stripLength = scalar(view, little, entry, type, count);
				break;
			case TAG_JPEG_OFFSET:
				jpegAt = scalar(view, little, entry, type, count);
				break;
			case TAG_JPEG_LENGTH:
				jpegLength = scalar(view, little, entry, type, count);
				break;
			case TAG_SUB_IFDS:
				for (const child of subIfdOffsets(
					bytes,
					view,
					little,
					entry,
					type,
					count,
					MAX_SUB_IFDS - children.length,
				)) {
					follow(child);
				}
				break;
			case TAG_EXIF_IFD:
				follow(scalar(view, little, entry, type, count));
				break;
			default:
				break;
		}
	}

	// The next directory in the chain, four bytes past the last entry. A zero
	// ends the chain, and a file that ends without writing the link at all is
	// common enough to be worth surviving. Queued whether or not the
	// sub-directory cap was reached, because it is one offset per directory
	// however the entries went, and it is how IFD1 and its thumbnail are found.
	if (entriesEnd + 4 <= bytes.length) {
		children.push(view.getUint32(entriesEnd, little));
	}

	// The classic pair, which is where a thumbnail and most vendors' previews
	// live.
	offer(bytes, jpegAt, jpegLength, search, into);
	// And the other shape: a directory that describes an image in one strip and
	// says that strip is JPEG compressed. A DNG's full size preview is here,
	// and so is the one in a CR2.
	if (compression === COMPRESSION_JPEG_OLD || compression === COMPRESSION_JPEG_NEW) {
		offer(bytes, stripAt, stripLength, search, into);
	}
	return children;
}

/**
 * Walk IFD0, the whole IFD chain, every SubIFD and the Exif directory.
 *
 * Keyed off the byte order marker rather than the version number, because
 * Olympus writes 0x4F52 and Panasonic 0x0055 where an ordinary TIFF writes 42,
 * and refusing those would refuse ORF and RW2 outright. What the version is
 * still good for is spotting a BigTIFF, whose directories are laid out
 * differently and are not read here.
 *
 * Vendor private tags are not read: Panasonic's JpgFromRaw, the preview
 * pointers some cameras hide inside a maker note, and Phase One's own index
 * are all left alone rather than half implemented. The buffer scan is what
 * finds those previews, which is why it runs even when this search succeeds.
 */
function searchTiff(bytes: Uint8Array, search: Search, into: Candidate[]): void {
	if (bytes.length < 8) return;
	const order = ((bytes[0] as number) << 8) | (bytes[1] as number);
	if (order !== 0x4949 && order !== 0x4d4d) return;
	const little = order === 0x4949;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	if (view.getUint16(2, little) === 43) {
		search.bigTiff = true;
		return;
	}

	const queue: number[] = [view.getUint32(4, little)];
	const visited = new Set<number>();
	while (queue.length > 0 && visited.size < MAX_DIRECTORIES && search.steps > 0) {
		const at = queue.shift() as number;
		search.steps -= 1;
		// The visited set is the cycle defence, and it is only half of the bound.
		// A malformed file can point a directory at itself or two of them at each
		// other, and a naive walk hangs the tab rather than failing. What the set
		// does not bound is the queue: an offset that is out of range or already
		// visited is skipped without ever counting towards MAX_DIRECTORIES, so
		// what caps the work is the budget above and the cap on how many
		// sub-directories one directory may name.
		if (at < 8 || at + 2 > bytes.length || visited.has(at)) continue;
		visited.add(at);
		for (const child of readDirectory(bytes, view, little, at, search, into)) queue.push(child);
	}
}

/* ── 2. Fujifilm RAF ──────────────────────────────────────────────────── */

/** 'FUJIFILMCCD-RAW', the fifteen bytes a RAF opens with. */
const RAF_MAGIC = 'FUJIFILMCCD-RAW';
const RAF_JPEG_OFFSET_AT = 84;
const RAF_JPEG_LENGTH_AT = 88;

/**
 * Fujifilm's own header, which is not a TIFF and not related to one.
 *
 * Two big endian words at fixed positions, which makes this the only search
 * here that cannot be wrong about where to look. Everything after those two
 * words is Fujifilm's business.
 */
function searchRaf(bytes: Uint8Array, search: Search, into: Candidate[]): void {
	if (bytes.length < RAF_JPEG_LENGTH_AT + 4) return;
	for (let i = 0; i < RAF_MAGIC.length; i += 1) {
		if (bytes[i] !== RAF_MAGIC.charCodeAt(i)) return;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = view.getUint32(RAF_JPEG_OFFSET_AT);
	const length = view.getUint32(RAF_JPEG_LENGTH_AT);
	if (at < RAF_JPEG_LENGTH_AT + 4 || length < 1 || at + length > bytes.length) return;
	const candidate = candidateAt(bytes, at, 'raf', search);
	if (candidate) into.push(candidate);
}

/* ── 3. The buffer scan ───────────────────────────────────────────────── */

/**
 * Every complete JPEG stream in the buffer, found by walking rather than by
 * searching for the end bytes.
 *
 * A stream that walks to its EOI is stepped over whole, so the thumbnail
 * inside a preview's own Exif segment is not offered a second time as a
 * picture of its own. A run of bytes that only looked like a stream start
 * costs the two bytes of its SOI and the scan carries on from there.
 */
function scanForStreams(bytes: Uint8Array, search: Search, into: Candidate[]): void {
	let at = 0;
	while (at + 2 < bytes.length) {
		if (bytes[at] !== MARKER || bytes[at + 1] !== SOI || bytes[at + 2] !== MARKER) {
			at += 1;
			continue;
		}
		const candidate = candidateAt(bytes, at, 'scan', search);
		if (candidate) {
			into.push(candidate);
			at = candidate.end;
			continue;
		}
		at += 2;
	}
}

/* ── Entry point ──────────────────────────────────────────────────────── */

function refuse(search: Search): never {
	if (search.bigTiff) {
		fail(
			'it is a BigTIFF, whose 64 bit image directories this reader does not walk, and scanning the rest of it turned up no JPEG preview either.',
		);
	}
	if (search.truncated) {
		fail('one of its image directories runs past the end of the file, and no preview survived it.');
	}
	if (search.undecodableFrame !== undefined) {
		const marker = search.undecodableFrame;
		const mode = frameMode(marker);
		fail(
			`the JPEG inside it is ${article(mode)} ${mode} one (SOF${marker - 0xc0}), which is how a raw file stores its sensor data rather than its preview, and developing sensor data into a picture is not something this tool does.`,
		);
	}
	if (search.abbreviated) {
		fail(
			'the JPEG inside it carries none of its own tables, which is how a TIFF stores an image whose tables sit in a separate JPEGTables tag, and this reader does not stitch the two back together.',
		);
	}
	if (search.oversized) {
		const [width, height] = search.oversized;
		fail(
			`a JPEG inside it claims to be ${width} by ${height} pixels, which is not a size a camera preview comes in.`,
		);
	}
	if (search.sizeless) {
		fail(
			'the JPEG inside it never states its size in a frame header, and a size given only by a DNL marker is not one this reader follows.',
		);
	}
	fail(
		'it carries no JPEG preview this reader could find, and developing the sensor data into a picture is not something this tool does.',
	);
}

/**
 * Find the largest JPEG preview a camera raw file carries.
 *
 * The result is the camera's own rendering of the photograph, not a
 * development of the raw data. See the note at the top of this file: the
 * distinction is the whole point of the module.
 */
export function findRawPreview(bytes: Uint8Array): RawPreview {
	const search: Search = {
		steps: bytes.length * 4 + 4096,
		sizeless: false,
		abbreviated: false,
		bigTiff: false,
		truncated: false,
	};
	const found: Candidate[] = [];
	searchTiff(bytes, search, found);
	searchRaf(bytes, search, found);
	scanForStreams(bytes, search, found);

	let best: Candidate | undefined;
	for (const candidate of found) {
		// Strictly larger, so a stream that two searches both found keeps the
		// source of the first one to find it.
		if (!best || candidate.width * candidate.height > best.width * best.height) best = candidate;
	}
	if (!best) refuse(search);

	return {
		// Copied rather than returned as a view. A view would hold the whole raw
		// file alive for as long as anything keeps the preview, which is forty
		// megabytes to save copying three. `slice` is not that copy: on a Node
		// Buffer, which is what `readFileSync` hands back and a Uint8Array as far
		// as any type says, it is an alias for `subarray` and returns exactly the
		// window this is avoiding.
		bytes: new Uint8Array(bytes.subarray(best.start, best.end)),
		width: best.width,
		height: best.height,
		source: best.source,
	};
}
