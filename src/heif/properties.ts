/**
 * Item properties, from the `ipco` box.
 *
 * Only the properties this reader acts on are decoded. Everything else is kept
 * as a raw box so that `ipma`'s one-based indices still line up, which matters
 * because those indices are how an item claims its properties and an off-by-one
 * silently hands an item somebody else's rotation.
 */

import { HeifMalformedError } from '../errors.js';
import type { Mirror, Rotation } from '../types.js';
import { ByteReader, readFullBoxHeader } from './boxes.js';
import type { BoxHeader } from './boxes.js';

export interface SpatialExtent {
	readonly kind: 'ispe';
	readonly width: number;
	readonly height: number;
}

export interface RotationProperty {
	readonly kind: 'irot';
	readonly rotation: Rotation;
}

export interface MirrorProperty {
	readonly kind: 'imir';
	readonly mirror: Mirror;
}

export interface HevcConfigProperty {
	readonly kind: 'hvcC';
	/**
	 * The box payload, unmodified.
	 *
	 * WebCodecs takes this verbatim as `VideoDecoderConfig.description`, so it
	 * is kept rather than rebuilt from the parsed fields. Rebuilding it would
	 * mean round-tripping every field correctly, including ones this parser
	 * ignores, for no benefit.
	 */
	readonly raw: Uint8Array;
	readonly profileSpace: number;
	readonly tierFlag: number;
	readonly profileIdc: number;
	readonly profileCompatibilityFlags: number;
	readonly constraintFlags: Uint8Array;
	readonly levelIdc: number;
	/** Bytes in each NAL length prefix in the item payload. Almost always 4. */
	readonly lengthSize: number;
	/** VPS, SPS and PPS, in the order the file lists them. */
	readonly parameterSets: readonly Uint8Array[];
}

export interface ColourProperty {
	readonly kind: 'colr';
	readonly type: 'nclx' | 'icc';
	/** ITU-T H.273 colour primaries. 12 is Display P3. */
	readonly primaries?: number;
	readonly transfer?: number;
	readonly matrix?: number;
	readonly fullRange?: boolean;
	readonly iccProfile?: Uint8Array;
}

export interface PixelInformation {
	readonly kind: 'pixi';
	readonly bitsPerChannel: readonly number[];
}

export interface AuxiliaryType {
	readonly kind: 'auxC';
	readonly auxType: string;
}

export interface CleanAperture {
	readonly kind: 'clap';
	readonly width: number;
	readonly height: number;
	readonly horizontalOffset: number;
	readonly verticalOffset: number;
}

export interface ContentLightLevel {
	readonly kind: 'clli';
	readonly maxContentLightLevel: number;
	readonly maxPictureAverageLightLevel: number;
}

export interface UnknownProperty {
	readonly kind: 'other';
	readonly type: string;
}

export type ItemProperty =
	| SpatialExtent
	| RotationProperty
	| MirrorProperty
	| HevcConfigProperty
	| ColourProperty
	| PixelInformation
	| AuxiliaryType
	| CleanAperture
	| ContentLightLevel
	| UnknownProperty;

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

function parseHvcC(bytes: Uint8Array, box: BoxHeader): HevcConfigProperty {
	const raw = bytes.subarray(box.bodyStart, box.end);
	const reader = new ByteReader(bytes, 'decoder-config', box.bodyStart, box.end);
	reader.u8(); // configurationVersion
	const first = reader.u8();
	const profileSpace = first >> 6;
	const tierFlag = (first >> 5) & 1;
	const profileIdc = first & 0x1f;
	const profileCompatibilityFlags = reader.u32();
	const constraintFlags = reader.slice(6);
	const levelIdc = reader.u8();
	// min_spatial_segmentation_idc (2), parallelismType (1), chromaFormat (1),
	// bitDepthLumaMinus8 (1), bitDepthChromaMinus8 (1), avgFrameRate (2).
	// Eight bytes, not six: miscounting here lands lengthSizeMinusOne on the
	// frame rate, which yields a NAL length prefix of 1 and a parameter set
	// count of 0, and the file then looks like it has no decoder configuration
	// at all rather than like it was read wrongly.
	reader.skip(8);
	const lengthSize = (reader.u8() & 0x03) + 1;

	const arrayCount = reader.u8();
	const parameterSets: Uint8Array[] = [];
	for (let i = 0; i < arrayCount; i += 1) {
		reader.u8(); // array completeness and NAL unit type
		const nalCount = reader.u16();
		for (let n = 0; n < nalCount; n += 1) {
			const length = reader.u16();
			parameterSets.push(reader.slice(length));
		}
	}

	return {
		kind: 'hvcC',
		raw,
		profileSpace,
		tierFlag,
		profileIdc,
		profileCompatibilityFlags,
		constraintFlags,
		levelIdc,
		lengthSize,
		parameterSets,
	};
}

function parseColr(bytes: Uint8Array, box: BoxHeader): ColourProperty {
	const reader = new ByteReader(bytes, 'item-properties', box.bodyStart, box.end);
	const type = reader.ascii(4);
	if (type === 'nclx') {
		const primaries = reader.u16();
		const transfer = reader.u16();
		const matrix = reader.u16();
		const fullRange = (reader.u8() & 0x80) !== 0;
		return { kind: 'colr', type: 'nclx', primaries, transfer, matrix, fullRange };
	}
	if (type === 'rICC' || type === 'prof') {
		return { kind: 'colr', type: 'icc', iccProfile: reader.slice(reader.remaining) };
	}
	throw new HeifMalformedError(
		'item-properties',
		`a colr box declared an unknown type "${type}"`,
		box.start,
	);
}

function parseClap(bytes: Uint8Array, box: BoxHeader): CleanAperture {
	const reader = new ByteReader(bytes, 'item-properties', box.bodyStart, box.end);
	const ratio = (): number => {
		const numerator = reader.u32();
		const denominator = reader.u32();
		if (denominator === 0) {
			throw new HeifMalformedError('item-properties', 'a clap box divided by zero', box.start);
		}
		return numerator / denominator;
	};
	const width = ratio();
	const height = ratio();
	const horizontalOffset = ratio();
	const verticalOffset = ratio();
	return { kind: 'clap', width, height, horizontalOffset, verticalOffset };
}

export function parseProperty(bytes: Uint8Array, box: BoxHeader): ItemProperty {
	switch (box.type) {
		case 'ispe': {
			const full = readFullBoxHeader(bytes, box, 'item-properties');
			const reader = new ByteReader(bytes, 'item-properties', full.bodyStart, box.end);
			return { kind: 'ispe', width: reader.u32(), height: reader.u32() };
		}
		case 'irot': {
			const reader = new ByteReader(bytes, 'item-properties', box.bodyStart, box.end);
			return { kind: 'irot', rotation: ROTATIONS[reader.u8() & 0x03] as Rotation };
		}
		case 'imir': {
			const reader = new ByteReader(bytes, 'item-properties', box.bodyStart, box.end);
			// axis 0 mirrors about a vertical axis, which flips left to right.
			return { kind: 'imir', mirror: (reader.u8() & 0x01) === 0 ? 'horizontal' : 'vertical' };
		}
		case 'hvcC':
			return parseHvcC(bytes, box);
		case 'colr':
			return parseColr(bytes, box);
		case 'pixi': {
			const full = readFullBoxHeader(bytes, box, 'item-properties');
			const reader = new ByteReader(bytes, 'item-properties', full.bodyStart, box.end);
			const channels = reader.u8();
			const bits: number[] = [];
			for (let i = 0; i < channels; i += 1) bits.push(reader.u8());
			return { kind: 'pixi', bitsPerChannel: bits };
		}
		case 'auxC': {
			const full = readFullBoxHeader(bytes, box, 'item-properties');
			const reader = new ByteReader(bytes, 'item-properties', full.bodyStart, box.end);
			return { kind: 'auxC', auxType: reader.cString() };
		}
		case 'clap':
			return parseClap(bytes, box);
		case 'clli': {
			const reader = new ByteReader(bytes, 'item-properties', box.bodyStart, box.end);
			return {
				kind: 'clli',
				maxContentLightLevel: reader.u16(),
				maxPictureAverageLightLevel: reader.u16(),
			};
		}
		default:
			return { kind: 'other', type: box.type };
	}
}

/**
 * The HEVC codec string for a `VideoDecoderConfig`.
 *
 * Built to ISO/IEC 14496-15 Annex E: profile space as a letter, the
 * compatibility flags with their bits reversed, the tier as L or H, and the
 * six constraint bytes with trailing zeroes dropped. Getting the bit reversal
 * wrong produces a string a browser rejects, which reads as "this machine has
 * no HEVC support" rather than as the bug it is.
 */
export function hevcCodecString(config: HevcConfigProperty): string {
	const space = ['', 'A', 'B', 'C'][config.profileSpace] ?? '';

	let reversed = 0;
	for (let bit = 0; bit < 32; bit += 1) {
		reversed = (reversed << 1) | ((config.profileCompatibilityFlags >>> bit) & 1);
	}
	const compatibility = (reversed >>> 0).toString(16);

	const tier = config.tierFlag === 0 ? 'L' : 'H';

	const constraints: string[] = [];
	let lastSet = -1;
	for (let i = 0; i < config.constraintFlags.length; i += 1) {
		if (config.constraintFlags[i] !== 0) lastSet = i;
	}
	for (let i = 0; i <= lastSet; i += 1) {
		constraints.push((config.constraintFlags[i] as number).toString(16).toUpperCase());
	}

	const parts = [
		'hvc1',
		`${space}${config.profileIdc}`,
		compatibility,
		`${tier}${config.levelIdc}`,
		...constraints,
	];
	return parts.join('.');
}
