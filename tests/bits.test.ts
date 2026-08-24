/**
 * Bit reader and writer tests.
 *
 * The byte used almost everywhere below is 0xb2, which is 1011 0010. It is
 * deliberately not a palindrome and not symmetrical in either nibble, because
 * the failure these classes actually have is a bit order read the wrong way
 * round, and on a byte like 0xff, 0x00 or 0x18 the wrong order produces the
 * right answer. Every expectation here is written out in binary in the comment
 * that derives it, so an expectation cannot be "whatever the code returned".
 *
 * The pair of orders is the whole point of the module, so they are compared
 * against each other directly rather than only tested apart. Two readers that
 * agree on 0xb2 are the same reader wearing two names, and half the codecs in
 * this package would then be silently decoding noise.
 */

import { describe, expect, it } from 'vitest';
import { ByteWriter, LsbBitReader, LsbBitWriter, MsbBitReader, MsbBitWriter } from '../src/bits.js';

/** 1011 0010 and 0101 1101. Neither byte reads the same from both ends. */
const PAIR = Uint8Array.from([0xb2, 0x5d]);

describe('reading bits most significant first', () => {
	it('takes the top of the byte before the bottom', () => {
		// 1011 0010 splits into 1011 and 0010, in that order.
		const reader = new MsbBitReader(PAIR);
		expect(reader.read(4)).toBe(0b1011);
		expect(reader.read(4)).toBe(0b0010);
	});

	it('carries a value across a byte boundary in order', () => {
		// Six bits leaves two behind, so the second read takes 10 from the first
		// byte and 0101 from the second and joins them as 10 0101.
		const reader = new MsbBitReader(PAIR);
		expect(reader.read(6)).toBe(0b101100);
		expect(reader.read(6)).toBe(0b100101);
	});

	it('reads a code wider than a byte in a single call', () => {
		// 1011 0010 0101, the first twelve bits of the pair.
		expect(new MsbBitReader(PAIR).read(12)).toBe(0b101100100101);
	});

	it('reads sixteen bits as the two bytes in the order they appear', () => {
		expect(new MsbBitReader(PAIR).read(16)).toBe(0xb25d);
	});

	it('reads twenty four bits, which is the widest code any format here uses', () => {
		// Beyond this the shifting would meet the 32 bit bitwise operators, so
		// the top of the range is worth pinning.
		const reader = new MsbBitReader(Uint8Array.from([0x12, 0x34, 0x56]));
		expect(reader.read(24)).toBe(0x123456);
	});

	it('reads nothing and consumes nothing when asked for zero bits', () => {
		const reader = new MsbBitReader(PAIR);
		expect(reader.read(0)).toBe(0);
		expect(reader.position).toBe(0);
		expect(reader.read(4)).toBe(0b1011);
	});

	it('pads the low end of a value that runs off the end of the buffer', () => {
		// A truncated file is a normal thing to be handed. The four bits that
		// exist land at the top of the value and the missing four come back as
		// zeros, so 1111 read as eight bits is 1111 0000 rather than 0000 1111.
		const reader = new MsbBitReader(Uint8Array.from([0xff]));
		expect(reader.read(4)).toBe(0b1111);
		expect(reader.read(8)).toBe(0b11110000);
	});

	it('returns zero once every byte has been read rather than throwing', () => {
		const reader = new MsbBitReader(Uint8Array.from([0xff]));
		expect(reader.read(8)).toBe(0xff);
		expect(reader.read(8)).toBe(0);
		expect(reader.read(1)).toBe(0);
	});

	it('reads one bit at a time in the same order as a wide read', () => {
		const reader = new MsbBitReader(PAIR);
		const bits = [1, 0, 1, 1, 0, 0, 1, 0];
		for (const bit of bits) expect(reader.readBit()).toBe(bit);
		expect(reader.readBit()).toBe(0);
	});

	it('returns zero from readBit past the end of the buffer', () => {
		const reader = new MsbBitReader(Uint8Array.from([0x80]));
		expect(reader.readBit()).toBe(1);
		reader.skip(7);
		expect(reader.readBit()).toBe(0);
	});

	it('leaves the position where it was when peeking', () => {
		const reader = new MsbBitReader(PAIR);
		expect(reader.peek(4)).toBe(0b1011);
		expect(reader.peek(4)).toBe(0b1011);
		expect(reader.position).toBe(0);
		expect(reader.read(4)).toBe(0b1011);
	});

	it('peeks across a byte boundary without consuming either byte', () => {
		// A peek that restored only the byte index and not the bit offset would
		// pass a peek inside one byte and fail here.
		const reader = new MsbBitReader(PAIR);
		reader.read(6);
		expect(reader.peek(6)).toBe(0b100101);
		expect(reader.position).toBe(6);
		expect(reader.read(6)).toBe(0b100101);
	});

	it('peeks past the end without moving the position', () => {
		const reader = new MsbBitReader(Uint8Array.from([0xff]));
		expect(reader.peek(16)).toBe(0xff00);
		expect(reader.position).toBe(0);
	});

	it('skips across several whole bytes', () => {
		const reader = new MsbBitReader(Uint8Array.from([0x00, 0x00, 0x00, 0xab]));
		reader.skip(24);
		expect(reader.position).toBe(24);
		expect(reader.read(8)).toBe(0xab);
	});

	it('skips from the middle of a byte into the middle of a later one', () => {
		// 3 + 10 lands on bit 13, which is the fifth bit of the second byte:
		// 0101 1101 with five taken leaves 101.
		const reader = new MsbBitReader(PAIR);
		reader.read(3);
		reader.skip(10);
		expect(reader.position).toBe(13);
		expect(reader.read(3)).toBe(0b101);
	});

	it.each([1, 2, 3, 4, 5, 6, 7])(
		'discards the rest of the byte when aligning from bit %i',
		(offset) => {
			// Row-aligned formats call this at the end of every row, from whatever
			// offset the row happened to end on. An align that moved on only from
			// certain offsets would skew every row below the first.
			const reader = new MsbBitReader(Uint8Array.from([0xaa, 0x55]));
			reader.read(offset);
			reader.alignToByte();
			expect(reader.position).toBe(8);
			expect(reader.read(8)).toBe(0x55);
		},
	);

	it('consumes nothing when aligning on a byte boundary', () => {
		const reader = new MsbBitReader(Uint8Array.from([0xaa, 0x55]));
		reader.alignToByte();
		expect(reader.position).toBe(0);
		expect(reader.read(8)).toBe(0xaa);
		reader.alignToByte();
		expect(reader.position).toBe(8);
	});

	it('counts every bit handed out in the position', () => {
		const reader = new MsbBitReader(PAIR);
		reader.read(3);
		expect(reader.position).toBe(3);
		reader.readBit();
		expect(reader.position).toBe(4);
		reader.read(9);
		expect(reader.position).toBe(13);
	});

	it('is not exhausted until the last bit of the last byte is taken', () => {
		// Byte granularity is the trap: a reader that reports exhaustion the
		// moment it moves off a byte would call a file truncated with seven good
		// bits still in hand.
		const reader = new MsbBitReader(PAIR);
		expect(reader.exhausted).toBe(false);
		reader.read(15);
		expect(reader.exhausted).toBe(false);
		reader.read(1);
		expect(reader.exhausted).toBe(true);
	});

	it('is exhausted immediately when the range holds no bytes', () => {
		expect(new MsbBitReader(new Uint8Array(0)).exhausted).toBe(true);
	});

	it('reads only the bytes inside the range it was given', () => {
		const reader = new MsbBitReader(Uint8Array.from([0x11, 0x22, 0x33, 0x44]), 1, 3);
		expect(reader.read(8)).toBe(0x22);
		expect(reader.read(8)).toBe(0x33);
		expect(reader.exhausted).toBe(true);
		expect(reader.read(8)).toBe(0);
	});

	it('clamps an end past the buffer to the buffer', () => {
		// A codec that trusts a length field from the file will hand one of these
		// in, and the answer has to be zeros rather than an exception thrown from
		// inside a decode loop.
		const reader = new MsbBitReader(Uint8Array.from([0x11, 0x22]), 0, 500);
		expect(reader.read(16)).toBe(0x1122);
		expect(reader.exhausted).toBe(true);
	});
});

describe('reading bits least significant first', () => {
	it('takes the bottom of the byte before the top', () => {
		// The same 1011 0010 splits into 0010 and 1011, the opposite way round.
		const reader = new LsbBitReader(PAIR);
		expect(reader.read(4)).toBe(0b0010);
		expect(reader.read(4)).toBe(0b1011);
	});

	it('places the bits of a later byte above the bits of an earlier one', () => {
		// Twelve bits is the whole of 0xb2 with the low nibble of 0x5d, 1101,
		// sitting above it: 1101 1011 0010.
		expect(new LsbBitReader(PAIR).read(12)).toBe(0b110110110010);
	});

	it('reads sixteen bits as the two bytes in the reverse of their file order', () => {
		expect(new LsbBitReader(PAIR).read(16)).toBe(0x5db2);
	});

	it('leaves the high end of a value zero when it runs off the end', () => {
		// The mirror of the most significant reader, and the opposite answer: the
		// bits that exist keep the places they had, so the padding lands above
		// them rather than below.
		const reader = new LsbBitReader(Uint8Array.from([0xff]));
		expect(reader.read(4)).toBe(0b1111);
		expect(reader.read(8)).toBe(0b1111);
	});

	it('returns zero once every byte has been read', () => {
		const reader = new LsbBitReader(Uint8Array.from([0xff]));
		expect(reader.read(8)).toBe(0xff);
		expect(reader.read(9)).toBe(0);
	});

	it('counts every bit handed out in the position', () => {
		const reader = new LsbBitReader(PAIR);
		reader.read(5);
		expect(reader.position).toBe(5);
		reader.read(6);
		expect(reader.position).toBe(11);
	});

	it('is not exhausted until the last bit of the last byte is taken', () => {
		const reader = new LsbBitReader(PAIR);
		reader.read(15);
		expect(reader.exhausted).toBe(false);
		reader.read(1);
		expect(reader.exhausted).toBe(true);
	});

	it.each([1, 2, 3, 4, 5, 6, 7])(
		'discards the rest of the byte when aligning from bit %i',
		(offset) => {
			const reader = new LsbBitReader(Uint8Array.from([0xaa, 0x55]));
			reader.read(offset);
			reader.alignToByte();
			expect(reader.position).toBe(8);
			expect(reader.read(8)).toBe(0x55);
		},
	);

	it('consumes nothing when aligning on a byte boundary', () => {
		const reader = new LsbBitReader(Uint8Array.from([0xaa, 0x55]));
		reader.alignToByte();
		expect(reader.read(8)).toBe(0xaa);
	});

	it('reads only the bytes inside the range it was given', () => {
		const reader = new LsbBitReader(Uint8Array.from([0x11, 0x22, 0x33, 0x44]), 2);
		expect(reader.read(8)).toBe(0x33);
		expect(reader.read(8)).toBe(0x44);
		expect(reader.exhausted).toBe(true);
	});

	it('clamps an end past the buffer to the buffer', () => {
		const reader = new LsbBitReader(Uint8Array.from([0x11]), 0, 99);
		expect(reader.read(8)).toBe(0x11);
		expect(reader.exhausted).toBe(true);
	});
});

describe('the two bit orders against each other', () => {
	it('gives different answers for the same bytes, which is why both exist', () => {
		// This is the assertion the module exists for. TIFF, CCITT and PCX fill
		// from the top of the byte and GIF's LZW fills from the bottom, and a
		// codec handed the wrong one decodes plausible-looking noise rather than
		// failing. If this test ever passes with both sides equal, one of the two
		// readers has been quietly rewritten into the other.
		expect(new MsbBitReader(PAIR).read(4)).toBe(0b1011);
		expect(new LsbBitReader(PAIR).read(4)).toBe(0b0010);
		expect(new MsbBitReader(PAIR).read(12)).not.toBe(new LsbBitReader(PAIR).read(12));
	});

	it('agrees only where the read is a whole byte, where bit order cannot show', () => {
		// Byte-aligned whole bytes are the one case both orders answer the same
		// way, which is precisely why a codec tested only on byte-sized reads can
		// ship with the wrong reader.
		expect(new MsbBitReader(PAIR).read(8)).toBe(0xb2);
		expect(new LsbBitReader(PAIR).read(8)).toBe(0xb2);
	});
});

describe('writing bits most significant first', () => {
	it('fills a byte from the top down', () => {
		// 101 written into an empty byte sits at the top and the padding follows:
		// 1010 0000.
		const writer = new MsbBitWriter();
		writer.write(0b101, 3);
		expect([...writer.finish()]).toEqual([0b10100000]);
	});

	it('splits a value wider than a byte across two of them', () => {
		// 0x123 is 0001 0010 0011 in twelve bits, so the second byte carries 0011
		// at the top and four zero bits behind it.
		const writer = new MsbBitWriter();
		writer.write(0x123, 12);
		expect([...writer.finish()]).toEqual([0x12, 0x30]);
	});

	it('ignores bits of the value above the count it was given', () => {
		// A compressor hands codes that are already masked, but a caller that has
		// not masked one must not corrupt the bits already written.
		const writer = new MsbBitWriter();
		writer.write(0b11110101, 4);
		expect([...writer.finish()]).toEqual([0b01010000]);
	});

	it('writes nothing at all for a count of zero', () => {
		const writer = new MsbBitWriter();
		writer.write(0xff, 0);
		expect([...writer.finish()]).toEqual([]);
	});

	it('takes a single bit at a time in the same order', () => {
		const writer = new MsbBitWriter();
		for (const bit of [1, 0, 1, 1, 0, 0, 1, 0]) writer.writeBit(bit);
		expect([...writer.finish()]).toEqual([0xb2]);
	});

	it('pads the tail of a part filled byte with zeros when aligning', () => {
		const writer = new MsbBitWriter();
		writer.write(0b111, 3);
		writer.alignToByte();
		writer.write(0xff, 8);
		expect([...writer.finish()]).toEqual([0b11100000, 0xff]);
	});

	it('adds nothing when aligning on a byte boundary', () => {
		// An align that emitted a byte regardless would put a zero byte in the
		// middle of every LZW stream that happened to end on a boundary.
		const writer = new MsbBitWriter();
		writer.write(0xab, 8);
		writer.alignToByte();
		writer.alignToByte();
		expect([...writer.finish()]).toEqual([0xab]);
	});

	it('pads the last byte on finishing rather than dropping it', () => {
		const writer = new MsbBitWriter();
		writer.write(0xff, 8);
		writer.write(0b11, 2);
		expect([...writer.finish()]).toEqual([0xff, 0b11000000]);
	});

	it('keeps every byte when the output grows past its initial buffer', () => {
		// Five thousand bytes crosses any plausible starting capacity more than
		// once, which is the case the doubling gets wrong: a reallocation that
		// copies the old buffer into the new one but forgets the length leaves a
		// run of zeros in the middle of an image rather than at the end.
		const writer = new MsbBitWriter();
		for (let i = 0; i < 5000; i += 1) writer.write(i & 0xff, 8);
		const bytes = writer.finish();
		expect(bytes.length).toBe(5000);
		expect([...bytes].every((byte, index) => byte === (index & 0xff))).toBe(true);
	});

	it('round trips mixed widths back through the reader of the same order', () => {
		const widths = [3, 12, 1, 8, 5, 16, 7];
		const values = [0b101, 0x123, 1, 0xb2, 0b10110, 0x5dab, 0b1010101];
		const writer = new MsbBitWriter();
		widths.forEach((width, index) => writer.write(values[index] as number, width));
		const reader = new MsbBitReader(writer.finish());
		widths.forEach((width, index) => expect(reader.read(width)).toBe(values[index]));
	});
});

describe('writing bits least significant first', () => {
	it('fills a byte from the bottom up', () => {
		// The same 101 as the other order, and the opposite byte: 0000 0101.
		const writer = new LsbBitWriter();
		writer.write(0b101, 3);
		expect([...writer.finish()]).toEqual([0b00000101]);
	});

	it('splits a value wider than a byte with its low bits in the first byte', () => {
		// 0x123 in twelve bits is 0x23 then the remaining 0x1, which is how GIF
		// stores a code that crosses a byte.
		const writer = new LsbBitWriter();
		writer.write(0x123, 12);
		expect([...writer.finish()]).toEqual([0x23, 0x01]);
	});

	it('ignores bits of the value above the count it was given', () => {
		const writer = new LsbBitWriter();
		writer.write(0b11110101, 4);
		expect([...writer.finish()]).toEqual([0b00000101]);
	});

	it('writes nothing at all for a count of zero', () => {
		const writer = new LsbBitWriter();
		writer.write(0xff, 0);
		expect([...writer.finish()]).toEqual([]);
	});

	it('pads the top of a part filled byte with zeros when aligning', () => {
		const writer = new LsbBitWriter();
		writer.write(0b111, 3);
		writer.alignToByte();
		writer.write(0xff, 8);
		expect([...writer.finish()]).toEqual([0b00000111, 0xff]);
	});

	it('adds nothing when aligning on a byte boundary', () => {
		const writer = new LsbBitWriter();
		writer.write(0xab, 8);
		writer.alignToByte();
		writer.alignToByte();
		expect([...writer.finish()]).toEqual([0xab]);
	});

	it('keeps every byte when the output grows past its initial buffer', () => {
		// The trailing three bits matter: they force the align inside `finish` to
		// run after the buffer has already been replaced, which is the one place
		// the two growth paths differ.
		const writer = new LsbBitWriter();
		for (let i = 0; i < 5000; i += 1) writer.write(i & 0xff, 8);
		writer.write(0b101, 3);
		const bytes = writer.finish();
		expect(bytes.length).toBe(5001);
		expect([...bytes.subarray(0, 5000)].every((byte, index) => byte === (index & 0xff))).toBe(true);
		expect(bytes[5000]).toBe(0b00000101);
	});

	it('round trips mixed widths back through the reader of the same order', () => {
		const widths = [3, 12, 1, 8, 5, 16, 7];
		const values = [0b101, 0x123, 1, 0xb2, 0b10110, 0x5dab, 0b1010101];
		const writer = new LsbBitWriter();
		widths.forEach((width, index) => writer.write(values[index] as number, width));
		const reader = new LsbBitReader(writer.finish());
		widths.forEach((width, index) => expect(reader.read(width)).toBe(values[index]));
	});

	it('produces different bytes from the other order for the same writes', () => {
		const msb = new MsbBitWriter();
		const lsb = new LsbBitWriter();
		msb.write(0b101, 3);
		lsb.write(0b101, 3);
		expect([...msb.finish()]).not.toEqual([...lsb.finish()]);
	});
});

describe('the byte writer', () => {
	it('keeps only the low eight bits of a value', () => {
		const writer = new ByteWriter();
		writer.u8(0x1ff);
		writer.u8(-1);
		expect([...writer.finish()]).toEqual([0xff, 0xff]);
	});

	it('writes a sixteen bit value low byte first in little endian', () => {
		const writer = new ByteWriter();
		writer.u16le(0x1234);
		expect([...writer.finish()]).toEqual([0x34, 0x12]);
	});

	it('writes a sixteen bit value high byte first in big endian', () => {
		const writer = new ByteWriter();
		writer.u16be(0x1234);
		expect([...writer.finish()]).toEqual([0x12, 0x34]);
	});

	it('writes a thirty two bit value low byte first in little endian', () => {
		const writer = new ByteWriter();
		writer.u32le(0x12345678);
		expect([...writer.finish()]).toEqual([0x78, 0x56, 0x34, 0x12]);
	});

	it('writes a thirty two bit value high byte first in big endian', () => {
		const writer = new ByteWriter();
		writer.u32be(0x12345678);
		expect([...writer.finish()]).toEqual([0x12, 0x34, 0x56, 0x78]);
	});

	it.each([
		['u32le', [0xef, 0xbe, 0xad, 0xde]],
		['u32be', [0xde, 0xad, 0xbe, 0xef]],
	] as const)('writes a value with the top bit set through %s', (method, expected) => {
		// 0xdeadbeef is negative as a signed 32 bit integer, so a shift written
		// with >> rather than >>> sign extends and fills the high bytes with 0xff.
		// Every file length and every offset in a large image goes through here.
		const writer = new ByteWriter();
		writer[method](0xdeadbeef);
		expect([...writer.finish()]).toEqual(expected);
	});

	it('copies a run of bytes in order', () => {
		const writer = new ByteWriter();
		writer.u8(1);
		writer.bytesOf(Uint8Array.from([2, 3, 4]));
		expect([...writer.finish()]).toEqual([1, 2, 3, 4]);
	});

	it('writes one byte per character of a string', () => {
		const writer = new ByteWriter();
		writer.ascii('BM');
		expect([...writer.finish()]).toEqual([0x42, 0x4d]);
	});

	it('keeps the low byte of a character outside the byte range', () => {
		// Every field these encoders write is a byte field, so a character that
		// does not fit is truncated rather than encoded as two bytes, which would
		// put the rest of the header at the wrong offset.
		const writer = new ByteWriter();
		writer.ascii('☃');
		expect([...writer.finish()]).toEqual([0x03]);
	});

	it('reports how many bytes have been written', () => {
		const writer = new ByteWriter();
		expect(writer.size).toBe(0);
		writer.u8(1);
		expect(writer.size).toBe(1);
		writer.u32be(0);
		expect(writer.size).toBe(5);
		writer.ascii('abc');
		writer.bytesOf(Uint8Array.from([9]));
		expect(writer.size).toBe(9);
	});

	it('returns only what was written, not the buffer behind it', () => {
		// The default capacity is a kilobyte, so a header of a few bytes handed
		// back whole would be a file of mostly zeros that still opens in some
		// readers and not in others.
		const writer = new ByteWriter();
		writer.u8(7);
		expect(writer.finish().length).toBe(1);
	});

	it('hands back an independent copy each time it finishes', () => {
		const writer = new ByteWriter();
		writer.u8(7);
		const first = writer.finish();
		writer.u8(8);
		expect([...first]).toEqual([7]);
		expect([...writer.finish()]).toEqual([7, 8]);
	});

	it('accepts a capacity smaller than it can use and still works', () => {
		// The floor exists so a caller who asks for a one byte buffer does not
		// get a reallocation on every single byte.
		const writer = new ByteWriter(0);
		for (let i = 0; i < 20; i += 1) writer.u8(i);
		expect([...writer.finish()]).toEqual([...Array(20).keys()]);
	});

	it.each([
		['u8', 1, (writer: ByteWriter, value: number) => writer.u8(value)],
		['u16le', 2, (writer: ByteWriter, value: number) => writer.u16le(value)],
		['u16be', 2, (writer: ByteWriter, value: number) => writer.u16be(value)],
		['u32le', 4, (writer: ByteWriter, value: number) => writer.u32le(value)],
		['u32be', 4, (writer: ByteWriter, value: number) => writer.u32be(value)],
	] as const)('grows past its capacity while writing through %s', (_name, width, write) => {
		// Forty calls from a capacity of sixteen crosses the boundary at least
		// twice, which is the case the comment on `ByteWriter` says two encoders
		// had wrong: the first reallocation worked and the second lost bytes.
		const writer = new ByteWriter(16);
		for (let i = 0; i < 40; i += 1) write(writer, 0);
		writer.u8(0xff);
		const bytes = writer.finish();
		expect(bytes.length).toBe(40 * width + 1);
		expect(bytes[bytes.length - 1]).toBe(0xff);
		expect([...bytes.subarray(0, bytes.length - 1)].every((byte) => byte === 0)).toBe(true);
	});

	it('grows past its capacity in a single run of bytes', () => {
		// One `bytesOf` larger than the whole buffer has to double more than once
		// before it fits, which a reallocation written as a single doubling gets
		// wrong.
		const source = Uint8Array.from({ length: 300 }, (_value, index) => index & 0xff);
		const writer = new ByteWriter(16);
		writer.bytesOf(source);
		expect([...writer.finish()]).toEqual([...source]);
	});

	it('grows past its capacity while writing a string', () => {
		const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
		const writer = new ByteWriter(16);
		writer.ascii(text);
		expect(writer.size).toBe(text.length);
		expect(String.fromCharCode(...writer.finish())).toBe(text);
	});

	it('keeps what was already written when it grows', () => {
		// The reallocation copies the old contents across, and a copy that takes
		// the whole old buffer rather than the used part of it is the same bug in
		// reverse: it works until a `finish` after a grow.
		const writer = new ByteWriter(16);
		writer.ascii('header');
		writer.bytesOf(new Uint8Array(100).fill(0x5a));
		const bytes = writer.finish();
		expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('header');
		expect(bytes.length).toBe(106);
	});
});
