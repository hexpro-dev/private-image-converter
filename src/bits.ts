/**
 * Bit-level readers and writers.
 *
 * Half the formats here pack their pixels or their codes into bit fields, and
 * they do not agree on which end of a byte comes first. TIFF, CCITT and PCX
 * fill from the top bit down; GIF's LZW fills from the bottom bit up. Both
 * orders are here rather than one order and a comment, because writing the
 * wrong one produces plausible-looking noise instead of an error, and every
 * codec that got this wrong got it wrong silently.
 *
 * Reading past the end returns zero bits rather than throwing. A truncated
 * file is a normal thing to be handed, and the codec that called this is in a
 * better position to say what was missing than a reader that only knows it ran
 * out. Ask `exhausted` when that matters.
 */

/** Bits fill from the most significant end of each byte. TIFF, CCITT, PCX. */
export class MsbBitReader {
	private readonly bytes: Uint8Array;
	private readonly end: number;
	private at: number;
	/** How many bits of `bytes[at]` have already been handed out. */
	private used = 0;

	constructor(bytes: Uint8Array, from = 0, end = bytes.length) {
		this.bytes = bytes;
		this.at = from;
		this.end = Math.min(end, bytes.length);
	}

	/** True once every bit in the range has been read. */
	get exhausted(): boolean {
		return this.at >= this.end;
	}

	/** Bits consumed so far, counted from the start of the range. */
	get position(): number {
		return this.at * 8 + this.used;
	}

	/**
	 * Read `count` bits, most significant first.
	 *
	 * `count` may be up to 24. Beyond that the shifting would meet JavaScript's
	 * 32 bit bitwise operators, and a code that long does not occur in any
	 * format here.
	 */
	read(count: number): number {
		let value = 0;
		let left = count;
		while (left > 0) {
			if (this.at >= this.end) return value << left;
			const available = 8 - this.used;
			const take = Math.min(available, left);
			const byte = this.bytes[this.at] as number;
			const chunk = (byte >> (available - take)) & ((1 << take) - 1);
			value = (value << take) | chunk;
			this.used += take;
			left -= take;
			if (this.used === 8) {
				this.used = 0;
				this.at += 1;
			}
		}
		return value;
	}

	/** Read one bit. The common case, and worth not going through `read`. */
	readBit(): number {
		if (this.at >= this.end) return 0;
		const bit = ((this.bytes[this.at] as number) >> (7 - this.used)) & 1;
		this.used += 1;
		if (this.used === 8) {
			this.used = 0;
			this.at += 1;
		}
		return bit;
	}

	/** Look at the next `count` bits without consuming them. */
	peek(count: number): number {
		const at = this.at;
		const used = this.used;
		const value = this.read(count);
		this.at = at;
		this.used = used;
		return value;
	}

	skip(count: number): void {
		const total = this.at * 8 + this.used + count;
		this.at = Math.floor(total / 8);
		this.used = total % 8;
	}

	/** Discard the rest of the current byte. Row-aligned formats need this. */
	alignToByte(): void {
		if (this.used !== 0) {
			this.used = 0;
			this.at += 1;
		}
	}
}

/** Bits fill from the least significant end of each byte. GIF's LZW. */
export class LsbBitReader {
	private readonly bytes: Uint8Array;
	private readonly end: number;
	private at: number;
	private used = 0;

	constructor(bytes: Uint8Array, from = 0, end = bytes.length) {
		this.bytes = bytes;
		this.at = from;
		this.end = Math.min(end, bytes.length);
	}

	get exhausted(): boolean {
		return this.at >= this.end;
	}

	get position(): number {
		return this.at * 8 + this.used;
	}

	read(count: number): number {
		let value = 0;
		let filled = 0;
		while (filled < count) {
			if (this.at >= this.end) return value;
			const available = 8 - this.used;
			const take = Math.min(available, count - filled);
			const byte = this.bytes[this.at] as number;
			const chunk = (byte >> this.used) & ((1 << take) - 1);
			value |= chunk << filled;
			this.used += take;
			filled += take;
			if (this.used === 8) {
				this.used = 0;
				this.at += 1;
			}
		}
		return value;
	}

	alignToByte(): void {
		if (this.used !== 0) {
			this.used = 0;
			this.at += 1;
		}
	}
}

/**
 * A growing bit writer, most significant bit first.
 *
 * Grows by doubling rather than by taking a size up front, because the callers
 * are compressors and none of them knows how long the output will be until it
 * has written it.
 */
export class MsbBitWriter {
	private bytes = new Uint8Array(1024);
	private length = 0;
	private current = 0;
	private filled = 0;

	private grow(): void {
		if (this.length < this.bytes.length) return;
		const bigger = new Uint8Array(this.bytes.length * 2);
		bigger.set(this.bytes);
		this.bytes = bigger;
	}

	write(value: number, count: number): void {
		for (let i = count - 1; i >= 0; i -= 1) {
			this.writeBit((value >> i) & 1);
		}
	}

	writeBit(bit: number): void {
		this.current = (this.current << 1) | (bit & 1);
		this.filled += 1;
		if (this.filled === 8) {
			this.grow();
			this.bytes[this.length] = this.current;
			this.length += 1;
			this.current = 0;
			this.filled = 0;
		}
	}

	/** Pad the current byte with zero bits. */
	alignToByte(): void {
		while (this.filled !== 0) this.writeBit(0);
	}

	/** Everything written, with any part-filled last byte padded out. */
	finish(): Uint8Array {
		this.alignToByte();
		return this.bytes.slice(0, this.length);
	}
}

/** A growing bit writer, least significant bit first. GIF's LZW. */
export class LsbBitWriter {
	private bytes = new Uint8Array(1024);
	private length = 0;
	private current = 0;
	private filled = 0;

	private grow(): void {
		if (this.length < this.bytes.length) return;
		const bigger = new Uint8Array(this.bytes.length * 2);
		bigger.set(this.bytes);
		this.bytes = bigger;
	}

	write(value: number, count: number): void {
		for (let i = 0; i < count; i += 1) {
			this.current |= ((value >> i) & 1) << this.filled;
			this.filled += 1;
			if (this.filled === 8) {
				this.grow();
				this.bytes[this.length] = this.current;
				this.length += 1;
				this.current = 0;
				this.filled = 0;
			}
		}
	}

	alignToByte(): void {
		if (this.filled !== 0) {
			this.grow();
			this.bytes[this.length] = this.current;
			this.length += 1;
			this.current = 0;
			this.filled = 0;
		}
	}

	finish(): Uint8Array {
		this.alignToByte();
		return this.bytes.slice(0, this.length);
	}
}

/**
 * A byte buffer that grows, for encoders that write whole bytes.
 *
 * Every encoder here was otherwise doing the same three lines of doubling, and
 * two of them had the reallocation slightly wrong in a way that only showed on
 * an image large enough to cross the boundary twice.
 */
export class ByteWriter {
	private bytes: Uint8Array;
	private length = 0;

	constructor(capacity = 1024) {
		this.bytes = new Uint8Array(Math.max(16, capacity));
	}

	get size(): number {
		return this.length;
	}

	private reserve(extra: number): void {
		if (this.length + extra <= this.bytes.length) return;
		let capacity = this.bytes.length;
		while (capacity < this.length + extra) capacity *= 2;
		const bigger = new Uint8Array(capacity);
		bigger.set(this.bytes.subarray(0, this.length));
		this.bytes = bigger;
	}

	u8(value: number): void {
		this.reserve(1);
		this.bytes[this.length] = value & 0xff;
		this.length += 1;
	}

	u16le(value: number): void {
		this.u8(value);
		this.u8(value >>> 8);
	}

	u16be(value: number): void {
		this.u8(value >>> 8);
		this.u8(value);
	}

	u32le(value: number): void {
		this.u16le(value & 0xffff);
		this.u16le((value >>> 16) & 0xffff);
	}

	u32be(value: number): void {
		this.u16be((value >>> 16) & 0xffff);
		this.u16be(value & 0xffff);
	}

	bytesOf(source: Uint8Array): void {
		this.reserve(source.length);
		this.bytes.set(source, this.length);
		this.length += source.length;
	}

	ascii(text: string): void {
		this.reserve(text.length);
		for (let i = 0; i < text.length; i += 1) {
			this.bytes[this.length + i] = text.charCodeAt(i) & 0xff;
		}
		this.length += text.length;
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.length);
	}
}
