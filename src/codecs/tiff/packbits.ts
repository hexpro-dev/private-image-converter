/**
 * PackBits, the run length encoding TIFF inherited from the Macintosh.
 *
 * One control byte, read as a signed value: zero or above copies that many
 * plus one literal bytes, below zero repeats the next byte one minus it times,
 * and exactly -128 means nothing at all. That last case is the one people
 * leave out, and leaving it out shifts everything after it by one byte, which
 * looks like a corrupt image rather than a decoder bug.
 *
 * Each strip is compressed on its own, so a strip is decoded to exactly the
 * bytes its rows need and nothing carries over from the strip before it.
 */

import { DecodeFailedError } from '../../errors.js';

// Repeated rather than shared with the other compression modules on purpose.
// Each of them is a self-contained reader for a published scheme, and a shared
// helper module would be one more thing to move if any of them is ever lifted
// out on its own.
const DECODER_ID = 'tiff-pure';

function fail(detail: string): never {
	throw new DecodeFailedError('tiff', DECODER_ID, detail);
}

/**
 * Expand one PackBits compressed strip to `expected` bytes.
 *
 * Output past `expected` is discarded rather than refused. A writer that pads
 * the last row of a strip out to a whole run is producing a file every other
 * reader accepts, and the extra bytes are padding by construction: the caller
 * asked for exactly the number of bytes its rows occupy.
 */
export function unpackBits(source: Uint8Array, expected: number): Uint8Array {
	const out = new Uint8Array(expected);
	let at = 0;
	let to = 0;

	while (to < expected) {
		if (at >= source.length) {
			fail('a PackBits compressed strip ends before its rows are complete.');
		}
		const control = source[at] as number;
		at += 1;

		// 128 is a no-op. It is the only value with no length attached, and it
		// exists so that a writer can keep a strip word aligned.
		if (control === 128) continue;

		if (control < 128) {
			const count = control + 1;
			if (at + count > source.length) {
				fail('a PackBits literal run reaches past the end of its own strip.');
			}
			const room = Math.min(count, expected - to);
			out.set(source.subarray(at, at + room), to);
			at += count;
			to += room;
			continue;
		}

		// Two's complement over a byte: 255 means -1, which repeats twice.
		const count = 257 - control;
		if (at >= source.length) {
			fail('a PackBits repeat run has no byte to repeat.');
		}
		const value = source[at] as number;
		at += 1;
		const room = Math.min(count, expected - to);
		out.fill(value, to, to + room);
		to += room;
	}

	return out;
}
