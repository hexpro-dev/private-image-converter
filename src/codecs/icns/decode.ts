/**
 * An Apple icon suite (.icns) reader.
 *
 * The container is trivial: the four bytes `icns`, a total length, then a flat
 * list of entries, each a four character type and a length that counts its own
 * eight byte header. Everything interesting is inside an entry, and what is
 * inside depends on which decade the file was written in. A suite from 2003
 * holds three colour planes run length coded with a mask beside them, one from
 * 2008 holds JPEG 2000, and one from today holds PNG. All three spellings turn
 * up in the same directory on a current macOS install, and plenty of files
 * carry several at once.
 *
 * So the payload is sniffed rather than inferred from the type. `ic04` and
 * `ic05` are raw ARGB in almost every file and PNG in a few; `icp4` and `icp5`
 * are PNG in almost every file and 24 bit run length coded in a few. Trusting
 * the type would hand a PNG to the run length unpacker, which does not fail,
 * it just produces noise.
 *
 * What it reads: PNG entries at every size, raw ARGB entries, and the classic
 * 24 bit run length entries `is32`, `il32`, `ih32` and `it32` with alpha from
 * their matching `s8mk`, `l8mk`, `h8mk` and `t8mk` masks. What it refuses by
 * name: JPEG 2000 payloads, and the 1, 4 and 8 bit indexed entries, which are
 * drawn through the classic Macintosh system palettes.
 */

import { DecodeFailedError } from '../../errors.js';
import { createRaster, detectAlpha } from '../../raster/image.js';
import type { RasterImage } from '../../types.js';
import { decodePng } from '../png/decode.js';

const DECODER_ID = 'icns-pure';

/** `icns` and the total length. */
const HEADER_BYTES = 8;
/** A four character type and a length. The length counts these eight bytes. */
const ENTRY_HEADER_BYTES = 8;

/**
 * The largest side a PNG inside an icon may claim, before anything is decoded.
 *
 * The biggest slot Apple defines is 1024, so this is generous by a factor of
 * four and still refuses a two hundred byte entry whose header asks for a
 * fourteen gigabyte buffer. Sizes for every other payload form come from the
 * table below rather than from the file, so they need no bound of their own.
 *
 * This is also the answer to why this reader has no `measure` hook where the
 * PNG and PCX readers have one. Those two can be handed a header describing
 * an image of any size at all, so a caller needs the declared size before the
 * decode to have any defence. Here the declared size cannot get past this
 * line: the only payload that carries its own dimensions is a PNG, this
 * refuses it above 4096 a side, and every other entry is sized from the fixed
 * table below, whose largest slot is 1024. Sixteen million pixels is the most
 * an icon suite can ever ask for, which is a fifth of the converter's default
 * budget. Raising this would change that, so raise the two together or not at
 * all.
 */
const MAX_PNG_SIDE = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The chunk header PNG requires first: a length of thirteen, then `IHDR`. */
const IHDR_HEADER = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52] as const;

/** The JPEG 2000 signature box: length 12, `jP  `, then a CRLF check pattern. */
const JP2_SIGNATURE = [
	0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
] as const;

/** A bare JPEG 2000 codestream, with no container around it. */
const J2K_SIGNATURE = [0xff, 0x4f, 0xff, 0x51] as const;

const ARGB_MARKER = [0x41, 0x52, 0x47, 0x42] as const;

/** What one entry turned out to hold. Decided from its type and its first bytes. */
export type IcnsEntryKind =
	| 'png'
	| 'jpeg2000'
	| 'argb'
	| 'rle24'
	/** Eight bit alpha for the run length entry of the same size. */
	| 'mask'
	/** One of the classic palettised icons, which this reader refuses. */
	| 'indexed'
	/** A table of contents, a version number or a property list. Not a picture. */
	| 'metadata'
	| 'unknown';

interface IconType {
	readonly side: number;
	/**
	 * A retina spelling: the same pixels as a smaller point size at twice the
	 * scale. `ic11` and `icp5` both hold a 32 pixel square, but one of them is
	 * a 16 point icon drawn at 2x and the other is a 32 point icon.
	 */
	readonly retina: boolean;
	/** What the payload is when it is neither a PNG nor a JPEG 2000. */
	readonly raw: 'argb' | 'rle24' | 'none';
}

/**
 * Every entry type that carries a picture, with the size its name implies.
 *
 * The sizes are checked rather than remembered: reading the `IHDR` of every
 * PNG in the 3077 icon suites on a macOS install produced exactly these
 * numbers for these types and nothing else, so a mismatch between the type and
 * the payload is a thing that does not happen in practice.
 */
const ICON_TYPES: Readonly<Record<string, IconType>> = {
	// The `icp` family is PNG in every file but four, where it is 24 bit run
	// length data with no mask beside it. Both are read.
	icp4: { side: 16, retina: false, raw: 'rle24' },
	icp5: { side: 32, retina: false, raw: 'rle24' },
	icp6: { side: 64, retina: false, raw: 'none' },
	ic07: { side: 128, retina: false, raw: 'none' },
	ic08: { side: 256, retina: false, raw: 'none' },
	ic09: { side: 512, retina: false, raw: 'none' },
	ic10: { side: 1024, retina: true, raw: 'none' },
	ic11: { side: 32, retina: true, raw: 'none' },
	ic12: { side: 64, retina: true, raw: 'none' },
	ic13: { side: 256, retina: true, raw: 'none' },
	ic14: { side: 512, retina: true, raw: 'none' },
	ic04: { side: 16, retina: false, raw: 'argb' },
	ic05: { side: 32, retina: false, raw: 'argb' },
	// The sidebar sizes, which macOS uses in Finder's source list.
	icsb: { side: 18, retina: false, raw: 'argb' },
	sb24: { side: 24, retina: false, raw: 'none' },
	SB24: { side: 48, retina: true, raw: 'none' },
	// The classic 24 bit entries. Their alpha is a separate entry.
	is32: { side: 16, retina: false, raw: 'rle24' },
	il32: { side: 32, retina: false, raw: 'rle24' },
	ih32: { side: 48, retina: false, raw: 'rle24' },
	it32: { side: 128, retina: false, raw: 'rle24' },
};

/** Eight bit alpha planes, keyed by the size of the picture they belong to. */
const MASK_TYPES: Readonly<Record<string, number>> = {
	s8mk: 16,
	l8mk: 32,
	h8mk: 48,
	t8mk: 128,
};

/**
 * The palettised icons, which are refused rather than read.
 *
 * Each of these stores indices into one of the classic Macintosh system
 * colour tables, which are not in the file: the 4 bit and 8 bit tables are
 * fixed lists that shipped inside the operating system, and the `#` types are
 * a 1 bit picture with a 1 bit mask stacked underneath it. Carrying two dead
 * palettes to read a format that Mac OS X stopped writing in 2001 is not worth
 * the bytes, so these are named in the refusal instead.
 */
const INDEXED_TYPES = new Set([
	'ICON',
	'ICN#',
	'icm#',
	'icm4',
	'icm8',
	'ics#',
	'ics4',
	'ics8',
	'icl4',
	'icl8',
	'ich#',
	'ich4',
	'ich8',
]);

/**
 * Entries that are not pictures at all.
 *
 * `TOC ` repeats the type and length of every other entry so a reader can
 * index the file without walking it, which is exactly what the walk below does
 * anyway. `icnV` is a version float, `info` a binary property list and `name`
 * a short label.
 */
const METADATA_TYPES = new Set(['TOC ', 'icnV', 'info', 'name']);

export interface IcnsEntry {
	/** The four character type, as it appears in the file. */
	readonly type: string;
	/** Pixels across, or 0 when neither the type nor the payload names a size. */
	readonly width: number;
	readonly height: number;
	readonly retina: boolean;
	readonly kind: IcnsEntryKind;
	/** A view into the input, not a copy. */
	readonly payload: Uint8Array;
}

export interface IcnsDirectory {
	/** The total length the header declares, which bounds the walk. */
	readonly declaredBytes: number;
	readonly entries: readonly IcnsEntry[];
}

function fail(detail: string, options?: ErrorOptions): never {
	throw new DecodeFailedError('icns', DECODER_ID, detail, options);
}

function matches(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
	if (at + signature.length > bytes.length) return false;
	for (let i = 0; i < signature.length; i += 1) {
		if (bytes[at + i] !== signature[i]) return false;
	}
	return true;
}

function ascii4(bytes: Uint8Array, at: number): string {
	let out = '';
	for (let i = 0; i < 4; i += 1) out += String.fromCharCode(bytes[at + i] as number);
	return out;
}

/**
 * A type as it can safely appear in a message.
 *
 * The four bytes came out of the file and are not guaranteed to be text: a
 * handful of suites on a stock install carry entries whose type is binary
 * rubbish. Anything outside printable ASCII becomes a full stop rather than
 * reaching a screen, a log or a bug report as a control character.
 */
function label(type: string): string {
	let out = '';
	for (let i = 0; i < type.length; i += 1) {
		const code = type.charCodeAt(i);
		out += code >= 0x20 && code <= 0x7e ? (type[i] as string) : '.';
	}
	return out;
}

/** The distinct types of the entries matching `wanted`, in file order. */
function typesOf(entries: readonly IcnsEntry[], wanted?: IcnsEntryKind): string[] {
	const seen: string[] = [];
	for (const entry of entries) {
		if (wanted !== undefined && entry.kind !== wanted) continue;
		const name = label(entry.type);
		if (!seen.includes(name)) seen.push(name);
	}
	return seen;
}

/**
 * The width and height a PNG payload declares, without decoding it.
 *
 * `IHDR` is required to be the first chunk and to be thirteen bytes long, so
 * the two numbers sit at fixed offsets 16 and 20. Reading them here is what
 * lets an entry be measured and bounded before anything is allocated, and it
 * also settles the size of a PNG sitting in an entry type this reader has
 * never heard of.
 *
 * The chunk header is checked rather than assumed. These numbers order the
 * entries against each other, so a payload with the right signature and rubbish
 * behind it would otherwise claim whatever size the rubbish spells and push a
 * whole picture down the list on the strength of it.
 */
function pngSize(payload: Uint8Array): { width: number; height: number } | undefined {
	if (payload.length < 24 || !matches(payload, 8, IHDR_HEADER)) return undefined;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function classify(type: string, payload: Uint8Array): IcnsEntryKind {
	if (MASK_TYPES[type] !== undefined) return 'mask';
	if (INDEXED_TYPES.has(type)) return 'indexed';
	if (METADATA_TYPES.has(type)) return 'metadata';
	if (matches(payload, 0, PNG_SIGNATURE)) return 'png';
	if (matches(payload, 0, JP2_SIGNATURE) || matches(payload, 0, J2K_SIGNATURE)) return 'jpeg2000';
	if (matches(payload, 0, ARGB_MARKER)) return 'argb';
	const known = ICON_TYPES[type];
	if (known === undefined || known.raw === 'none') return 'unknown';
	return known.raw;
}

/**
 * Parse the container and return every entry, in file order.
 *
 * Nothing here decompresses anything. The payloads are views into the input,
 * which is what the offline application wants when it lists the contents of a
 * suite, and what the decoder below wants when it picks one of them.
 */
export function readIcnsDirectory(bytes: Uint8Array): IcnsDirectory {
	if (bytes.length < HEADER_BYTES) {
		fail('it ends before its eight byte header.');
	}
	if (ascii4(bytes, 0) !== 'icns') {
		fail('it does not start with the four byte "icns" signature every icon suite begins with.');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const declared = view.getUint32(4);
	if (declared < HEADER_BYTES) {
		fail(
			`its header declares a total length of ${declared} bytes, which is shorter than the header itself.`,
		);
	}
	if (declared > bytes.length) {
		fail(
			`its header declares ${declared} bytes and the file holds ${bytes.length}, so it is truncated.`,
		);
	}

	// The declared total is the authority on where the entry list stops, not
	// the buffer. One suite in three thousand on a stock macOS install has
	// bytes after it, and reading those as another entry would invent one.
	const end = declared;
	const entries: IcnsEntry[] = [];
	let at = HEADER_BYTES;

	while (at + ENTRY_HEADER_BYTES <= end) {
		const type = ascii4(bytes, at);
		const length = view.getUint32(at + 4);
		// The length counts its own header, so anything under eight would
		// advance the cursor by nothing or send it backwards, and the walk
		// would sit on the same entry until the tab ran out of memory.
		if (length < ENTRY_HEADER_BYTES) {
			fail(
				`its "${label(type)}" entry declares a length of ${length} bytes, and an entry cannot be shorter than the eight byte header it starts with.`,
			);
		}
		if (at + length > end) {
			fail(`its "${label(type)}" entry runs past the end of the file.`);
		}

		const payload = bytes.subarray(at + ENTRY_HEADER_BYTES, at + length);
		const kind = classify(type, payload);
		const known = ICON_TYPES[type];
		// A PNG carries its own dimensions, and they win: the payload is what
		// will actually be decoded, and it is the only way to size an entry
		// whose type is newer than this reader.
		const declaredSize = kind === 'png' ? pngSize(payload) : undefined;
		const side = known?.side ?? MASK_TYPES[type] ?? 0;
		entries.push({
			type,
			width: declaredSize?.width ?? side,
			height: declaredSize?.height ?? side,
			retina: known?.retina ?? false,
			kind,
			payload,
		});
		at += length;
	}

	if (at !== end) {
		fail(`it ends with ${end - at} bytes left over, which is too few to be another entry.`);
	}
	if (entries.length === 0) {
		fail('it holds no entries at all.');
	}
	return { declaredBytes: declared, entries };
}

/* ── Payloads ─────────────────────────────────────────────────────────── */

/**
 * Apple's variant of PackBits, which is not the one TIFF uses.
 *
 * A control byte under 128 introduces that many plus one literal bytes, so a
 * literal run is 1 to 128 long. A control byte of 128 or over repeats the
 * single byte after it that many minus 125 times, so a repeat is 3 to 130.
 * TIFF reads the control byte as a signed number and counts a repeat from 2,
 * and a reader that used TIFF's rule here would produce a picture that is
 * almost right, which is the worst kind of wrong.
 */
function unpackBits(
	bytes: Uint8Array,
	from: number,
	end: number,
	expected: number,
	what: string,
): Uint8Array {
	const out = new Uint8Array(expected);
	let at = from;
	let filled = 0;

	while (filled < expected) {
		if (at >= end) {
			fail(`${what} ends after ${filled} of the ${expected} bytes it should hold.`);
		}
		const control = bytes[at] as number;
		at += 1;

		if (control < 128) {
			const count = control + 1;
			if (at + count > end) {
				fail(`a literal run in ${what} runs past the end of the entry.`);
			}
			// A run that overshoots the end of the last plane is truncated
			// rather than refused. Those bytes describe pixels that do not
			// exist, and throwing the whole picture away over the tail of its
			// final run helps nobody.
			const take = Math.min(count, expected - filled);
			out.set(bytes.subarray(at, at + take), filled);
			at += count;
			filled += take;
			continue;
		}

		const count = control - 125;
		if (at >= end) {
			fail(`a repeat in ${what} has no byte after it to repeat.`);
		}
		const value = bytes[at] as number;
		at += 1;
		const take = Math.min(count, expected - filled);
		out.fill(value, filled, filled + take);
		filled += take;
	}
	return out;
}

/** Alpha for a run length entry, from the mask entry of the same size. */
function maskFor(entries: readonly IcnsEntry[], side: number): Uint8Array | undefined {
	for (const entry of entries) {
		// Matched by the size the mask type stands for, never by position. The
		// order inside a suite is whatever the tool that wrote it felt like, and
		// a mask that happens to sit before its picture is still its mask.
		if (entry.kind !== 'mask' || entry.width !== side) continue;
		const needed = side * side;
		if (entry.payload.length < needed) {
			fail(
				`its "${label(entry.type)}" mask holds ${entry.payload.length} bytes, and a ${side} by ${side} mask needs ${needed}.`,
			);
		}
		return entry.payload;
	}
	// A suite with a colour entry and no mask beside it is uncommon but real,
	// and it means the picture is opaque rather than that the file is broken.
	return undefined;
}

/**
 * One of the classic 24 bit entries: red, then green, then blue, as planes.
 *
 * A coded `it32` opens with four bytes that are always zero, which is a header
 * field that was never given a meaning. Skipping them is not optional: leaving
 * them in front of the stream makes the first control byte a literal run of one
 * and shifts every plane by a pixel. The uncompressed spelling of the same
 * entry has no such field, which is why the length decides before the skip.
 */
function decodeRle24(entry: IcnsEntry, entries: readonly IcnsEntry[]): RasterImage {
	const { width, height, payload } = entry;
	const pixels = width * height;

	// The four zero bytes belong to the run length form of `it32` and to
	// nothing else, so the uncompressed length has to be ruled out before they
	// are skipped. Subtracting them first turns the 65536 bytes of a raw entry
	// into 65532, which misses the test below and hands a picture that was
	// never coded to the unpacker, and the unpacker does not fail: it produces
	// noise. Five suites inside Microsoft Office are written that way, with
	// four bytes a pixel and nothing at all in front of them.
	//
	// Telling the two apart by length is safe because the coded form cannot
	// reach four bytes a pixel. Three planes of a 128 square are 49152 bytes,
	// which costs 49536 when every run is spelled as a literal, and 49540 with
	// the padding, so it can never be mistaken for 65536.
	const from = entry.type === 'it32' && payload.length !== pixels * 4 ? 4 : 0;
	if (payload.length < from) {
		fail(
			`its "${label(entry.type)}" entry is too short to hold the four padding bytes it starts with.`,
		);
	}

	const image = createRaster(width, height, 'srgb', false);
	const target = image.data;

	if (payload.length - from === pixels * 4) {
		// Not run length coded at all. A few writers, Microsoft Office among
		// them, store these entries as uncompressed interleaved ARGB, and the
		// only signal is the length landing exactly on four bytes a pixel.
		//
		// Four, never three. An `is32` compressed down to exactly 768 bytes
		// occurs on a stock install, so treating a length of three bytes a
		// pixel as uncompressed would misread a perfectly ordinary file.
		for (let i = 0; i < pixels; i += 1) {
			const at = from + i * 4;
			// The alpha byte of this form is zero throughout and the mask is
			// what carries transparency, so it is read past rather than used.
			target[i * 4] = payload[at + 1] as number;
			target[i * 4 + 1] = payload[at + 2] as number;
			target[i * 4 + 2] = payload[at + 3] as number;
			target[i * 4 + 3] = 255;
		}
	} else {
		const planes = unpackBits(
			payload,
			from,
			payload.length,
			pixels * 3,
			`the colour runs of its "${label(entry.type)}" entry`,
		);
		for (let i = 0; i < pixels; i += 1) {
			target[i * 4] = planes[i] as number;
			target[i * 4 + 1] = planes[pixels + i] as number;
			target[i * 4 + 2] = planes[pixels * 2 + i] as number;
			target[i * 4 + 3] = 255;
		}
	}

	const mask = maskFor(entries, width);
	if (mask) {
		for (let i = 0; i < pixels; i += 1) target[i * 4 + 3] = mask[i] as number;
	}
	return { ...image, hasAlpha: detectAlpha(image) };
}

/**
 * A raw ARGB entry: alpha, then red, then green, then blue, as planes.
 *
 * The four byte `ARGB` marker is skipped where it is present, which is every
 * file Apple's own tools write. An `ic04` or `ic05` without it is still this
 * form, so the marker is treated as optional rather than as the thing that
 * identifies the entry.
 */
function decodeArgb(entry: IcnsEntry): RasterImage {
	const { width, height, payload } = entry;
	const from = matches(payload, 0, ARGB_MARKER) ? ARGB_MARKER.length : 0;
	const pixels = width * height;
	const planes = unpackBits(
		payload,
		from,
		payload.length,
		pixels * 4,
		`the ARGB runs of its "${label(entry.type)}" entry`,
	);

	const image = createRaster(width, height, 'srgb', true);
	const target = image.data;
	for (let i = 0; i < pixels; i += 1) {
		target[i * 4] = planes[pixels + i] as number;
		target[i * 4 + 1] = planes[pixels * 2 + i] as number;
		target[i * 4 + 2] = planes[pixels * 3 + i] as number;
		target[i * 4 + 3] = planes[i] as number;
	}
	return { ...image, hasAlpha: detectAlpha(image) };
}

async function decodePngEntry(entry: IcnsEntry): Promise<RasterImage> {
	if (entry.width > MAX_PNG_SIDE || entry.height > MAX_PNG_SIDE) {
		fail(
			`its "${label(entry.type)}" entry holds a PNG claiming to be ${entry.width} by ${entry.height} pixels, which is far larger than any icon.`,
		);
	}
	try {
		return await decodePng(entry.payload);
	} catch (error) {
		// Rewritten rather than passed through, so the sentence says which file
		// the reader was actually given. The PNG decoder's own message is kept
		// on the cause for anybody looking at the error rather than at a screen.
		fail(`the PNG inside its "${label(entry.type)}" entry could not be read.`, { cause: error });
	}
}

/* ── Choosing ─────────────────────────────────────────────────────────── */

function decodable(entry: IcnsEntry): boolean {
	if (entry.kind !== 'png' && entry.kind !== 'argb' && entry.kind !== 'rle24') return false;
	return entry.width >= 1 && entry.height >= 1;
}

/**
 * The entries this reader can unpack, best first.
 *
 * Largest rather than first, because the order inside a suite is whatever the
 * tool that wrote it felt like: `iconutil` emits 256, then 32, then 32 again,
 * then 16, then 128. Where two entries hold the same number of pixels the
 * unscaled spelling wins, because `icp5` is a 32 point icon and `ic11` is a 16
 * point icon drawn at twice the scale, and the first is the one somebody
 * converting the file meant. Anything still tied keeps its place in the file,
 * which the sort below is required to preserve.
 *
 * A whole order rather than a single winner, because a suite is a stack of
 * pictures of the same thing and the largest one being unreadable is not a
 * reason to refuse the others.
 */
function rankEntries(entries: readonly IcnsEntry[]): IcnsEntry[] {
	return entries.filter(decodable).sort((a, b) => {
		const area = b.width * b.height - a.width * a.height;
		return area !== 0 ? area : Number(a.retina) - Number(b.retina);
	});
}

/**
 * Say what the file holds instead of a picture this reader can unpack.
 *
 * Ordered by how much it explains. A file whose icons are all JPEG 2000 is a
 * Leopard-era suite and the sentence should say so; one holding only the
 * classic palettised entries is older still. Anything else falls through to
 * the list, which at least names what was in there.
 */
function refuseWholeFile(entries: readonly IcnsEntry[]): never {
	const jpeg2000 = typesOf(entries, 'jpeg2000');
	if (jpeg2000.length > 0) {
		fail(
			`its icons are stored as JPEG 2000 (${jpeg2000.join(', ')}), which this reader does not decode.`,
		);
	}
	const indexed = typesOf(entries, 'indexed');
	if (indexed.length > 0) {
		fail(
			`it holds only the classic indexed icons (${indexed.join(', ')}), which are drawn through the Macintosh system colour palettes and this reader does not implement them.`,
		);
	}
	fail(
		`it holds no picture this reader can unpack: its entries are ${typesOf(entries).join(', ')}.`,
	);
}

/**
 * Unpack one entry, whichever of the three forms it turned out to be.
 *
 * Asynchronous for all three, so that every way of failing arrives as a
 * rejection and the caller below needs one shape of `catch` rather than two.
 */
async function decodeEntry(entry: IcnsEntry, entries: readonly IcnsEntry[]): Promise<RasterImage> {
	if (entry.kind === 'png') return decodePngEntry(entry);
	if (entry.kind === 'argb') return decodeArgb(entry);
	return decodeRle24(entry, entries);
}

/**
 * Read an Apple icon suite and return its largest usable picture.
 *
 * A suite holds the same drawing several times over, so an entry that will not
 * unpack costs the file its best size and nothing more: the next one down is
 * tried, and only a file where every entry fails is refused. That already
 * happened for a JPEG 2000 entry, which is skipped before anything is
 * attempted, and a damaged PNG beside a sound one deserves the same treatment.
 * The refusal that comes back is the largest entry's, because that is the
 * picture the caller asked for and the one worth explaining.
 *
 * Asynchronous because most of a modern suite is PNG, and inflating one goes
 * through `DecompressionStream`. A file holding only the older forms still
 * returns a promise, so that a caller never has to ask which kind it handed in.
 */
export async function decodeIcns(bytes: Uint8Array): Promise<RasterImage> {
	const directory = readIcnsDirectory(bytes);
	const [best, ...rest] = rankEntries(directory.entries);
	if (best === undefined) refuseWholeFile(directory.entries);

	try {
		return await decodeEntry(best, directory.entries);
	} catch (refusal) {
		for (const entry of rest) {
			try {
				return await decodeEntry(entry, directory.entries);
			} catch {
				// Keep going, and keep the first refusal to report.
			}
		}
		throw refusal;
	}
}
