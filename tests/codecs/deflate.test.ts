/**
 * The platform's deflate, and the one thing that goes wrong with it.
 *
 * `pump` writes, closes and reads three separate promises, and only the read
 * is awaited. That is deliberate and load bearing, because awaiting the write
 * deadlocks on anything larger than the stream's internal queue. What it costs
 * is that a corrupt stream rejects all three, and the two nobody is holding
 * become unhandled rejections: in Node that ends the process, and in a browser
 * it fires `unhandledrejection` at the page. So a decoder that correctly
 * reported a damaged file used to take the tab down with it, which is a far
 * worse failure than the one it was reporting.
 *
 * `openDeflate` is the same stream taken a piece at a time, and it carries one
 * promise the whole encoder rests on: the bytes it produces are the bytes a
 * single `deflate` of the joined pieces would have produced. Deflate has no
 * per-write boundary, so that holds for any way of cutting the input up, but
 * only while nothing flushes between chunks. An implementation that did would
 * still write valid PNG files, a few percent larger, and every round trip test
 * in this suite would pass. The comparison below is the only thing that would
 * not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	deflate,
	hasCompressionStream,
	inflate,
	openDeflate,
} from '../../src/codecs/png/deflate.js';
import { CodecUnavailableError } from '../../src/errors.js';

function ascii(text: string): Uint8Array {
	return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
}

describe('deflate and inflate', () => {
	it('is available under Node, which is what the suite assumes', () => {
		expect(hasCompressionStream()).toBe(true);
	});

	it('round trips a buffer', async () => {
		const source = ascii('the same sentence, over and over, '.repeat(40));
		const packed = await deflate(source);
		expect(packed.length).toBeLessThan(source.length);
		expect(Array.from(await inflate(packed))).toEqual(Array.from(source));
	});

	it('writes the zlib wrapper a PNG IDAT expects', async () => {
		// 0x78 is the compression method and window size; the second byte
		// carries the level and a check. Anything else here would be raw
		// deflate, which a PNG reader rejects.
		const packed = await deflate(ascii('hello'));
		expect(packed[0]).toBe(0x78);
	});

	it('round trips an empty buffer', async () => {
		expect(Array.from(await inflate(await deflate(new Uint8Array(0))))).toEqual([]);
	});

	it('round trips a buffer larger than the stream queue', async () => {
		// The reason the write is not awaited. A megabyte is comfortably past
		// the internal high water mark, so a version that awaited would hang
		// here rather than fail, which is why this is a test and not a comment.
		const source = new Uint8Array(1 << 20);
		for (let i = 0; i < source.length; i += 1) source[i] = (i * 31) & 0xff;
		expect(Array.from(await inflate(await deflate(source)))).toEqual(Array.from(source));
	});

	it('rejects on a stream that is not deflate at all', async () => {
		await expect(inflate(ascii('this is not compressed anything'))).rejects.toThrow();
	});

	it('says which browser feature is missing rather than throwing a type error', async () => {
		// Safari before 16.4 is the browser this is about. A reader that landed
		// there used to get `CompressionStream is not a constructor`, which
		// tells whoever is looking at it nothing they can act on.
		vi.stubGlobal('CompressionStream', undefined);
		vi.stubGlobal('DecompressionStream', undefined);
		try {
			expect(hasCompressionStream()).toBe(false);
			expect(() => deflate(ascii('anything'))).toThrow(CodecUnavailableError);
			expect(() => inflate(ascii('anything'))).toThrow(CodecUnavailableError);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/**
 * Compare two buffers and name the first byte that differs.
 *
 * `expect([...a]).toEqual([...b])` over a few megabytes builds a diff of a few
 * million entries the moment it fails, which reads as a hung run rather than a
 * failed one.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
	expect(actual.length, `${label}: length`).toBe(expected.length);
	let first = -1;
	for (let i = 0; i < expected.length; i += 1) {
		if (actual[i] !== expected[i]) {
			first = i;
			break;
		}
	}
	expect(first, `${label}: the first byte that differs`).toBe(-1);
}

/** Compressible, but not to nothing, so the output is worth comparing byte for byte. */
function mixed(length: number): Uint8Array {
	const out = new Uint8Array(length);
	let state = 0x2545f491;
	for (let i = 0; i < length; i += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		out[i] = i % 97 === 0 ? state & 0xff : (i * 3) & 0x3f;
	}
	return out;
}

async function inPieces(bytes: Uint8Array, size: number): Promise<Uint8Array> {
	const sink = openDeflate();
	for (let at = 0; at < bytes.length; at += size) {
		// A copy rather than a view of `bytes`, because the stream reads the
		// buffer after the write settles and this is what a caller has to do.
		await sink.write(bytes.slice(at, at + size));
	}
	return sink.finish();
}

describe('a deflate stream written a piece at a time', () => {
	it('produces the same bytes as one write of the whole buffer', async () => {
		// The load bearing property. Everything else about the streaming path
		// could be right and the PNG encoder would still stop writing the file
		// it wrote yesterday if this were false.
		const source = mixed(300_000);
		const whole = await deflate(source);
		for (const size of [1023, 16 * 1024, 300_000, 400_000]) {
			expectSameBytes(await inPieces(source, size), whole, `in pieces of ${size}`);
		}
	});

	it('produces the same bytes when the pieces are single bytes', async () => {
		const source = mixed(2000);
		expectSameBytes(await inPieces(source, 1), await deflate(source), 'a byte at a time');
	});

	it('round trips a buffer that arrived in pieces', async () => {
		const source = mixed(200_000);
		expectSameBytes(await inflate(await inPieces(source, 4096)), source, 'round trip');
	});

	it('takes a piece far larger than the stream queue without deadlocking', async () => {
		// `pump` cannot await its write for exactly this reason. This one can,
		// because the reader is already draining before the first byte goes in,
		// and the await is what applies backpressure rather than what hangs.
		const source = mixed(4 << 20);
		expectSameBytes(await inflate(await inPieces(source, 4 << 20)), source, 'four megabytes');
	});

	it('writes a zlib wrapper even when nothing was written into it', async () => {
		const out = await openDeflate().finish();
		expect(out[0]).toBe(0x78);
		expect((await inflate(out)).length).toBe(0);
	});

	it('keeps what came after an empty piece', async () => {
		const sink = openDeflate();
		await sink.write(ascii('before'));
		await sink.write(new Uint8Array(0));
		await sink.write(ascii('after'));
		expectSameBytes(await inflate(await sink.finish()), ascii('beforeafter'), 'either side');
	});

	it('refuses to open where the platform has no compression at all', async () => {
		vi.stubGlobal('CompressionStream', undefined);
		try {
			expect(() => openDeflate()).toThrow(CodecUnavailableError);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('a corrupt stream does not take the process with it', () => {
	const escaped: unknown[] = [];
	const capture = (reason: unknown) => {
		escaped.push(reason);
	};

	beforeEach(() => {
		escaped.length = 0;
		process.on('unhandledRejection', capture);
	});

	afterEach(() => {
		process.off('unhandledRejection', capture);
	});

	/**
	 * Wait long enough for an unhandled rejection to be reported.
	 *
	 * Node decides a rejection is unhandled once the microtask queue has
	 * drained and a turn of the event loop has passed, so a plain `await` is
	 * not enough to see one. Two timer turns is.
	 */
	const settle = async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	};

	it('leaves nothing unhandled when a whole run of streams fails', async () => {
		// One failure was enough to end the process before this was fixed. The
		// run is here because the timing depends on which of the three promises
		// rejects first, and a single case can pass by luck.
		for (let seed = 0; seed < 24; seed += 1) {
			const damaged = new Uint8Array(64);
			for (let i = 0; i < damaged.length; i += 1) damaged[i] = (seed * 37 + i * 11) & 0xff;
			// Kept as a rejection that is caught here, which is the whole point:
			// the caller handles the read, and the write and the close must not
			// escape on their own.
			await inflate(damaged).catch(() => undefined);
		}
		await settle();
		expect(escaped).toEqual([]);
	});

	it('leaves nothing unhandled when a valid header is followed by rubbish', async () => {
		// The nastier shape: the stream starts decoding, so the failure arrives
		// partway through rather than on the first byte.
		const packed = await deflate(ascii('a sentence long enough to compress into several bytes'));
		const damaged = packed.slice();
		for (let i = 4; i < damaged.length; i += 1) damaged[i] = (damaged[i] as number) ^ 0xff;
		await expect(inflate(damaged)).rejects.toThrow();
		await settle();
		expect(escaped).toEqual([]);
	});

	it('leaves nothing unhandled when the stream is truncated', async () => {
		const packed = await deflate(ascii('the same sentence, over and over, '.repeat(40)));
		await expect(inflate(packed.subarray(0, packed.length - 8))).rejects.toThrow();
		await settle();
		expect(escaped).toEqual([]);
	});

	/**
	 * A view whose buffer has been handed to somebody else.
	 *
	 * Deflate does not fail on valid input, so a stream that goes wrong on the
	 * writing side went wrong over the bytes rather than over the compression,
	 * and this is that: transferring a buffer to a worker detaches it, and
	 * every view of it becomes unreadable in place. The stream rejects the
	 * write, rejects the close after it, and then, under Node, leaves the read
	 * pending for ever, which is why `finish` reports before it waits.
	 */
	const detached = (): Uint8Array => {
		const buffer = new ArrayBuffer(64);
		const view = new Uint8Array(buffer);
		structuredClone(buffer, { transfer: [buffer] });
		return view;
	};

	it('reports a failed piecewise stream once, from finish', async () => {
		const sink = openDeflate();
		await sink.write(detached());
		await expect(sink.finish()).rejects.toThrow(TypeError);
		await settle();
		expect(escaped).toEqual([]);
	});

	it('swallows the pieces written after a piecewise stream failed', async () => {
		// Reporting from `write` as well would hand the caller a second error
		// about the same thing, in the middle of a loop over scanlines rather
		// than where the output is collected.
		const sink = openDeflate();
		await sink.write(detached());
		await sink.write(ascii('this goes nowhere'));
		await sink.write(ascii('and so does this'));
		await expect(sink.finish()).rejects.toThrow(TypeError);
		await settle();
		expect(escaped).toEqual([]);
	});

	it('leaves nothing unhandled when a failed piecewise stream is abandoned', async () => {
		// No `finish`, which is what happens when the caller throws part way
		// through building the image. The read and the close still have to
		// have somebody holding them.
		const sink = openDeflate();
		await sink.write(detached());
		await settle();
		expect(escaped).toEqual([]);
	});

	it('leaves nothing unhandled when a healthy piecewise stream is abandoned', async () => {
		const sink = openDeflate();
		await sink.write(ascii('written and then forgotten'));
		await settle();
		expect(escaped).toEqual([]);
	});
});
