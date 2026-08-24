/**
 * The ZIP compressed image data section, which is rarely one deflate stream.
 *
 * Photoshop never writes one. It stores the flattened composite raw or run
 * length encoded and keeps ZIP for the layer stack, where every channel carries
 * its own length. The writers that do use ZIP for the composite, ImageMagick
 * among them, emit one zlib stream per channel plane, laid end to end with no
 * length in front of any of them. A three channel file is three streams.
 *
 * That is the whole difficulty here. `DecompressionStream` decodes one stream
 * and then refuses whatever follows it, and it will not say how many bytes it
 * read, so there is no way to ask it where the second stream starts. What is
 * below instead is a walk over the deflate blocks that measures a stream
 * without decoding it: enough of RFC 1951 to know where every block ends, and
 * none of the copying. The platform still does the decompressing.
 *
 * The same measurement is what lets a file with padding after its image data
 * decode. The raw and run length paths have always read their exact length and
 * ignored the rest; handing everything to EOF to a decompressor that treats a
 * single spare byte as corruption is the reason ZIP did not.
 */

/** Thrown for a stream this module can describe. Anything else is a bug here. */
export class ZipFormatError extends Error {}

function fail(detail: string): never {
	throw new ZipFormatError(detail);
}

/** The order RFC 1951 stores the code length code's own lengths in. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Extra bits after length symbols 257 to 285, and after distance symbols. */
const LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** A deflate code is at most fifteen bits, which bounds every table below. */
const MAX_CODE_BITS = 15;

const MAX_LENGTH_SYMBOLS = 288;
/**
 * The fixed distance table is 32 codes, and the last two of them mean nothing.
 *
 * Building it with the 30 that are defined would be tidier and would refuse the
 * other two as a code no table describes, which is a worse sentence for the
 * same file. RFC 1951 gives all 32 a code and then says two are unused, so this
 * says the same thing and lets the check below name what it found.
 */
const FIXED_DISTANCE_SYMBOLS = 32;
/** How many of them carry a distance. Symbols past this are not defined. */
const MAX_DISTANCE_SYMBOL = 29;

interface Huffman {
	/** How many codes there are of each length, indexed by length. */
	readonly counts: Uint16Array;
	/** The symbols themselves, ordered by code length and then by symbol. */
	readonly symbols: Uint16Array;
}

/**
 * Build the canonical Huffman table a run of code lengths describes.
 *
 * Canonical means the codes are implied by the lengths alone, so counting how
 * many codes share each length and listing the symbols in order is the whole
 * table. `decode` below walks it a bit at a time, which is slower than the
 * lookup table a real inflater builds and does not matter: this only ever runs
 * over a compressed stream nobody is decompressing here.
 */
function buildHuffman(lengths: Uint8Array, count: number): Huffman {
	const counts = new Uint16Array(MAX_CODE_BITS + 1);
	for (let i = 0; i < count; i += 1) counts[lengths[i] as number] += 1;
	counts[0] = 0;

	const offsets = new Uint16Array(MAX_CODE_BITS + 2);
	for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
		offsets[length + 1] = (offsets[length] as number) + (counts[length] as number);
	}

	const symbols = new Uint16Array(count);
	for (let symbol = 0; symbol < count; symbol += 1) {
		const length = lengths[symbol] as number;
		if (length !== 0) {
			symbols[offsets[length] as number] = symbol;
			offsets[length] = (offsets[length] as number) + 1;
		}
	}
	return { counts, symbols };
}

/** The fixed tables of RFC 1951 section 3.2.6, built once and shared. */
const FIXED_LENGTHS = (() => {
	const lengths = new Uint8Array(MAX_LENGTH_SYMBOLS);
	lengths.fill(8, 0, 144);
	lengths.fill(9, 144, 256);
	lengths.fill(7, 256, 280);
	lengths.fill(8, 280, 288);
	return buildHuffman(lengths, MAX_LENGTH_SYMBOLS);
})();
const FIXED_DISTANCES = buildHuffman(
	new Uint8Array(FIXED_DISTANCE_SYMBOLS).fill(5),
	FIXED_DISTANCE_SYMBOLS,
);

/**
 * Measure one zlib stream, in bytes, without decompressing it.
 *
 * Returns the offset one past its Adler-32 checksum, which is where the next
 * stream starts if there is one. Every read is bounds checked, so a truncated
 * or invented stream names what it stopped inside rather than walking off the
 * end of the buffer.
 */
function zlibStreamEnd(bytes: Uint8Array, from: number): number {
	let at = from;
	let bit = 0;

	function readBits(count: number): number {
		let value = 0;
		for (let i = 0; i < count; i += 1) {
			if (at >= bytes.length) fail('its ZIP compressed image data ends inside a deflate block.');
			value |= (((bytes[at] as number) >> bit) & 1) << i;
			bit += 1;
			if (bit === 8) {
				bit = 0;
				at += 1;
			}
		}
		return value;
	}

	/** Walk the table a bit at a time, longest match last, as puff.c does. */
	function decode(table: Huffman): number {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
			code |= readBits(1);
			const count = table.counts[length] as number;
			if (code - first < count) return table.symbols[index + (code - first)] as number;
			index += count;
			first = (first + count) << 1;
			code <<= 1;
		}
		return fail('its ZIP compressed image data holds a Huffman code no table in it describes.');
	}

	function alignToByte(): void {
		if (bit !== 0) {
			bit = 0;
			at += 1;
		}
	}

	if (from + 2 > bytes.length) {
		fail('its ZIP compressed image data ends before the two byte zlib header it starts with.');
	}
	const cmf = bytes[from] as number;
	const flags = bytes[from + 1] as number;
	// Compression method 8 is deflate and the only one zlib ever defined, and
	// the two header bytes are chosen so that they read as a multiple of 31.
	// Both checks are how a reader tells a stream from the middle of one.
	if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flags) % 31 !== 0) {
		fail('its ZIP compressed image data does not start with a zlib header.');
	}
	if ((flags & 0x20) !== 0) {
		fail(
			'its ZIP compressed image data names a preset dictionary, which nothing writes and no decompressor here could supply.',
		);
	}
	at = from + 2;

	let final = 0;
	do {
		final = readBits(1);
		const type = readBits(2);
		if (type === 0) {
			// A stored block restarts on a byte boundary and says its own length
			// twice, once inverted. Only the first copy is needed to step over it.
			alignToByte();
			if (at + 4 > bytes.length) {
				fail('its ZIP compressed image data ends inside the header of a stored block.');
			}
			const length = (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
			at += 4 + length;
			if (at > bytes.length) fail('its ZIP compressed image data ends inside a stored block.');
			continue;
		}
		if (type === 3) {
			fail('its ZIP compressed image data holds a deflate block of the type RFC 1951 reserves.');
		}

		let lengthCodes = FIXED_LENGTHS;
		let distanceCodes = FIXED_DISTANCES;
		if (type === 2) {
			const literals = readBits(5) + 257;
			const distances = readBits(5) + 1;
			const codeLengths = readBits(4) + 4;

			const lengthsOfLengths = new Uint8Array(19);
			for (let i = 0; i < codeLengths; i += 1) {
				lengthsOfLengths[CODE_LENGTH_ORDER[i] as number] = readBits(3);
			}
			const lengthTable = buildHuffman(lengthsOfLengths, 19);

			// The code lengths of the two real tables are themselves Huffman
			// coded, with three symbols that repeat rather than state a length.
			const lengths = new Uint8Array(literals + distances);
			let written = 0;
			while (written < lengths.length) {
				const symbol = decode(lengthTable);
				if (symbol < 16) {
					lengths[written] = symbol;
					written += 1;
					continue;
				}
				let repeat: number;
				let value = 0;
				if (symbol === 16) {
					if (written === 0) {
						fail('its ZIP compressed image data repeats a code length before it has stated one.');
					}
					value = lengths[written - 1] as number;
					repeat = 3 + readBits(2);
				} else if (symbol === 17) {
					repeat = 3 + readBits(3);
				} else {
					repeat = 11 + readBits(7);
				}
				if (written + repeat > lengths.length) {
					fail('its ZIP compressed image data repeats more code lengths than its table holds.');
				}
				lengths.fill(value, written, written + repeat);
				written += repeat;
			}
			lengthCodes = buildHuffman(lengths, literals);
			distanceCodes = buildHuffman(lengths.subarray(literals), distances);
		}

		for (;;) {
			const symbol = decode(lengthCodes);
			if (symbol === 256) break;
			if (symbol < 256) continue;
			if (symbol > 285) {
				fail('its ZIP compressed image data holds a length symbol RFC 1951 does not define.');
			}
			readBits(LENGTH_EXTRA[symbol - 257] as number);
			const distance = decode(distanceCodes);
			if (distance > MAX_DISTANCE_SYMBOL) {
				fail('its ZIP compressed image data holds a distance symbol RFC 1951 does not define.');
			}
			readBits(DISTANCE_EXTRA[distance] as number);
		}
	} while (final === 0);

	alignToByte();
	if (at + 4 > bytes.length) {
		fail('its ZIP compressed image data ends before the checksum that closes it.');
	}
	return at + 4;
}

// The compression streams declare a writable of `BufferSource` and a readable
// of `Uint8Array`, which is not a `TransformStream<Uint8Array, Uint8Array>`.
interface ByteTransform {
	readonly writable: WritableStream<BufferSource>;
	readonly readable: ReadableStream<Uint8Array>;
}

/**
 * One zlib stream through the platform's decompressor.
 *
 * Written and closed on a promise of its own rather than awaited in line: a
 * decompression stream will not accept the close until the chunk has been
 * consumed, and the reader below is what consumes it, so awaiting the write
 * here deadlocks on any input larger than the internal queue.
 *
 * That promise is caught rather than dropped. A damaged stream rejects both
 * halves, and a rejection nobody is watching is an unhandled rejection that
 * takes the whole process down a tick after this function has already failed
 * correctly. The read loop below reports the same failure, with the same cause.
 */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
	const stream: ByteTransform = new DecompressionStream('deflate');
	const writer = stream.writable.getWriter();
	// `BufferSource` requires an `ArrayBuffer` backed view, while a plain
	// `Uint8Array` is declared over `ArrayBufferLike`, which also covers
	// `SharedArrayBuffer`. The values here are never shared.
	const pumping = (async () => {
		await writer.write(bytes as unknown as BufferSource);
		await writer.close();
	})();
	pumping.catch(() => undefined);

	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}
	// Reached only when the read side finished cleanly, so this surfaces a
	// failure on the write side rather than swallowing one.
	await pumping;

	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * Every channel plane out of the image data section, whatever it is made of.
 *
 * One stream is measured, decompressed and counted at a time until the planes
 * are covered, which reads a section holding a single stream and a section
 * holding one per plane the same way, and stops at the picture in both cases
 * rather than at the end of the file. `streams` caps how many are read: a file
 * cannot honestly need more of them than it has channels.
 */
export async function inflateImageData(
	bytes: Uint8Array,
	from: number,
	wanted: number,
	streams: number,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let have = 0;
	let at = from;

	for (let read = 0; read < streams && have < wanted && at < bytes.length; read += 1) {
		const end = zlibStreamEnd(bytes, at);
		const part = await inflateZlib(bytes.subarray(at, end));
		parts.push(part);
		have += part.length;
		at = end;
	}

	if (parts.length === 1) return parts[0] as Uint8Array;
	const out = new Uint8Array(have);
	let written = 0;
	for (const part of parts) {
		out.set(part, written);
		written += part.length;
	}
	return out;
}
