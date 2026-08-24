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
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflate, hasCompressionStream, inflate } from '../../src/codecs/png/deflate.js';

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
});
