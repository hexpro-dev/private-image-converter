import { describe, expect, it } from 'vitest';
import { ByteReader, findBox, readFullBoxHeader, walkBoxes } from '../../src/heif/boxes.js';
import { HeifMalformedError } from '../../src/errors.js';
import { ascii, box, concat, u16, u32, u8 } from '../helpers/heif.js';

/** A reader over the given bytes, in a stage that will show up in any error. */
function reader(bytes: Uint8Array): ByteReader {
	return new ByteReader(bytes, 'meta');
}

describe('ByteReader', () => {
	it('reads each width big endian, as ISOBMFF stores everything', () => {
		// Every integer in this container format is big endian. A reader that
		// used the platform order would work on nothing and fail on everything,
		// which at least is obvious; the dangerous version is getting one field
		// right and another wrong.
		const r = reader(Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a]));
		expect(r.u8()).toBe(0x12);
		expect(r.u16()).toBe(0x3456);
		expect(r.u16()).toBe(0x789a);
	});

	it('reads a 24 bit field, which is what a FullBox flags field is', () => {
		const r = reader(Uint8Array.from([0xab, 0xcd, 0xef]));
		expect(r.u24()).toBe(0xabcdef);
	});

	it('reads a 32 bit field at its full unsigned range', () => {
		// Signed arithmetic here would turn a large but legal box size into a
		// negative number, and the bounds check that follows would pass.
		const r = reader(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
		expect(r.u32()).toBe(0xffffffff);
	});

	it('reads a 64 bit size that fits in a Number', () => {
		const r = reader(concat([u32(0), u32(0x0001e240)]));
		expect(r.u64()).toBe(123456);
	});

	it('refuses a 64 bit size beyond exact integer precision', () => {
		// Past 2^53 a Number silently stops counting, so an offset derived from
		// one would land somewhere arbitrary. A file that large is damaged
		// rather than big, and it says so.
		const r = reader(concat([u32(0x00ffffff), u32(0xffffffff)]));
		expect(() => r.u64()).toThrow(HeifMalformedError);
	});

	it.each([
		[0, 0],
		[1, 0x12],
		[2, 0x1234],
		[3, 0x123456],
		[4, 0x12345678],
	])('reads an integer of %i bytes', (size, expected) => {
		// iloc declares its own field widths, and zero is a real width meaning
		// the field is absent. Treating zero as "read one byte" shifts every
		// following field by one and the whole item table becomes garbage.
		const r = reader(Uint8Array.from([0x12, 0x34, 0x56, 0x78]));
		expect(r.uint(size)).toBe(expected);
	});

	it('reads an eight byte integer through uint', () => {
		const r = reader(concat([u32(0), u32(4096)]));
		expect(r.uint(8)).toBe(4096);
	});

	it('refuses a field width the format cannot express', () => {
		expect(() => reader(new Uint8Array(8)).uint(5)).toThrow(HeifMalformedError);
		expect(() => reader(new Uint8Array(8)).uint(7)).toThrow(HeifMalformedError);
	});

	it('reads a four character code', () => {
		expect(reader(ascii('ftyp')).ascii(4)).toBe('ftyp');
	});

	it('reads a null terminated string and steps past the terminator', () => {
		const r = reader(concat([ascii('image/jpeg'), u8(0), ascii('next')]));
		expect(r.cString()).toBe('image/jpeg');
		expect(r.ascii(4)).toBe('next');
	});

	it('reads a string that runs to the end with no terminator', () => {
		// A truncated infe box ends mid-name. Returning what is there beats
		// running off the end looking for a zero that was never written.
		const r = reader(ascii('unterminated'));
		expect(r.cString()).toBe('unterminated');
		expect(r.remaining).toBe(0);
	});

	it('decodes a name as UTF-8 rather than as bytes', () => {
		// Item names come from whatever wrote the file, and Apple writes them
		// in the user's language.
		const name = new TextEncoder().encode('画像');
		const r = reader(concat([name, u8(0)]));
		expect(r.cString()).toBe('画像');
	});

	it('slices without copying the whole buffer', () => {
		const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
		const r = reader(bytes);
		r.skip(1);
		const slice = r.slice(3);
		expect([...slice]).toEqual([2, 3, 4]);
		// A view, so a large tile payload costs nothing to hand around.
		expect(slice.buffer).toBe(bytes.buffer);
	});

	it('tracks its offset and what is left', () => {
		const r = reader(new Uint8Array(10));
		expect(r.offset).toBe(0);
		expect(r.remaining).toBe(10);
		r.skip(4);
		expect(r.offset).toBe(4);
		expect(r.remaining).toBe(6);
		r.seek(9);
		expect(r.remaining).toBe(1);
	});

	it('refuses to read past the end of its box', () => {
		// The whole point of the reader. These bytes come from a stranger's
		// file, so a short read has to produce a sentence rather than an
		// undefined that surfaces four functions later.
		const r = reader(new Uint8Array(3));
		expect(() => r.u32()).toThrow(HeifMalformedError);
	});

	it('names the stage it failed in', () => {
		const r = new ByteReader(new Uint8Array(1), 'item-location');
		try {
			r.u32();
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HeifMalformedError);
			expect((error as HeifMalformedError).stage).toBe('item-location');
			expect((error as HeifMalformedError).offset).toBe(0);
		}
	});

	it('honours an end before the end of the buffer', () => {
		// A child box may not read into its sibling even though the bytes are
		// right there.
		const r = new ByteReader(new Uint8Array(16), 'meta', 0, 4);
		r.u32();
		expect(() => r.u8()).toThrow(HeifMalformedError);
	});
});

describe('walkBoxes', () => {
	it('walks siblings in order', () => {
		const bytes = concat([box('ftyp', ascii('heic')), box('meta'), box('mdat', u8(1, 2, 3))]);
		const types = [...walkBoxes(bytes, 0, bytes.length, 'meta')].map((b) => b.type);
		expect(types).toEqual(['ftyp', 'meta', 'mdat']);
	});

	it('reads a 64 bit size when the 32 bit field is 1', () => {
		// The escape hatch for a box above four gigabytes. mdat reaches it on a
		// long video, and a reader that ignores it treats the largesize field
		// as the start of the payload.
		const payload = u8(9, 9, 9, 9);
		const large = concat([u32(1), ascii('mdat'), u32(0), u32(16 + payload.length), payload]);
		const [first] = [...walkBoxes(large, 0, large.length, 'meta')];
		expect(first?.type).toBe('mdat');
		expect(first?.bodyStart).toBe(16);
		expect(first?.end).toBe(large.length);
	});

	it('treats a size of 0 as running to the end of the parent', () => {
		// Legal, and means "the rest of the file". A reader that takes it
		// literally computes an end before the start.
		const bytes = concat([u32(0), ascii('mdat'), u8(1, 2, 3, 4)]);
		const [first] = [...walkBoxes(bytes, 0, bytes.length, 'meta')];
		expect(first?.end).toBe(bytes.length);
	});

	it('skips the extended type of a uuid box', () => {
		// A uuid box carries sixteen bytes of type before its payload. Missing
		// that reads the type as content.
		const extended = new Uint8Array(16).fill(0xaa);
		const payload = u8(7, 7);
		const bytes = concat([u32(8 + 16 + payload.length), ascii('uuid'), extended, payload]);
		const [first] = [...walkBoxes(bytes, 0, bytes.length, 'meta')];
		expect(first?.bodyStart).toBe(24);
		expect(first?.end - (first?.bodyStart ?? 0)).toBe(payload.length);
	});

	it('refuses a box smaller than its own header', () => {
		const bytes = concat([u32(4), ascii('junk'), u8(0, 0, 0, 0)]);
		expect(() => [...walkBoxes(bytes, 0, bytes.length, 'meta')]).toThrow(HeifMalformedError);
	});

	it('refuses a box that overruns its parent', () => {
		// The check that stops a dishonest length turning into a read of
		// whatever happens to follow in memory.
		const bytes = concat([u32(999), ascii('meta'), u8(1, 2)]);
		expect(() => [...walkBoxes(bytes, 0, bytes.length, 'meta')]).toThrow(HeifMalformedError);
	});

	it('stops cleanly on trailing bytes too short to be a box', () => {
		// Padding after the last box is common and harmless, so it ends the
		// walk rather than failing the file.
		const bytes = concat([box('ftyp', ascii('heic')), u8(0, 0, 0)]);
		const types = [...walkBoxes(bytes, 0, bytes.length, 'meta')].map((b) => b.type);
		expect(types).toEqual(['ftyp']);
	});
});

describe('findBox', () => {
	it('finds a child by type', () => {
		const bytes = concat([box('ftyp'), box('meta', u8(1))]);
		expect(findBox(bytes, 0, bytes.length, 'meta', 'meta')?.type).toBe('meta');
	});

	it('returns undefined when there is no such child', () => {
		const bytes = box('ftyp');
		expect(findBox(bytes, 0, bytes.length, 'moov', 'meta')).toBeUndefined();
	});
});

describe('readFullBoxHeader', () => {
	it('splits the version from the flags', () => {
		// One byte of version and three of flags. Reading them as a single
		// 32 bit field is a common shortcut that works until a box uses a flag.
		const bytes = concat([u32(16), ascii('iloc'), u8(1), u8(0x00, 0x00, 0x0f), u32(0)]);
		const [first] = [...walkBoxes(bytes, 0, bytes.length, 'meta')];
		const full = readFullBoxHeader(bytes, first!, 'meta');
		expect(full.version).toBe(1);
		expect(full.flags).toBe(0x0f);
		expect(full.bodyStart).toBe(12);
	});

	it('reads a 24 bit flags field at its full range', () => {
		const bytes = concat([u32(12), ascii('ipma'), u8(2), u8(0xff, 0xff, 0xff)]);
		const [first] = [...walkBoxes(bytes, 0, bytes.length, 'meta')];
		const full = readFullBoxHeader(bytes, first!, 'meta');
		expect(full.version).toBe(2);
		expect(full.flags).toBe(0xffffff);
	});
});

describe('the sizes a real file uses', () => {
	it('walks a box whose payload is exactly empty', () => {
		const bytes = concat([u32(8), ascii('free')]);
		const [first] = [...walkBoxes(bytes, 0, bytes.length, 'meta')];
		expect(first?.bodyStart).toBe(first?.end);
	});

	it('reads a 16 bit field at its full range', () => {
		expect(reader(u16(0xffff)).u16()).toBe(65535);
	});
});
