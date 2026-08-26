/**
 * Putting metadata back into a JPEG.
 *
 * Every fixture here is assembled by hand from ITU-T T.81 and the JFIF and
 * Exif specifications rather than produced by anything in `src/`. That matters
 * more than usual for this file: the code under test is byte surgery on a
 * finished file, so a fixture built by the same assumptions would agree with it
 * whatever those assumptions were.
 *
 * The insertion point is the assertion worth reading twice. A segment written
 * after a quantisation table rather than before it produces a file that opens
 * everywhere and whose metadata some readers find and others do not, which is
 * the failure that never shows up on the machine it was written on.
 */

import { describe, expect, it } from 'vitest';
import { spliceJpegMetadata } from '../../src/metadata/jpegSegments.js';

/** A marker segment: 0xff, the marker, a two byte length counting itself. */
function segment(marker: number, payload: readonly number[]): number[] {
	const length = payload.length + 2;
	return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
const EXIF_TAG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const ICC_TAG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];

/** Stands in for the entropy coded data. Never walked into by the survey. */
const SCAN = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9];

interface JpegShape {
	readonly jfif?: boolean;
	/** A quantisation table, which must stay after anything inserted. */
	readonly dqt?: boolean;
	readonly exif?: readonly number[];
	readonly profile?: readonly number[];
}

function jpeg(shape: JpegShape = {}): Uint8Array {
	const bytes: number[] = [0xff, 0xd8];
	if (shape.jfif) bytes.push(...segment(0xe0, JFIF));
	if (shape.exif) bytes.push(...segment(0xe1, [...EXIF_TAG, ...shape.exif]));
	if (shape.profile) bytes.push(...segment(0xe2, [...ICC_TAG, 1, 1, ...shape.profile]));
	if (shape.dqt)
		bytes.push(
			...segment(
				0xdb,
				Array.from({ length: 65 }, (_, i) => i & 0xff),
			),
		);
	bytes.push(...SCAN);
	return Uint8Array.from(bytes);
}

/** Walk the segments of a result, by the specification, and name what is there. */
function segmentsOf(bytes: Uint8Array): { marker: number; payload: Uint8Array }[] {
	const out: { marker: number; payload: Uint8Array }[] = [];
	let at = 2;
	while (at + 4 <= bytes.length) {
		const marker = bytes[at + 1] as number;
		if (marker === 0xda || marker === 0xd9) break;
		const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
		out.push({ marker, payload: bytes.subarray(at + 4, at + 2 + length) });
		at += 2 + length;
	}
	return out;
}

function startsWith(bytes: Uint8Array, tag: readonly number[]): boolean {
	return tag.every((value, i) => bytes[i] === value);
}

const EXIF = Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00]);
const PROFILE = Uint8Array.from(Array.from({ length: 300 }, (_, i) => i & 0xff));

describe('splicing metadata into a JPEG a canvas produced', () => {
	it('writes EXIF as an APP1 segment tagged the way a reader expects', () => {
		const out = spliceJpegMetadata(jpeg(), { exif: EXIF });
		const app1 = segmentsOf(out).filter((s) => s.marker === 0xe1);
		expect(app1).toHaveLength(1);
		// The prefix is what tells an APP1 carrying EXIF apart from one carrying
		// XMP, which is the other common occupant of that marker.
		expect(startsWith(app1[0]?.payload as Uint8Array, EXIF_TAG)).toBe(true);
		expect([...(app1[0]?.payload as Uint8Array).subarray(EXIF_TAG.length)]).toEqual([...EXIF]);
	});

	it('puts the segment after a JFIF header rather than before it', () => {
		// A JFIF APP0 belongs immediately after the start of image marker. A
		// file that puts something else first is one that some readers treat as
		// not being a JFIF file at all.
		const out = spliceJpegMetadata(jpeg({ jfif: true }), { exif: EXIF });
		const markers = segmentsOf(out).map((s) => s.marker);
		expect(markers[0]).toBe(0xe0);
		expect(markers[1]).toBe(0xe1);
	});

	it('puts the segment before the quantisation table, not after it', () => {
		const out = spliceJpegMetadata(jpeg({ jfif: true, dqt: true }), { exif: EXIF });
		const markers = segmentsOf(out).map((s) => s.marker);
		expect(markers).toEqual([0xe0, 0xe1, 0xdb]);
	});

	it('leaves the image data untouched', () => {
		const source = jpeg({ jfif: true, dqt: true });
		const out = spliceJpegMetadata(source, { exif: EXIF });
		expect([...out.subarray(out.length - SCAN.length)]).toEqual([...SCAN]);
		expect(out.length).toBe(source.length + 4 + EXIF_TAG.length + EXIF.length);
	});

	it('does not write a second EXIF segment over one already there', () => {
		// Two APP1 Exif segments is not a merge. Which one a reader believes is
		// a question with no answer in the specification.
		const source = jpeg({ exif: [1, 2, 3] });
		const out = spliceJpegMetadata(source, { exif: EXIF });
		expect(out).toBe(source);
		const app1 = segmentsOf(out).filter((s) => s.marker === 0xe1);
		expect(app1).toHaveLength(1);
		expect([...(app1[0]?.payload as Uint8Array).subarray(EXIF_TAG.length)]).toEqual([1, 2, 3]);
	});

	it('splits a profile across segments with the right sequence numbering', () => {
		const big = Uint8Array.from(Array.from({ length: 200_000 }, (_, i) => i & 0xff));
		const out = spliceJpegMetadata(jpeg(), { iccProfile: big });
		const app2 = segmentsOf(out).filter((s) => s.marker === 0xe2);
		expect(app2.length).toBeGreaterThan(1);
		const rebuilt: number[] = [];
		app2.forEach((s, index) => {
			expect(startsWith(s.payload, ICC_TAG)).toBe(true);
			// One based, and every segment carries the same total.
			expect(s.payload[ICC_TAG.length]).toBe(index + 1);
			expect(s.payload[ICC_TAG.length + 1]).toBe(app2.length);
			rebuilt.push(...s.payload.subarray(ICC_TAG.length + 2));
		});
		expect(rebuilt).toEqual([...big]);
	});

	it('leaves a profile alone when the browser already wrote one', () => {
		// Recent Chrome tags a wide gamut canvas itself. Adding ours would make
		// the colour of the file depend on which reader opened it.
		const out = spliceJpegMetadata(jpeg({ profile: [9, 9] }), { iccProfile: PROFILE });
		expect(segmentsOf(out).filter((s) => s.marker === 0xe2)).toHaveLength(1);
	});

	it('drops EXIF too large for one segment rather than writing it truncated', () => {
		// Multi-segment EXIF exists and is unevenly implemented. A block that
		// half the readers cannot parse is worse than no block.
		const huge = new Uint8Array(70_000);
		const out = spliceJpegMetadata(jpeg(), { exif: huge });
		expect(segmentsOf(out).filter((s) => s.marker === 0xe1)).toHaveLength(0);
	});

	it('writes both when both are given', () => {
		const out = spliceJpegMetadata(jpeg({ jfif: true }), { exif: EXIF, iccProfile: PROFILE });
		const markers = segmentsOf(out).map((s) => s.marker);
		expect(markers).toEqual([0xe0, 0xe1, 0xe2]);
	});

	it('hands back the same array when there is nothing to add', () => {
		const source = jpeg();
		expect(spliceJpegMetadata(source, {})).toBe(source);
		expect(spliceJpegMetadata(source, { exif: new Uint8Array(0) })).toBe(source);
	});

	it('hands back anything that is not a JPEG untouched', () => {
		// This runs on the output of an encoder that has already been checked,
		// so a surprise here means something further up is wrong, and losing
		// the metadata beats losing the picture.
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(spliceJpegMetadata(png, { exif: EXIF })).toBe(png);
		expect(spliceJpegMetadata(new Uint8Array(2), { exif: EXIF })).toBeInstanceOf(Uint8Array);
	});

	it('refuses a file whose segment length runs past the end', () => {
		// A lying length is where a naive walker reads out of bounds. Returning
		// the input is the only safe answer: the file is damaged and this is not
		// the code that should be deciding what to do about that.
		const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
		expect(spliceJpegMetadata(broken, { exif: EXIF })).toBe(broken);
	});

	it('steps over padding bytes between segments', () => {
		// A run of 0xff before a marker is legal fill and a walker that treats
		// it as a marker loses its place.
		const bytes = Uint8Array.from([
			0xff,
			0xd8,
			...segment(0xe0, JFIF),
			0xff,
			0xff,
			...segment(0xdb, [1, 2]),
			...SCAN,
		]);
		const out = spliceJpegMetadata(bytes, { exif: EXIF });
		expect(segmentsOf(out).filter((s) => s.marker === 0xe1)).toHaveLength(1);
	});
});
