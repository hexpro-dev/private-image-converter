/**
 * Just enough ICC to know whether an image is wide gamut.
 *
 * This is not a colour management engine and must not become one. It answers
 * one question, which is whether the numbers in this file mean Display P3 or
 * something close to it, because that decides whether asking the browser for a
 * wide gamut readback is preservation or damage.
 *
 * Getting it backwards is the failure worth naming: converting an image that
 * is already sRGB into P3 and then writing it untagged oversaturates it by
 * roughly the same amount that dropping a P3 tag washes one out. Neither
 * throws, and on a wide gamut display both look plausible.
 */

/**
 * Whether an ICC profile describes a gamut meaningfully wider than sRGB.
 *
 * Decided from the red colourant rather than the profile description, because
 * the description is free text that vendors change between releases. sRGB puts
 * the red primary's X at about 0.436 and Display P3 at about 0.515, so a
 * midpoint separates them with room to spare and there is nothing to tune.
 */
export function iccIsWideGamut(profile: Uint8Array): boolean {
	if (profile.length < 132) return false;
	const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
	const tagCount = view.getUint32(128);
	// A plausible profile has a handful of tags. A four billion tag count means
	// this is not a profile at all.
	if (tagCount === 0 || tagCount > 1024) return false;

	for (let i = 0; i < tagCount; i += 1) {
		const entry = 132 + i * 12;
		if (entry + 12 > profile.length) break;
		let signature = '';
		for (let c = 0; c < 4; c += 1) signature += String.fromCharCode(view.getUint8(entry + c));
		if (signature !== 'rXYZ') continue;
		const offset = view.getUint32(entry + 4);
		if (offset + 20 > profile.length) return false;
		// An XYZType tag is a signature, four reserved bytes, then s15Fixed16
		// X, Y and Z.
		return view.getInt32(offset + 8) / 65536 > 0.48;
	}
	return false;
}

/**
 * Find the embedded ICC profile in a file, if it has one.
 *
 * Covers the three formats where a browser decode is the fast path and the
 * gamut question is live: JPEG, PNG and WebP. HEIC is not here because its
 * profile comes out of the container parser, which has already read it.
 */
export function findIccProfile(bytes: Uint8Array, format: string): Uint8Array | undefined {
	if (format === 'jpeg') return jpegIcc(bytes);
	if (format === 'png') return pngIcc(bytes);
	if (format === 'webp') return webpIcc(bytes);
	return undefined;
}

/**
 * JPEG carries ICC in APP2 segments marked `ICC_PROFILE`.
 *
 * A profile larger than a segment is split across several, each numbered, and
 * they have to be joined in order. Reading only the first chunk yields a
 * truncated profile that parses far enough to give a confident wrong answer.
 */
function jpegIcc(bytes: Uint8Array): Uint8Array | undefined {
	const marker = 'ICC_PROFILE\0';
	const chunks: { index: number; data: Uint8Array }[] = [];
	let offset = 2;

	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) break;
		const kind = bytes[offset + 1] as number;
		// Start of scan: the entropy coded data begins and there are no more
		// headers worth walking.
		if (kind === 0xda) break;
		const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
		if (length < 2 || offset + 2 + length > bytes.length) break;

		if (kind === 0xe2) {
			let tag = '';
			for (let i = 0; i < marker.length; i += 1) {
				tag += String.fromCharCode(bytes[offset + 4 + i] as number);
			}
			if (tag === marker) {
				const index = bytes[offset + 4 + marker.length] as number;
				chunks.push({
					index,
					data: bytes.subarray(offset + 4 + marker.length + 2, offset + 2 + length),
				});
			}
		}
		offset += 2 + length;
	}

	if (chunks.length === 0) return undefined;
	chunks.sort((a, b) => a.index - b.index);
	let total = 0;
	for (const chunk of chunks) total += chunk.data.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk.data, at);
		at += chunk.data.length;
	}
	return out;
}

/**
 * PNG carries ICC in a deflated `iCCP` chunk, and a gamut hint in `cICP`.
 *
 * The profile is compressed, and inflating it here would make this function
 * async for one boolean. `cICP` is read directly when present; otherwise the
 * mere presence of `iCCP` is reported by returning an empty array, which the
 * caller treats as "there is a profile but its contents are unknown".
 */
function pngIcc(bytes: Uint8Array): Uint8Array | undefined {
	if (bytes.length < 8) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		if (offset + 12 + length > bytes.length) break;
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + 4 + i] as number);
		if (type === 'cICP') {
			// Colour primaries 12 is SMPTE EG 432-1, which is Display P3.
			return bytes[offset + 8] === 12 ? WIDE_GAMUT_SENTINEL : new Uint8Array(0);
		}
		if (type === 'iCCP') return new Uint8Array(0);
		if (type === 'IDAT' || type === 'IEND') break;
		offset += 12 + length;
	}
	return undefined;
}

function webpIcc(bytes: Uint8Array): Uint8Array | undefined {
	if (bytes.length < 16) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		let type = '';
		for (let i = 0; i < 4; i += 1) type += String.fromCharCode(bytes[offset + i] as number);
		const size = view.getUint32(offset + 4, true);
		if (offset + 8 + size > bytes.length) break;
		if (type === 'ICCP') return bytes.subarray(offset + 8, offset + 8 + size);
		// Chunks are padded to an even length.
		offset += 8 + size + (size & 1);
	}
	return undefined;
}

/**
 * Returned when a file declares a wide gamut without carrying a readable
 * profile, as a PNG with only a `cICP` chunk does.
 *
 * A distinct object rather than a boolean so the one caller can tell "wide,
 * and here is the profile to re-embed" from "wide, but there is nothing to
 * carry across".
 */
export const WIDE_GAMUT_SENTINEL = new Uint8Array(0);

/** Whether a file's own bytes say it is wider than sRGB. */
export function declaresWideGamut(bytes: Uint8Array, format: string): boolean {
	const profile = findIccProfile(bytes, format);
	if (!profile) return false;
	if (profile === WIDE_GAMUT_SENTINEL) return true;
	if (profile.length === 0) return false;
	return iccIsWideGamut(profile);
}
