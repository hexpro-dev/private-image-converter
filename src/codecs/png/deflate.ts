/**
 * Deflate and inflate, borrowed from the platform.
 *
 * `CompressionStream` has been in every browser since Safari 16.4 in March
 * 2023 and in Node since 18, which is what makes a real PNG encoder possible
 * here without a zlib dependency. `deflate` is the zlib wrapped form of
 * RFC 1950, which is exactly what a PNG `IDAT` holds, so no header has to be
 * written by hand.
 *
 * The one thing it will not do is let you choose a compression level. Output
 * is a few percent larger than zopfli would manage. That is the price of the
 * dependency count, and it is the right trade for a tool whose whole claim is
 * that it carries nothing.
 */

import { CodecUnavailableError } from '../../errors.js';

// The compression streams declare a writable of `BufferSource` and a readable
// of `Uint8Array`, which is not a `TransformStream<Uint8Array, Uint8Array>`.
// Stating the two halves separately is closer to what they are than widening
// the parameter would be.
interface ByteTransform {
	readonly writable: WritableStream<BufferSource>;
	readonly readable: ReadableStream<Uint8Array>;
}

async function pump(bytes: Uint8Array, stream: ByteTransform): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	// Written and closed without awaiting the write first: a compression
	// stream will not accept the close until the chunk has been consumed, and
	// the reader below is what consumes it. Awaiting here deadlocks on inputs
	// larger than the internal queue, which is every photograph.
	// `BufferSource` requires an `ArrayBuffer` backed view, while a plain
	// `Uint8Array` is declared over `ArrayBufferLike`, which also covers
	// `SharedArrayBuffer`. The values here are never shared, so the cast states
	// what is already true rather than hiding a real mismatch.
	//
	// The rejections have to be claimed, though, and this is not tidiness. A
	// corrupt deflate stream rejects the write and the close as well as the
	// read, and the read is the only one anybody is awaiting. The other two
	// then have no handler, which in Node kills the process and in a browser
	// fires `unhandledrejection`. So a decoder that correctly reported a
	// damaged file also took the worker down with it, on about one malformed
	// input in twenty. Discarding them here is right rather than merely quiet:
	// whatever went wrong surfaces on the read, which is awaited, and it is
	// the same failure reported once instead of three times.
	void writer.write(bytes as unknown as BufferSource).catch(() => {});
	void writer.close().catch(() => {});

	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}

	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

export function hasCompressionStream(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** zlib-wrapped deflate, as PNG's IDAT and iCCP chunks both want. */
export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream !== 'function') {
		throw new CodecUnavailableError(
			'CompressionStream',
			'This browser is too old to write PNG files here. It needs compression built in, which arrived in Safari 16.4 and has been in Chrome and Firefox for longer.',
		);
	}
	return pump(bytes, new CompressionStream('deflate'));
}

export function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== 'function') {
		throw new CodecUnavailableError(
			'DecompressionStream',
			'This browser is too old to read PNG files here.',
		);
	}
	return pump(bytes, new DecompressionStream('deflate'));
}
