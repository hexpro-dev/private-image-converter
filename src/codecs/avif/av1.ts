/**
 * The AV1 bitstream, read as far as writing a container needs and no further.
 *
 * An AVIF is a still photograph pretending to be one frame of a video, so what
 * comes back from the browser's video encoder is an OBU chain rather than a
 * picture file: a temporal delimiter carrying nothing, a sequence header, then
 * the frame. AV1 keeps its sequence header in the stream instead of handing
 * one out separately, which is why `decoderConfig.description` is null for AV1
 * where it is the whole configuration for HEVC. The container still has to be
 * told the profile, the level, the bit depth and the chroma layout up front,
 * in an `av1C` record, and the only place those numbers exist is inside the
 * sequence header. So they are read here.
 *
 * The sequence header is a bit field. Nothing in it is byte aligned, nothing
 * carries a length, and there is no way to seek to a field: every bit before
 * it has to be consumed in the right order or the read lands somewhere else
 * and returns a number that is still perfectly in range. A misread profile is
 * 0 or 1 either way; a misread chroma flag is 0 or 1 either way. The file that
 * results is rejected by every decoder for reasons that point nowhere near the
 * mistake.
 *
 * Two places account for most of that. `operating_points_cnt_minus_1` is a
 * loop, and its body is not a fixed width: `seq_tier` only appears when the
 * level is above 7. `decoder_model_info_present_flag` adds another two fields
 * to every iteration of that loop, and the width of those depends on a value
 * read earlier still. The browser writes one operating point and no decoder
 * model, so neither path is ever taken here in practice, and both are parsed
 * in full anyway, because the cost of being wrong is silence rather than an
 * error.
 */

import { MsbBitReader } from '../../bits.js';
import { EncodeFailedError } from '../../errors.js';

const ENCODER_ID = 'avif-webcodecs';

function fail(detail: string): never {
	throw new EncodeFailedError('avif', ENCODER_ID, detail);
}

/** The sequence header, which is the one OBU this file reads. */
export const OBU_SEQUENCE_HEADER = 1;
/** A frame boundary marker with an empty payload. Dropped from item data. */
export const OBU_TEMPORAL_DELIMITER = 2;
/** Frame header and tile group in one unit, which is what a keyframe is. */
export const OBU_FRAME = 6;

export interface Obu {
	readonly type: number;
	readonly temporalId: number;
	readonly spatialId: number;
	/**
	 * Offset of the first header byte.
	 *
	 * Kept alongside the payload so a caller can copy the unit out whole. An
	 * `av1C` record carries complete OBUs, headers and size fields included,
	 * so rebuilding one from its payload would mean re-encoding a leb128 for
	 * no reason.
	 */
	readonly start: number;
	/** One past the last byte of the unit. */
	readonly end: number;
	/** The payload alone, after the header and the size field. */
	readonly payload: Uint8Array;
}

/** What `parseSequenceHeader` found. Everything an `av1C` record needs, and the size. */
export interface Av1SequenceHeader {
	readonly seqProfile: number;
	readonly stillPicture: boolean;
	readonly reducedStillPictureHeader: boolean;
	readonly seqLevelIdx0: number;
	readonly seqTier0: number;
	readonly highBitdepth: boolean;
	readonly twelveBit: boolean;
	readonly monochrome: boolean;
	readonly chromaSubsamplingX: number;
	readonly chromaSubsamplingY: number;
	readonly chromaSamplePosition: number;
	/** 8, 10 or 12, resolved from `high_bitdepth`, `twelve_bit` and the profile. */
	readonly bitDepth: number;
	/**
	 * Whether the samples use all 256 codes rather than 16 to 235.
	 *
	 * Read because the container has to say the same thing the bitstream says.
	 * A `colr` box overrides the CICP values inside the sequence header, so a
	 * container that declares full range over studio range samples produces a
	 * picture with lifted blacks and dulled whites, and nothing anywhere
	 * reports an error.
	 */
	readonly fullRange: boolean;
	readonly maxFrameWidth: number;
	readonly maxFrameHeight: number;
}

/**
 * An `obu_size`, which is a leb128.
 *
 * Seven bits a byte, low group first, high bit set on every byte but the last.
 * Multiplication rather than a shift for the high groups: `1 << 28` is still
 * fine but `1 << 35` wraps to a small negative number, and a length field that
 * silently wraps is how a stream ends up looking truncated at a plausible
 * place.
 */
function readLeb128(bytes: Uint8Array, at: number): { value: number; next: number } {
	let value = 0;
	let cursor = at;
	for (let i = 0; i < 8; i += 1) {
		if (cursor >= bytes.length) fail('an OBU length ran off the end of the stream');
		const byte = bytes[cursor] as number;
		cursor += 1;
		value += (byte & 0x7f) * 2 ** (7 * i);
		if ((byte & 0x80) === 0) return { value, next: cursor };
	}
	fail('an OBU length used more than the eight bytes the format allows');
}

/**
 * Split an OBU chain into its units.
 *
 * A unit with no size field runs to the end of the chain, which the format
 * only permits for the last one. That is accepted here rather than refused,
 * because a stream that ends that way is still readable and refusing it would
 * trade a working file for a principle.
 */
export function splitObus(bytes: Uint8Array): Obu[] {
	const obus: Obu[] = [];
	let at = 0;
	while (at < bytes.length) {
		const start = at;
		const header = bytes[at] as number;
		if ((header & 0x80) !== 0) fail('an OBU set the forbidden bit');
		const type = (header >> 3) & 0x0f;
		const hasExtension = (header & 0x04) !== 0;
		const hasSize = (header & 0x02) !== 0;
		at += 1;

		let temporalId = 0;
		let spatialId = 0;
		if (hasExtension) {
			if (at >= bytes.length) fail('an OBU extension header was cut off');
			const extension = bytes[at] as number;
			temporalId = extension >> 5;
			spatialId = (extension >> 3) & 0x03;
			at += 1;
		}

		let end = bytes.length;
		if (hasSize) {
			const size = readLeb128(bytes, at);
			at = size.next;
			end = at + size.value;
			if (end > bytes.length) fail('an OBU declared more bytes than the stream holds');
		}

		obus.push({ type, temporalId, spatialId, start, end, payload: bytes.subarray(at, end) });
		at = end;
	}
	return obus;
}

/**
 * A `uvlc()`, the format's variable length integer.
 *
 * Only `num_ticks_per_picture_minus_1` uses one, in the timing information the
 * browser never writes. It is here because skipping a field of unknown length
 * is not possible: the only way past it is through it.
 */
function readUvlc(reader: MsbBitReader): number {
	let leadingZeros = 0;
	while (leadingZeros < 32 && reader.readBit() === 0) leadingZeros += 1;
	if (leadingZeros >= 32) return 2 ** 32 - 1;
	let value = 0;
	let left = leadingZeros;
	while (left > 0) {
		const take = Math.min(left, 16);
		value = value * 2 ** take + reader.read(take);
		left -= take;
	}
	return value + 2 ** leadingZeros - 1;
}

/**
 * Read a sequence header OBU's payload, in the order specification 5.5.1 sets.
 *
 * The parse stops at `separate_uv_delta_q`. Everything past that point is
 * quantiser and loop filter setup that a container never repeats, and a parse
 * that carried on would only be more surface to get wrong.
 */
export function parseSequenceHeader(obuPayload: Uint8Array): Av1SequenceHeader {
	const reader = new MsbBitReader(obuPayload);

	const seqProfile = reader.read(3);
	const stillPicture = reader.readBit() === 1;
	const reducedStillPictureHeader = reader.readBit() === 1;

	let seqLevelIdx0 = 0;
	let seqTier0 = 0;
	if (reducedStillPictureHeader) {
		// The reduced header exists for exactly this case, a single still
		// picture, and collapses the whole operating point apparatus to one
		// level index. No browser writes it, and libaom writes the long form
		// even for a one frame encode, so this branch is the one that never
		// runs rather than the one that always does.
		seqLevelIdx0 = reader.read(5);
	} else {
		let decoderModelInfoPresent = false;
		let bufferDelayLength = 0;
		if (reader.readBit() === 1) {
			// timing_info(): two 32 bit ticks and an optional picture interval.
			reader.skip(64);
			if (reader.readBit() === 1) readUvlc(reader);
			decoderModelInfoPresent = reader.readBit() === 1;
			if (decoderModelInfoPresent) {
				bufferDelayLength = reader.read(5) + 1;
				// num_units_in_decoding_tick, then two 5 bit field widths.
				reader.skip(42);
			}
		}
		const initialDisplayDelayPresent = reader.readBit() === 1;
		const operatingPoints = reader.read(5) + 1;
		for (let point = 0; point < operatingPoints; point += 1) {
			reader.skip(12); // operating_point_idc
			const level = reader.read(5);
			// Only levels above 7 have a high tier to distinguish, so the bit
			// is absent below that rather than present and zero.
			const tier = level > 7 ? reader.readBit() : 0;
			if (point === 0) {
				seqLevelIdx0 = level;
				seqTier0 = tier;
			}
			if (decoderModelInfoPresent && reader.readBit() === 1) {
				// operating_parameters_info(): two buffer delays and a flag.
				reader.skip(bufferDelayLength * 2 + 1);
			}
			if (initialDisplayDelayPresent && reader.readBit() === 1) {
				reader.skip(4); // initial_display_delay_minus_1
			}
		}
	}

	const frameWidthBits = reader.read(4) + 1;
	const frameHeightBits = reader.read(4) + 1;
	const maxFrameWidth = reader.read(frameWidthBits) + 1;
	const maxFrameHeight = reader.read(frameHeightBits) + 1;

	// A still picture has nothing to number, so the reduced header forbids the
	// flag outright rather than setting it to zero.
	if (!reducedStillPictureHeader && reader.readBit() === 1) {
		reader.skip(7); // delta_frame_id_length_minus_2, additional_frame_id_length_minus_1
	}

	reader.skip(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter

	if (!reducedStillPictureHeader) {
		// Four inter prediction tools, none of which a keyframe can use and
		// all of which still occupy their bits.
		reader.skip(4);
		const enableOrderHint = reader.readBit() === 1;
		if (enableOrderHint) reader.skip(2); // enable_jnt_comp, enable_ref_frame_mvs
		let forceScreenContentTools = 2;
		if (reader.readBit() === 0) forceScreenContentTools = reader.readBit();
		if (forceScreenContentTools > 0 && reader.readBit() === 0) {
			reader.skip(1); // seq_force_integer_mv
		}
		if (enableOrderHint) reader.skip(3); // order_hint_bits_minus_1
	}

	reader.skip(3); // enable_superres, enable_cdef, enable_restoration

	/* colour_config() */
	const highBitdepth = reader.readBit() === 1;
	let twelveBit = false;
	let bitDepth = highBitdepth ? 10 : 8;
	if (seqProfile === 2 && highBitdepth) {
		twelveBit = reader.readBit() === 1;
		bitDepth = twelveBit ? 12 : 10;
	}
	// Profile 1 is 4:4:4 colour and has no monochrome spelling, so the flag is
	// absent there rather than present and zero.
	const monochrome = seqProfile === 1 ? false : reader.readBit() === 1;

	let primaries = 2;
	let transfer = 2;
	let matrix = 2;
	if (reader.readBit() === 1) {
		primaries = reader.read(8);
		transfer = reader.read(8);
		matrix = reader.read(8);
	}

	let fullRange = false;
	let chromaSubsamplingX = 1;
	let chromaSubsamplingY = 1;
	let chromaSamplePosition = 0;
	if (monochrome) {
		fullRange = reader.readBit() === 1;
	} else if (primaries === 1 && transfer === 13 && matrix === 0) {
		// sRGB carried as GBR planes with no colour conversion at all. The
		// range and the subsampling are fixed by that choice, so neither is
		// written and reading them here would consume bits that are not there.
		fullRange = true;
		chromaSubsamplingX = 0;
		chromaSubsamplingY = 0;
	} else {
		fullRange = reader.readBit() === 1;
		if (seqProfile === 1) {
			chromaSubsamplingX = 0;
			chromaSubsamplingY = 0;
		} else if (seqProfile === 2) {
			if (bitDepth === 12) {
				chromaSubsamplingX = reader.readBit();
				chromaSubsamplingY = chromaSubsamplingX === 1 ? reader.readBit() : 0;
			} else {
				chromaSubsamplingY = 0;
			}
		}
		if (chromaSubsamplingX === 1 && chromaSubsamplingY === 1) {
			chromaSamplePosition = reader.read(2);
		}
	}

	return {
		seqProfile,
		stillPicture,
		reducedStillPictureHeader,
		seqLevelIdx0,
		seqTier0,
		highBitdepth,
		twelveBit,
		monochrome,
		chromaSubsamplingX,
		chromaSubsamplingY,
		chromaSamplePosition,
		bitDepth,
		fullRange,
		maxFrameWidth,
		maxFrameHeight,
	};
}

/**
 * The AV1CodecConfigurationRecord that goes inside an `av1C` box.
 *
 * Four bytes of packed flags and then the sequence header OBU repeated whole.
 * Repeating it looks redundant next to a bitstream that already carries one,
 * and it is what lets a reader configure a decoder before it has touched the
 * item's data, which is the difference between knowing the size of a picture
 * from the container and having to decode it to find out.
 *
 * `initial_presentation_delay_present` is left at zero. It describes how long
 * a player buffers before showing the first frame, which for a photograph is
 * not a question anybody is asking.
 */
export function buildAv1C(sequenceHeaderObu: Uint8Array, parsed: Av1SequenceHeader): Uint8Array {
	const record = new Uint8Array(4 + sequenceHeaderObu.length);
	// A one bit marker set to 1, then a seven bit version of 1.
	record[0] = 0x81;
	record[1] = ((parsed.seqProfile & 0x07) << 5) | (parsed.seqLevelIdx0 & 0x1f);
	record[2] =
		((parsed.seqTier0 & 0x01) << 7) |
		((parsed.highBitdepth ? 1 : 0) << 6) |
		((parsed.twelveBit ? 1 : 0) << 5) |
		((parsed.monochrome ? 1 : 0) << 4) |
		((parsed.chromaSubsamplingX & 0x01) << 3) |
		((parsed.chromaSubsamplingY & 0x01) << 2) |
		(parsed.chromaSamplePosition & 0x03);
	record[3] = 0;
	record.set(sequenceHeaderObu, 4);
	return record;
}
