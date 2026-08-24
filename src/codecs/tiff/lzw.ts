/**
 * TIFF's LZW, which is not quite anybody else's LZW.
 *
 * Two things separate it from the variant in a GIF, and both are silent when
 * they are got wrong. Codes are packed most significant bit first rather than
 * least. And the code width grows one code early: the switch from nine bits to
 * ten happens once the next free entry is 511, not 512, and again at 1023 and
 * 2047 rather than 1024 and 2048. Section 13 of the TIFF 6.0 specification is
 * written the other way round, which is where the bug comes from; the note in
 * the 1995 technical notes and every real file agree with libtiff.
 *
 * Decoding with the wrong timing does not throw at the first wrong bit. It
 * produces a plausible looking image with a diagonal tear in it, which is why
 * this is the single most common defect in a hand written TIFF reader.
 */

import { MsbBitReader } from '../../bits.js';
import { DecodeFailedError } from '../../errors.js';

const DECODER_ID = 'tiff-pure';

/** Reset the table and go back to nine bit codes. */
const CLEAR_CODE = 256;
const END_CODE = 257;
/** The first code a decoder assigns itself. 0 to 255 are the literals. */
const FIRST_CODE = 258;
/** Twelve bits, so the table cannot grow past this. */
const MAX_ENTRIES = 4096;

function fail(detail: string): never {
	throw new DecodeFailedError('tiff', DECODER_ID, detail);
}

/**
 * Expand one strip, with the code width growing either early or late.
 *
 * The table is a prefix chain rather than a list of byte strings: entry `n`
 * holds one byte and the code of everything before it, so adding an entry is
 * two stores instead of a copy of a string that can be thousands of bytes
 * long. The chain is walked backwards into `stack`, which is why the output is
 * written in reverse and then read out forwards.
 */
function expand(source: Uint8Array, expected: number, earlyChange: boolean): Uint8Array {
	const out = new Uint8Array(expected);
	const prefix = new Int32Array(MAX_ENTRIES);
	const suffix = new Uint8Array(MAX_ENTRIES);
	// Every entry is one byte longer than the entry it points at, and it always
	// points at a lower numbered one, so a chain cannot be longer than the
	// table and cannot loop.
	const stack = new Uint8Array(MAX_ENTRIES);
	for (let i = 0; i < 256; i += 1) {
		prefix[i] = -1;
		suffix[i] = i;
	}

	const reader = new MsbBitReader(source);
	let next = FIRST_CODE;
	let width = 9;
	let previous = -1;
	let at = 0;

	while (at < expected) {
		if (reader.exhausted) {
			fail('an LZW compressed strip ends before its rows are complete.');
		}
		const code = reader.read(width);
		if (code === END_CODE) break;
		if (code === CLEAR_CODE) {
			next = FIRST_CODE;
			width = 9;
			previous = -1;
			continue;
		}

		// The one case where a code refers to an entry that does not exist yet:
		// the encoder emitted it in the same step that it defined it, which it
		// may do when a string is immediately followed by itself. The entry is
		// always the previous string plus its own first byte.
		const deferred = code === next && previous >= 0;
		if (code > next || (code === next && previous < 0)) {
			fail('an LZW code refers to a table entry that has not been defined.');
		}

		let depth = 0;
		let walk = deferred ? previous : code;
		while (walk >= 0) {
			stack[depth] = suffix[walk] as number;
			depth += 1;
			walk = prefix[walk] as number;
		}
		// `stack` holds the string backwards, so its last element is the byte
		// the deferred case needs to append.
		const first = stack[depth - 1] as number;
		if (deferred) {
			// The string is held backwards, so appending a byte to the end of it
			// means inserting at the bottom. Shifted from the top down, or the
			// first store would overwrite the byte the second one reads.
			for (let i = depth; i > 0; i -= 1) stack[i] = stack[i - 1] as number;
			stack[0] = first;
			depth += 1;
		}

		// A strip that expands past the space its rows need is trailing padding
		// from the writer, not an error. Only the shortfall matters, and that is
		// caught below.
		const room = Math.min(depth, expected - at);
		for (let i = 0; i < room; i += 1) out[at + i] = stack[depth - 1 - i] as number;
		at += room;

		if (previous >= 0 && next < MAX_ENTRIES) {
			prefix[next] = previous;
			suffix[next] = first;
			next += 1;
			// The early change. With it, nine bit codes stop being written once
			// 511 is the next free entry, which is one code before the width
			// could no longer hold it.
			if (next + (earlyChange ? 1 : 0) >= 1 << width && width < 12) width += 1;
		}
		previous = code;
	}

	if (at < expected) {
		fail('an LZW compressed strip ends before its rows are complete.');
	}
	return out;
}

/**
 * Expand one LZW compressed strip to exactly `expected` bytes.
 *
 * The early change is tried first because it is what the format means. The
 * late change is tried only after the first reading has already failed, which
 * is the difference between tolerating the handful of writers that copied
 * GIF's timing and guessing at which of the two a file meant. A file that
 * decodes under the correct rule is never re-read under the wrong one.
 */
export function decodeLzw(source: Uint8Array, expected: number): Uint8Array {
	try {
		return expand(source, expected, true);
	} catch (error) {
		try {
			return expand(source, expected, false);
		} catch {
			// The first failure is the one worth reporting: the second reading
			// was a long shot and its complaint would send somebody looking at
			// the wrong half of the file.
			throw error;
		}
	}
}
