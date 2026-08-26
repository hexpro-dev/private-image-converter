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
 *
 * ## This predicate exists twice
 *
 * `src/heif/image.ts` carries its own copy, because ESLint forbids
 * `src/heif/**` from importing `src/metadata/**` and the container reader needs
 * the same answer. The duplication is deliberate and fenced rather than
 * accidental. `tests/metadata/icc.test.ts` imports both and asserts they agree
 * over a table of real profiles, so the two cannot drift; a change here without
 * the matching change there fails that test rather than shipping two different
 * ideas of what wide gamut means.
 */

/**
 * Display P3's three colourants, as a profile stores them.
 *
 * These are the D50 adapted XYZ triples that live in the `rXYZ`, `gXYZ` and
 * `bXYZ` tags, not the D65 matrix printed beside the primaries in the
 * specification. The ICC profile connection space is D50, so a matrix/TRC
 * profile holds its primaries already run through a Bradford adaptation.
 * Copying the specification's matrix in here instead moves every number by
 * more than the tolerance below and nothing matches anything: sRGB's red X, to
 * take the one people know, is 0.4124 in the specification and 0.4361 in the
 * profile.
 *
 * Derived from the Display P3 primaries (R 0.680, 0.320; G 0.265, 0.690;
 * B 0.150, 0.060) on a D65 white, Bradford adapted to D50. They agree to the
 * last digit s15Fixed16 can hold with the `Display P3.icc` that Apple ships in
 * /System/Library/ColorSync/Profiles, which is where the overwhelming majority
 * of the P3 files anybody converts came from.
 */
const DISPLAY_P3_COLOURANTS = new Map<string, readonly [number, number, number]>([
	['rXYZ', [0.51512, 0.2412, -0.00105]],
	['gXYZ', [0.29198, 0.69225, 0.04189]],
	['bXYZ', [0.1571, 0.06657, 0.78407]],
]);

/**
 * How far a colourant may sit from Display P3's and still count as Display P3.
 *
 * The nearest rivals are sRGB and Adobe RGB, whose worst components are 0.093
 * and 0.095 away, so this leaves a factor of four in hand while still admitting
 * a profile measured off a panel rather than computed. Do not widen it past
 * about 0.03: DCI-P3 shares the primaries but sits on the theatre white point,
 * its worst component is 0.032 away, and its pixels are not Display P3 pixels
 * even though its gamut is the same triangle.
 */
const COLOURANT_TOLERANCE = 0.02;

/**
 * Whether an ICC profile describes Display P3, or something near enough to it
 * that Display P3 pixels can be tagged with this profile without lying.
 *
 * That second clause is the whole of it, and it is why this is not the "wider
 * than sRGB" test the name suggests. A true here asks the browser for a
 * `display-p3` canvas readback, so the pixels become P3 numbers, and then the
 * source's own profile is handed to the encoder and written out beside them.
 *
 * The test this replaces looked at one number, the red colourant's X, and
 * called anything above 0.48 wide. Adobe RGB (1998) puts red at 0.6097,
 * Rec.2020 at 0.6735 and ProPhoto at 0.7977, so all three passed, and an Adobe
 * RGB photograph came out as P3 pixels carrying an Adobe RGB profile. Every
 * colour managed viewer honours that tag, so it pulls the picture back towards
 * a gamut the numbers were never in and the reds and greens land visibly wrong.
 * The file looks correct in anything that ignores profiles, which is what makes
 * it survive a review. Adobe RGB and Display P3 are close in size and nothing
 * alike in shape, and only checking all three colourants tells them apart.
 *
 * Decided from the colourants rather than the profile description, because the
 * description is free text that vendors change between releases.
 */
export function iccIsWideGamut(profile: Uint8Array): boolean {
	if (profile.length < 132) return false;
	const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
	const tagCount = view.getUint32(128);
	// A plausible profile has a handful of tags. A four billion tag count means
	// this is not a profile at all.
	if (tagCount === 0 || tagCount > 1024) return false;

	const matched = new Set<string>();
	for (let i = 0; i < tagCount; i += 1) {
		const entry = 132 + i * 12;
		if (entry + 12 > profile.length) break;
		let signature = '';
		for (let c = 0; c < 4; c += 1) signature += String.fromCharCode(view.getUint8(entry + c));
		const expected = DISPLAY_P3_COLOURANTS.get(signature);
		if (!expected) continue;
		const offset = view.getUint32(entry + 4);
		if (offset + 20 > profile.length) return false;
		// An XYZType tag is a signature, four reserved bytes, then s15Fixed16
		// X, Y and Z.
		for (let axis = 0; axis < 3; axis += 1) {
			const value = view.getInt32(offset + 8 + axis * 4) / 65536;
			if (Math.abs(value - expected[axis]) > COLOURANT_TOLERANCE) return false;
		}
		matched.add(signature);
	}
	// All three or none of it. One matching corner is not a gamut, and a
	// profile that carries only `rXYZ` is a fixture rather than a file.
	return matched.size === DISPLAY_P3_COLOURANTS.size;
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
