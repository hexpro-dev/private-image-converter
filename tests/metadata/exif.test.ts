/**
 * EXIF: finding the block in each container, and reading what is in it.
 *
 * Every payload here is assembled byte by byte from the TIFF layout and from
 * each container's own specification rather than lifted out of a photograph.
 * Camera files cannot be committed to a public repository, and a fixture
 * written by exiftool would only prove that this reader agrees with exiftool,
 * which is not the claim being made.
 *
 * Three traps drive most of what follows: a TIFF value of four bytes or fewer
 * lives in the directory entry instead of at an offset, EXIF counts rotation
 * clockwise while this package counts anticlockwise, and a JPEG carries more
 * than one APP1 segment so the EXIF one has to be found by its identifier.
 * All three produce a file that parses without complaint and comes out wrong.
 *
 * The ICC side lives in icc.test.ts beside this.
 */

import { describe, expect, it } from 'vitest';
import {
	findExif,
	orientationFromExif,
	readExif,
	withUprightOrientation,
} from '../../src/metadata/exif.js';

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

describe('setting an EXIF payload upright before it is written back out', () => {
	/** Where the value bytes of the first entry of the first directory sit. */
	const FIRST_VALUE_AT = MAIN_AT + 2 + 8;

	it.each(BYTE_ORDERS)('rewrites an orientation of 6 to 1 in %s byte order', (_o, little) => {
		const payload = tiff({ little, main: [{ tag: TAG_ORIENTATION, short: 6 }] });
		const upright = withUprightOrientation(payload);
		expect(readExif(upright)?.orientation).toBe(1);
		// The rest of the block has to survive untouched, because the offsets
		// in it point at each other. Same length, and the same bytes either
		// side of the two that changed.
		expect(upright.length).toBe(payload.length);
		expect(upright.subarray(0, FIRST_VALUE_AT)).toEqual(payload.subarray(0, FIRST_VALUE_AT));
		expect(upright.subarray(FIRST_VALUE_AT + 2)).toEqual(payload.subarray(FIRST_VALUE_AT + 2));
	});

	it('leaves the payload it was handed alone', () => {
		// The source EXIF is a view into the file being converted, and the
		// summary shown to the user is read from it. Writing through it changes
		// what the report says was removed.
		const payload = tiff({ main: [{ tag: TAG_ORIENTATION, short: 8 }] });
		const upright = withUprightOrientation(payload);
		expect(upright).not.toBe(payload);
		expect(readExif(payload)?.orientation).toBe(8);
		expect(readExif(upright)?.orientation).toBe(1);
	});

	it('hands back the same payload when there is no orientation tag to correct', () => {
		// Identity rather than a copy, so that carrying metadata across a
		// conversion does not duplicate every block for nothing.
		const payload = tiff({ main: [{ tag: TAG_MAKE, text: 'Canon' }] });
		expect(withUprightOrientation(payload)).toBe(payload);
	});

	it('leaves a second directory alone, because that one describes the thumbnail', () => {
		// IFD1 is the embedded thumbnail, and its orientation describes the
		// thumbnail rather than the picture. Written out byte for byte:
		//
		//     4d4d 002a 00000008          header, first directory at 8
		//     0001                        one entry
		//     0112 0003 00000001 00060000 Orientation, SHORT, one, value 6
		//     0000001a                    the next directory is at byte 26
		//     0001                        one entry
		//     0112 0003 00000001 00080000 Orientation, SHORT, one, value 8
		//     00000000                    no third directory
		const payload = hex(
			'4d4d002a00000008 0001 011200030000000100060000 0000001a' +
				'0001 011200030000000100080000 00000000',
		);
		expect(payload.length).toBe(44);
		const upright = withUprightOrientation(payload);
		expect(upright[19]).toBe(1);
		expect(upright[37]).toBe(8);
	});

	it('leaves an orientation tag alone when its type is not SHORT', () => {
		// A LONG in that tag is out of specification, and the two bytes this
		// writes into an entry are only in the right place for a SHORT. Writing
		// them anyway on a big endian file would set the high half of the value
		// and leave a file claiming orientation 65536.
		const payload = tiff({ little: false, main: [{ tag: TAG_ORIENTATION, long: 6 }] });
		expect(withUprightOrientation(payload)).toBe(payload);
	});

	it('hands back anything that is not an EXIF payload unchanged', () => {
		// Never a throw. A file whose metadata is damaged still has pixels, and
		// the conversion is what the user asked for.
		for (const payload of [
			new Uint8Array(0),
			u8(0x4d, 0x4d, 0x00),
			hex('00002a0000000008'),
			hex('4d4d002b00000008'),
		]) {
			expect(withUprightOrientation(payload)).toBe(payload);
		}
	});

	it('stops at a directory that runs off the end of the payload', () => {
		const full = tiff({
			main: [
				{ tag: TAG_MAKE, text: 'Canon' },
				{ tag: TAG_ORIENTATION, short: 6 },
			],
		});
		const cut = full.subarray(0, MAIN_AT + 2 + 12 + 6);
		expect(withUprightOrientation(cut)).toBe(cut);
	});

	it('ignores a first directory offset of zero or one past the end', () => {
		for (const offset of [0, 0xffff]) {
			const payload = tiff({ main: [{ tag: TAG_ORIENTATION, short: 6 }] });
			new DataView(payload.buffer).setUint32(4, offset, true);
			expect(withUprightOrientation(payload)).toBe(payload);
		}
	});
});

/**
 * Container fixtures for `findExif`.
 *
 * Each one is built from that format's own specification: JPEG segments from
 * ITU-T T.81 and the Exif identifier from CIPA DC-008, PNG chunks from the PNG
 * specification, and RIFF chunks from the WebP container specification. The
 * point of finding the block at all is that a payload written by this
 * package's own encoder would prove nothing about the files people convert.
 */

const SOI = u8(0xff, 0xd8);
const SOS = u8(0xff, 0xda, 0x00, 0x02);
const EOI = u8(0xff, 0xd9);
/** The JFIF header almost every JPEG opens with, so the walker has to pass one. */
const JFIF = u8(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);

const EXIF_IDENTIFIER = 'Exif\0\0';
/** What XMP puts at the front of its own APP1, from the XMP specification part 3. */
const XMP_IDENTIFIER = 'http://ns.adobe.com/xap/1.0/\0';

/** One APP1 segment: 0xffe1, a length that counts itself, an identifier, a payload. */
function app1(identifier: string, payload: Uint8Array): Uint8Array {
	const length = 2 + identifier.length + payload.length;
	const out = new Uint8Array(2 + length);
	out[0] = 0xff;
	out[1] = 0xe1;
	new DataView(out.buffer).setUint16(2, length);
	writeAscii(out, 4, identifier);
	out.set(payload, 4 + identifier.length);
	return out;
}

function jpeg(...segments: Uint8Array[]): Uint8Array {
	return concat([SOI, JFIF, ...segments, SOS, EOI]);
}

const PNG_SIGNATURE = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The CRCs are four zero bytes, because this walker never checks one. */
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

function idatChunk(): Uint8Array {
	return pngChunk('IDAT', u8(0x78, 0x9c, 0x03, 0x00));
}

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

/** A payload with something in it worth reporting as removed. */
function samplePayload(): Uint8Array {
	return tiff({
		main: [
			{ tag: TAG_ORIENTATION, short: 6 },
			{ tag: TAG_MAKE, text: 'Canon' },
			{ tag: TAG_GPS_IFD, points: 'gps' },
		],
		gps: [{ tag: TAG_GPS_LATITUDE, short: 33 }],
	});
}

describe('finding the EXIF block in a JPEG', () => {
	it('reads the payload behind the Exif identifier in an APP1 segment', () => {
		const payload = samplePayload();
		const found = findExif(jpeg(app1(EXIF_IDENTIFIER, payload)), 'jpeg');
		expect(found).toEqual(payload);
		// The block is what the report and the encoder both consume, so it has
		// to start at the TIFF header rather than at the identifier.
		expect(readExif(found ?? new Uint8Array(0))?.hasLocation).toBe(true);
	});

	it('finds the EXIF segment behind an XMP one, by identifier and not by position', () => {
		// Phones write both, XMP usually first. Taking the first APP1 in the
		// file hands back a lump of RDF/XML whose first two bytes are '<x',
		// which is neither II nor MM, so the metadata silently disappears.
		const payload = samplePayload();
		const xmp = app1(XMP_IDENTIFIER, u8(0x3c, 0x78, 0x3a, 0x78));
		expect(findExif(jpeg(xmp, app1(EXIF_IDENTIFIER, payload)), 'jpeg')).toEqual(payload);
		expect(findExif(jpeg(app1(EXIF_IDENTIFIER, payload), xmp), 'jpeg')).toEqual(payload);
	});

	it('takes the payload from six bytes on whatever the pad byte holds', () => {
		// The specification fixes the byte after 'Exif\0' at zero and a few
		// writers put something else there. The TIFF header starts after it
		// either way, so matching all six exactly loses those files.
		const payload = samplePayload();
		const bytes = jpeg(app1('Exif\0\u00ff', payload));
		expect(findExif(bytes, 'jpeg')).toEqual(payload);
	});

	it('steps over an APP1 too short to hold the identifier without losing its place', () => {
		// The identifier check reads six bytes whether the segment has six or
		// not. What must not happen is the walk advancing by anything other
		// than this segment's own length, because after that every offset is
		// wrong and the block behind it is never found.
		const payload = samplePayload();
		const stub = u8(0xff, 0xe1, 0x00, 0x04, 0x45, 0x78);
		expect(findExif(jpeg(stub), 'jpeg')).toBeUndefined();
		expect(findExif(jpeg(stub, app1(EXIF_IDENTIFIER, payload)), 'jpeg')).toEqual(payload);
	});

	it('stops at the start of scan rather than reading compressed data as segments', () => {
		// After SOS the bytes are entropy coded, so anything in there that
		// looks like a segment header is a coincidence.
		const bytes = concat([SOI, JFIF, SOS, app1(EXIF_IDENTIFIER, samplePayload()), EOI]);
		expect(findExif(bytes, 'jpeg')).toBeUndefined();
	});

	it('gives up on a segment whose length runs past the end of the file', () => {
		// The commonest damaged JPEG there is: the download stopped. The length
		// field being read comes out of the same file, so it cannot be trusted
		// to point anywhere inside it.
		const bytes = jpeg(app1(EXIF_IDENTIFIER, samplePayload()));
		const app1At = SOI.length + JFIF.length;
		new DataView(bytes.buffer).setUint16(app1At + 2, 0xfffe);
		expect(findExif(bytes, 'jpeg')).toBeUndefined();
	});

	it('refuses an Exif segment whose payload is not a TIFF block', () => {
		// A correct identifier in front of rubbish. Handing that back means the
		// encoder embeds it and the next reader has no way to know, so it is
		// worse than carrying no metadata at all.
		expect(
			findExif(jpeg(app1(EXIF_IDENTIFIER, u8(1, 2, 3, 4, 5, 6, 7, 8))), 'jpeg'),
		).toBeUndefined();
		expect(findExif(jpeg(app1(EXIF_IDENTIFIER, u8(0x4d, 0x4d))), 'jpeg')).toBeUndefined();
	});

	it('gives up where the segment structure stops making sense', () => {
		// Both of these put the walk somewhere that is not a segment boundary,
		// and in both the EXIF segment behind them is genuinely there. Carrying
		// on from a position that is already wrong means reading two arbitrary
		// bytes as a length and jumping by it, which lands anywhere at all, so
		// stopping is the only answer that cannot make something up.
		const payload = samplePayload();
		const good = app1(EXIF_IDENTIFIER, payload);
		// A marker has to start with 0xff, and this one does not.
		expect(findExif(concat([SOI, u8(0x00, 0x00, 0x00, 0x10), good]), 'jpeg')).toBeUndefined();
		// A length of zero, from a segment claiming to be shorter than the two
		// bytes of the length field itself.
		expect(findExif(concat([SOI, u8(0xff, 0xe1, 0x00, 0x00), good]), 'jpeg')).toBeUndefined();
	});

	it('returns undefined for a JPEG carrying no APP1 at all', () => {
		expect(findExif(jpeg(), 'jpeg')).toBeUndefined();
	});
});

describe('finding the EXIF block in a PNG', () => {
	it('reads an eXIf chunk, whose contents are the block with no prefix', () => {
		const payload = samplePayload();
		expect(findExif(png(pngChunk('eXIf', payload), idatChunk()), 'png')).toEqual(payload);
	});

	it('reads an eXIf chunk written after the image data', () => {
		// This is the difference from the ICC walk beside it, which stops at
		// IDAT because a colour chunk after the image data declares nothing.
		// eXIf is explicitly allowed on either side, and a tool that appends
		// metadata to a finished file puts it after. Copying the IDAT guard
		// across, which looks like an obvious tidy-up, loses exactly those.
		const payload = samplePayload();
		expect(findExif(png(idatChunk(), pngChunk('eXIf', payload)), 'png')).toEqual(payload);
	});

	it('gives up on a chunk whose length is larger than the file', () => {
		const payload = samplePayload();
		const bytes = png(pngChunk('eXIf', payload), idatChunk());
		const chunkAt = PNG_SIGNATURE.length + 12 + 13;
		new DataView(bytes.buffer).setUint32(chunkAt, payload.length + 64);
		expect(findExif(bytes, 'png')).toBeUndefined();
	});

	it('stops at IEND, where nothing legal follows', () => {
		const bytes = concat([png(idatChunk()), pngChunk('eXIf', samplePayload())]);
		expect(findExif(bytes, 'png')).toBeUndefined();
	});

	it('refuses an eXIf chunk whose contents are not a TIFF block', () => {
		expect(findExif(png(pngChunk('eXIf', u8(0, 0, 0, 0, 0, 0, 0, 0))), 'png')).toBeUndefined();
	});

	it('returns undefined for a PNG carrying no eXIf chunk', () => {
		expect(findExif(png(idatChunk()), 'png')).toBeUndefined();
	});
});

describe('finding the EXIF block in a WebP', () => {
	it('reads an EXIF chunk out of the RIFF container', () => {
		const payload = samplePayload();
		expect(
			findExif(webp(riffChunk('VP8 ', new Uint8Array(10)), riffChunk('EXIF', payload)), 'webp'),
		).toEqual(payload);
	});

	it('steps over the pad byte RIFF adds after an odd length chunk', () => {
		// The pad is not counted in the chunk's size. Walking without it lands
		// one byte into the next fourcc and every chunk after that is lost.
		const payload = samplePayload();
		const bytes = webp(riffChunk('ICCP', new Uint8Array(5)), riffChunk('EXIF', payload));
		expect(findExif(bytes, 'webp')).toEqual(payload);
	});

	it('returns an odd length payload without the pad byte that follows it', () => {
		// The pad belongs to the container, not to the block. Handing it over
		// puts a stray zero on the end of what gets embedded in the output.
		const payload = concat([samplePayload(), u8(0x41)]);
		expect(payload.length % 2).toBe(1);
		const bytes = webp(riffChunk('EXIF', payload), riffChunk('ICCP', new Uint8Array(4)));
		expect(findExif(bytes, 'webp')).toEqual(payload);
	});

	it('gives up on a chunk whose size field is larger than the file', () => {
		const payload = samplePayload();
		const bytes = webp(riffChunk('EXIF', payload));
		new DataView(bytes.buffer).setUint32(12 + 4, payload.length + 16, true);
		expect(findExif(bytes, 'webp')).toBeUndefined();
	});

	it('refuses an EXIF chunk whose contents are not a TIFF block', () => {
		expect(findExif(webp(riffChunk('EXIF', new Uint8Array(20))), 'webp')).toBeUndefined();
	});

	it('returns undefined for a WebP carrying no EXIF chunk', () => {
		expect(findExif(webp(riffChunk('VP8 ', new Uint8Array(10))), 'webp')).toBeUndefined();
	});
});

describe('finding the EXIF block in a TIFF', () => {
	it('hands back the file itself, without copying it', () => {
		// A TIFF is a TIFF header followed by its directories, which is what
		// the other three carry wrapped up. Copying it would mean holding a
		// second copy of a file that can run to a hundred megabytes for no
		// gain, so identity is the behaviour being pinned here.
		const bytes = samplePayload();
		expect(findExif(bytes, 'tiff')).toBe(bytes);
	});

	it('refuses a file that is not a TIFF at all', () => {
		expect(findExif(png(idatChunk()), 'tiff')).toBeUndefined();
		expect(findExif(hex('4d4d002b00000008'), 'tiff')).toBeUndefined();
	});
});

describe('files with no EXIF to find', () => {
	it('returns undefined for a format this reader does not search', () => {
		// HEIC is absent on purpose: its block comes out of the container
		// parser, which has already read it.
		expect(findExif(jpeg(app1(EXIF_IDENTIFIER, samplePayload())), 'heic')).toBeUndefined();
		expect(findExif(samplePayload(), 'raw')).toBeUndefined();
	});

	it('returns undefined for bytes far too short to be any of the four', () => {
		// An empty file is what a cancelled download leaves behind, and one
		// byte is what a picker hands back for a file the user has no
		// permission to read.
		for (const format of ['jpeg', 'png', 'webp', 'tiff']) {
			expect(findExif(new Uint8Array(0), format)).toBeUndefined();
			expect(findExif(u8(0xff), format)).toBeUndefined();
			expect(findExif(u8(0x49, 0x49, 0x2a, 0x00), format)).toBeUndefined();
		}
	});
});
