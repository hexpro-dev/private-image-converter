/**
 * Reading EXIF, mostly so it can be thrown away knowingly.
 *
 * A conversion through a canvas strips metadata whether you meant it to or
 * not. That is the right default for this tool, but "the metadata is gone" is
 * a much weaker thing to tell somebody than "the coordinates of where this was
 * taken, the time, and the camera's serial number are gone". So this reads
 * enough to say what was there, and to put it back when it is asked to.
 *
 * It is a TIFF header parser and nothing more. No tag is interpreted beyond
 * the handful named below, because every additional tag is another chance to
 * mis-parse a stranger's file for no gain.
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
 * Summarise an EXIF payload, starting at its TIFF header.
 *
 * Returns undefined rather than throwing on anything malformed. A photograph
 * with damaged metadata should still convert; refusing it would be trading a
 * working conversion for a tidier error path.
 */
export function readExif(payload: Uint8Array): ExifSummary | undefined {
	if (payload.length < 8) return undefined;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	const byteOrder = view.getUint16(0);
	if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return undefined;
	const little = byteOrder === 0x4949;
	if (view.getUint16(2, little) !== 42) return undefined;

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
