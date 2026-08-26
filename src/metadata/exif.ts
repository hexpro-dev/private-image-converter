/**
 * Reading EXIF, mostly so it can be thrown away knowingly.
 *
 * A conversion through a canvas strips metadata whether you meant it to or
 * not. That is the right default for this tool, but "the metadata is gone" is
 * a much weaker thing to tell somebody than "the coordinates of where this was
 * taken, the time, and the camera's serial number are gone". So this reads
 * enough to say what was there, and to put it back when it is asked to.
 *
 * Putting it back has one mandatory edit, which `withUprightOrientation` makes.
 * Every decoder in this package hands back pixels that are already the right
 * way up, so an EXIF block copied across unchanged would tell the next reader
 * to rotate a photograph that has already been rotated.
 *
 * Getting at the block is the other half, and it is container work rather than
 * TIFF work: `findExif` unwraps the four formats that carry one. Before it
 * existed only HEIC handed an EXIF block over, which meant the report of what
 * had been stripped was silent for every other source and `metadata: 'preserve'`
 * had nothing to preserve on the commonest job of the lot, JPEG in and JPEG out.
 *
 * Past that it is a TIFF header parser and nothing more. No tag is interpreted
 * beyond the handful named below, because every additional tag is another
 * chance to mis-parse a stranger's file for no gain.
 */

const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_SOFTWARE = 0x0131;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_BODY_SERIAL = 0xa431;
const TAG_LENS_SERIAL = 0xa435;

/** Sizes in bytes of each TIFF field type, indexed by the type code. */
const TYPE_SIZES: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8,
};

/**
 * What a file was carrying, in terms somebody would recognise.
 *
 * Deliberately not a dump of every tag. This is the list a person would want
 * read back to them before deciding whether to keep it.
 */
export interface ExifSummary {
	/** 1 to 8, as TIFF tag 0x0112 records it. 1 means already upright. */
	readonly orientation: number;
	/** True when the file carried a GPS directory of any kind. */
	readonly hasLocation: boolean;
	readonly capturedAt?: string;
	readonly cameraMake?: string;
	readonly cameraModel?: string;
	readonly software?: string;
	/** True when a body or lens serial number was present. */
	readonly hasSerialNumber: boolean;
	/** Every tag id seen, so a caller can report a count honestly. */
	readonly tagCount: number;
}

interface Cursor {
	readonly view: DataView;
	readonly little: boolean;
	readonly length: number;
}

function readString(cursor: Cursor, offset: number, count: number): string {
	let out = '';
	for (let i = 0; i < count; i += 1) {
		if (offset + i >= cursor.length) break;
		const byte = cursor.view.getUint8(offset + i);
		if (byte === 0) break;
		out += String.fromCharCode(byte);
	}
	return out.trim();
}

/**
 * Walk one image file directory.
 *
 * Returns the offsets of any sub-directories it points at, rather than
 * recursing itself, so that a file which points a directory at itself cannot
 * put this into an infinite loop.
 */
interface Accumulator {
	orientation?: number;
	hasLocation: boolean;
	capturedAt?: string;
	cameraMake?: string;
	cameraModel?: string;
	software?: string;
	hasSerialNumber: boolean;
	tagCount: number;
}

function readDirectory(cursor: Cursor, start: number, into: Accumulator): number[] {
	if (start + 2 > cursor.length) return [];
	const count = cursor.view.getUint16(start, cursor.little);
	const children: number[] = [];

	for (let i = 0; i < count; i += 1) {
		const entry = start + 2 + i * 12;
		if (entry + 12 > cursor.length) break;
		const tag = cursor.view.getUint16(entry, cursor.little);
		const type = cursor.view.getUint16(entry + 2, cursor.little);
		const length = cursor.view.getUint32(entry + 4, cursor.little);
		const size = (TYPE_SIZES[type] ?? 0) * length;
		// A value of four bytes or fewer is stored in the entry itself rather
		// than at an offset, which is the detail that catches every hand
		// written EXIF reader once.
		const valueAt = size <= 4 ? entry + 8 : cursor.view.getUint32(entry + 8, cursor.little);
		into.tagCount += 1;

		switch (tag) {
			case TAG_ORIENTATION:
				if (type === 3 && valueAt + 2 <= cursor.length) {
					into.orientation = cursor.view.getUint16(valueAt, cursor.little);
				}
				break;
			case TAG_MAKE:
				into.cameraMake = readString(cursor, valueAt, length);
				break;
			case TAG_MODEL:
				into.cameraModel = readString(cursor, valueAt, length);
				break;
			case TAG_SOFTWARE:
				into.software = readString(cursor, valueAt, length);
				break;
			case TAG_DATETIME:
			case TAG_DATETIME_ORIGINAL:
				into.capturedAt ??= readString(cursor, valueAt, length);
				break;
			case TAG_BODY_SERIAL:
			case TAG_LENS_SERIAL:
				into.hasSerialNumber = true;
				break;
			case TAG_GPS_IFD:
				into.hasLocation = true;
				children.push(cursor.view.getUint32(entry + 8, cursor.little));
				break;
			case TAG_EXIF_IFD:
				children.push(cursor.view.getUint32(entry + 8, cursor.little));
				break;
			default:
				break;
		}
	}
	return children;
}

/**
 * The payload back, if it opens with a TIFF header, and nothing if it does not.
 *
 * Byte order and the number 42 are the only two things a TIFF header asserts
 * about itself, and every path into this file checks both before trusting a
 * single offset behind them. It is also the gate on what leaves `findExif`:
 * what comes back from there is not only read, it is handed to an encoder and
 * written into the output file, and a block that is not a TIFF is worse to
 * embed than no block at all, because the next reader has no way to tell.
 */
function asExifPayload(payload: Uint8Array): Uint8Array | undefined {
	if (payload.length < 8) return undefined;
	const byteOrder = ((payload[0] as number) << 8) | (payload[1] as number);
	if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return undefined;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	if (view.getUint16(2, byteOrder === 0x4949) !== 42) return undefined;
	return payload;
}

/**
 * Find the EXIF block in a file, if it has one.
 *
 * The four formats that carry one and that this package can put one back into.
 * HEIC is absent for the same reason it is absent from the ICC reader beside
 * this file: its block comes out of the container parser, which has already
 * read it.
 *
 * What comes back starts at the TIFF header, which is what `readExif`,
 * `withUprightOrientation` and every encoder that can carry EXIF all expect.
 * Each container wraps that block differently and only JPEG puts a prefix in
 * front of it, so this is four unwrappings rather than one.
 *
 * The walks below are deliberately not shared with `findIccProfile`. The JPEG
 * ones are different jobs, not the same job on a different marker: an ICC
 * profile is split across numbered APP2 segments and has to be reassembled in
 * index order, while an EXIF block is one APP1 taken whole. The PNG ones stop
 * in different places, for the reason given at `pngExif`. That leaves the RIFF
 * walk, and sharing four lines is not worth a dependency between the two.
 */
export function findExif(bytes: Uint8Array, format: string): Uint8Array | undefined {
	if (format === 'jpeg') return jpegExif(bytes);
	if (format === 'png') return pngExif(bytes);
	if (format === 'webp') return webpExif(bytes);
	// A TIFF file is a TIFF header followed by its directories, which is
	// exactly what the other three carry wrapped in a container. There is
	// nothing to unwrap, and copying the block out would only mean holding a
	// second copy of a file that can run to a hundred megabytes.
	if (format === 'tiff') return asExifPayload(bytes);
	return undefined;
}

/**
 * JPEG carries EXIF in an APP1 segment whose payload begins `Exif\0`.
 *
 * The identifier is the test, not the position. XMP is also APP1, it is also
 * written by phones, and it is usually the earlier of the two, so anything
 * that takes the first APP1 it meets hands back a lump of RDF/XML and calls it
 * a TIFF header. The identifier is followed by a pad byte the specification
 * fixes at zero, which a handful of writers do not, so the payload is taken
 * from six bytes on regardless of what that byte holds.
 */
function jpegExif(bytes: Uint8Array): Uint8Array | undefined {
	const identifier = 'Exif\0';
	// The identifier, its pad byte, and the two length bytes that precede both.
	const prefix = 2 + identifier.length + 1;
	let offset = 2;

	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) break;
		const kind = bytes[offset + 1] as number;
		// Start of scan: the entropy coded data begins, and a 0xff in it that
		// looks like a marker is a coincidence.
		if (kind === 0xda) break;
		const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
		if (length < 2 || offset + 2 + length > bytes.length) break;

		if (kind === 0xe1 && length >= prefix) {
			let tag = '';
			for (let i = 0; i < identifier.length; i += 1) {
				tag += String.fromCharCode(bytes[offset + 4 + i] as number);
			}
			if (tag === identifier) {
				return asExifPayload(bytes.subarray(offset + 2 + prefix, offset + 2 + length));
			}
		}
		offset += 2 + length;
	}
	return undefined;
}

/**
 * PNG carries EXIF in an `eXIf` chunk, whose contents are the block itself.
 *
 * No prefix and no compression, unlike `iCCP` beside it. The trap is where the
 * walk stops: a colour chunk after `IDAT` declares nothing, so the ICC reader
 * gives up there, but `eXIf` is explicitly allowed on either side of the image
 * data and writers that append metadata to a finished file put it after. Adding
 * the same `IDAT` guard here, which looks like an obvious tidy-up, loses the
 * metadata on exactly those files. Skipping a chunk costs one addition whatever
 * its length, so walking to the end of a large PNG is a few dozen iterations
 * rather than a scan.
 */
function pngExif(bytes: Uint8Array): Uint8Array | undefined {
	if (bytes.length < 8) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		// Length, type, data and CRC. A chunk that does not fit is a truncated
		// download, and the length field it is being measured by came out of
		// the same damaged file.
		if (offset + 12 + length > bytes.length) break;
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + 4 + i] as number);
		if (type === 'eXIf') return asExifPayload(bytes.subarray(offset + 8, offset + 8 + length));
		if (type === 'IEND') break;
		offset += 12 + length;
	}
	return undefined;
}

/** WebP carries EXIF in a RIFF chunk called `EXIF`, again with no prefix. */
function webpExif(bytes: Uint8Array): Uint8Array | undefined {
	if (bytes.length < 16) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + i] as number);
		const size = view.getUint32(offset + 4, true);
		if (offset + 8 + size > bytes.length) break;
		if (type === 'EXIF') return asExifPayload(bytes.subarray(offset + 8, offset + 8 + size));
		// Chunks are padded to an even length and the pad is not counted in the
		// size. Walking without it lands one byte into the next fourcc and
		// every chunk after that is lost.
		offset += 8 + size + (size & 1);
	}
	return undefined;
}

/**
 * Summarise an EXIF payload, starting at its TIFF header.
 *
 * Returns undefined rather than throwing on anything malformed. A photograph
 * with damaged metadata should still convert; refusing it would be trading a
 * working conversion for a tidier error path.
 */
export function readExif(payload: Uint8Array): ExifSummary | undefined {
	if (!asExifPayload(payload)) return undefined;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const little = view.getUint16(0) === 0x4949;

	const cursor: Cursor = { view, little, length: payload.length };
	const into: Accumulator = { hasLocation: false, hasSerialNumber: false, tagCount: 0 };

	const queue = [view.getUint32(4, little)];
	const seen = new Set<number>();
	while (queue.length > 0) {
		const offset = queue.shift() as number;
		if (offset <= 0 || offset >= payload.length || seen.has(offset)) continue;
		seen.add(offset);
		try {
			for (const child of readDirectory(cursor, offset, into)) queue.push(child);
		} catch {
			break;
		}
	}

	return {
		orientation: into.orientation ?? 1,
		hasLocation: into.hasLocation,
		capturedAt: into.capturedAt,
		cameraMake: into.cameraMake,
		cameraModel: into.cameraModel,
		software: into.software,
		hasSerialNumber: into.hasSerialNumber,
		tagCount: into.tagCount,
	};
}

/**
 * The same payload with its orientation tag set to 1.
 *
 * The one edit that has to happen before EXIF is written back out. The decoder
 * contract in this package is that pixels arrive upright, and a browser applies
 * the tag while decoding, so the block that came off the file is describing a
 * rotation that has already been performed. Copied across as it stands, every
 * portrait photograph converted with metadata preserved comes out sideways in
 * anything that honours the tag, which is most things.
 *
 * Writes in place on a copy rather than rebuilding the directory. A rewritten
 * block would have to renumber every offset in it, and an EXIF block holds
 * offsets into itself from directories this reader deliberately does not
 * understand. Overwriting two bytes in the entry moves nothing.
 *
 * A payload with no orientation tag, or one that cannot be parsed, is returned
 * unchanged: there is nothing to correct, and refusing to carry metadata over a
 * malformed tag would be trading a working conversion for a tidier error path.
 */
export function withUprightOrientation(payload: Uint8Array): Uint8Array {
	if (!asExifPayload(payload)) return payload;
	const little = payload[0] === 0x49;

	const out = payload.slice();
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

	// Only IFD0 and the directories it names. The orientation tag belongs to
	// IFD0 by specification, and a copy of it in a thumbnail directory
	// describes the thumbnail, which is not the picture being written.
	const queue = [view.getUint32(4, little)];
	const seen = new Set<number>();
	let found = false;
	while (queue.length > 0) {
		const start = queue.shift() as number;
		if (start <= 0 || start + 2 > out.length || seen.has(start)) continue;
		seen.add(start);
		const count = view.getUint16(start, little);
		for (let i = 0; i < count; i += 1) {
			const entry = start + 2 + i * 12;
			if (entry + 12 > out.length) break;
			if (view.getUint16(entry, little) !== TAG_ORIENTATION) continue;
			// Type 3 is SHORT, one of them, so the value sits in the entry.
			if (view.getUint16(entry + 2, little) !== 3) continue;
			view.setUint16(entry + 8, 1, little);
			found = true;
		}
		if (found) break;
	}
	return found ? out : payload;
}

/**
 * The rotation and mirror an EXIF orientation asks for.
 *
 * Only useful for a decoder that does not apply it already. Every browser
 * applies it while decoding, so calling this on the output of a native decode
 * rotates the picture a second time. That bug only shows on photographs taken
 * sideways, which is most of them, and only after somebody has shipped it.
 */
export function orientationFromExif(value: number): {
	rotation: 0 | 90 | 180 | 270;
	mirror: 'none' | 'horizontal' | 'vertical';
} {
	switch (value) {
		case 2:
			return { rotation: 0, mirror: 'horizontal' };
		case 3:
			return { rotation: 180, mirror: 'none' };
		case 4:
			return { rotation: 0, mirror: 'vertical' };
		case 5:
			return { rotation: 90, mirror: 'horizontal' };
		case 6:
			// EXIF counts clockwise, this package counts anticlockwise, so a
			// quarter turn one way is three quarters the other.
			return { rotation: 270, mirror: 'none' };
		case 7:
			return { rotation: 270, mirror: 'horizontal' };
		case 8:
			return { rotation: 90, mirror: 'none' };
		default:
			return { rotation: 0, mirror: 'none' };
	}
}
