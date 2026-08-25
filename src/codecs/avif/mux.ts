/**
 * Writing the ISOBMFF that turns an AV1 keyframe into an AVIF.
 *
 * The reader in `src/heif/` takes these boxes apart; this takes the other
 * direction, and deliberately does not share code with it. A codec is a leaf
 * that receives bytes and returns bytes, and the box vocabulary a writer needs
 * is a fraction of what a reader has to survive: nothing here reads a
 * stranger's file, so none of the bounds checking that makes the reader what
 * it is has anything to guard.
 *
 * The shape of the file is `ftyp`, then `meta`, then `mdat`. `meta` says which
 * items exist, what each of them is, which properties each claims and where
 * each one's bytes are; `mdat` is the bytes. Nothing is interleaved and
 * nothing is optional about the order, because the offsets in `iloc` are
 * absolute positions in the file. That is the one genuinely awkward thing
 * about writing this format: the size of `meta` depends on what is in `iloc`,
 * and what is in `iloc` depends on the size of `meta`. It is settled here by
 * building `meta` twice, once with zeroes to measure it and once with the real
 * offsets, and then asserting the two came out the same length. They always
 * do, because the offset fields are a fixed four bytes wide, and the assertion
 * is there because an offset that is wrong by one produces a file that every
 * reader rejects and no reader explains.
 *
 * The item layout for a gain map follows what Apple's own HEIC does, which is
 * a base picture as the primary item, the gain map as a second hidden picture,
 * and a `tmap` item whose `dimg` reference names the two of them in that order
 * and whose own data is the parameter block. Leaving the base picture as the
 * primary item rather than the `tmap` is the part worth saying out loud: a
 * reader that has never heard of gain maps then shows the ordinary photograph
 * instead of failing on a derived item it cannot build.
 */

import { EncodeFailedError } from '../../errors.js';
import type { ColourSpace } from '../../types.js';

const ENCODER_ID = 'avif-webcodecs';

function fail(detail: string): never {
	throw new EncodeFailedError('avif', ENCODER_ID, detail);
}

/* ── Box writing ──────────────────────────────────────────────────────── */

function u8(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff);
}

function u16(value: number): Uint8Array {
	return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u24(value: number): Uint8Array {
	return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
	return Uint8Array.of(
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

/** A four character box type or brand. Always ASCII, by definition of the format. */
function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

/** A null-terminated UTF-8 string, as `infe` and `auxC` carry. */
function cString(text: string): Uint8Array {
	const encoded = new TextEncoder().encode(text);
	const out = new Uint8Array(encoded.length + 1);
	out.set(encoded);
	return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * A box: a length, a four character type, and whatever was handed in.
 *
 * Composable rather than one long writer, because the nesting is four deep in
 * places and every level of it is the same three lines. The 64 bit `largesize`
 * spelling is not written: a box that needs it is four gigabytes of picture,
 * which will not have reached this point.
 */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(parts);
	return concat([u32(body.length + 8), ascii(type), body]);
}

/** A box whose first four payload bytes are a version and 24 bits of flags. */
function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
	return box(type, u8(version), u24(flags), ...parts);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/* ── Properties ───────────────────────────────────────────────────────── */

/**
 * The `ipco` list, and the one-based indices `ipma` uses to point into it.
 *
 * Identical properties are stored once and claimed by every item that wants
 * them, which is what Apple does: one `ispe` serves all thirty-two tiles of a
 * photograph. Here it matters far less, with at most four items, and it is
 * still worth doing because the alternative is a list where two entries are
 * byte for byte the same and a reader has no way to know that was deliberate.
 */
class Properties {
	private readonly boxes: Uint8Array[] = [];

	/** The index of `property`, adding it to the list if it is new. */
	index(property: Uint8Array): number {
		for (let i = 0; i < this.boxes.length; i += 1) {
			if (same(this.boxes[i] as Uint8Array, property)) return i + 1;
		}
		this.boxes.push(property);
		return this.boxes.length;
	}

	container(): Uint8Array {
		return box('ipco', ...this.boxes);
	}
}

/** ITU-T H.273 colour primaries. 1 is BT.709, which is also sRGB's. */
const PRIMARIES: Readonly<Record<ColourSpace, number>> = { srgb: 1, 'display-p3': 12 };
/** Transfer characteristics 13, IEC 61966-2-1, which is the sRGB curve. */
const TRANSFER_SRGB = 13;
/** Matrix coefficients 6, BT.601, which is what the browser's encoder writes. */
const MATRIX_BT601 = 6;
/** Primaries and transfer 2, meaning unspecified. What an auxiliary picture is. */
const UNSPECIFIED = 2;

/** The URN that marks an auxiliary item as the alpha channel of its master. */
export const ALPHA_AUX_URN = 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha';

function ispeBox(width: number, height: number): Uint8Array {
	return fullBox('ispe', 0, 0, u32(width), u32(height));
}

/**
 * Bits per channel, one entry per channel.
 *
 * Always eight, because `VideoEncoder` refuses ten bit AV1 in every browser
 * measured, so there is no other depth this package can produce.
 */
function pixiBox(channels: number): Uint8Array {
	const bits: Uint8Array[] = [];
	for (let i = 0; i < channels; i += 1) bits.push(u8(8));
	return fullBox('pixi', 0, 0, u8(channels), ...bits);
}

function nclxBox(
	primaries: number,
	transfer: number,
	matrix: number,
	fullRange: boolean,
): Uint8Array {
	return box(
		'colr',
		ascii('nclx'),
		u16(primaries),
		u16(transfer),
		u16(matrix),
		u8(fullRange ? 0x80 : 0x00),
	);
}

function iccBox(profile: Uint8Array): Uint8Array {
	// `prof` rather than `rICC`: the restricted spelling forbids most of what a
	// camera profile contains, and a profile that came out of a photograph is
	// not restricted.
	return box('colr', ascii('prof'), profile);
}

function auxCBox(urn: string): Uint8Array {
	return fullBox('auxC', 0, 0, cString(urn));
}

/* ── The specification a caller hands in ──────────────────────────────── */

/** One coded picture, ready to be an item. */
export interface AvifCodedImage {
	/** The OBU chain, temporal delimiters already removed. */
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
	/** The `av1C` record, as `buildAv1C` produced it. */
	readonly config: Uint8Array;
}

export interface AvifGainMapSpec {
	readonly image: AvifCodedImage;
	/**
	 * The parameter block, carried through untouched.
	 *
	 * Never parsed and never rewritten. Every value that decides what the
	 * photograph looks like at a given display headroom is in here, so copying
	 * it reproduces the picture exactly, and reading it in order to write it
	 * back could only introduce error.
	 */
	readonly metadata: Uint8Array;
	readonly iccProfile?: Uint8Array;
}

export interface AvifMuxSpec {
	readonly colour: AvifCodedImage;
	readonly colourSpace: ColourSpace;
	readonly alpha?: AvifCodedImage;
	readonly gainMap?: AvifGainMapSpec;
	readonly iccProfile?: Uint8Array;
	/**
	 * Whether the coded samples use all 256 codes.
	 *
	 * Defaults to true, which is what a writer that controls its own encoder
	 * would say. It is a parameter because this one does not: the browser's AV1
	 * encoder writes studio range and says so in the sequence header, and a
	 * `colr` box overrides that, so declaring full range over studio range
	 * samples lifts every black in the picture without reporting anything.
	 */
	readonly fullRange?: boolean;
}

/* ── The file ─────────────────────────────────────────────────────────── */

interface Association {
	readonly index: number;
	readonly essential: boolean;
}

interface PlannedItem {
	readonly id: number;
	readonly type: string;
	readonly hidden: boolean;
	/** Offset of this item's bytes from the first byte of the `mdat` payload. */
	readonly offset: number;
	readonly length: number;
	readonly associations: readonly Association[];
}

interface PlannedReference {
	readonly type: string;
	readonly from: number;
	readonly to: readonly number[];
}

/**
 * The `meta` box, with every item offset shifted by `base`.
 *
 * Called twice: once with zero, to find out how long it is, and once with the
 * real position of the `mdat` payload. Every field it writes is a fixed width,
 * so the length cannot change between the two calls, and the caller checks.
 */
function buildMeta(
	items: readonly PlannedItem[],
	properties: Properties,
	primaryId: number,
	references: readonly PlannedReference[],
	base: number,
): Uint8Array {
	const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), u8(0));
	const pitm = fullBox('pitm', 0, 0, u16(primaryId));

	const infes = items.map((item) =>
		// Version 2 is the first with an item type in it, which is the only
		// field here that matters. Flag bit 0 marks an item hidden, which is
		// how an auxiliary picture says it is not the photograph.
		fullBox('infe', 2, item.hidden ? 1 : 0, u16(item.id), u16(0), ascii(item.type), u8(0)),
	);
	const iinf = fullBox('iinf', 0, 0, u16(items.length), ...infes);

	// Four byte offsets and four byte lengths, no base offset and no index.
	// Version 0 has no construction method field, which is correct here: every
	// item's bytes are in `mdat` at an absolute file position.
	const locations = items.map((item) =>
		concat([u16(item.id), u16(0), u16(1), u32(base + item.offset), u32(item.length)]),
	);
	const iloc = fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(items.length), ...locations);

	const ipmaEntries = items.map((item) =>
		concat([
			u16(item.id),
			u8(item.associations.length),
			// The high bit marks a property essential, meaning a reader that
			// does not understand it must refuse the item rather than ignore
			// it. `av1C` and `auxC` carry it; a descriptive property like
			// `ispe` must not, or an old reader throws away a picture it could
			// have shown.
			...item.associations.map((a) => u8((a.essential ? 0x80 : 0x00) | a.index)),
		]),
	);
	const ipma = fullBox('ipma', 0, 0, u32(items.length), ...ipmaEntries);
	const iprp = box('iprp', properties.container(), ipma);

	const children = [hdlr, pitm, iloc, iinf, iprp];
	if (references.length > 0) {
		const entries = references.map((reference) =>
			box(reference.type, u16(reference.from), u16(reference.to.length), ...reference.to.map(u16)),
		);
		children.push(fullBox('iref', 0, 0, ...entries));
	}
	return fullBox('meta', 0, 0, ...children);
}

/** Assemble an AVIF around one or more coded pictures. */
export function muxAvif(spec: AvifMuxSpec): Uint8Array {
	const properties = new Properties();
	const items: PlannedItem[] = [];
	const references: PlannedReference[] = [];
	const chunks: Uint8Array[] = [];
	let mdatLength = 0;
	let nextId = 1;

	const place = (data: Uint8Array): number => {
		const offset = mdatLength;
		chunks.push(data);
		mdatLength += data.length;
		return offset;
	};

	const fullRange = spec.fullRange ?? true;
	const sceneColour = nclxBox(PRIMARIES[spec.colourSpace], TRANSFER_SRGB, MATRIX_BT601, fullRange);

	const colourId = nextId;
	nextId += 1;
	const colourProperties: Association[] = [
		{ index: properties.index(box('av1C', spec.colour.config)), essential: true },
		{ index: properties.index(ispeBox(spec.colour.width, spec.colour.height)), essential: false },
		{ index: properties.index(pixiBox(3)), essential: false },
		{ index: properties.index(sceneColour), essential: false },
	];
	if (spec.iccProfile) {
		colourProperties.push({ index: properties.index(iccBox(spec.iccProfile)), essential: false });
	}
	items.push({
		id: colourId,
		type: 'av01',
		hidden: false,
		offset: place(spec.colour.data),
		length: spec.colour.data.length,
		associations: colourProperties,
	});

	if (spec.alpha) {
		const alphaId = nextId;
		nextId += 1;
		items.push({
			id: alphaId,
			type: 'av01',
			hidden: true,
			offset: place(spec.alpha.data),
			length: spec.alpha.data.length,
			associations: [
				{ index: properties.index(box('av1C', spec.alpha.config)), essential: true },
				{
					index: properties.index(ispeBox(spec.alpha.width, spec.alpha.height)),
					essential: false,
				},
				// One channel, even though the coded picture has three. The
				// item carries one meaningful plane and this encoder cannot
				// produce a monochrome AV1, so coverage is written into all
				// three and the luma plane is the one a reader takes.
				{ index: properties.index(pixiBox(1)), essential: false },
				// Unspecified primaries and transfer, because coverage is not a
				// colour. The matrix and the range are not decoration: they are
				// what tells a reader how to get the plane back out.
				{
					index: properties.index(nclxBox(UNSPECIFIED, UNSPECIFIED, MATRIX_BT601, fullRange)),
					essential: false,
				},
				{ index: properties.index(auxCBox(ALPHA_AUX_URN)), essential: true },
			],
		});
		// From the auxiliary item to the picture it belongs to, which is the
		// direction the standard sets and the direction Apple writes.
		references.push({ type: 'auxl', from: alphaId, to: [colourId] });
	}

	if (spec.gainMap) {
		const map = spec.gainMap;
		const gainMapId = nextId;
		nextId += 1;
		const gainMapProperties: Association[] = [
			{ index: properties.index(box('av1C', map.image.config)), essential: true },
			{
				index: properties.index(ispeBox(map.image.width, map.image.height)),
				essential: false,
			},
			{ index: properties.index(pixiBox(3)), essential: false },
			{
				index: properties.index(nclxBox(UNSPECIFIED, UNSPECIFIED, MATRIX_BT601, fullRange)),
				essential: false,
			},
		];
		if (map.iccProfile) {
			gainMapProperties.push({
				index: properties.index(iccBox(map.iccProfile)),
				essential: false,
			});
		}
		items.push({
			id: gainMapId,
			type: 'av01',
			hidden: true,
			offset: place(map.image.data),
			length: map.image.data.length,
			associations: gainMapProperties,
		});

		const tmapId = nextId;
		nextId += 1;
		const tmapProperties: Association[] = [
			// The derived picture is the size of the base, not of the map: the
			// map is usually smaller and is scaled up as it is applied.
			{ index: properties.index(ispeBox(spec.colour.width, spec.colour.height)), essential: false },
			{ index: properties.index(pixiBox(3)), essential: false },
			{ index: properties.index(sceneColour), essential: false },
		];
		if (spec.iccProfile) {
			tmapProperties.push({ index: properties.index(iccBox(spec.iccProfile)), essential: false });
		}
		items.push({
			id: tmapId,
			type: 'tmap',
			hidden: false,
			offset: place(map.metadata),
			length: map.metadata.length,
			associations: tmapProperties,
		});
		// Base first, gain map second. The order is the meaning: swapping them
		// asks a reader to brighten the map by the photograph.
		references.push({ type: 'dimg', from: tmapId, to: [colourId, gainMapId] });
	}

	// `tmap` is how a file announces that it holds a gain map, and it goes in
	// the compatible brands rather than anywhere in `meta`. Apple writes it on
	// every HDR photograph an iPhone takes, and a reader is entitled to decide
	// from the brand list alone whether it is worth looking for one, so a file
	// that carried the map and omitted the brand would be an HDR photograph
	// that most things display as standard range.
	const brands = [ascii('avif'), ascii('mif1'), ascii('miaf')];
	if (spec.gainMap) brands.push(ascii('tmap'));
	const ftyp = box('ftyp', ascii('avif'), u32(0), ...brands);
	const measured = buildMeta(items, properties, colourId, references, 0);
	const mdatStart = ftyp.length + measured.length + 8;
	if (mdatStart + mdatLength > 0xffffffff) {
		fail('the picture is too large for the four byte offsets this writer uses');
	}
	const settled = buildMeta(items, properties, colourId, references, mdatStart);
	if (settled.length !== measured.length) {
		fail('the item locations changed size when the real offsets were written into them');
	}
	return concat([ftyp, settled, box('mdat', ...chunks)]);
}
