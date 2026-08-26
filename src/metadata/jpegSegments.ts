/**
 * Putting metadata back into a JPEG a canvas produced.
 *
 * A canvas encodes pixels and nothing else. It is handed a raster and returns a
 * JPEG with no EXIF and, depending on the browser, no colour profile either, so
 * everything the decoder went and found is lost at the last step unless it is
 * spliced back in here.
 *
 * This is byte surgery on a finished file rather than an encoder option,
 * because there is no encoder option: `toBlob` takes a type and a quality. The
 * surgery is safe because JPEG is a sequence of marker segments and inserting
 * another one before the first scan changes nothing about how the image data is
 * read.
 *
 * ## Where a segment may go
 *
 * Straight after the start of image marker, and after a JFIF `APP0` if there is
 * one. The specification wants `APP1` immediately after `SOI`, and every reader
 * in practice accepts it after `APP0` as well, which is the arrangement a
 * camera writes. Putting it later, after a quantisation table for instance,
 * is where readers start disagreeing.
 *
 * ## What this refuses to do
 *
 * A segment's payload is at most 65,533 bytes. EXIF larger than that has to be
 * split across several `APP1` segments in a scheme only some readers implement,
 * so an oversized block is dropped rather than written in a form that would
 * make the file unreadable to the readers that matter. A profile is different:
 * chunking `ICC_PROFILE` across segments is part of the ICC specification and
 * is universally understood, so that one is split properly.
 *
 * Nothing is inserted twice. If the browser already wrote a profile, which
 * recent Chrome does for a wide gamut canvas, the one found in the file wins
 * and ours is left out. Two profiles in one JPEG is not a merge, it is a file
 * where the answer depends on which reader opened it.
 */

const SOI = 0xd8;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const SOS = 0xda;
const EOI = 0xd9;

/** The most a marker segment can carry, counting its own two length bytes. */
const MAX_SEGMENT_PAYLOAD = 0xffff - 2;

const EXIF_TAG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const ICC_TAG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];

export interface JpegMetadata {
	/** EXIF from the TIFF header onwards, with no `Exif\0\0` prefix. */
	readonly exif?: Uint8Array;
	readonly iccProfile?: Uint8Array;
}

interface Survey {
	/** Byte offset where a new segment may be inserted. */
	readonly insertAt: number;
	readonly hasExif: boolean;
	readonly hasProfile: boolean;
}

function startsWith(bytes: Uint8Array, at: number, tag: readonly number[]): boolean {
	if (at + tag.length > bytes.length) return false;
	for (let i = 0; i < tag.length; i += 1) {
		if (bytes[at + i] !== tag[i]) return false;
	}
	return true;
}

/**
 * Walk the marker segments, far enough to know what is already there.
 *
 * Stops at the first scan, because everything after it is entropy coded data in
 * which a byte that looks like a marker usually is not one. Returns undefined
 * for anything that is not a JPEG, which is the caller's signal to leave the
 * bytes alone rather than to throw: this runs on the output of an encoder that
 * has already been checked, so a surprise here means something further up is
 * wrong and losing the metadata is better than losing the picture.
 */
function survey(bytes: Uint8Array): Survey | undefined {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return undefined;

	let at = 2;
	let insertAt = 2;
	let hasExif = false;
	let hasProfile = false;

	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) return undefined;
		const marker = bytes[at + 1] as number;
		if (marker === SOS || marker === EOI) break;
		// Padding: a run of 0xff bytes before a marker is legal.
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
		if (length < 2 || at + 2 + length > bytes.length) return undefined;
		const payload = at + 4;

		if (marker === APP0) {
			// A JFIF header belongs first, so anything of ours goes after it.
			insertAt = at + 2 + length;
		} else if (marker === APP1 && startsWith(bytes, payload, EXIF_TAG)) {
			hasExif = true;
		} else if (marker === APP2 && startsWith(bytes, payload, ICC_TAG)) {
			hasProfile = true;
		}
		at += 2 + length;
	}

	return { insertAt, hasExif, hasProfile };
}

function segment(marker: number, tag: readonly number[], payload: Uint8Array): Uint8Array {
	const length = 2 + tag.length + payload.length;
	const out = new Uint8Array(2 + length);
	out[0] = 0xff;
	out[1] = marker;
	out[2] = (length >> 8) & 0xff;
	out[3] = length & 0xff;
	out.set(tag, 4);
	out.set(payload, 4 + tag.length);
	return out;
}

/**
 * The profile, split into as many segments as it needs.
 *
 * Each carries a one-based sequence number and the total count, which is what
 * lets a reader put them back together. The count is a single byte, so a
 * profile needing more than 255 segments cannot be written; at roughly 65 kB a
 * segment that is a sixteen megabyte profile, which does not exist.
 */
function profileSegments(profile: Uint8Array): Uint8Array[] {
	const room = MAX_SEGMENT_PAYLOAD - ICC_TAG.length - 2;
	const count = Math.ceil(profile.length / room);
	if (count === 0 || count > 255) return [];
	const out: Uint8Array[] = [];
	for (let i = 0; i < count; i += 1) {
		const slice = profile.subarray(i * room, Math.min((i + 1) * room, profile.length));
		const payload = new Uint8Array(2 + slice.length);
		payload[0] = i + 1;
		payload[1] = count;
		payload.set(slice, 2);
		out.push(segment(APP2, ICC_TAG, payload));
	}
	return out;
}

/**
 * Return `bytes` with the given metadata inserted, or `bytes` itself.
 *
 * Never throws and never returns something that is not a JPEG. A caller that
 * hands it anything unexpected gets its input back.
 */
export function spliceJpegMetadata(bytes: Uint8Array, metadata: JpegMetadata): Uint8Array {
	const found = survey(bytes);
	if (!found) return bytes;

	const additions: Uint8Array[] = [];

	if (metadata.exif && metadata.exif.length > 0 && !found.hasExif) {
		if (metadata.exif.length <= MAX_SEGMENT_PAYLOAD - EXIF_TAG.length) {
			additions.push(segment(APP1, EXIF_TAG, metadata.exif));
		}
	}

	if (metadata.iccProfile && metadata.iccProfile.length > 0 && !found.hasProfile) {
		additions.push(...profileSegments(metadata.iccProfile));
	}

	if (additions.length === 0) return bytes;

	let added = 0;
	for (const part of additions) added += part.length;
	const out = new Uint8Array(bytes.length + added);
	out.set(bytes.subarray(0, found.insertAt), 0);
	let at = found.insertAt;
	for (const part of additions) {
		out.set(part, at);
		at += part.length;
	}
	out.set(bytes.subarray(found.insertAt), at);
	return out;
}
