/**
 * CCITT Group 3 and Group 4, the compression a fax machine and a document
 * scanner still use.
 *
 * All three of TIFF's bilevel schemes are the same coder with different
 * framing. A row is a list of alternating white and black run lengths, each
 * run written as a Huffman code from a fixed table published in ITU-T T.4.
 * Group 3 adds a two dimensional mode where a row is coded as the differences
 * from the row above it, and Group 4 (T.6) drops the one dimensional rows and
 * the end of line codes and keeps only that.
 *
 * The tables below are the specification as data. They are worth reading as
 * such: a run of zero white pixels has a code and a run of 2560 has a code,
 * runs above 63 are a make-up code plus a terminating code, and the make-ups
 * above 1728 are shared between the two colours. None of that is derivable, so
 * none of it is derived here.
 *
 * The output is one bit per pixel, most significant bit first, and a set bit
 * is what the coder called black. Nothing here knows what that looks like: the
 * photometric tag decides, and the two agree only under WhiteIsZero, which is
 * what a fax carries. A file that codes runs of white and then tags itself
 * BlackIsZero renders inverted from the coder's sense, which is what it asked
 * for and what every other reader does with it.
 */

import { MsbBitReader } from '../../bits.js';
import { DecodeFailedError } from '../../errors.js';

const DECODER_ID = 'tiff-pure';

function fail(detail: string): never {
	throw new DecodeFailedError('tiff', DECODER_ID, detail);
}

/* ── The T.4 code tables ──────────────────────────────────────────────── */

/** White runs of 0 to 63, indexed by run length. */
// prettier-ignore
const WHITE_TERMINATING = [
	'00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
	'10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
	'101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
	'0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
	'00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
	'00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
	'00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
	'01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];

/** White make-up codes for 64 to 1728, indexed so that entry `i` is 64 times `i` plus 64. */
// prettier-ignore
const WHITE_MAKEUP = [
	'11011', '10010', '010111', '0110111', '00110110', '00110111',
	'01100100', '01100101', '01101000', '01100111', '011001100', '011001101',
	'011010010', '011010011', '011010100', '011010101', '011010110', '011010111',
	'011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
	'010011010', '011000', '010011011',
];

/** Black runs of 0 to 63, indexed by run length. */
// prettier-ignore
const BLACK_TERMINATING = [
	'0000110111', '010', '11', '10', '011', '0011',
	'0010', '00011', '000101', '000100', '0000100', '0000101',
	'0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000',
	'0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
	'00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101',
	'000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011',
	'000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101',
	'000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
	'000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111',
	'000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011',
	'000000101100', '000001011010', '000001100110', '000001100111',
];

/** Black make-up codes for 64 to 1728. */
// prettier-ignore
const BLACK_MAKEUP = [
	'0000001111', '000011001000', '000011001001', '000001011011', '000000110011',
	'000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010',
	'0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011',
	'0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010',
	'0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011',
	'0000001100100', '0000001100101',
];

/**
 * Make-up codes for 1792 to 2560, which mean the same run whichever colour is
 * being coded. A run longer than 2560 is written as several of these.
 */
// prettier-ignore
const EXTENDED_MAKEUP = [
	'00000001000', '00000001100', '00000001101', '000000010010', '000000010011',
	'000000010100', '000000010101', '000000010110', '000000010111', '000000011100',
	'000000011101', '000000011110', '000000011111',
];

/**
 * A code table keyed by length and bits together.
 *
 * The codes are a prefix free set of between two and thirteen bits, so a
 * decoder reads one bit at a time and asks after each whether what it holds is
 * a code yet. Keying on the length as well as the value is what makes that
 * question answerable: `010` and `10` are different codes and the same number.
 */
function buildTable(
	terminating: readonly string[],
	makeup: readonly string[],
): ReadonlyMap<number, number> {
	const table = new Map<number, number>();
	const add = (bits: string, run: number): void => {
		table.set((bits.length << 16) | parseInt(bits, 2), run);
	};
	terminating.forEach((bits, run) => add(bits, run));
	makeup.forEach((bits, index) => add(bits, (index + 1) * 64));
	EXTENDED_MAKEUP.forEach((bits, index) => add(bits, 1792 + index * 64));
	return table;
}

const WHITE_TABLE = buildTable(WHITE_TERMINATING, WHITE_MAKEUP);
const BLACK_TABLE = buildTable(BLACK_TERMINATING, BLACK_MAKEUP);

/** The longest code in either table is thirteen bits, and an end of line is twelve. */
const LONGEST_CODE = 14;

/* ── Two dimensional mode codes ───────────────────────────────────────── */

/** Vertical modes are returned as their offset plus this, so V0 is 3. */
const VERTICAL_BASE = 3;
const MODE_PASS = 100;
const MODE_HORIZONTAL = 101;
/** Seven zero bits: an end of line, an end of block, or the end of the data. */
const MODE_END = 102;

/**
 * Read one mode code.
 *
 * Written as a walk down the prefix tree rather than as another table, because
 * the tree is four levels deep and the shape of it is the thing worth seeing:
 * a single 1 bit is "the transition is exactly where it was on the row above",
 * which is the code a page of text spends most of its time in.
 */
function readMode(reader: MsbBitReader): number {
	if (reader.readBit() === 1) return VERTICAL_BASE;
	if (reader.readBit() === 1) return VERTICAL_BASE + (reader.readBit() === 1 ? 1 : -1);
	if (reader.readBit() === 1) return MODE_HORIZONTAL;
	if (reader.readBit() === 1) return MODE_PASS;
	if (reader.readBit() === 1) return VERTICAL_BASE + (reader.readBit() === 1 ? 2 : -2);
	if (reader.readBit() === 1) return VERTICAL_BASE + (reader.readBit() === 1 ? 3 : -3);
	if (reader.readBit() === 1) {
		fail('it uses CCITT uncompressed mode, which this reader does not implement.');
	}
	return MODE_END;
}

/* ── Runs ─────────────────────────────────────────────────────────────── */

function readCode(reader: MsbBitReader, colour: number): number {
	const table = colour === 0 ? WHITE_TABLE : BLACK_TABLE;
	let code = 0;
	for (let length = 1; length <= LONGEST_CODE; length += 1) {
		code = (code << 1) | reader.readBit();
		const run = table.get((length << 16) | code);
		if (run !== undefined) return run;
	}
	// Fourteen bits were read, so a reader that had anything left has been
	// asked to interpret real data and could not. One that has not is simply
	// out of file, and saying so points at the right problem.
	if (reader.exhausted) fail('the compressed data ends before the last row is complete.');
	fail('the compressed data holds a run length code that is not in the CCITT tables.');
}

/**
 * Read one complete run.
 *
 * A run of 64 or more is a make-up code giving a multiple of 64 followed by a
 * terminating code giving the remainder, and a run past 2560 is several
 * make-ups in a row. Only a terminating code, which is the only kind below 64,
 * ends the run.
 */
function readRun(reader: MsbBitReader, colour: number): number {
	let total = 0;
	for (;;) {
		const value = readCode(reader, colour);
		total += value;
		if (value < 64) return total;
		if (total > 0xffff) {
			fail('the compressed data describes a run longer than any row could hold.');
		}
	}
}

/* ── Rows ─────────────────────────────────────────────────────────────── */

/**
 * Skip fill bits and end of line codes.
 *
 * No run length code and no mode code begins with as many as eleven zero bits,
 * so a window of twelve zeros can only be the front of an end of line or the
 * fill a writer inserted before one to land it on a byte boundary. That is
 * what makes this safe to run before every row rather than only where the
 * options tag says to expect it.
 */
function skipFillAndEndOfLine(reader: MsbBitReader): void {
	// Bounded rather than open ended: the tail of a strip is zero padding, and
	// without a limit this would walk it one bit at a time to no purpose.
	for (let guard = 0; guard < 4096 && !reader.exhausted; guard += 1) {
		const window = reader.peek(12);
		if (window === 1) {
			reader.skip(12);
			continue;
		}
		if (window !== 0) return;
		reader.skip(1);
	}
}

/**
 * Decode a one dimensional row into its changing element positions.
 *
 * A row is runs of white and black, starting with white, and a row whose first
 * pixel is black opens with a white run of zero. The positions recorded are
 * where the colour changes, which is also the form the two dimensional coder
 * needs for the row above it.
 */
function decodeRow1D(reader: MsbBitReader, columns: number, transitions: Int32Array): number {
	let at = 0;
	let colour = 0;
	let count = 0;

	while (at < columns) {
		// An end of line here means the row was cut short. Fax rows are cut
		// short by line noise rather than by a writer, and every reader pads
		// the rest of the row with white rather than losing the page.
		if (reader.peek(12) === 1) break;
		at = Math.min(at + readRun(reader, colour), columns);
		transitions[count] = at;
		count += 1;
		colour ^= 1;
		if (count + 2 > transitions.length) {
			fail('a row holds more runs than it has pixels.');
		}
	}
	return count;
}

/**
 * Decode a two dimensional row against the row above it.
 *
 * `b1` is the next changing element on the reference row that changes to the
 * opposite of the colour being coded, and `b2` is the one after it. Everything
 * turns on that definition: a vertical code says the transition is within three
 * pixels of `b1`, a pass code says this row runs straight through `b2` without
 * changing, and a horizontal code gives up and writes two run lengths.
 *
 * Returns -1 when the coder stopped, which in T.6 means the end of block.
 */
function decodeRow2D(
	reader: MsbBitReader,
	columns: number,
	reference: Int32Array,
	referenceCount: number,
	transitions: Int32Array,
): number {
	let a0 = -1;
	let colour = 0;
	let count = 0;
	// Where the search for b1 left off. The reference row's changing elements
	// only ever increase, and a0 walks the same way along it, so restarting the
	// search at zero for every mode code costs the whole row again each time:
	// one strip of a wide scan is then quadratic in its changing elements, and
	// a fax page 20000 pixels across takes minutes on the one thread a browser
	// gives this. A cursor that resumes makes it linear. libtiff carries the
	// same pointer for the same reason.
	let cursor = 0;

	// Unbounded on purpose, because the count of changing elements below is the
	// bound. Every code either moves a0 forward (pass, which lands on an
	// element strictly to the right of it) or records a changing element
	// (horizontal records two, vertical one), and a row cannot hold more
	// changing elements than it has pixels, so the loop cannot spin on a file
	// that is making no progress.
	for (;;) {
		if (a0 >= columns) return count;
		const mode = readMode(reader);
		if (mode === MODE_END) return -1;

		// The first element strictly to the right of a0, then a step to fix its
		// colour: elements alternate, so an even numbered one changes to black
		// and an odd numbered one to white.
		//
		// A vertical code can put a0 up to three pixels behind where it was, so
		// the cursor walks backwards as well. Forwards it covers the reference
		// row once over the whole row; backwards it only ever covers the
		// elements inside that three pixel window. The pair is a resume rather
		// than a search, which is the whole point of it.
		while (cursor > 0 && (reference[cursor - 1] as number) > a0) cursor -= 1;
		while (cursor < referenceCount && (reference[cursor] as number) <= a0) cursor += 1;
		let index = cursor;
		if ((index & 1) !== colour) index += 1;
		const b1 = index < referenceCount ? (reference[index] as number) : columns;
		const b2 = index + 1 < referenceCount ? (reference[index + 1] as number) : columns;

		if (count + 2 > transitions.length) {
			fail('a row holds more changing elements than it has pixels.');
		}

		if (mode === MODE_PASS) {
			// The colour runs through b2 without changing, so nothing is
			// recorded. This is the code that carries a row past a mark that has
			// ended on the row above.
			a0 = b2;
			continue;
		}

		if (mode === MODE_HORIZONTAL) {
			// a0 is -1 only before the first pixel, where the run is measured
			// from 0. Everywhere else it is measured from a0 itself.
			const from = a0 < 0 ? 0 : a0;
			const first = Math.min(from + readRun(reader, colour), columns);
			const second = Math.min(first + readRun(reader, colour ^ 1), columns);
			transitions[count] = first;
			transitions[count + 1] = second;
			count += 2;
			a0 = second;
			continue;
		}

		const a1 = Math.max(0, Math.min(b1 + (mode - VERTICAL_BASE), columns));
		if (count > 0 && a1 < (transitions[count - 1] as number)) {
			fail('a vertical code moves the coding position back up its own row.');
		}
		transitions[count] = a1;
		count += 1;
		a0 = a1;
		colour ^= 1;
	}
}

/** Set the bits of one row from `from` up to but not including `to`. */
function setRun(out: Uint8Array, rowAt: number, from: number, to: number): void {
	for (let x = from; x < to; x += 1) {
		out[rowAt + (x >> 3)] = (out[rowAt + (x >> 3)] as number) | (0x80 >> (x & 7));
	}
}

/** Paint one row from its changing elements. The buffer starts white. */
function paintRow(
	out: Uint8Array,
	rowAt: number,
	columns: number,
	transitions: Int32Array,
	count: number,
): void {
	let position = 0;
	let colour = 0;
	for (let i = 0; i < count && position < columns; i += 1) {
		const next = Math.min(transitions[i] as number, columns);
		if (colour === 1) setRun(out, rowAt, position, next);
		position = next;
		colour ^= 1;
	}
	if (colour === 1) setRun(out, rowAt, position, columns);
}

/* ── Entry point ──────────────────────────────────────────────────────── */

export type CcittKind = 'modified-huffman' | 'group-3' | 'group-4';

export interface CcittParams {
	readonly kind: CcittKind;
	readonly columns: number;
	readonly rows: number;
	/** T4Options for Group 3, T6Options for Group 4, zero for modified Huffman. */
	readonly options: number;
}

/**
 * Expand one CCITT compressed strip or tile.
 *
 * The three framings differ only here. Modified Huffman has no end of line
 * codes at all and restarts each row on a byte boundary. Group 3 separates
 * rows with an end of line and, when the options tag says so, follows each one
 * with a bit saying whether the row that follows is coded one or two
 * dimensionally. Group 4 has neither: every row is two dimensional and the
 * first one is coded against an imaginary white row above the page.
 */
export function decodeCcitt(source: Uint8Array, params: CcittParams): Uint8Array {
	const { kind, columns, rows, options } = params;
	const rowBytes = Math.ceil(columns / 8);
	const out = new Uint8Array(rowBytes * rows);
	const reader = new MsbBitReader(source);

	let reference = new Int32Array(columns + 8);
	let current = new Int32Array(columns + 8);
	let referenceCount = 0;

	const mixed = kind === 'group-3' && (options & 1) !== 0;

	for (let row = 0; row < rows; row += 1) {
		let twoDimensional = kind === 'group-4';
		if (kind !== 'group-4') {
			skipFillAndEndOfLine(reader);
			// The tag bit belongs to the end of line before the row, so it is
			// only present in a file that said it may use both codings.
			if (mixed) twoDimensional = reader.readBit() === 0;
		}
		if (reader.exhausted) {
			fail(`the compressed data ends after ${row} of ${rows} rows.`);
		}

		const count = twoDimensional
			? decodeRow2D(reader, columns, reference, referenceCount, current)
			: decodeRow1D(reader, columns, current);
		if (count < 0) {
			fail(`the compressed data ends after ${row} of ${rows} rows.`);
		}
		paintRow(out, row * rowBytes, columns, current, count);

		// This row becomes the reference for the next one, and the buffer it
		// displaces is reused, so no allocation happens per row.
		const spent = reference;
		reference = current;
		current = spent;
		referenceCount = count;

		// Modified Huffman is the one framing with no end of line codes, and it
		// pads each row out to a byte instead.
		if (kind === 'modified-huffman') reader.alignToByte();
	}

	return out;
}
