/**
 * ISOBMFF box reading.
 *
 * Every read is bounds checked and every failure throws `HeifMalformedError`
 * with the stage it happened in. This file parses untrusted bytes from a
 * stranger's file, so a truncated box has to produce a sentence rather than an
 * `undefined` that surfaces four functions later as "cannot read property of
 * undefined".
 */

import { HeifMalformedError } from '../errors.js';
import type { HeifStage } from '../errors.js';

export class ByteReader {
	readonly bytes: Uint8Array;
	private readonly view: DataView;
	private cursor: number;
	readonly end: number;
	private readonly stage: HeifStage;

	constructor(bytes: Uint8Array, stage: HeifStage, start = 0, end = bytes.length) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.cursor = start;
		this.end = end;
		this.stage = stage;
	}

	get offset(): number {
		return this.cursor;
	}

	get remaining(): number {
		return this.end - this.cursor;
	}

	private need(count: number): number {
		const at = this.cursor;
		if (at + count > this.end) {
			throw new HeifMalformedError(
				this.stage,
				`a field ran past the end of its box (wanted ${count} bytes, ${this.end - at} left)`,
				at,
			);
		}
		this.cursor = at + count;
		return at;
	}

	u8(): number {
		return this.view.getUint8(this.need(1));
	}

	u16(): number {
		return this.view.getUint16(this.need(2));
	}

	u24(): number {
		const at = this.need(3);
		return (this.view.getUint8(at) << 16) | this.view.getUint16(at + 1);
	}

	u32(): number {
		return this.view.getUint32(this.need(4));
	}

	/**
	 * A 64 bit field, as a Number.
	 *
	 * Sizes and offsets in a HEIF are file positions, and a file that does not
	 * fit in a browser tab certainly does not exceed 2^53 bytes, so the
	 * precision loss is unreachable. Anything above that is a damaged file
	 * rather than a large one, and it says so.
	 */
	u64(): number {
		const at = this.need(8);
		const value = this.view.getBigUint64(at);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new HeifMalformedError(this.stage, 'a box declared an impossible size', at);
		}
		return Number(value);
	}

	/** An unsigned integer of `size` bytes. `size` of 0 reads nothing and returns 0. */
	uint(size: number): number {
		switch (size) {
			case 0:
				return 0;
			case 1:
				return this.u8();
			case 2:
				return this.u16();
			case 3:
				return this.u24();
			case 4:
				return this.u32();
			case 8:
				return this.u64();
			default:
				throw new HeifMalformedError(
					this.stage,
					`a field declared a width of ${size} bytes`,
					this.cursor,
				);
		}
	}

	ascii(count: number): string {
		const at = this.need(count);
		let out = '';
		for (let i = 0; i < count; i += 1) out += String.fromCharCode(this.bytes[at + i] as number);
		return out;
	}

	/** A null-terminated UTF-8 string, as `infe` and `iinf` use. */
	cString(): string {
		const start = this.cursor;
		while (this.cursor < this.end && this.bytes[this.cursor] !== 0) this.cursor += 1;
		const raw = this.bytes.subarray(start, this.cursor);
		if (this.cursor < this.end) this.cursor += 1;
		return new TextDecoder().decode(raw);
	}

	slice(count: number): Uint8Array {
		const at = this.need(count);
		return this.bytes.subarray(at, at + count);
	}

	skip(count: number): void {
		this.need(count);
	}

	seek(offset: number): void {
		this.cursor = offset;
	}
}

export interface BoxHeader {
	readonly type: string;
	/** Offset of the box itself, including its header. */
	readonly start: number;
	/** Offset of the first payload byte. */
	readonly bodyStart: number;
	/** One past the last byte of the box. */
	readonly end: number;
}

/** Version and flags of a FullBox, read from the start of its payload. */
export interface FullBoxHeader {
	readonly version: number;
	readonly flags: number;
	/** Offset of the first byte after version and flags. */
	readonly bodyStart: number;
}

export function readFullBoxHeader(
	bytes: Uint8Array,
	box: BoxHeader,
	stage: HeifStage,
): FullBoxHeader {
	const reader = new ByteReader(bytes, stage, box.bodyStart, box.end);
	const version = reader.u8();
	const flags = reader.u24();
	return { version, flags, bodyStart: reader.offset };
}

/**
 * Walk the boxes between `start` and `end`.
 *
 * Stops cleanly at the first box that cannot be a box, rather than throwing,
 * because trailing padding after the last box is common and harmless. A box
 * whose declared size would overrun its parent is a real error and throws.
 */
export function* walkBoxes(
	bytes: Uint8Array,
	start: number,
	end: number,
	stage: HeifStage,
): Generator<BoxHeader> {
	let offset = start;
	while (offset + 8 <= end) {
		const reader = new ByteReader(bytes, stage, offset, end);
		let size = reader.u32();
		const type = reader.ascii(4);
		if (size === 1) {
			size = reader.u64();
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < reader.offset - offset) {
			throw new HeifMalformedError(
				stage,
				`a ${type} box declared a size smaller than its own header`,
				offset,
			);
		}
		if (offset + size > end) {
			throw new HeifMalformedError(stage, `a ${type} box ran past the end of its parent`, offset);
		}
		// A `uuid` box carries a 16 byte extended type before its payload.
		const bodyStart = type === 'uuid' ? reader.offset + 16 : reader.offset;
		yield { type, start: offset, bodyStart, end: offset + size };
		offset += size;
	}
}

/** The first child box of the given type, or undefined. */
export function findBox(
	bytes: Uint8Array,
	start: number,
	end: number,
	type: string,
	stage: HeifStage,
): BoxHeader | undefined {
	for (const box of walkBoxes(bytes, start, end, stage)) {
		if (box.type === type) return box;
	}
	return undefined;
}
