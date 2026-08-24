/**
 * GIF's variable width LZW, in both directions.
 *
 * The compressor is the one part of GIF that cannot be read straight off the
 * specification, because the two halves keep their tables one entry apart and
 * the code width changes as a consequence rather than on a schedule. A decoder
 * learns an entry only when it reads the code *after* the one that created it,
 * so at every moment it has created exactly one fewer entry than the encoder
 * has. Both then widen their codes when the table reaches a power of two, and
 * because they are counting different numbers the two tests are written
 * differently on purpose: the encoder widens at `next > 2 ** codeSize` and the
 * decoder at `next === 2 ** codeSize`. Making them look the same, which is the
 * obvious tidy-up, puts the width change one code apart and the file decodes
 * into noise from that byte on with nothing to say why.
 *
 * Bits fill from the low end of each byte, which is the opposite of TIFF and
 * PCX, so this uses the LSB readers and writers rather than the MSB ones.
 */

import { LsbBitReader, LsbBitWriter } from '../../bits.js';
import { DecodeFailedError } from '../../errors.js';

/**
 * The id every refusal from this reader carries.
 *
 * It lives in this file rather than in `decode.ts` because this one is the
 * leaf: the reader imports the codec, nothing here imports the reader, and
 * putting the string the other way round would make the pair circular.
 */
export const DECODER_ID = 'gif-pure';

/** A code is twelve bits at most, so the table stops at 4096 entries. */
const MAX_CODE = 4096;
const MAX_CODE_SIZE = 12;

function fail(detail: string): never {
	throw new DecodeFailedError('gif', DECODER_ID, detail);
}

/**
 * Expand one frame's compressed pixel data into `expected` palette indices.
 *
 * `data` is the sub-block chain already joined into one buffer. The chain
 * boundaries carry no meaning for the bit stream: a code routinely straddles
 * two sub-blocks, so joining first is not an optimisation but the only way to
 * read it at all.
 */
export function lzwDecode(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
	// Eight is the ceiling because an index is a byte. The floor is one rather
	// than the two the specification names: a file written at one is not
	// ambiguous about its own bits, its clear code is 2 and its end code is 3,
	// and Chrome renders such a file, so refusing it would refuse a picture the
	// person can already see in their own browser. Pillow reads the same file as
	// something else, so this is not the only reading, only the one the
	// specification's own code widths give and the one that is on screen.
	if (minCodeSize < 1 || minCodeSize > 8) {
		fail(
			`a frame declares an LZW minimum code size of ${minCodeSize}, and a code is between 1 and 8 bits.`,
		);
	}

	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;

	// The table as three parallel arrays rather than an array of strings. Every
	// entry is some earlier entry plus one byte, so a chain of prefixes is the
	// whole of it, and `first` saves walking that chain again for the one byte
	// the next entry needs.
	const prefix = new Int32Array(MAX_CODE);
	const suffix = new Uint8Array(MAX_CODE);
	const first = new Uint8Array(MAX_CODE);
	for (let i = 0; i < clearCode; i += 1) {
		suffix[i] = i;
		first[i] = i;
	}
	// An entry is at most as long as the table is large, because each one is
	// exactly one byte longer than the entry it was built from.
	const stack = new Uint8Array(MAX_CODE);

	const out = new Uint8Array(expected);
	const reader = new LsbBitReader(data);
	const totalBits = data.length * 8;
	let codeSize = minCodeSize + 1;
	let next = clearCode + 2;
	let previous = -1;
	let at = 0;

	while (at < expected) {
		// Asked of the reader rather than left to it. Reading past the end
		// returns zero bits, which is a perfectly plausible code, so a truncated
		// file would decode a few hundred more pixels of whatever colour index
		// zero happens to be instead of saying it was truncated.
		if (reader.position + codeSize > totalBits) {
			fail('the compressed pixel data of a frame ends before the whole frame has been read.');
		}
		const code = reader.read(codeSize);

		if (code === clearCode) {
			codeSize = minCodeSize + 1;
			next = clearCode + 2;
			previous = -1;
			continue;
		}
		if (code === endCode) {
			fail('a frame ends before it has given a colour to every one of its own pixels.');
		}

		if (previous === -1) {
			// The first code after a clear has nothing to build an entry from, so
			// it can only be a literal.
			if (code >= clearCode) {
				fail('the first LZW code of a frame is not one of its own colours.');
			}
			out[at] = code;
			at += 1;
			previous = code;
			// The width test below runs only where an entry is defined, and no
			// entry is defined by the first code after a clear. That matters at
			// a minimum code size of one and nowhere else: two colours, a clear
			// and an end use up everything a two bit code can say before the
			// table has grown at all, so the code after this one is already
			// three bits wide. Every larger size leaves room, and this widens
			// nothing there.
			if (next === 1 << codeSize && codeSize < MAX_CODE_SIZE) codeSize += 1;
			continue;
		}

		if (code > next) {
			fail('a frame uses an LZW code that its own table has not defined yet.');
		}

		let top = 0;
		let current = code;
		if (code === next) {
			// The case every LZW implementation is judged on: a code for the
			// entry that this very code is about to create. It can only mean the
			// previous entry followed by its own first byte, and a decoder that
			// treats it as an error rejects perfectly ordinary files, because
			// any run of three identical pixels produces it.
			stack[top] = first[previous] as number;
			top += 1;
			current = previous;
		}
		// Prefixes strictly decrease, so this always terminates.
		while (current >= clearCode) {
			stack[top] = suffix[current] as number;
			top += 1;
			current = prefix[current] as number;
		}
		stack[top] = current;
		top += 1;

		const firstByte = stack[top - 1] as number;
		while (top > 0 && at < expected) {
			top -= 1;
			out[at] = stack[top] as number;
			at += 1;
		}
		// Anything still on the stack is a frame whose last code carries more
		// pixels than the frame has room for. Writers pad like this and browsers
		// drop the overflow, so dropping it is what a person expects to see.

		if (next < MAX_CODE) {
			prefix[next] = previous;
			suffix[next] = firstByte;
			first[next] = first[previous] as number;
			next += 1;
			if (next === 1 << codeSize && codeSize < MAX_CODE_SIZE) codeSize += 1;
		}
		// Past 4096 the table simply stops growing. Most writers send a clear
		// code at that point and start again, but some never do and keep coding
		// against the full table to the end of the frame, which is legal and
		// which a decoder that insisted on the clear would read as corruption.

		previous = code;
	}

	return out;
}

/* ── Compression ──────────────────────────────────────────────────────── */

/**
 * Slots in the encoder's phrase table.
 *
 * Eight thousand for at most 4094 entries, so the table never passes half
 * full. Linear probing degrades sharply past about two thirds, and 32 kilobytes
 * is nothing next to the image being compressed.
 */
const HASH_BITS = 13;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function slotOf(keys: Int32Array, key: number): number {
	// Knuth's multiplicative hash, as in the quantiser. A key is a code in the
	// high bits and a colour index in the low ones, so hashing on the raw value
	// would put every phrase ending in the same colour into one run of slots,
	// which is exactly the distribution a flat area of an image produces.
	let at = Math.imul(key, 2654435761) >>> (32 - HASH_BITS);
	while (keys[at] !== -1 && keys[at] !== key) at = (at + 1) & HASH_MASK;
	return at;
}

/**
 * Compress one frame's palette indices.
 *
 * The result is the raw code stream. Splitting it into sub-blocks is the
 * container's job, not the compressor's, and keeping them apart is what lets
 * the round trip tests feed this straight back into `lzwDecode`.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const writer = new LsbBitWriter();
	let codeSize = minCodeSize + 1;
	let next = clearCode + 2;

	// A decoder resets its table on this, so a stream that opens without one
	// would be read against whatever the previous frame left behind.
	writer.write(clearCode, codeSize);

	if (indices.length === 0) {
		writer.write(endCode, codeSize);
		return writer.finish();
	}

	const keys = new Int32Array(HASH_SIZE).fill(-1);
	const values = new Int32Array(HASH_SIZE);
	let prefix = indices[0] as number;

	for (let i = 1; i < indices.length; i += 1) {
		const value = indices[i] as number;
		const key = (prefix << 8) | value;
		const slot = slotOf(keys, key);
		if (keys[slot] === key) {
			prefix = values[slot] as number;
			continue;
		}

		writer.write(prefix, codeSize);
		if (next < MAX_CODE) {
			keys[slot] = key;
			values[slot] = next;
			next += 1;
			// See the note at the top of this file: the decoder is one entry
			// behind, so its test is `===` where this one is `>`. No ceiling is
			// tested for either, unlike the decoder's: the branch above holds
			// `next` at 4096 and two to the twelfth is 4096, so the width stops
			// at twelve on its own.
			if (next > 1 << codeSize) codeSize += 1;
		} else {
			// The table is full at 4096 and a twelve bit code is as wide as GIF
			// goes, so the only way to keep describing new phrases is to throw
			// the table away and start again.
			writer.write(clearCode, codeSize);
			keys.fill(-1);
			codeSize = minCodeSize + 1;
			next = clearCode + 2;
		}
		prefix = value;
	}

	writer.write(prefix, codeSize);
	writer.write(endCode, codeSize);
	return writer.finish();
}
