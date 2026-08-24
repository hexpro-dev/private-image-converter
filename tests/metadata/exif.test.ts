/**
 * EXIF and ICC metadata reading.
 *
 * Every payload here is assembled byte by byte from the TIFF and ICC layouts
 * rather than lifted out of a photograph. Camera files cannot be committed to a
 * public repository, and a fixture written by exiftool would only prove that
 * this reader agrees with exiftool, which is not the claim being made.
 *
 * Two traps drive most of what follows: a TIFF value of four bytes or fewer
 * lives in the directory entry instead of at an offset, and EXIF counts
 * rotation clockwise while this package counts anticlockwise. Both produce a
 * file that parses without complaint and comes out wrong.
 */

import { describe, expect, it } from 'vitest';
import { orientationFromExif, readExif } from '../../src/metadata/exif.js';
import { declaresWideGamut, findIccProfile, iccIsWideGamut } from '../../src/metadata/icc.js';

const TAG_IMAGE_WIDTH = 0x0100;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_SOFTWARE = 0x0131;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_BODY_SERIAL = 0xa431;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE = 0x0004;

/** Where the first directory is put, immediately after the eight byte header. */
const MAIN_AT = 8;

const BYTE_ORDERS: readonly [string, boolean][] = [
	['II', true],
	['MM', false],
];

function u8(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

/**
 * Bytes from a hex string.
 *
 * For the fixtures that are written out in full rather than assembled, so that
 * the payload in the test is the payload the reader sees and can be checked
 * against the TIFF layout a field at a time by anybody reading it.
 */
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

/** One directory entry, in the four shapes these tests need. */
type Field =
	| { readonly tag: number; readonly short: number }
	| { readonly tag: number; readonly text: string }
	| { readonly tag: number; readonly long: number }
	| {
			readonly tag: number;
			readonly points: 'exif' | 'gps';
			/** The field type to declare, for pointers written as something other than LONG. */
			readonly asType?: number;
	  };

/** A directory is a count, twelve bytes per entry, and a next directory pointer. */
function directoryBytes(fields: readonly Field[]): number {
	return 2 + fields.length * 12 + 4;
}

/** What a directory needs after itself for values too long to sit in an entry. */
function overflowBytes(fields: readonly Field[]): number {
	let total = 0;
	for (const field of fields) {
		if (!('text' in field)) continue;
		const count = field.text.length + 1;
		if (count > 4) total += count + (count & 1);
	}
	return total;
}

function writeDirectory(
	bytes: Uint8Array,
	view: DataView,
	little: boolean,
	at: number,
	fields: readonly Field[],
	targets: { readonly exif: number; readonly gps: number },
): void {
	view.setUint16(at, fields.length, little);
	let overflow = at + directoryBytes(fields);
	fields.forEach((field, i) => {
		const entry = at + 2 + i * 12;
		view.setUint16(entry, field.tag, little);
		// The four value bytes start as 0xff so that anything left unwritten is
		// loud. A reader that mistakes an inline value for an offset then looks
		// at an address in the billions rather than at a byte which happens to
		// hold the right answer.
		bytes.fill(0xff, entry + 8, entry + 12);
		if ('short' in field) {
			view.setUint16(entry + 2, 3, little);
			view.setUint32(entry + 4, 1, little);
			// A SHORT is two bytes, left justified in the entry's four.
			view.setUint16(entry + 8, field.short, little);
		} else if ('long' in field) {
			view.setUint16(entry + 2, 4, little);
			view.setUint32(entry + 4, 1, little);
			view.setUint32(entry + 8, field.long, little);
		} else if ('points' in field) {
			view.setUint16(entry + 2, field.asType ?? 4, little);
			view.setUint32(entry + 4, 1, little);
			view.setUint32(entry + 8, targets[field.points], little);
		} else {
			const count = field.text.length + 1;
			view.setUint16(entry + 2, 2, little);
			view.setUint32(entry + 4, count, little);
			if (count <= 4) {
				writeAscii(bytes, entry + 8, field.text);
				bytes[entry + 8 + field.text.length] = 0;
			} else {
				view.setUint32(entry + 8, overflow, little);
				writeAscii(bytes, overflow, field.text);
				bytes[overflow + field.text.length] = 0;
				overflow += count + (count & 1);
			}
		}
	});
}

interface TiffSpec {
	/** Little endian by default, which is what a phone writes. */
	readonly little?: boolean;
	readonly main?: readonly Field[];
	readonly exif?: readonly Field[];
	readonly gps?: readonly Field[];
}

/** Build a TIFF payload of the shape a JPEG APP1 segment carries. */
function tiff(spec: TiffSpec = {}): Uint8Array {
	const little = spec.little ?? true;
	const main = spec.main ?? [];
	const exifAt = MAIN_AT + directoryBytes(main) + overflowBytes(main);
	const gpsAt = exifAt + (spec.exif ? directoryBytes(spec.exif) + overflowBytes(spec.exif) : 0);
	const end = gpsAt + (spec.gps ? directoryBytes(spec.gps) + overflowBytes(spec.gps) : 0);

	const bytes = new Uint8Array(end);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, little ? 0x4949 : 0x4d4d);
	view.setUint16(2, 42, little);
	view.setUint32(4, MAIN_AT, little);

	const targets = { exif: exifAt, gps: gpsAt };
	writeDirectory(bytes, view, little, MAIN_AT, main, targets);
	if (spec.exif) writeDirectory(bytes, view, little, exifAt, spec.exif, targets);
	if (spec.gps) writeDirectory(bytes, view, little, gpsAt, spec.gps, targets);
	return bytes;
}

/**
 * One payload written out in full rather than assembled, so that at least one
 * fixture in this file is a byte string a reader can check against TIFF 6.0
 * without first believing the builder above.
 *
 * Big endian, because the field boundaries are then readable left to right.
 *
 *     4d4d                       byte order, 'MM'
 *     002a                       42, the number that says this is a TIFF
 *     00000008                   the first directory is at byte 8
 *     0002                       it has two entries
 *     0112 0003 00000001 0006    Orientation, SHORT, one of them, value 6
 *     0000                         the two bytes of padding after a SHORT
 *     010f 0002 00000006 00000026  Make, ASCII, six bytes, at byte 38
 *     00000000                   no second directory
 *     43616e6f6e00               'Canon' and its NUL, at byte 38
 *
 * The padding here is zero, which is what a camera writes. The builder above
 * fills it with 0xff instead, so between them the two prove the reader takes
 * the value from the front of the field either way.
 */
const HAND_WRITTEN_TIFF = [
	'4d4d 002a 00000008',
	'0002',
	'0112 0003 00000001 00060000',
	'010f 0002 00000006 00000026',
	'00000000',
	'43616e6f6e00',
].join(' ');

describe('reading a TIFF directory', () => {
	it('reads a payload written out byte for byte from the TIFF layout', () => {
		const bytes = hex(HAND_WRITTEN_TIFF);
		// 8 header + 2 count + 24 entries + 4 next pointer + 6 of string.
		expect(bytes.length).toBe(44);
		const summary = readExif(bytes);
		expect(summary?.orientation).toBe(6);
		expect(summary?.cameraMake).toBe('Canon');
		expect(summary?.tagCount).toBe(2);
		expect(summary?.hasLocation).toBe(false);
		expect(summary?.hasSerialNumber).toBe(false);
		expect(summary?.capturedAt).toBeUndefined();
	});

	it.each(BYTE_ORDERS)(
		'reads the orientation from tag 0x0112 in %s byte order',
		(_order, little) => {
			const summary = readExif(tiff({ little, main: [{ tag: TAG_ORIENTATION, short: 8 }] }));
			expect(summary?.orientation).toBe(8);
		},
	);

	it.each(BYTE_ORDERS)('keeps a two byte value inside the entry in %s byte order', (_o, little) => {
		// This is the trap. A value of four bytes or fewer is written in the
		// entry's own value field, and only a longer one is an offset. The two
		// spare bytes of this entry are 0xff, so a reader that follows the field
		// as an offset lands past the end of the payload and reports the default
		// orientation of 1 for a file that plainly says 6.
		const summary = readExif(tiff({ little, main: [{ tag: TAG_ORIENTATION, short: 6 }] }));
		expect(summary?.orientation).toBe(6);
	});

	it.each(BYTE_ORDERS)(
		'reads make, model, software and datetime in %s byte order',
		(_o, little) => {
			// 'EOS' and its NUL are exactly four bytes, so the model sits in the
			// entry while the make does not and is written at an offset. Both have
			// to come back, which is the whole of the inline rule in one fixture.
			const summary = readExif(
				tiff({
					little,
					main: [
						{ tag: TAG_MAKE, text: 'Canon' },
						{ tag: TAG_MODEL, text: 'EOS' },
						{ tag: TAG_SOFTWARE, text: 'Darkroom 5.2' },
						{ tag: TAG_DATETIME, text: '2024:11:03 14:22:07' },
					],
				}),
			);
			expect(summary?.cameraMake).toBe('Canon');
			expect(summary?.cameraModel).toBe('EOS');
			expect(summary?.software).toBe('Darkroom 5.2');
			expect(summary?.capturedAt).toBe('2024:11:03 14:22:07');
		},
	);

	it('stops a string at its NUL and trims the padding around it', () => {
		// Cameras pad these fields to a fixed width. Handing the padding back
		// means every comparison against a model name has to trim first, and one
		// of them will not.
		const summary = readExif(tiff({ main: [{ tag: TAG_MAKE, text: 'NIKON  ' }] }));
		expect(summary?.cameraMake).toBe('NIKON');
	});

	it('reports orientation 1 and no tags for a file that carries neither', () => {
		const summary = readExif(tiff({ main: [{ tag: TAG_IMAGE_WIDTH, short: 4032 }] }));
		expect(summary?.orientation).toBe(1);
		expect(summary?.hasLocation).toBe(false);
		expect(summary?.hasSerialNumber).toBe(false);
		expect(summary?.tagCount).toBe(1);
	});

	it('sets hasLocation from the GPS pointer at tag 0x8825', () => {
		// The pointer alone is the answer. No coordinate is read, because the
		// only question being asked is whether there was a location to lose.
		const summary = readExif(
			tiff({
				main: [
					{ tag: TAG_ORIENTATION, short: 1 },
					{ tag: TAG_GPS_IFD, points: 'gps' },
				],
				gps: [
					{ tag: TAG_GPS_LATITUDE, short: 33 },
					{ tag: TAG_GPS_LONGITUDE, short: 151 },
				],
			}),
		);
		expect(summary?.hasLocation).toBe(true);
		// The pointer counts, and so do the two tags in the directory it points
		// at. A caller that tells somebody "4 tags were removed" should not be
		// counting only the first directory.
		expect(summary?.tagCount).toBe(4);
	});

	it('follows the sub directory at tag 0x8769 and counts the tags inside it', () => {
		const summary = readExif(
			tiff({
				main: [
					{ tag: TAG_MAKE, text: 'Apple' },
					{ tag: TAG_EXIF_IFD, points: 'exif' },
				],
				exif: [
					{ tag: TAG_DATETIME_ORIGINAL, text: '2023:06:01 09:15:00' },
					{ tag: TAG_BODY_SERIAL, text: 'F2LX9' },
				],
			}),
		);
		expect(summary?.cameraMake).toBe('Apple');
		expect(summary?.capturedAt).toBe('2023:06:01 09:15:00');
		// A serial number is the tag people are most surprised to learn is in
		// there, so it is reported even though its value never is.
		expect(summary?.hasSerialNumber).toBe(true);
		expect(summary?.tagCount).toBe(4);
	});

	it('follows a sub directory pointer declared as an IFD rather than a LONG', () => {
		// TIFF Technical Note 1 added type 13, IFD, for exactly this: a value
		// that is the address of another directory. Writers use both it and
		// LONG, and a reader that sizes the value by its type before taking it
		// finds type 13 in no size table, calls it four bytes or fewer, and
		// then has to take the address from the entry rather than from an
		// offset. Either type has to lead to the same directory.
		const summary = readExif(
			tiff({
				main: [{ tag: TAG_EXIF_IFD, points: 'exif', asType: 13 }],
				exif: [{ tag: TAG_BODY_SERIAL, text: 'F2LX9' }],
			}),
		);
		expect(summary?.hasSerialNumber).toBe(true);
		expect(summary?.tagCount).toBe(2);
	});

	it('reports an orientation outside 1 to 8 as the file wrote it', () => {
		// The summary is a report of what was in the file, so it does not
		// quietly correct one. Nothing rotates on it either: the clamp is in
		// orientationFromExif, and this is the pair that has to hold for a file
		// that says something absurd.
		//
		// Zero is the value that catches a reader written with || rather than
		// ??, because it is both a real thing the file said and falsy.
		for (const written of [0, 9, 65535]) {
			const summary = readExif(tiff({ main: [{ tag: TAG_ORIENTATION, short: written }] }));
			expect(summary?.orientation).toBe(written);
			expect(orientationFromExif(summary?.orientation ?? 1)).toEqual({
				rotation: 0,
				mirror: 'none',
			});
		}
	});

	it('keeps the datetime it saw first when a file carries two of them', () => {
		const summary = readExif(
			tiff({
				main: [
					{ tag: TAG_DATETIME, text: '2024:01:02 03:04:05' },
					{ tag: TAG_EXIF_IFD, points: 'exif' },
				],
				exif: [{ tag: TAG_DATETIME_ORIGINAL, text: '1999:12:31 23:59:59' }],
			}),
		);
		expect(summary?.capturedAt).toBe('2024:01:02 03:04:05');
	});

	it('reads a payload that sits inside a larger buffer', () => {
		// EXIF arrives as a view into a JPEG's APP1 segment rather than as a
		// buffer of its own, so a DataView built without the byte offset reads
		// the segment header where the TIFF header should be.
		const payload = tiff({ main: [{ tag: TAG_ORIENTATION, short: 6 }] });
		const padded = new Uint8Array(payload.length + 24);
		padded.set(payload, 16);
		expect(readExif(padded.subarray(16, 16 + payload.length))?.orientation).toBe(6);
	});
});

describe('EXIF payloads that are damaged or are not EXIF at all', () => {
	it('returns undefined for a byte order mark that is neither II nor MM', () => {
		const bytes = tiff({ main: [{ tag: TAG_ORIENTATION, short: 3 }] });
		bytes[0] = 0x4d;
		expect(readExif(bytes)).toBeUndefined();
	});

	it('returns undefined when the magic number is not 42', () => {
		// Byte order and 42 are the only two things a TIFF header asserts about
		// itself. Without checking both, any four bytes become an offset.
		const bytes = tiff({ main: [{ tag: TAG_ORIENTATION, short: 3 }] });
		bytes[2] = 43;
		expect(readExif(bytes)).toBeUndefined();
	});

	it('returns undefined for a payload one byte short of a header', () => {
		const bytes = tiff({ main: [{ tag: TAG_ORIENTATION, short: 3 }] });
		expect(readExif(bytes.subarray(0, 7))).toBeUndefined();
		expect(readExif(new Uint8Array(0))).toBeUndefined();
	});

	it('reads nothing from a header whose first directory offset is zero', () => {
		// Zero is not an address, it is where the byte order mark lives, and a
		// writer that had no directory to point at leaves it there. Following
		// it reads the header as a directory: 0x4d4d entries, the first of them
		// the magic number.
		const bytes = tiff({ main: [{ tag: TAG_ORIENTATION, short: 3 }] });
		new DataView(bytes.buffer).setUint32(4, 0, true);
		const summary = readExif(bytes);
		expect(summary?.orientation).toBe(1);
		expect(summary?.tagCount).toBe(0);
	});

	it('reads nothing from the smallest payload that is still a valid header', () => {
		// Eight bytes: byte order, 42, and an offset with nothing at it. Legal
		// as far as the header goes, and there is no directory to walk.
		const summary = readExif(hex('49492a00 08000000'));
		expect(summary?.orientation).toBe(1);
		expect(summary?.tagCount).toBe(0);
	});

	it('bounds an ASCII count of four billion by the payload rather than by the count', () => {
		// The count field is four bytes and comes off a stranger's file, so it
		// can say 4294967295 for a string with three bytes behind it. Reading
		// the count rather than the payload is a loop of four billion in the
		// user's tab, and this is the only string in the fixture with no NUL to
		// stop it early.
		//
		//     010f 0002 ffffffff 00000026    Make, ASCII, 4294967295, at 38
		//     0112 0003 00000001 00080000    Orientation, SHORT, one, value 8
		//     414243                         'ABC' at 38, then the payload ends
		const summary = readExif(
			hex(
				'4d4d002a00000008 0002 010f0002ffffffff00000026 011200030000000100080000 00000000 414243',
			),
		);
		expect(summary?.cameraMake).toBe('ABC');
		// The tag after the hostile one is still read, so the walk was bounded
		// rather than abandoned partway through.
		expect(summary?.orientation).toBe(8);
		expect(summary?.tagCount).toBe(2);
	}, 1000);

	it('still reports a location when the GPS directory it points at is unreadable', () => {
		// The pointer is the disclosure. Whether the directory it names can be
		// parsed changes what else can be said about the file, not whether the
		// file was carrying a location, and telling somebody there was none
		// because a damaged sub directory could not be read is the one wrong
		// answer this cannot give.
		const summary = readExif(tiff({ main: [{ tag: TAG_GPS_IFD, long: 0xffff }] }));
		expect(summary?.hasLocation).toBe(true);
		expect(summary?.tagCount).toBe(1);
	});

	it('yields an empty make rather than bytes from elsewhere when the string is gone', () => {
		// A string whose offset points past the end of the payload reads as ''
		// and not as undefined, so a caller has to test the field for truth
		// rather than for presence. Pinned because the alternative, which is
		// whatever bytes happen to be at that address, is the failure that
		// matters, and because a caller rendering the summary should show no
		// camera rather than a blank one.
		const bytes = tiff({ main: [{ tag: TAG_MAKE, text: 'Panasonic' }] });
		new DataView(bytes.buffer).setUint32(MAIN_AT + 2 + 8, 0xffff, true);
		expect(readExif(bytes)?.cameraMake).toBe('');
	});

	it('ignores a first directory offset that lies past the end of the payload', () => {
		const bytes = tiff({ main: [{ tag: TAG_ORIENTATION, short: 7 }] });
		new DataView(bytes.buffer).setUint32(4, 0xffff, true);
		const summary = readExif(bytes);
		expect(summary?.orientation).toBe(1);
		expect(summary?.tagCount).toBe(0);
	});

	it('reads what it can from a directory that runs off the end of the payload', () => {
		// Truncation is ordinary: an APP1 segment has a 64k ceiling and writers
		// do overflow it. Whatever came before the cut is still worth reporting,
		// and a photograph with damaged metadata must still convert.
		const full = tiff({
			main: [
				{ tag: TAG_ORIENTATION, short: 6 },
				{ tag: TAG_MAKE, text: 'Fujifilm' },
			],
		});
		const summary = readExif(full.subarray(0, MAIN_AT + 2 + 12 + 6));
		expect(summary?.orientation).toBe(6);
		expect(summary?.tagCount).toBe(1);
		expect(summary?.cameraMake).toBeUndefined();
	});

	it('returns rather than looping when a directory points at itself', () => {
		// A denial of service guard, not a tidiness one. These bytes come off
		// a stranger's file and are parsed in the user's tab, so a directory
		// whose sub directory pointer is its own address must not spin. Take
		// the guard away and this run never finishes, because a synchronous
		// loop cannot be interrupted by a test timeout. The short timeout
		// below is for the slower version of the same fault, where the walk
		// terminates but only after re-reading the file thousands of times.
		const bytes = tiff({ main: [{ tag: TAG_EXIF_IFD, long: MAIN_AT }] });
		expect(readExif(bytes)?.tagCount).toBe(1);
	}, 1000);

	it('returns when two directories point at each other', () => {
		const bytes = tiff({
			main: [{ tag: TAG_EXIF_IFD, points: 'exif' }],
			exif: [{ tag: TAG_EXIF_IFD, long: MAIN_AT }],
		});
		expect(readExif(bytes)?.tagCount).toBe(2);
	}, 1000);
});

describe('the rotation an EXIF orientation asks for', () => {
	const ORIENTATIONS: readonly [number, number, string][] = [
		[1, 0, 'none'],
		[2, 0, 'horizontal'],
		[3, 180, 'none'],
		[4, 0, 'vertical'],
		[5, 90, 'horizontal'],
		[6, 270, 'none'],
		[7, 270, 'horizontal'],
		[8, 90, 'none'],
	];

	it.each(ORIENTATIONS)('turns %i into %i degrees and a %s mirror', (value, rotation, mirror) => {
		expect(orientationFromExif(value)).toEqual({ rotation, mirror });
	});

	it('counts anticlockwise, so a quarter turn is 270 where EXIF says 90', () => {
		// EXIF 6 is a camera held with the shutter button down, and the file has
		// to be turned a quarter clockwise to look right. This package measures
		// anticlockwise, so that is 270 and not 90. Reading it as 90 leaves every
		// portrait photograph a half turn from upright, which is most of the
		// photographs anybody converts.
		expect(orientationFromExif(6).rotation).toBe(270);
		expect(orientationFromExif(8).rotation).toBe(90);
	});

	it('swaps 5 and 7, which are the two a hand written table gets backwards', () => {
		// The specification reads 5 as "mirror horizontal and rotate 270
		// clockwise" and 7 as "mirror horizontal and rotate 90 clockwise".
		// Anticlockwise those become 90 and 270, so the numbers in the table
		// are the opposite way round from the numbers in the file. Copying the
		// clockwise column straight across leaves a transposed photograph
		// transverse, which is a half turn from upright and mirrored as well.
		expect(orientationFromExif(5)).toEqual({ rotation: 90, mirror: 'horizontal' });
		expect(orientationFromExif(7)).toEqual({ rotation: 270, mirror: 'horizontal' });
	});

	it('treats an orientation outside 1 to 8 as upright rather than guessing', () => {
		for (const value of [0, 9, 255]) {
			expect(orientationFromExif(value)).toEqual({ rotation: 0, mirror: 'none' });
		}
	});
});

/**
 * ICC fixtures.
 *
 * A profile is a 128 byte header, a tag count, a table of twelve byte entries,
 * and the tag data. Only the red colourant matters to this reader, so that is
 * the only tag with real numbers in it.
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
function xyzTag(x: number, y: number, z: number): Uint8Array {
	const data = new Uint8Array(20);
	const view = new DataView(data.buffer);
	writeAscii(data, 0, 'XYZ ');
	view.setInt32(8, fixed16(x));
	view.setInt32(12, fixed16(y));
	view.setInt32(16, fixed16(z));
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

/** Display P3 puts the red primary's X at about 0.515. */
function p3Profile(): Uint8Array {
	return iccProfile([{ signature: 'rXYZ', data: xyzTag(0.5151, 0.2412, 0) }]);
}

/** sRGB puts it at about 0.436, which is the whole of the difference. */
function srgbProfile(): Uint8Array {
	return iccProfile([{ signature: 'rXYZ', data: xyzTag(0.436, 0.2225, 0.0139) }]);
}

describe('deciding gamut from an ICC profile', () => {
	it('calls a Display P3 red colourant wide', () => {
		expect(iccIsWideGamut(p3Profile())).toBe(true);
	});

	it('calls an sRGB red colourant narrow', () => {
		expect(iccIsWideGamut(srgbProfile())).toBe(false);
	});

	it('ignores a description that says Display P3 when the colourant says sRGB', () => {
		// Vendors rewrite the description between releases and copy each other's
		// wording. The numbers are the profile; the text beside them is not.
		const profile = iccProfile([
			{ signature: 'desc', data: asciiTag('Display P3') },
			{ signature: 'rXYZ', data: xyzTag(0.436, 0.2225, 0.0139) },
		]);
		expect(iccIsWideGamut(profile)).toBe(false);
	});

	it('puts the line between the two primaries rather than on top of either', () => {
		expect(iccIsWideGamut(iccProfile([{ signature: 'rXYZ', data: xyzTag(0.48, 0.24, 0) }]))).toBe(
			false,
		);
		expect(iccIsWideGamut(iccProfile([{ signature: 'rXYZ', data: xyzTag(0.4801, 0.24, 0) }]))).toBe(
			true,
		);
	});

	it('refuses a buffer too short to hold a header and a tag count', () => {
		expect(iccIsWideGamut(new Uint8Array(131))).toBe(false);
	});

	it('refuses a tag count no profile would carry', () => {
		// Reached by handing this arbitrary bytes, where the four at offset 128
		// are as likely to be four billion as anything else. Trusting the count
		// is a loop over a table that is not there.
		expect(
			iccIsWideGamut(iccProfile([{ signature: 'rXYZ', data: xyzTag(0.5151, 0.24, 0) }], 0)),
		).toBe(false);
		const many = iccProfile([{ signature: 'rXYZ', data: xyzTag(0.5151, 0.24, 0) }], 0x7fffffff);
		expect(iccIsWideGamut(many)).toBe(false);
	});

	it('refuses a profile whose table has no red colourant', () => {
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

	it('finds a red colourant at the far end of a table of the largest size it accepts', () => {
		// Every other fixture here puts rXYZ first or second. A real profile
		// has it after the description, the copyright and the white point, and
		// the loop has to reach it. 1024 entries is the ceiling this reader
		// sets, so a profile with exactly that many is the largest it must
		// still read and one more is the point at which it stops trusting the
		// count.
		const filler = (count: number) =>
			Array.from({ length: count }, () => ({ signature: 'wtpt', data: new Uint8Array(0) }));
		const red = { signature: 'rXYZ', data: xyzTag(0.5151, 0.2412, 0) };
		expect(iccIsWideGamut(iccProfile([...filler(1023), red]))).toBe(true);
		expect(iccIsWideGamut(iccProfile([...filler(1024), red]))).toBe(false);
	});

	it('refuses an rXYZ entry pointing outside the profile', () => {
		// This is what a profile truncated partway through looks like: the table
		// survives and the data it names does not. The wrong answer here is a
		// confident one taken from whatever bytes follow.
		const profile = iccProfile([
			{ signature: 'rXYZ', data: xyzTag(0.5151, 0.2412, 0), offset: 4096 },
		]);
		expect(iccIsWideGamut(profile)).toBe(false);
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
		// that is short by sixteen bytes and says nothing about it. Here the
		// bytes that are missing are the ones nothing reads, so the answer
		// would come back wide and confident off a file that is damaged.
		const profile = p3Profile();
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
		// table. The table survives and names a red colourant whose twenty
		// bytes were in the segment that did not arrive, so there is a
		// plausible looking profile with the one number missing.
		expect(declaresWideGamut(jpeg(app2Icc(1, 2, p3Profile().subarray(0, 150))), 'jpeg')).toBe(
			false,
		);
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
