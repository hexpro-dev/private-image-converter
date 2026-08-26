/**
 * Deciding a file's colour space from what it carries.
 *
 * Every profile here is assembled byte by byte from the ICC layout rather than
 * lifted out of a photograph, and every colourant in it is a published number
 * with a source beside it. That matters more here than in most fixtures: the
 * predicate under test is nine comparisons against a table, so a fixture built
 * from the same table proves only that the table equals itself.
 *
 * The failure this file exists to hold shut is quiet. A profile that is wide
 * but is not Display P3, and Adobe RGB is the one people have, used to answer
 * true, so the browser was asked for a Display P3 readback and the source's
 * Adobe RGB profile was then written out beside pixels that had become P3
 * numbers. Nothing throws. It looks right in a viewer that ignores profiles and
 * wrong in every viewer that does not, which is the wrong way round for
 * catching it.
 */

import { describe, expect, it } from 'vitest';
import { iccIsWideGamut as heifIccIsWideGamut } from '../../src/heif/image.js';
import { declaresWideGamut, findIccProfile, iccIsWideGamut } from '../../src/metadata/icc.js';

function u8(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function hex(text: string): Uint8Array {
	const clean = text.replace(/\s+/g, '');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function writeAscii(bytes: Uint8Array, at: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
}

/**
 * ICC fixtures.
 *
 * A profile is a 128 byte header, a tag count, a table of twelve byte entries,
 * and the tag data. Only the three colourants matter to this reader, so they
 * are the only tags with real numbers in them.
 */

interface IccTag {
	readonly signature: string;
	readonly data: Uint8Array;
	/** Where the table claims the data is, for when that is to be a lie. */
	readonly offset?: number;
}

/** s15Fixed16: a signed 32 bit number with sixteen fractional bits. */
function fixed16(value: number): number {
	return Math.round(value * 65536);
}

/** An XYZType tag: a signature, four reserved bytes, then X, Y and Z. */
function xyzTag(xyz: readonly [number, number, number]): Uint8Array {
	const data = new Uint8Array(20);
	const view = new DataView(data.buffer);
	writeAscii(data, 0, 'XYZ ');
	view.setInt32(8, fixed16(xyz[0]));
	view.setInt32(12, fixed16(xyz[1]));
	view.setInt32(16, fixed16(xyz[2]));
	return data;
}

function asciiTag(text: string): Uint8Array {
	const data = new Uint8Array(text.length);
	writeAscii(data, 0, text);
	return data;
}

function iccProfile(tags: readonly IccTag[], declaredCount = tags.length): Uint8Array {
	const tableAt = 128;
	let cursor = tableAt + 4 + tags.length * 12;
	const placed = tags.map((tag) => {
		if (tag.offset !== undefined) return { tag, at: tag.offset, embedded: false };
		const at = cursor;
		cursor += tag.data.length + ((4 - (tag.data.length % 4)) % 4);
		return { tag, at, embedded: true };
	});

	const bytes = new Uint8Array(Math.max(cursor, 132));
	const view = new DataView(bytes.buffer);
	// The size field and the 'acsp' signature, so the fixture is shaped like a
	// profile even though this reader looks at neither.
	view.setUint32(0, bytes.length);
	writeAscii(bytes, 36, 'acsp');
	view.setUint32(tableAt, declaredCount);
	placed.forEach((entry, i) => {
		const at = tableAt + 4 + i * 12;
		writeAscii(bytes, at, entry.tag.signature);
		view.setUint32(at + 4, entry.at);
		view.setUint32(at + 8, entry.tag.data.length);
		if (entry.embedded) bytes.set(entry.tag.data, entry.at);
	});
	return bytes;
}

/** The three colourants of one RGB space, in the order red, green, blue. */
interface Gamut {
	readonly r: readonly [number, number, number];
	readonly g: readonly [number, number, number];
	readonly b: readonly [number, number, number];
}

/**
 * The colourants of the RGB spaces people actually tag files with.
 *
 * XYZ against the D50 profile connection space, which is what an ICC
 * matrix/TRC profile stores, and not the D65 matrix printed in the primaries
 * specification. The two differ by more than the tolerance under test: sRGB's
 * red X is 0.4124 in the Rec.709 matrix and 0.4361 once it has been Bradford
 * adapted to D50 for the profile. A table built from the wrong one of those
 * would put every space in the wrong place and the tests would still look
 * orderly.
 *
 * Each row was derived from that space's published primaries and white point,
 * adapted to D50 through Bradford, and then checked against the profile Apple
 * ships for it in /System/Library/ColorSync/Profiles: Display P3.icc,
 * sRGB Profile.icc, AdobeRGB1998.icc, ROMM RGB.icc, ITU-2020.icc and
 * DCI(P3) RGB.icc. The numbers below are the profiles' own, to five decimals,
 * so this is a table of what is in the files rather than of what the maths
 * says should be.
 */
const GAMUTS = {
	srgb: {
		r: [0.43607, 0.22249, 0.01392],
		g: [0.38515, 0.71687, 0.09708],
		b: [0.14307, 0.06061, 0.7141],
	},
	displayP3: {
		r: [0.51512, 0.2412, -0.00105],
		g: [0.29198, 0.69225, 0.04189],
		b: [0.1571, 0.06657, 0.78407],
	},
	adobeRgb: {
		r: [0.60974, 0.31111, 0.01947],
		g: [0.20528, 0.62567, 0.06087],
		b: [0.14919, 0.06322, 0.74457],
	},
	proPhoto: {
		r: [0.79767, 0.28804, 0],
		g: [0.13519, 0.71188, 0],
		b: [0.03136, 0.00009, 0.8252],
	},
	rec2020: {
		r: [0.67348, 0.27904, -0.00194],
		g: [0.16566, 0.67534, 0.02998],
		b: [0.12505, 0.04561, 0.79684],
	},
	/**
	 * The same primaries as Display P3 on the theatre white point, which is
	 * green next to D65. The gamut is the same triangle and the profile is not
	 * interchangeable, which is the distinction the tolerance has to keep.
	 */
	dciP3: {
		r: [0.48616, 0.22668, -0.00081],
		g: [0.32385, 0.71033, 0.04323],
		b: [0.15419, 0.06299, 0.78247],
	},
} as const satisfies Record<string, Gamut>;

type GamutName = keyof typeof GAMUTS;

/** A profile carrying a description and the three colourants, as a real one does. */
function profileOf(gamut: Gamut, description = 'Fixture'): Uint8Array {
	return iccProfile([
		{ signature: 'desc', data: asciiTag(description) },
		{ signature: 'rXYZ', data: xyzTag(gamut.r) },
		{ signature: 'gXYZ', data: xyzTag(gamut.g) },
		{ signature: 'bXYZ', data: xyzTag(gamut.b) },
	]);
}

/** Every colourant moved by the same amount, for the profiles at the margin. */
function nudged(gamut: Gamut, by: number): Gamut {
	const move = (xyz: readonly [number, number, number]) =>
		[xyz[0] + by, xyz[1] + by, xyz[2] + by] as const;
	return { r: move(gamut.r), g: move(gamut.g), b: move(gamut.b) };
}

function p3Profile(): Uint8Array {
	return profileOf(GAMUTS.displayP3);
}

function srgbProfile(): Uint8Array {
	return profileOf(GAMUTS.srgb);
}

/**
 * A P3 profile with a copyright tag behind the colourants.
 *
 * For the one test that needs the last sixteen bytes of the profile to be
 * bytes nothing reads, so that losing them changes the answer only if the
 * length is checked.
 */
function paddedP3Profile(): Uint8Array {
	return iccProfile([
		{ signature: 'desc', data: asciiTag('Fixture') },
		{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) },
		{ signature: 'gXYZ', data: xyzTag(GAMUTS.displayP3.g) },
		{ signature: 'bXYZ', data: xyzTag(GAMUTS.displayP3.b) },
		{ signature: 'cprt', data: asciiTag('Copyright, thirty two bytes long.') },
	]);
}

describe('deciding gamut from an ICC profile', () => {
	const VERDICTS: readonly [GamutName, boolean][] = [
		['srgb', false],
		['displayP3', true],
		['adobeRgb', false],
		['proPhoto', false],
		['rec2020', false],
		['dciP3', false],
	];

	it.each(VERDICTS)('reads %s as Display P3: %s', (name, expected) => {
		expect(iccIsWideGamut(profileOf(GAMUTS[name]))).toBe(expected);
	});

	it('calls Adobe RGB narrow even though its red is further out than P3s', () => {
		// The regression, named. The test this replaces was a single comparison,
		// red's X against 0.48, so Adobe RGB at 0.6097 passed it comfortably, as
		// did ProPhoto at 0.7977 and Rec.2020 at 0.6735. Every one of those files
		// was then decoded through a Display P3 readback and written out still
		// carrying the profile it arrived with, so the pixels said one gamut and
		// the tag beside them said another.
		//
		// The first two assertions are what makes this test bite rather than
		// merely pass: they pin that these profiles would have gone the other
		// way under the old rule, so restoring it cannot leave this green.
		for (const name of ['adobeRgb', 'proPhoto', 'rec2020'] as const) {
			expect(GAMUTS[name].r[0]).toBeGreaterThan(0.48);
			expect(GAMUTS.displayP3.r[0]).toBeGreaterThan(0.48);
			expect(iccIsWideGamut(profileOf(GAMUTS[name]))).toBe(false);
		}
	});

	it('refuses a profile whose red is P3s and whose green and blue are not', () => {
		// Adobe RGB and Display P3 are close in area and nothing alike in shape,
		// so the corner that matches says nothing about the two that do not.
		const mixed = { r: GAMUTS.displayP3.r, g: GAMUTS.srgb.g, b: GAMUTS.srgb.b };
		expect(iccIsWideGamut(profileOf(mixed))).toBe(false);
	});

	it('refuses a profile carrying a P3 red colourant and nothing else', () => {
		// One tag is not a gamut. It is also the shape of the fixture the old
		// tests used, so a reader that still answers from red alone passes every
		// other case here and fails this one.
		const profile = iccProfile([{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) }]);
		expect(iccIsWideGamut(profile)).toBe(false);
	});

	it('accepts a profile measured off a panel rather than computed', () => {
		// Display profiles are generated from measurements and land near the
		// published numbers rather than on them, so the test cannot be equality.
		// Half a percent of a colourant is comfortably inside the tolerance and
		// nowhere near any other space.
		expect(iccIsWideGamut(profileOf(nudged(GAMUTS.displayP3, 0.005)))).toBe(true);
		expect(iccIsWideGamut(profileOf(nudged(GAMUTS.displayP3, -0.008)))).toBe(true);
	});

	it('puts the line at 0.02 from each colourant', () => {
		// Pinned so that widening the tolerance is a deliberate act with a test
		// to change. It cannot go past about 0.03 without DCI-P3 matching, and
		// DCI-P3 pixels are not Display P3 pixels.
		expect(iccIsWideGamut(profileOf(nudged(GAMUTS.displayP3, 0.0199)))).toBe(true);
		expect(iccIsWideGamut(profileOf(nudged(GAMUTS.displayP3, 0.0201)))).toBe(false);
	});

	it('ignores a description that says Display P3 when the colourants say sRGB', () => {
		// Vendors rewrite the description between releases and copy each other's
		// wording. The numbers are the profile; the text beside them is not.
		expect(iccIsWideGamut(profileOf(GAMUTS.srgb, 'Display P3'))).toBe(false);
	});

	it('refuses a buffer too short to hold a header and a tag count', () => {
		expect(iccIsWideGamut(new Uint8Array(131))).toBe(false);
	});

	it('refuses a tag count no profile would carry', () => {
		// Reached by handing this arbitrary bytes, where the four at offset 128
		// are as likely to be four billion as anything else. Trusting the count
		// is a loop over a table that is not there.
		expect(
			iccIsWideGamut(iccProfile([{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) }], 0)),
		).toBe(false);
		const many = iccProfile([{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) }], 0x7fffffff);
		expect(iccIsWideGamut(many)).toBe(false);
	});

	it('refuses a profile whose table has no colourants', () => {
		expect(iccIsWideGamut(iccProfile([{ signature: 'desc', data: asciiTag('sRGB') }]))).toBe(false);
	});

	it('refuses a table entry that runs off the end rather than reading past it', () => {
		// A profile of exactly 132 bytes has room for the header and the count
		// and none for the twelve byte entry the count promises. The entry is
		// read a byte at a time out of a DataView, so walking into it throws a
		// RangeError rather than returning a wrong answer, and a throw here is
		// a failed conversion of a file that was only ever going to be sRGB.
		const bytes = new Uint8Array(132);
		new DataView(bytes.buffer).setUint32(128, 1);
		expect(iccIsWideGamut(bytes)).toBe(false);
	});

	it('finds colourants at the far end of a table of the largest size it accepts', () => {
		// A real profile has them after the description, the copyright and the
		// white point, and the loop has to reach them. 1024 entries is the
		// ceiling this reader sets, so a profile with exactly that many is the
		// largest it must still read and one more is the point at which it stops
		// trusting the count.
		const filler = (count: number) =>
			Array.from({ length: count }, () => ({ signature: 'wtpt', data: new Uint8Array(0) }));
		const colourants = [
			{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) },
			{ signature: 'gXYZ', data: xyzTag(GAMUTS.displayP3.g) },
			{ signature: 'bXYZ', data: xyzTag(GAMUTS.displayP3.b) },
		];
		expect(iccIsWideGamut(iccProfile([...filler(1021), ...colourants]))).toBe(true);
		expect(iccIsWideGamut(iccProfile([...filler(1022), ...colourants]))).toBe(false);
	});

	it('refuses a colourant entry pointing outside the profile', () => {
		// This is what a profile truncated partway through looks like: the table
		// survives and the data it names does not. The wrong answer here is a
		// confident one taken from whatever bytes follow.
		const profile = iccProfile([
			{ signature: 'desc', data: asciiTag('Display P3') },
			{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) },
			{ signature: 'gXYZ', data: xyzTag(GAMUTS.displayP3.g) },
			{ signature: 'bXYZ', data: xyzTag(GAMUTS.displayP3.b), offset: 4096 },
		]);
		expect(iccIsWideGamut(profile)).toBe(false);
	});
});

/**
 * The same question, asked twice.
 *
 * `src/heif/image.ts` carries its own copy of this predicate because
 * `eslint.config.js` forbids `src/heif/**` from importing `src/metadata/**`,
 * which keeps the container reader liftable into a package of its own. The
 * copy is cheap; the two disagreeing is not, because an iPhone photograph goes
 * through the HEIF one and the same picture exported as a JPEG goes through
 * this one, and a user comparing the two outputs would be looking at the same
 * image in two colour spaces.
 */
describe('the copy of this predicate in the HEIF reader', () => {
	const redOnly = () => iccProfile([{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) }]);
	const CASES: readonly [string, Uint8Array][] = [
		...(Object.keys(GAMUTS) as GamutName[]).map((name): [string, Uint8Array] => [
			name,
			profileOf(GAMUTS[name]),
		]),
		['a panel measured near P3', profileOf(nudged(GAMUTS.displayP3, 0.005))],
		['a panel measured well off P3', profileOf(nudged(GAMUTS.displayP3, 0.05))],
		['P3 red and nothing else', redOnly()],
		['no colourants at all', iccProfile([{ signature: 'desc', data: asciiTag('sRGB') }])],
		[
			'a tag count of zero',
			iccProfile([{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) }], 0),
		],
		['nothing but zeroes', new Uint8Array(300)],
		['too few bytes to be a profile', new Uint8Array(131)],
		[
			'a colourant pointing past the end',
			iccProfile([
				{ signature: 'rXYZ', data: xyzTag(GAMUTS.displayP3.r) },
				{ signature: 'gXYZ', data: xyzTag(GAMUTS.displayP3.g) },
				{ signature: 'bXYZ', data: xyzTag(GAMUTS.displayP3.b), offset: 4096 },
			]),
		],
	];

	it.each(CASES)('agrees on %s', (_name, profile) => {
		expect(heifIccIsWideGamut(profile)).toBe(iccIsWideGamut(profile));
	});

	it('is being compared against a table that contains both answers', () => {
		// Two predicates that both return false for everything agree perfectly.
		const answers = CASES.map(([, profile]) => iccIsWideGamut(profile));
		expect(answers).toContain(true);
		expect(answers).toContain(false);
	});
});

/**
 * PNG fixtures. The chunk CRCs are left as four zero bytes, because the profile
 * reader walks past them and never checks one.
 */

const PNG_SIGNATURE = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	new DataView(out.buffer).setUint32(0, data.length);
	writeAscii(out, 4, type);
	out.set(data, 8);
	return out;
}

function png(...chunks: Uint8Array[]): Uint8Array {
	const ihdr = pngChunk('IHDR', u8(0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0));
	return concat([PNG_SIGNATURE, ihdr, ...chunks, pngChunk('IEND', new Uint8Array(0))]);
}

/** Colour primaries, transfer characteristics, matrix coefficients, full range. */
function cicpChunk(primaries: number): Uint8Array {
	return pngChunk('cICP', u8(primaries, 13, 0, 1));
}

/** A profile name, a NUL, the compression method, then deflated bytes. */
function iccpChunk(): Uint8Array {
	return pngChunk('iCCP', u8(0x50, 0x33, 0, 0, 0x78, 0x9c, 0x03, 0x00));
}

function idatChunk(): Uint8Array {
	return pngChunk('IDAT', u8(0x78, 0x9c, 0x03, 0x00));
}

describe('what a PNG declares', () => {
	it('reads Display P3 out of a cICP chunk carrying 12', () => {
		// Primaries 12 is SMPTE EG 432-1. An iPhone screenshot says P3 this way
		// and carries no profile at all, so a reader that only looks for iCCP
		// calls the most common wide gamut file on the platform narrow.
		expect(declaresWideGamut(png(cicpChunk(12), idatChunk()), 'png')).toBe(true);
	});

	it('leaves a cICP chunk naming BT.709 alone', () => {
		expect(declaresWideGamut(png(cicpChunk(1), idatChunk()), 'png')).toBe(false);
	});

	it('finds an iCCP chunk but will not call it wide without inflating it', () => {
		// The profile is deflated, and inflating it would make the whole call
		// async to answer one boolean. Reporting narrow is the safe half of the
		// answer: it leaves the image in sRGB, which is where dropping the
		// profile would have left it anyway.
		const bytes = png(iccpChunk(), idatChunk());
		// An empty array rather than undefined, which is the difference between
		// "there is a profile here and its contents are unknown" and "there is
		// no profile". The two are told apart by length, so pin the length
		// rather than only that something came back.
		expect(findIccProfile(bytes, 'png')?.length).toBe(0);
		expect(declaresWideGamut(bytes, 'png')).toBe(false);
	});

	it('stops at IDAT, where a colour chunk can no longer legally appear', () => {
		// Anything found after the image data is not a declaration, and walking
		// on means reading every chunk of a large file to learn nothing.
		expect(declaresWideGamut(png(idatChunk(), cicpChunk(12)), 'png')).toBe(false);
	});

	it('will not read a cICP chunk the file is too short to be carrying', () => {
		// Both ways a truncated download can land inside this chunk. The chunk
		// is sixteen bytes: four of length, four of type, four of data and four
		// of CRC, and the primaries byte is the first of the data.
		//
		// The second cut is the one that matters. The primaries byte is there
		// and says 12, and everything needed to find it is there, so a reader
		// that takes the byte without first checking the chunk arrived whole
		// calls a half downloaded file wide gamut on the strength of four
		// bytes that were never followed by their CRC.
		const CHUNK_STARTS_AT = PNG_SIGNATURE.length + 12 + 13;
		const bytes = png(cicpChunk(12), idatChunk());
		for (const kept of [9, 12]) {
			const cut = bytes.subarray(0, CHUNK_STARTS_AT + kept);
			expect(cut[CHUNK_STARTS_AT + 8]).toBe(12);
			expect(declaresWideGamut(cut, 'png')).toBe(false);
		}
	});

	it('returns false for a PNG with no colour chunk at all', () => {
		expect(declaresWideGamut(png(idatChunk()), 'png')).toBe(false);
	});
});

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + data.length + (data.length & 1));
	writeAscii(out, 0, fourcc);
	new DataView(out.buffer).setUint32(4, data.length, true);
	out.set(data, 8);
	return out;
}

function webp(...chunks: Uint8Array[]): Uint8Array {
	const body = concat(chunks);
	const out = new Uint8Array(12 + body.length);
	writeAscii(out, 0, 'RIFF');
	new DataView(out.buffer).setUint32(4, 4 + body.length, true);
	writeAscii(out, 8, 'WEBP');
	out.set(body, 12);
	return out;
}

describe('what a WebP declares', () => {
	it('reads a Display P3 profile out of an ICCP chunk', () => {
		expect(declaresWideGamut(webp(riffChunk('ICCP', p3Profile())), 'webp')).toBe(true);
	});

	it('calls an sRGB profile in the same chunk narrow', () => {
		expect(declaresWideGamut(webp(riffChunk('ICCP', srgbProfile())), 'webp')).toBe(false);
	});

	it('steps over the pad byte RIFF adds after an odd length chunk', () => {
		// The pad is not counted in the chunk's size. Walking without it lands
		// one byte into the next fourcc, and every chunk after that is lost.
		const bytes = webp(riffChunk('EXIF', new Uint8Array(5)), riffChunk('ICCP', p3Profile()));
		expect(declaresWideGamut(bytes, 'webp')).toBe(true);
	});

	it('reads a profile that starts partway into the file, not at the front of the buffer', () => {
		// The profile comes back as a view into the WebP rather than a copy, so
		// a DataView built on the underlying buffer without its byte offset
		// reads the RIFF header where the profile header should be.
		const found = findIccProfile(webp(riffChunk('ICCP', p3Profile())), 'webp') ?? new Uint8Array(0);
		expect(found.byteOffset).toBeGreaterThan(0);
		expect(iccIsWideGamut(found)).toBe(true);
	});

	it('will not read an ICCP chunk whose size field is larger than the file', () => {
		// A subarray past the end of a Uint8Array is clipped rather than
		// refused, so a size field that lies by sixteen bytes yields a profile
		// that is short by sixteen bytes and says nothing about it. The sixteen
		// bytes missing from this fixture are the tail of a copyright string,
		// which nothing reads, so without the length check the answer comes
		// back wide and confident off a file that is damaged.
		const profile = paddedP3Profile();
		const bytes = webp(riffChunk('ICCP', profile));
		// The chunk starts after the twelve byte RIFF header, and its size is
		// the four bytes after the fourcc.
		new DataView(bytes.buffer).setUint32(12 + 4, profile.length + 16, true);
		expect(declaresWideGamut(bytes, 'webp')).toBe(false);
	});

	it('returns false for a WebP with no ICCP chunk', () => {
		expect(declaresWideGamut(webp(riffChunk('VP8 ', new Uint8Array(10))), 'webp')).toBe(false);
	});
});

const ICC_MARKER = 'ICC_PROFILE';

/** One APP2 segment carrying a numbered part of a profile. Parts count from 1. */
function app2Icc(index: number, count: number, data: Uint8Array): Uint8Array {
	const length = 2 + ICC_MARKER.length + 1 + 2 + data.length;
	const out = new Uint8Array(2 + length);
	out[0] = 0xff;
	out[1] = 0xe2;
	new DataView(out.buffer).setUint16(2, length);
	writeAscii(out, 4, ICC_MARKER);
	out[4 + ICC_MARKER.length] = 0;
	out[5 + ICC_MARKER.length] = index;
	out[6 + ICC_MARKER.length] = count;
	out.set(data, 7 + ICC_MARKER.length);
	return out;
}

/**
 * An APP2 segment that is not a profile.
 *
 * A phone with more than one camera writes a Multi-Picture Format segment,
 * which is APP2 marked `MPF\0`, and it comes before the ICC one. Anything that
 * treats APP2 as meaning ICC concatenates this into the profile.
 */
function app2Mpf(): Uint8Array {
	// 'MPF\0', a TIFF header, and an index directory of three entries, which is
	// the size a real one runs to. Size matters here: a segment shorter than
	// the ICC marker leaves nothing behind it to mistake for profile data, and
	// this one is long enough that mistaking it puts forty bytes at the front
	// of the profile. The byte a reader would take as the part number is the
	// high half of the entry count, which is zero, so the mistake sorts itself
	// ahead of the real first part.
	const body = concat([
		hex('4d504600 4d4d 002a 00000008 0003'),
		new Uint8Array(3 * 12),
		new Uint8Array(4),
	]);
	const out = new Uint8Array(4 + body.length);
	out[0] = 0xff;
	out[1] = 0xe2;
	new DataView(out.buffer).setUint16(2, 2 + body.length);
	out.set(body, 4);
	return out;
}

/** An APP2 with a length of two, which is to say no payload at all. */
const EMPTY_APP2 = u8(0xff, 0xe2, 0x00, 0x02);

const SOI = u8(0xff, 0xd8);
const SOS = u8(0xff, 0xda, 0x00, 0x02);
const EOI = u8(0xff, 0xd9);
/** The JFIF header almost every JPEG opens with, so the walker has to pass one. */
const JFIF = u8(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);

function jpeg(...segments: Uint8Array[]): Uint8Array {
	return concat([SOI, JFIF, ...segments, SOS, EOI]);
}

describe('what a JPEG declares', () => {
	it('reads a profile out of a single ICC_PROFILE APP2 segment', () => {
		expect(declaresWideGamut(jpeg(app2Icc(1, 1, p3Profile())), 'jpeg')).toBe(true);
		expect(declaresWideGamut(jpeg(app2Icc(1, 1, srgbProfile())), 'jpeg')).toBe(false);
	});

	it('joins a profile split across two APP2 segments in index order, not file order', () => {
		// A profile past 65533 bytes has to be split, and the segments are not
		// required to appear in order. This fixture puts part two first and cuts
		// before the tag table, so joining as they come, or reading only the
		// first, gives a profile whose table points at the wrong bytes.
		const profile = p3Profile();
		const cut = 100;
		const bytes = jpeg(
			app2Icc(2, 2, profile.subarray(cut)),
			app2Icc(1, 2, profile.subarray(0, cut)),
		);
		expect(findIccProfile(bytes, 'jpeg')).toEqual(profile);
		expect(declaresWideGamut(bytes, 'jpeg')).toBe(true);
	});

	it('gives no gamut answer from the first segment of a split profile alone', () => {
		expect(declaresWideGamut(jpeg(app2Icc(1, 2, p3Profile().subarray(0, 100))), 'jpeg')).toBe(
			false,
		);
		// The more dangerous cut is further in, past the header and the tag
		// table. The table survives and names three colourants, of which only
		// the first arrived, so there is a plausible looking profile with two
		// thirds of the answer missing.
		expect(declaresWideGamut(jpeg(app2Icc(1, 2, p3Profile().subarray(0, 200))), 'jpeg')).toBe(
			false,
		);
	});

	it('gives up where the segment structure stops making sense', () => {
		// The same two ways of losing the thread that findExif is held to in
		// exif.test.ts, because these are two walks over the same containers
		// and a guard that exists in one of them and not the other is the sort
		// of gap nobody finds until a damaged file reaches it.
		const good = app2Icc(1, 1, p3Profile());
		// A marker has to start with 0xff, and this one does not.
		expect(declaresWideGamut(concat([SOI, u8(0x00, 0x00, 0x00, 0x10), good]), 'jpeg')).toBe(false);
		// A length of zero, from a segment claiming to be shorter than the two
		// bytes of the length field itself.
		expect(declaresWideGamut(concat([SOI, u8(0xff, 0xe2, 0x00, 0x00), good]), 'jpeg')).toBe(false);
	});

	it('walks past an APP2 that is not a profile', () => {
		// The marker string is the whole of the test for whether a segment is
		// a profile. Skipping it and taking any APP2 puts twelve bytes of
		// Multi-Picture Format at the front of the profile, and every offset in
		// the tag table then points twelve bytes short of what it names.
		const bytes = jpeg(app2Mpf(), app2Icc(1, 1, p3Profile()));
		expect(findIccProfile(bytes, 'jpeg')).toEqual(p3Profile());
		expect(declaresWideGamut(bytes, 'jpeg')).toBe(true);
	});

	it('steps over an APP2 too short to hold a marker without losing its place', () => {
		// The marker check reads twelve bytes whether the segment has twelve
		// bytes or not, so this one is read into the segment behind it. What
		// must not happen is the walk advancing by anything other than this
		// segment's own length, because after that every offset is wrong and
		// the profile behind it is never found.
		expect(declaresWideGamut(jpeg(EMPTY_APP2), 'jpeg')).toBe(false);
		expect(declaresWideGamut(jpeg(EMPTY_APP2, app2Icc(1, 1, p3Profile())), 'jpeg')).toBe(true);
	});

	it('stops at the start of scan rather than reading compressed data as segments', () => {
		// After SOS the bytes are entropy coded and their 0xff bytes are stuffed,
		// so anything that looks like a segment header there is a coincidence.
		const bytes = concat([SOI, JFIF, SOS, app2Icc(1, 1, p3Profile()), EOI]);
		expect(declaresWideGamut(bytes, 'jpeg')).toBe(false);
	});

	it('returns false for a JPEG with no APP2 segment', () => {
		expect(declaresWideGamut(jpeg(), 'jpeg')).toBe(false);
	});
});

describe('files with nothing to declare', () => {
	it('returns false for a format this reader does not search', () => {
		// HEIC is absent on purpose: its profile comes out of the container
		// parser, which has already read it.
		const bytes = png(cicpChunk(12), idatChunk());
		expect(findIccProfile(bytes, 'heic')).toBeUndefined();
		expect(declaresWideGamut(bytes, 'heic')).toBe(false);
	});

	it('returns false for bytes far too short to be any of the three', () => {
		// An empty file is what a cancelled download leaves behind, and one
		// byte is what a picker hands back for a file the user has no
		// permission to read.
		for (const format of ['png', 'webp', 'jpeg']) {
			expect(declaresWideGamut(new Uint8Array(0), format)).toBe(false);
			expect(declaresWideGamut(u8(0xff), format)).toBe(false);
			expect(declaresWideGamut(u8(0, 1, 2, 3), format)).toBe(false);
		}
	});
});
