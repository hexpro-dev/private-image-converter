import { describe, expect, it } from 'vitest';
import { buildAv1C, parseSequenceHeader, splitObus } from '../../src/codecs/avif/av1.js';
import type { Obu } from '../../src/codecs/avif/av1.js';
import { ALPHA_AUX_URN, muxAvif } from '../../src/codecs/avif/mux.js';
import type { AvifCodedImage } from '../../src/codecs/avif/mux.js';
import { av1CodecString, av1RateFor, encodeAvif } from '../../src/codecs/avif/encode.js';
import type { Av1FrameEncoder, Av1FrameRequest } from '../../src/codecs/avif/webcodecs.js';
import { ByteReader, findBox, readFullBoxHeader, walkBoxes } from '../../src/heif/boxes.js';
import { itemBytes, itemProperties, itemProperty, parseMeta } from '../../src/heif/parse.js';
import type { HeifMeta } from '../../src/heif/parse.js';
import { CancelledError, EncodeFailedError } from '../../src/errors.js';
import type {
	Capabilities,
	EncodeContext,
	EncodeOptions,
	GainMap,
	RasterImage,
} from '../../src/types.js';

/**
 * Real AV1 keyframes, captured out of Chrome's `VideoEncoder`.
 *
 * Copied in as base64 rather than read from a file, because a fixture that
 * lives outside the repository is a test that quietly stops running on
 * somebody else's machine, and a binary one cannot be committed here at all.
 * None of them is a photograph: four small synthetic pictures, encoded once
 * and kept for the bytes of their sequence headers.
 *
 * They are never decoded. What is under test is a container writer and a bit
 * field reader, and neither needs a codec to be wrong.
 */
interface Fixture {
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(Buffer.from(text, 'base64'));
}

const GRADIENT128: Fixture = {
	bytes: fromBase64(
		'EgAKDQAAAAM3/+ANEGBgYEAytQQQQoACCCCEAAgA3Svv+SAE9Z6o7NEV74eZUmYHIt4xfDZiy87f3uo+SEOzGe7WX4gNE85fbHasHUZc8NfsK8i24Zq7gwIt69uvRGokKRpFWmEolP866dUfE9YXDLTOe9vIBwvYXKqbEXnE3bGufeh+PQyoxMpssU840n9JRPVCoohFQ7GZCPR0SwdaBuds1R460cKJAXndv3zPiyFJb5qfm3F8a6ENTOhLiv7jUWBmphmrxSsx19VxpuRfWyeyL10aE9bIEK9oRtYw4ZX0QaR5Jvq+2FUw06u+ux3Ectu6LS39bSRCXKPz1/i0SnIo0Yr7J6NqoFh9G3Ba69mx3T+GycCpQS2cKmqXwLGUXfA2H05voYdCvtgKOCSm3YodRnl056N3PmO9qcEJ5+R2cpW6VoBSzEGQzHk++3KV1wJpuZqrqKr7H/gL4zpWr6HXi8sBVMO9Rp2n2os9TGgpio7LsdwiPxZ1ALi2R/+kvMgwD6gjNNFBwAd0AF8sr3Dn+BXEXl5gnIgUNgpkQE+kK13skcXvfqOxIKfdurLIiS25yUeuvOVto3VHwSHEZ5BQXwIZcjxz16zE9Mj4kDy8gRN7Z8/pwFHaALQ9d53lvj0PDvwggbGZscchoV9oPpIvMDCRD9V3x4ewZKFlVjxfzbzN5Vt4xotMbEm6WHIfoixHJo3h1hePAxWySBQ3nYjbiwY3Ze7CUo4tugDlDncIswHC4d63TQhCcEVPhBcyCZTj+gVhErwg',
	),
	width: 128,
	height: 128,
};
const GRADIENT64X48: Fixture = {
	bytes: fromBase64(
		'EgAKDAAAAAKv94A0QYGBgTL9ARBKAAggghAAIN0sKvIxO9V/lfvTsPnI/JwIWyh88+A4yAPa7Z74y5cD6EfSmq1dplhgM9LAplXZTr68+KFCwA2nQnPbMiVZAluruoCdvU67gWh4u/2U4UHX35dQzJ5uLZzHUNetg71gLDff4sXKDr2U9+25dzRAgJ196UB/1nM2UjyAwP1nekWb9egdkufWEn9WieNN39UhqES1Il+toZbOUdeekjlWJMxn8O4kmM+yF0QvRY4iG0aKSQn1wpf5/MKDkei5N7ecs3XkPG0AQnW01UPlBP9ev+XC6mOhxTOhqKlj8QBULzvpZ/8fsk4gyHma0Mb3Il0eck6oC+A=',
	),
	width: 64,
	height: 48,
};
const GREY32: Fixture = {
	bytes: fromBase64(
		'EgAKDAAAAAIn/gDRBgYGBDIvEEoACCCCEAAgzw9u4bWGzdsHn4mFVpt4q8NpLAjLmqmyS7kWZABt3/FFq0uVWso=',
	),
	width: 32,
	height: 32,
};
const ODD33X17: Fixture = {
	bytes: fromBase64(
		'EgAKDAAAAAKkEABogwMDAjKGARBKAAggghAAIPE0jdctCbcGJP4zdyvszFoV9BSh2Y8CMXT3hJR9piuRmA7SyfRpeS0hbwkkeaB2F/CJvsTrb0RXuNgz4mL8pCpGqp6e8zYeYeecgMZuFecq+/cCn9pxZHQ0z1HbX5uT8brE/xfu5Wi/T3D9OEj+Z1OA/P1mtvUi6ds4c/OA',
	),
	width: 33,
	height: 17,
};

const ALL: readonly [string, Fixture][] = [
	['gradient128', GRADIENT128],
	['gradient64x48', GRADIENT64X48],
	['grey32', GREY32],
	['odd33x17', ODD33X17],
];

const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_FRAME = 6;

function need<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`the fixture has no ${what}`);
	return value;
}

function sequenceHeaderObu(fixture: Fixture): Obu {
	return need(
		splitObus(fixture.bytes).find((obu) => obu.type === OBU_SEQUENCE_HEADER),
		'sequence header',
	);
}

/** A fixture as an item, exactly as `encodeAvif` would prepare one. */
function coded(fixture: Fixture): AvifCodedImage {
	const obus = splitObus(fixture.bytes);
	const header = sequenceHeaderObu(fixture);
	const kept = obus.filter((obu) => obu.type !== OBU_TEMPORAL_DELIMITER);
	let length = 0;
	for (const obu of kept) length += obu.end - obu.start;
	const data = new Uint8Array(length);
	let at = 0;
	for (const obu of kept) {
		data.set(fixture.bytes.subarray(obu.start, obu.end), at);
		at += obu.end - obu.start;
	}
	const config = buildAv1C(
		fixture.bytes.subarray(header.start, header.end),
		parseSequenceHeader(header.payload),
	);
	return { data, width: fixture.width, height: fixture.height, config };
}

/* ── Reading back what was written ────────────────────────────────────── */

/**
 * The `ipma` associations with their essential bits intact.
 *
 * The reader in `src/heif/` throws that bit away on purpose, because it
 * refuses on the properties it cannot honour by name rather than by trusting
 * a file to mark them. Writing the bit is still this encoder's job, so the
 * test reads the box itself.
 */
interface Association {
	readonly index: number;
	readonly essential: boolean;
}

function associations(file: Uint8Array): Map<number, Association[]> {
	const meta = need(findBox(file, 0, file.length, 'meta', 'meta'), 'meta box');
	const metaFull = readFullBoxHeader(file, meta, 'meta');
	const iprp = need(
		findBox(file, metaFull.bodyStart, meta.end, 'iprp', 'item-properties'),
		'iprp box',
	);
	const ipma = need(findBox(file, iprp.bodyStart, iprp.end, 'ipma', 'item-properties'), 'ipma box');
	const full = readFullBoxHeader(file, ipma, 'item-properties');
	const reader = new ByteReader(file, 'item-properties', full.bodyStart, ipma.end);

	const out = new Map<number, Association[]>();
	const entries = reader.u32();
	for (let i = 0; i < entries; i += 1) {
		const id = reader.u16();
		const count = reader.u8();
		const list: Association[] = [];
		for (let a = 0; a < count; a += 1) {
			const byte = reader.u8();
			list.push({ index: byte & 0x7f, essential: (byte & 0x80) !== 0 });
		}
		out.set(id, list);
	}
	return out;
}

/** Which property kinds an item claims, and whether each was marked essential. */
function essentials(file: Uint8Array, meta: HeifMeta, id: number): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const association of need(associations(file).get(id), `associations for item ${id}`)) {
		const property = need(meta.properties[association.index - 1], 'property');
		out.set(property.kind === 'other' ? property.type : property.kind, association.essential);
	}
	return out;
}

function topLevelBoxes(file: Uint8Array): string[] {
	return [...walkBoxes(file, 0, file.length, 'ftyp')].map((box) => box.type);
}

function brands(file: Uint8Array): string[] {
	const ftyp = need(findBox(file, 0, file.length, 'ftyp', 'ftyp'), 'ftyp box');
	const reader = new ByteReader(file, 'ftyp', ftyp.bodyStart, ftyp.end);
	const out = [reader.ascii(4)];
	reader.u32();
	while (reader.remaining >= 4) out.push(reader.ascii(4));
	return out;
}

/** The bytes an item's `iloc` entry points at, taken straight out of the file. */
function slice(file: Uint8Array, meta: HeifMeta, id: number): Uint8Array {
	const location = need(meta.locations.get(id), `location for item ${id}`);
	const extent = need(location.extents[0], 'extent');
	return file.subarray(extent.offset, extent.offset + extent.length);
}

/* ── The AV1 bitstream ────────────────────────────────────────────────── */

describe('the OBU chain', () => {
	it.each(ALL)('splits %s into a delimiter, a sequence header and a frame', (_name, fixture) => {
		const obus = splitObus(fixture.bytes);
		expect(obus.map((obu) => obu.type)).toEqual([
			OBU_TEMPORAL_DELIMITER,
			OBU_SEQUENCE_HEADER,
			OBU_FRAME,
		]);
		// Every unit accounted for, with nothing between them and nothing left
		// over. A length read one byte short still yields three plausible units.
		expect(obus[0]?.start).toBe(0);
		expect(obus[2]?.end).toBe(fixture.bytes.length);
		expect(obus[0]?.payload.length).toBe(0);
	});

	it('refuses a stream whose length field runs past the end', () => {
		// A sequence header OBU claiming 200 bytes in a buffer that holds two.
		expect(() => splitObus(Uint8Array.of(0x0a, 0xc8, 0x00))).toThrow(EncodeFailedError);
	});

	it('refuses an OBU with the forbidden bit set', () => {
		expect(() => splitObus(Uint8Array.of(0x92, 0x00))).toThrow(EncodeFailedError);
	});

	it('refuses a length that never terminates', () => {
		const runaway = new Uint8Array(12).fill(0x80);
		runaway[0] = 0x0a;
		expect(() => splitObus(runaway)).toThrow(EncodeFailedError);
	});

	it('refuses a length whose continuation byte is the last byte there is', () => {
		expect(() => splitObus(Uint8Array.of(0x0a, 0x80))).toThrow(EncodeFailedError);
	});

	it('refuses a truncated extension header', () => {
		expect(() => splitObus(Uint8Array.of(0x0e))).toThrow(EncodeFailedError);
	});

	it('reads a unit that carries no size field as running to the end', () => {
		// Type 6, no size field, four bytes of payload behind it.
		const chain = Uint8Array.of(0x30, 0x01, 0x02, 0x03, 0x04);
		const obus = splitObus(chain);
		expect(obus).toHaveLength(1);
		expect(obus[0]?.payload).toHaveLength(4);
	});

	it('reads the temporal and spatial identifiers out of an extension header', () => {
		// Type 1 with an extension: temporal 3, spatial 2, then an empty payload.
		const chain = Uint8Array.of(0x0e, 0x70, 0x00);
		const obu = need(splitObus(chain)[0], 'obu');
		expect(obu.temporalId).toBe(3);
		expect(obu.spatialId).toBe(2);
	});
});

describe('the sequence header', () => {
	it.each(ALL)('reads %s as profile 0, level 2.0, 4:2:0 at eight bits', (_name, fixture) => {
		const parsed = parseSequenceHeader(sequenceHeaderObu(fixture).payload);
		expect(parsed.seqProfile).toBe(0);
		// Every capture came back at level index 0, which is 2.0, whatever
		// level the codec string asked for.
		expect(parsed.seqLevelIdx0).toBe(0);
		expect(parsed.seqTier0).toBe(0);
		expect(parsed.highBitdepth).toBe(false);
		expect(parsed.twelveBit).toBe(false);
		expect(parsed.bitDepth).toBe(8);
		expect(parsed.monochrome).toBe(false);
		expect(parsed.chromaSubsamplingX).toBe(1);
		expect(parsed.chromaSubsamplingY).toBe(1);
		expect(parsed.chromaSamplePosition).toBe(0);
	});

	it.each(ALL)('recovers the dimensions of %s from the bit field', (_name, fixture) => {
		// The strongest check there is that every field before these was
		// consumed at the right width: the frame size sits behind the whole
		// operating point block, and a bit lost anywhere earlier lands here as
		// a number that is not the size of the picture.
		const parsed = parseSequenceHeader(sequenceHeaderObu(fixture).payload);
		expect(parsed.maxFrameWidth).toBe(fixture.width);
		expect(parsed.maxFrameHeight).toBe(fixture.height);
	});

	it('reads the studio range flag the browser actually writes', () => {
		const parsed = parseSequenceHeader(sequenceHeaderObu(GRADIENT128).payload);
		expect(parsed.fullRange).toBe(false);
	});

	it('reads the reduced still picture spelling', () => {
		// Profile 0, still_picture 1, reduced 1, level 8, four bit frame sizes
		// of 16 by 16, then the tools and colour_config for 4:2:0 at eight bits
		// with no colour description. Hand built because no browser writes it.
		const bits = [
			'000', // seq_profile
			'1', // still_picture
			'1', // reduced_still_picture_header
			'01000', // seq_level_idx_0 = 8
			'0011', // frame_width_bits_minus_1 = 3
			'0011', // frame_height_bits_minus_1 = 3
			'1111', // max_frame_width_minus_1 = 15
			'1111', // max_frame_height_minus_1 = 15
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'0', // high_bitdepth
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'0', // colour_range
			'00', // chroma_sample_position
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.reducedStillPictureHeader).toBe(true);
		expect(parsed.stillPicture).toBe(true);
		expect(parsed.seqLevelIdx0).toBe(8);
		expect(parsed.maxFrameWidth).toBe(16);
		expect(parsed.maxFrameHeight).toBe(16);
	});

	it('walks the timing information, the decoder model and two operating points', () => {
		// The two places this parse is usually wrong, both taken at once. A
		// reader that skipped the decoder model would lose 42 bits and then
		// read the operating point loop out of the middle of the frame sizes.
		const bits = [
			'000', // seq_profile
			'0', // still_picture
			'0', // reduced_still_picture_header
			'1', // timing_info_present_flag
			'0'.repeat(64), // num_units_in_display_tick, time_scale
			'1', // equal_picture_interval
			'010', // num_ticks_per_picture_minus_1 as a uvlc, one leading zero
			'1', // decoder_model_info_present_flag
			'00001', // buffer_delay_length_minus_1 = 1, so two bits each
			'0'.repeat(42), // decoding tick and two field widths
			'1', // initial_display_delay_present_flag
			'00001', // operating_points_cnt_minus_1 = 1, so two points
			'0'.repeat(12), // operating_point_idc[0]
			'01001', // seq_level_idx[0] = 9, which is above 7
			'1', // seq_tier[0]
			'1', // decoder_model_present_for_this_op[0]
			'00000', // two buffer delays of two bits, then low_delay_mode_flag
			'1', // initial_display_delay_present_for_this_op[0]
			'0011', // initial_display_delay_minus_1[0]
			'0'.repeat(12), // operating_point_idc[1]
			'00011', // seq_level_idx[1] = 3, which is not above 7
			'0', // decoder_model_present_for_this_op[1]
			'0', // initial_display_delay_present_for_this_op[1]
			'0011', // frame_width_bits_minus_1 = 3
			'0011', // frame_height_bits_minus_1 = 3
			'0111', // max_frame_width_minus_1 = 7
			'0011', // max_frame_height_minus_1 = 3
			'1', // frame_id_numbers_present_flag
			'0'.repeat(7), // the two frame id lengths
			'000', // superblock, filter intra, intra edge filter
			'0000', // interintra, masked, warped, dual filter
			'1', // enable_order_hint
			'00', // enable_jnt_comp, enable_ref_frame_mvs
			'0', // seq_choose_screen_content_tools
			'1', // seq_force_screen_content_tools
			'0', // seq_choose_integer_mv
			'0', // seq_force_integer_mv
			'000', // order_hint_bits_minus_1
			'000', // superres, cdef, restoration
			'0', // high_bitdepth
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'1', // colour_range
			'00', // chroma_sample_position
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		// The first operating point is the one the container records, and it is
		// the one carrying a tier because its level is above 7.
		expect(parsed.seqLevelIdx0).toBe(9);
		expect(parsed.seqTier0).toBe(1);
		expect(parsed.maxFrameWidth).toBe(8);
		expect(parsed.maxFrameHeight).toBe(4);
		expect(parsed.fullRange).toBe(true);
	});

	it('reads 4:4:4 at ten bits, where the chroma flags are implied by the profile', () => {
		const bits = [
			'001', // seq_profile = 1
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'1', // high_bitdepth
			// Profile 1 has no mono_chrome bit at all.
			'0', // colour_description_present_flag
			'0', // colour_range
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.bitDepth).toBe(10);
		expect(parsed.monochrome).toBe(false);
		expect(parsed.chromaSubsamplingX).toBe(0);
		expect(parsed.chromaSubsamplingY).toBe(0);
	});

	it('reads monochrome, where the subsampling is not written down', () => {
		const bits = [
			'000', // seq_profile
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'0', // high_bitdepth
			'1', // mono_chrome
			'0', // colour_description_present_flag
			'1', // colour_range
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.monochrome).toBe(true);
		expect(parsed.fullRange).toBe(true);
		expect(parsed.chromaSubsamplingX).toBe(1);
		expect(parsed.chromaSubsamplingY).toBe(1);
	});

	it('reads sRGB carried as GBR, where the range and subsampling are fixed', () => {
		const bits = [
			'000', // seq_profile
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'0', // high_bitdepth
			'0', // mono_chrome
			'1', // colour_description_present_flag
			'00000001', // colour_primaries = 1
			'00001101', // transfer_characteristics = 13
			'00000000', // matrix_coefficients = 0, the identity
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.fullRange).toBe(true);
		expect(parsed.chromaSubsamplingX).toBe(0);
		expect(parsed.chromaSubsamplingY).toBe(0);
	});

	it('reads profile 2 at twelve bits, where the subsampling is written down', () => {
		const bits = [
			'010', // seq_profile = 2
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'1', // high_bitdepth
			'1', // twelve_bit
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'0', // colour_range
			'1', // subsampling_x
			'0', // subsampling_y
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.bitDepth).toBe(12);
		expect(parsed.twelveBit).toBe(true);
		expect(parsed.chromaSubsamplingX).toBe(1);
		expect(parsed.chromaSubsamplingY).toBe(0);
	});

	it('reads profile 2 at twelve bits with no subsampling at all', () => {
		// Subsampling in neither direction, so the second flag is not written
		// and neither is the chroma sample position: 4:4:4 has nowhere to put a
		// chroma sample except on the luma one.
		const bits = [
			'010', // seq_profile = 2
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'1', // high_bitdepth
			'1', // twelve_bit
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'0', // colour_range
			'0', // subsampling_x
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.chromaSubsamplingX).toBe(0);
		expect(parsed.chromaSubsamplingY).toBe(0);
		expect(parsed.chromaSamplePosition).toBe(0);
	});

	it('walks a picture interval whose length field never terminates', () => {
		// A uvlc of 32 zeroes, which the format defines as the largest value
		// there is rather than as an error. Reading it as an ordinary count
		// would leave the parse 32 bits behind for the whole of the rest of
		// the header.
		const bits = [
			'000', // seq_profile
			'1', // still_picture
			'0', // reduced_still_picture_header
			'1', // timing_info_present_flag
			'0'.repeat(64), // num_units_in_display_tick, time_scale
			'1', // equal_picture_interval
			'0'.repeat(32), // num_ticks_per_picture_minus_1
			'0', // decoder_model_info_present_flag
			'0', // initial_display_delay_present_flag
			'00000', // operating_points_cnt_minus_1 = 0
			'0'.repeat(12), // operating_point_idc[0]
			'00010', // seq_level_idx[0] = 2
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0101', // max_frame_width_minus_1 = 5
			'0011', // max_frame_height_minus_1 = 3
			'0', // frame_id_numbers_present_flag
			'000', // superblock, filter intra, intra edge filter
			'0000', // interintra, masked, warped, dual filter
			'0', // enable_order_hint
			'1', // seq_choose_screen_content_tools
			'1', // seq_choose_integer_mv
			'000', // superres, cdef, restoration
			'0', // high_bitdepth
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'0', // colour_range
			'00', // chroma_sample_position
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.seqLevelIdx0).toBe(2);
		expect(parsed.maxFrameWidth).toBe(6);
		expect(parsed.maxFrameHeight).toBe(4);
	});

	it('reads profile 2 at ten bits, where 4:2:2 is implied', () => {
		const bits = [
			'010', // seq_profile = 2
			'1', // still_picture
			'1', // reduced_still_picture_header
			'00000', // seq_level_idx_0
			'0011', // frame_width_bits_minus_1
			'0011', // frame_height_bits_minus_1
			'0001', // max_frame_width_minus_1
			'0001', // max_frame_height_minus_1
			'000', // superblock, filter intra, intra edge filter
			'000', // superres, cdef, restoration
			'1', // high_bitdepth
			'0', // twelve_bit
			'0', // mono_chrome
			'0', // colour_description_present_flag
			'0', // colour_range
			'0', // separate_uv_delta_q
		].join('');
		const parsed = parseSequenceHeader(pack(bits));
		expect(parsed.bitDepth).toBe(10);
		expect(parsed.chromaSubsamplingX).toBe(1);
		expect(parsed.chromaSubsamplingY).toBe(0);
	});
});

/** A string of ones and zeroes as bytes, padded with zeroes at the tail. */
function pack(bits: string): Uint8Array {
	const out = new Uint8Array(Math.ceil(bits.length / 8));
	for (let i = 0; i < bits.length; i += 1) {
		if (bits[i] === '1') {
			out[i >> 3] = (out[i >> 3] as number) | (0x80 >> (i % 8));
		}
	}
	return out;
}

describe('the av1C record', () => {
	it('packs the fields the container needs, and repeats the OBU whole', () => {
		const header = sequenceHeaderObu(GRADIENT128);
		const parsed = parseSequenceHeader(header.payload);
		const record = buildAv1C(GRADIENT128.bytes.subarray(header.start, header.end), parsed);

		// Marker bit set, then version 1.
		expect(record[0]).toBe(0x81);
		// Profile 0 in the top three bits, level index 0 in the low five.
		expect(record[1]).toBe(0x00);
		// Tier 0, eight bits, colour, and both chroma flags set for 4:2:0.
		expect(record[2]).toBe(0x0c);
		expect(record[3]).toBe(0x00);
		expect(record.subarray(4)).toEqual(GRADIENT128.bytes.subarray(header.start, header.end));
	});

	it('packs a high tier ten bit monochrome record without spilling between fields', () => {
		const record = buildAv1C(Uint8Array.of(), {
			seqProfile: 5,
			stillPicture: true,
			reducedStillPictureHeader: true,
			seqLevelIdx0: 21,
			seqTier0: 1,
			highBitdepth: true,
			twelveBit: true,
			monochrome: true,
			chromaSubsamplingX: 1,
			chromaSubsamplingY: 1,
			chromaSamplePosition: 3,
			bitDepth: 12,
			fullRange: true,
			maxFrameWidth: 16,
			maxFrameHeight: 16,
		});
		expect(record[1]).toBe(0xb5);
		expect(record[2]).toBe(0xff);
	});
});

/* ── The container ────────────────────────────────────────────────────── */

describe('a colour only AVIF', () => {
	const file = muxAvif({ colour: coded(GRADIENT128), colourSpace: 'srgb' });
	const meta = parseMeta(file);

	it('is an ftyp, a meta and an mdat, in that order', () => {
		expect(topLevelBoxes(file)).toEqual(['ftyp', 'meta', 'mdat']);
		expect(brands(file)).toEqual(['avif', 'avif', 'mif1', 'miaf']);
	});

	it('holds one av01 item, and points the primary item at it', () => {
		expect([...meta.items.values()].map((item) => item.type)).toEqual(['av01']);
		expect(meta.primaryItemId).toBe(1);
		expect(meta.items.get(1)?.hidden).toBe(false);
	});

	it('carries the dimensions, the depth and the colour tag', () => {
		expect(itemProperty(meta, 1, 'ispe')).toEqual({ kind: 'ispe', width: 128, height: 128 });
		expect(itemProperty(meta, 1, 'pixi')?.bitsPerChannel).toEqual([8, 8, 8]);
		expect(itemProperty(meta, 1, 'colr')).toEqual({
			kind: 'colr',
			type: 'nclx',
			primaries: 1,
			transfer: 13,
			matrix: 6,
			fullRange: true,
		});
	});

	it('marks av1C essential and leaves the descriptive properties alone', () => {
		expect(essentials(file, meta, 1)).toEqual(
			new Map([
				['av1C', true],
				['ispe', false],
				['pixi', false],
				['colr', false],
			]),
		);
	});

	it('writes an iloc offset that lands on the AV1 bytes inside the mdat', () => {
		const expected = coded(GRADIENT128).data;
		const mdat = need(findBox(file, 0, file.length, 'mdat', 'tile-data'), 'mdat box');
		const location = need(meta.locations.get(1), 'location');
		const extent = need(location.extents[0], 'extent');

		// Inside the mdat payload rather than merely somewhere in the file: an
		// offset that is out by the length of a box header still points at
		// bytes and still slices without complaint.
		expect(extent.offset).toBe(mdat.bodyStart);
		expect(extent.offset + extent.length).toBe(mdat.end);
		expect(slice(file, meta, 1)).toEqual(expected);
		expect(itemBytes(file, meta, 1)).toEqual(expected);
	});

	it('does not write an iref when there is nothing to refer to', () => {
		expect(meta.references.size).toBe(0);
	});
});

describe('the colour tag', () => {
	it('says Display P3 when the picture is wide', () => {
		const file = muxAvif({ colour: coded(GRADIENT128), colourSpace: 'display-p3' });
		expect(itemProperty(parseMeta(file), 1, 'colr')?.primaries).toBe(12);
	});

	it('reports the studio range the bitstream declared rather than assuming full', () => {
		const file = muxAvif({ colour: coded(GRADIENT128), colourSpace: 'srgb', fullRange: false });
		expect(itemProperty(parseMeta(file), 1, 'colr')?.fullRange).toBe(false);
	});

	it('adds an ICC profile beside the compact tag rather than instead of it', () => {
		const profile = Uint8Array.from({ length: 32 }, (_value, i) => i);
		const file = muxAvif({
			colour: coded(GRADIENT128),
			colourSpace: 'srgb',
			iccProfile: profile,
		});
		const meta = parseMeta(file);
		const tags = meta.properties.filter((property) => property.kind === 'colr');
		expect(tags.map((tag) => tag.type)).toEqual(['nclx', 'icc']);
		expect(tags[1]?.iccProfile).toEqual(profile);
	});
});

describe('an AVIF with alpha', () => {
	// The same fixture for both items, because an alpha auxiliary picture has
	// to be exactly the size of the picture it covers and there is no second
	// 128 by 128 capture. That makes the two items byte for byte identical, so
	// the offsets are checked against the layout rather than against the bytes.
	const file = muxAvif({
		colour: coded(GRADIENT128),
		alpha: coded(GRADIENT128),
		colourSpace: 'srgb',
	});
	const meta = parseMeta(file);

	it('holds two items, the second of them hidden', () => {
		expect([...meta.items.values()].map((item) => [item.id, item.type, item.hidden])).toEqual([
			[1, 'av01', false],
			[2, 'av01', true],
		]);
		expect(meta.primaryItemId).toBe(1);
	});

	it('links the auxiliary item to the picture it belongs to', () => {
		expect(meta.references.get('auxl')?.get(2)).toEqual([1]);
	});

	it('names the alpha URN and says the item carries one channel', () => {
		expect(itemProperty(meta, 2, 'auxC')?.auxType).toBe(ALPHA_AUX_URN);
		expect(ALPHA_AUX_URN).toBe('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha');
		expect(itemProperty(meta, 2, 'pixi')?.bitsPerChannel).toEqual([8]);
	});

	it('marks auxC essential, so a reader that cannot honour it refuses the item', () => {
		const marks = essentials(file, meta, 2);
		expect(marks.get('auxC')).toBe(true);
		expect(marks.get('av1C')).toBe(true);
		expect(marks.get('ispe')).toBe(false);
	});

	it('lays the two items out end to end inside the mdat, neither overlapping', () => {
		const picture = coded(GRADIENT128).data;
		const mdat = need(findBox(file, 0, file.length, 'mdat', 'tile-data'), 'mdat box');
		const colour = need(need(meta.locations.get(1), 'colour').extents[0], 'extent');
		const alpha = need(need(meta.locations.get(2), 'alpha').extents[0], 'extent');

		expect(colour.offset).toBe(mdat.bodyStart);
		expect(alpha.offset).toBe(colour.offset + colour.length);
		expect(alpha.offset + alpha.length).toBe(mdat.end);
		expect(slice(file, meta, 1)).toEqual(picture);
		expect(slice(file, meta, 2)).toEqual(picture);
	});

	it('gives the alpha item the size of the picture it covers', () => {
		expect(itemProperty(meta, 2, 'ispe')).toEqual({ kind: 'ispe', width: 128, height: 128 });
	});
});

describe('an AVIF with a gain map', () => {
	const metadata = Uint8Array.from({ length: 62 }, (_value, i) => (i * 7) & 0xff);
	const file = muxAvif({
		colour: coded(GRADIENT128),
		colourSpace: 'srgb',
		gainMap: { image: coded(GREY32), metadata },
	});
	const meta = parseMeta(file);

	it('holds three items: the picture, the map, and the derived one', () => {
		expect([...meta.items.values()].map((item) => [item.id, item.type, item.hidden])).toEqual([
			[1, 'av01', false],
			[2, 'av01', true],
			[3, 'tmap', false],
		]);
	});

	it('announces the map in the compatible brands', () => {
		// A reader is entitled to decide from the brand list alone whether it
		// is worth looking for a gain map, which Apple relies on: every HDR
		// photograph an iPhone writes carries `tmap` here. Carrying the map and
		// omitting the brand produces a file that most things show as standard
		// range, and nothing about it looks wrong.
		expect(brands(file)).toEqual(['avif', 'avif', 'mif1', 'miaf', 'tmap']);
	});

	it('leaves the brand off a file that has no map to announce', () => {
		const plain = muxAvif({ colour: coded(GRADIENT128), colourSpace: 'srgb' });
		expect(brands(plain)).not.toContain('tmap');
	});

	it('leaves the base picture as the primary item', () => {
		// So a reader that has never heard of a gain map shows the photograph
		// rather than failing on a derived item it cannot build.
		expect(meta.primaryItemId).toBe(1);
	});

	it('names the base picture and the map, in that order, and nothing else', () => {
		expect(meta.references.get('dimg')?.get(3)).toEqual([1, 2]);
		expect([...need(meta.references.get('dimg'), 'dimg references').keys()]).toEqual([3]);
	});

	it('sizes the derived item to the base picture rather than to the map', () => {
		expect(itemProperty(meta, 3, 'ispe')).toEqual({ kind: 'ispe', width: 128, height: 128 });
		expect(itemProperty(meta, 2, 'ispe')).toEqual({ kind: 'ispe', width: 32, height: 32 });
	});

	it('gives the map an unspecified colour tag, because coverage is not a colour', () => {
		expect(itemProperty(meta, 2, 'colr')).toEqual({
			kind: 'colr',
			type: 'nclx',
			primaries: 2,
			transfer: 2,
			matrix: 6,
			fullRange: true,
		});
	});

	it('carries the parameter block back out byte for byte', () => {
		expect(itemBytes(file, meta, 3)).toEqual(metadata);
		expect(slice(file, meta, 3)).toEqual(metadata);
	});

	it('carries the map its own colour profile when it had one', () => {
		const profile = Uint8Array.from({ length: 16 }, (_value, i) => 255 - i);
		const tagged = muxAvif({
			colour: coded(GRADIENT128),
			colourSpace: 'srgb',
			iccProfile: profile,
			gainMap: { image: coded(GREY32), metadata, iccProfile: profile },
		});
		const parsed = parseMeta(tagged);
		// One shared entry in ipco rather than a copy of the same bytes per
		// item, and every item that needs it points at that one entry. A
		// profile is easily a few kilobytes, so writing it three times into a
		// file this small would be most of the file.
		const shared = parsed.properties.filter(
			(property) => property.kind === 'colr' && property.type === 'icc',
		);
		expect(shared).toHaveLength(1);

		// Each of the three picture-bearing items claims both spellings of the
		// tag: the compact one a reader needs to convert, and the profile the
		// camera meant.
		for (const id of [1, 2, 3]) {
			const tags = itemProperties(parsed, id).filter((property) => property.kind === 'colr');
			expect(tags.map((tag) => (tag.kind === 'colr' ? tag.type : ''))).toEqual(['nclx', 'icc']);
			const icc = tags[1];
			expect(icc?.kind === 'colr' ? icc.iccProfile : undefined).toEqual(profile);
		}
	});
});

describe('every item together', () => {
	it('writes four items, both references, and offsets that still line up', () => {
		const metadata = Uint8Array.from([1, 2, 3, 4, 5]);
		const file = muxAvif({
			colour: coded(GRADIENT128),
			alpha: coded(GRADIENT128),
			colourSpace: 'display-p3',
			// A gain map is usually smaller than the picture it brightens, so
			// this one is, and the derived item still reports the base size.
			gainMap: { image: coded(GRADIENT64X48), metadata },
			iccProfile: Uint8Array.from({ length: 8 }, (_value, i) => i),
		});
		const meta = parseMeta(file);
		expect([...meta.items.keys()]).toEqual([1, 2, 3, 4]);
		expect(meta.references.get('auxl')?.get(2)).toEqual([1]);
		expect(meta.references.get('dimg')?.get(4)).toEqual([1, 3]);
		expect(slice(file, meta, 1)).toEqual(coded(GRADIENT128).data);
		expect(slice(file, meta, 3)).toEqual(coded(GRADIENT64X48).data);
		expect(slice(file, meta, 4)).toEqual(metadata);
		expect(itemProperty(meta, 4, 'ispe')).toEqual({ kind: 'ispe', width: 128, height: 128 });
	});
});

describe('odd dimensions', () => {
	it('records 33 by 17 without rounding either of them', () => {
		// Both dimensions odd, so a writer that padded to a chroma pair would
		// report 34 by 18 and the picture would come back with a stripe of
		// nothing down two of its edges.
		const file = muxAvif({ colour: coded(ODD33X17), colourSpace: 'srgb' });
		const meta = parseMeta(file);
		expect(itemProperty(meta, 1, 'ispe')).toEqual({ kind: 'ispe', width: 33, height: 17 });
		expect(slice(file, meta, 1)).toEqual(coded(ODD33X17).data);
	});
});

/* ── The encoder ──────────────────────────────────────────────────────── */

const CAPABILITIES: Capabilities = {
	nativeDecode: new Set<string>(),
	canvasEncode: new Set<string>(),
	hevcVideoDecoder: false,
	av1VideoEncoder: true,
	displayP3Canvas: false,
	compressionStream: false,
	offscreenCanvas: false,
	imageDecoder: false,
};

const CONTEXT: EncodeContext = { capabilities: CAPABILITIES };

function raster(width: number, height: number, hasAlpha = false): RasterImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = i & 0xff;
		data[i + 1] = (i >> 2) & 0xff;
		data[i + 2] = 0x40;
		data[i + 3] = hasAlpha ? (i >> 4) & 0xff : 255;
	}
	return { data, width, height, colourSpace: 'srgb', hasAlpha };
}

/**
 * A stand-in for the browser, returning captured keyframes.
 *
 * The whole point of the seam. Node has no `VideoEncoder`, and a fake that
 * tried to produce AV1 would be a test of the fake; these are bytes a real
 * Chrome really wrote.
 */
function fakeEncoder(replies: readonly Fixture[], seen: Av1FrameRequest[]): Av1FrameEncoder {
	let at = 0;
	return async (request) => {
		seen.push(request);
		const reply = replies[Math.min(at, replies.length - 1)] as Fixture;
		at += 1;
		return reply.bytes;
	};
}

describe('the codec string', () => {
	it('takes its level from the size of the picture', () => {
		expect(av1CodecString(128, 128)).toBe('av01.0.04M.08');
		expect(av1CodecString(1920, 1080)).toBe('av01.0.08M.08');
		expect(av1CodecString(3000, 2000)).toBe('av01.0.12M.08');
		expect(av1CodecString(8000, 6000)).toBe('av01.0.16M.08');
	});

	it('does not go below 3.0 for a thumbnail, and does not run out at the top', () => {
		expect(av1CodecString(1, 1)).toBe('av01.0.04M.08');
		// Past level 6.0 there is no larger level to name.
		expect(av1CodecString(20000, 20000)).toBe('av01.0.16M.08');
	});

	it('picks a level by width as well as by area', () => {
		// Well inside 3.0's pixel budget and far outside its width.
		expect(av1CodecString(5000, 100)).toBe('av01.0.08M.08');
	});
});

describe('the quality mapping', () => {
	it('runs the whole quantiser scale, finest at the top of the slider', () => {
		expect(av1RateFor(128, 128, 1).quantizer).toBe(0);
		expect(av1RateFor(128, 128, 0).quantizer).toBe(63);
		expect(av1RateFor(128, 128, 0.5).quantizer).toBe(32);
	});

	it('clamps a setting from outside the range rather than passing it on', () => {
		expect(av1RateFor(128, 128, 4).quantizer).toBe(0);
		expect(av1RateFor(128, 128, -2).quantizer).toBe(63);
	});

	it('scales the fallback rate with the picture and with the setting', () => {
		const small = av1RateFor(1000, 1000, 0.8).bitrate;
		const large = av1RateFor(2000, 2000, 0.8).bitrate;
		expect(large / small).toBeCloseTo(4, 5);
		expect(av1RateFor(1000, 1000, 1).bitrate).toBeGreaterThan(small);
		expect(av1RateFor(1000, 1000, 0).bitrate).toBeLessThan(small);
	});

	it('puts a floor under a rate too small for an encoder to spend', () => {
		expect(av1RateFor(16, 16, 0).bitrate).toBe(100_000);
	});
});

describe('encodeAvif', () => {
	it('writes a file that re-parses, from one frame', async () => {
		const seen: Av1FrameRequest[] = [];
		const file = await encodeAvif(raster(128, 128), {}, CONTEXT, fakeEncoder([GRADIENT128], seen));
		const meta = parseMeta(file);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.codec).toBe('av01.0.04M.08');
		expect(seen[0]?.rgba).toHaveLength(128 * 128 * 4);
		expect([...meta.items.values()].map((item) => item.type)).toEqual(['av01']);
		expect(itemProperty(meta, 1, 'ispe')).toEqual({ kind: 'ispe', width: 128, height: 128 });
	});

	it('strips the temporal delimiter and keeps the sequence header and the frame', async () => {
		const file = await encodeAvif(raster(128, 128), {}, CONTEXT, fakeEncoder([GRADIENT128], []));
		const meta = parseMeta(file);
		const item = slice(file, meta, 1);
		expect(item.length).toBe(GRADIENT128.bytes.length - 2);
		expect(splitObus(item).map((obu) => obu.type)).toEqual([OBU_SEQUENCE_HEADER, OBU_FRAME]);
	});

	it('reports the range the bitstream declared, not the one a writer would prefer', async () => {
		const file = await encodeAvif(raster(128, 128), {}, CONTEXT, fakeEncoder([GRADIENT128], []));
		expect(itemProperty(parseMeta(file), 1, 'colr')?.fullRange).toBe(false);
	});

	it('encodes a second frame of coverage when the picture is translucent', async () => {
		const seen: Av1FrameRequest[] = [];
		const image = raster(128, 128, true);
		const file = await encodeAvif(image, {}, CONTEXT, fakeEncoder([GRADIENT128], seen));
		expect(seen).toHaveLength(2);

		// Coverage in all three channels and an opaque alpha, which is the only
		// spelling a VideoEncoder offers for a one channel picture.
		const coverage = need(seen[1], 'alpha request').rgba;
		expect(coverage[0]).toBe(image.data[3]);
		expect(coverage[1]).toBe(image.data[3]);
		expect(coverage[2]).toBe(image.data[3]);
		expect(coverage[3]).toBe(255);

		const meta = parseMeta(file);
		expect(meta.items.size).toBe(2);
		expect(itemProperty(meta, 2, 'auxC')?.auxType).toBe(ALPHA_AUX_URN);
	});

	it('encodes the gain map and carries its parameters through untouched', async () => {
		const seen: Av1FrameRequest[] = [];
		const metadata = Uint8Array.from({ length: 40 }, (_value, i) => (i * 11) & 0xff);
		const gainMap: GainMap = {
			image: raster(32, 32),
			metadata,
			standard: 'iso-21496-1',
		};
		const options: EncodeOptions = { gainMap };
		const file = await encodeAvif(
			raster(128, 128),
			options,
			CONTEXT,
			fakeEncoder([GRADIENT128, GREY32], seen),
		);
		expect(seen).toHaveLength(2);
		expect(seen[1]?.width).toBe(32);

		const meta = parseMeta(file);
		expect([...meta.items.values()].map((item) => item.type)).toEqual(['av01', 'av01', 'tmap']);
		expect(meta.references.get('dimg')?.get(3)).toEqual([1, 2]);
		expect(itemBytes(file, meta, 3)).toEqual(metadata);
	});

	it('carries an ICC profile into the file', async () => {
		const profile = Uint8Array.from({ length: 12 }, (_value, i) => i * 3);
		const file = await encodeAvif(
			raster(128, 128),
			{ iccProfile: profile },
			CONTEXT,
			fakeEncoder([GRADIENT128], []),
		);
		const meta = parseMeta(file);
		const icc = meta.properties.find(
			(property) => property.kind === 'colr' && property.type === 'icc',
		);
		expect(icc?.kind === 'colr' ? icc.iccProfile : undefined).toEqual(profile);
	});

	it('maps quality onto the quantiser at both ends of the slider', async () => {
		const seen: Av1FrameRequest[] = [];
		await encodeAvif(raster(128, 128), { quality: 1 }, CONTEXT, fakeEncoder([GRADIENT128], seen));
		await encodeAvif(raster(128, 128), { quality: 0 }, CONTEXT, fakeEncoder([GRADIENT128], seen));
		await encodeAvif(raster(128, 128), {}, CONTEXT, fakeEncoder([GRADIENT128], seen));
		expect(seen.map((request) => request.quantizer)).toEqual([0, 63, 25]);
	});

	it('clamps a quality setting from outside the range rather than passing it on', async () => {
		const seen: Av1FrameRequest[] = [];
		await encodeAvif(raster(64, 48), { quality: 4 }, CONTEXT, fakeEncoder([GRADIENT64X48], seen));
		await encodeAvif(raster(64, 48), { quality: -2 }, CONTEXT, fakeEncoder([GRADIENT64X48], seen));
		expect(seen.map((request) => request.quantizer)).toEqual([0, 63]);
	});

	it('hands the browser the rate that goes with the quality it was given', async () => {
		const seen: Av1FrameRequest[] = [];
		await encodeAvif(raster(64, 48), { quality: 0.5 }, CONTEXT, fakeEncoder([GRADIENT64X48], seen));
		expect(need(seen[0], 'request').bitrate).toBe(av1RateFor(64, 48, 0.5).bitrate);
	});

	it('stops when the conversion was cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			encodeAvif(
				raster(128, 128),
				{},
				{ capabilities: CAPABILITIES, signal: controller.signal },
				fakeEncoder([GRADIENT128], []),
			),
		).rejects.toThrow(CancelledError);
	});

	it('refuses a stream with no sequence header in it', async () => {
		// A temporal delimiter and a frame, and nothing to configure a decoder.
		const stripped: Av1FrameEncoder = async () => Uint8Array.of(0x12, 0x00, 0x32, 0x01, 0x00);
		await expect(encodeAvif(raster(128, 128), {}, CONTEXT, stripped)).rejects.toThrow(
			EncodeFailedError,
		);
	});

	it('refuses a stream that describes a smaller picture than it was given', async () => {
		// The container would otherwise claim a size the file does not hold.
		await expect(
			encodeAvif(raster(256, 256), {}, CONTEXT, fakeEncoder([GRADIENT128], [])),
		).rejects.toThrow(EncodeFailedError);
	});
});
