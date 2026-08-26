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
 *
 * There are two ways in. `deflate` takes a whole buffer, which is what the
 * short things want: an ICC profile is a few kilobytes and building it in one
 * piece costs nothing. `openDeflate` takes it a piece at a time, which is what
 * an `IDAT` wants: a 48 megapixel photograph filters to about 140 megabytes,
 * and holding all of it just to hand it over in one call doubles the peak of
 * an encode that is already the largest allocation this package makes.
 */

import { CodecUnavailableError } from '../../errors.js';

const NO_COMPRESSION =
	'This browser is too old to write PNG files here. It needs compression built in, which arrived in Safari 16.4 and has been in Chrome and Firefox for longer.';

// The compression streams declare a writable of `BufferSource` and a readable
// of `Uint8Array`, which is not a `TransformStream<Uint8Array, Uint8Array>`.
// Stating the two halves separately is closer to what they are than widening
// the parameter would be.
interface ByteTransform {
	readonly writable: WritableStream<BufferSource>;
	readonly readable: ReadableStream<Uint8Array>;
}

function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
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

	return join(chunks, total);
}

export function hasCompressionStream(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** zlib-wrapped deflate, as PNG's IDAT and iCCP chunks both want. */
export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream !== 'function') {
		throw new CodecUnavailableError('CompressionStream', NO_COMPRESSION);
	}
	return pump(bytes, new CompressionStream('deflate'));
}

/**
 * A deflate stream being fed a piece at a time.
 *
 * The output is the same bytes `deflate` would have produced from the pieces
 * joined together. That is not an accident of the current zlib: the deflate
 * format has no per-write boundary, and a compression stream only emits a
 * block when its own window fills or when it is closed, so how the input was
 * cut up leaves no trace. It is checked in `deflate.test.ts` against a single
 * write of the same bytes, because a future implementation that flushed on
 * every chunk would still produce a valid file, just a larger one, and nothing
 * else in the suite would notice.
 */
export interface DeflateSink {
	/**
	 * Hand over the next piece.
	 *
	 * The bytes are read after this resolves, so the buffer must not be reused
	 * or overwritten afterwards. See the note on `openDeflate`.
	 */
	write(bytes: Uint8Array): Promise<void>;
	/** Close the stream and return everything it produced. */
	finish(): Promise<Uint8Array>;
}

/**
 * Open a zlib-wrapped deflate stream to write into.
 *
 * Two traps live here, and both have cost somebody an afternoon.
 *
 * The first is the buffer. `write` resolving does NOT mean the bytes have been
 * consumed: Node's compression stream queues the chunk and reads it later, so
 * a caller that fills one scratch buffer, writes it, and then refills it for
 * the next batch produces a stream that inflates to whatever the buffer
 * happened to hold at the moment the compressor got round to it. That is
 * silent corruption in the middle of a file rather than an error anywhere, and
 * it survives every round trip test that only checks small images. Hand over
 * a buffer and forget it.
 *
 * The second is the reader. It starts draining here, before the first write,
 * which is what makes awaiting a write safe: `pump` above cannot await its
 * write, because nothing is consuming the readable end while it sits there,
 * and a chunk larger than the internal queue then deadlocks. With the drain
 * already running, awaiting is not only safe but the point, since it is the
 * backpressure that keeps a batch from being queued behind a hundred others.
 *
 * Every rejection is claimed as soon as its promise exists. A stream that
 * fails rejects the write, the close and the read, and an unclaimed one of
 * those ends the process in Node and fires `unhandledrejection` in a browser.
 * The reason is kept and rethrown from `finish`, so the failure is reported
 * once, where the caller is already looking.
 */
export function openDeflate(): DeflateSink {
	if (typeof CompressionStream !== 'function') {
		throw new CodecUnavailableError('CompressionStream', NO_COMPRESSION);
	}
	const stream: ByteTransform = new CompressionStream('deflate');
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();

	const chunks: Uint8Array[] = [];
	let total = 0;
	// Boxed rather than held bare, so a stream that failed with `undefined` is
	// still a stream that failed.
	let failure: { readonly reason: unknown } | undefined;
	const remember = (reason: unknown): void => {
		failure ??= { reason };
	};
	// A function rather than the check written out twice, because the checks
	// straddle an await and narrowing does not survive one: written inline,
	// the second `failure` reads as `never` and the compiler refuses it.
	const rethrow = (): void => {
		if (failure) throw failure.reason;
	};

	const drained = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			chunks.push(value);
			total += value.length;
		}
	})().catch(remember);

	return {
		async write(bytes: Uint8Array): Promise<void> {
			// A failed stream is not written to again. Reporting it from here
			// as well would give the caller a second error about the same
			// thing, and it would arrive in the middle of a loop over
			// scanlines rather than at the end where the output is collected.
			if (failure) return;
			await writer.ready.catch(remember);
			await writer.write(bytes as unknown as BufferSource).catch(remember);
		},
		async finish(): Promise<Uint8Array> {
			await writer.close().catch(remember);
			// Reported before the drain is waited on, and that order is the
			// whole of it. Node does not carry a failed write across to the
			// readable end: the read sits there unresolved and unrejected for
			// as long as anybody is willing to wait, so a `finish` that waited
			// for the drain first would hang instead of reporting the error it
			// already has. The drain is only worth waiting for when the stream
			// closed cleanly and the tail of the output is still in flight.
			rethrow();
			await drained;
			rethrow();
			return join(chunks, total);
		},
	};
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
