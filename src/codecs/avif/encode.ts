/**
 * Writing AVIF: one AV1 keyframe, or three, in a HEIF container.
 *
 * This is the only encoder in the package that cannot be finished in
 * TypeScript. The container is ours, and the whole of it is written in
 * `mux.ts`; the picture inside it comes from the browser's video encoder,
 * which is asked for a single keyframe and hands back an OBU chain. What
 * arrives has a temporal delimiter at the front, which is a marker saying a
 * frame boundary happened and nothing else. That belongs in a video stream and
 * not in a still picture item, so it is removed and the sequence header and
 * the frame are kept.
 *
 * Alpha does not travel with the colour. AVIF carries it as a separate coded
 * picture, an auxiliary item with a URN saying what it is, and the encoder
 * here has no way to produce a monochrome AV1, so coverage is written into all
 * three channels of a second frame and the luma plane is what a reader takes
 * back out. It costs more than it should and it is the only spelling available
 * from a `VideoEncoder`.
 *
 * A gain map is a third picture and a `tmap` item that names the other two.
 * The parameter block is carried through as bytes and never read, which is
 * what makes an HDR photograph survive the trip from a HEIC without this
 * package having to understand what any of the numbers in it mean.
 *
 * EXIF goes the same way, straight to the muxer as it arrived. `convert` has
 * already rewritten the orientation tag to upright by the time it gets here,
 * which is the one field that has to change: the frame handed to the encoder
 * is the rotated raster, so an EXIF still asking for a quarter turn would be
 * asking for a second one.
 */

import { ByteWriter } from '../../bits.js';
import { CancelledError, EncodeFailedError } from '../../errors.js';
import type { EncodeContext, EncodeOptions, RasterImage } from '../../types.js';
import {
	OBU_SEQUENCE_HEADER,
	OBU_TEMPORAL_DELIMITER,
	buildAv1C,
	parseSequenceHeader,
	splitObus,
} from './av1.js';
import type { Av1SequenceHeader } from './av1.js';
import { muxAvif } from './mux.js';
import type { AvifCodedImage } from './mux.js';
import { webCodecsAv1Encoder } from './webcodecs.js';
import type { Av1FrameEncoder } from './webcodecs.js';

const ENCODER_ID = 'avif-webcodecs';

function fail(detail: string): never {
	throw new EncodeFailedError('avif', ENCODER_ID, detail);
}

/**
 * How large a picture each AV1 level allows, from the specification's Annex A.
 *
 * Only the whole numbered levels are listed. The point ones raise the frame
 * rate and the bit rate rather than the size of the picture, and a photograph
 * has neither, so 3.1 buys nothing over 3.0 that this encoder can spend.
 *
 * The level in the codec string is a request. What ends up in the file is
 * whatever the browser's encoder chose to write into its own sequence header,
 * because that is what `buildAv1C` reads, and every capture measured so far
 * came back at level 2.0 no matter what was asked for. Asking for a level the
 * picture does not fit in is still worth avoiding: it is the one part of the
 * configuration a browser is entitled to refuse outright.
 */
interface Av1Level {
	readonly index: number;
	readonly maxPixels: number;
	readonly maxWidth: number;
	readonly maxHeight: number;
}

const LEVELS: readonly Av1Level[] = [
	{ index: 4, maxPixels: 665856, maxWidth: 4352, maxHeight: 2448 }, // 3.0
	{ index: 8, maxPixels: 2359296, maxWidth: 6144, maxHeight: 3456 }, // 4.0
	{ index: 12, maxPixels: 8912896, maxWidth: 8192, maxHeight: 4352 }, // 5.0
	{ index: 16, maxPixels: 35651584, maxWidth: 16384, maxHeight: 8704 }, // 6.0
];

/**
 * The codec string for a picture of this size.
 *
 * Profile 0, main tier, eight bits: 4:2:0 at eight bits is the only thing a
 * browser's AV1 encoder will produce here, so the only variable is the level.
 * Levels below 3.0 are not offered even for a thumbnail, because 3.0 and 4.0
 * are the two configurations measured to be accepted and there is nothing to
 * gain from a lower one. Above 6.0 there is no larger level to name, so the
 * largest is used and the encoder's own choice, recorded in the sequence
 * header, is what the container ends up reporting.
 */
export function av1CodecString(width: number, height: number): string {
	const pixels = width * height;
	const level =
		LEVELS.find(
			(candidate) =>
				pixels <= candidate.maxPixels &&
				width <= candidate.maxWidth &&
				height <= candidate.maxHeight,
		) ?? (LEVELS[LEVELS.length - 1] as Av1Level);
	return `av01.0.${level.index.toString().padStart(2, '0')}M.08`;
}

/**
 * The default when the caller does not say.
 *
 * `avifenc` with no flags, which is quality 60 of 100 and quantiser 25. Chosen
 * to match rather than invented, so a file written here is the size and the
 * quality somebody would get from the reference encoder, and a report of one
 * being too large or too small is a conversation about the same number.
 *
 * It was 0.8 first, on the reasoning that a conversion which visibly costs
 * detail is worse than one that costs bytes. Measured on a twelve megapixel
 * phone photograph, 0.8 wrote 2532 kB against the 1751 kB HEIC it came from,
 * for 44.75 dB against 43.60 at this setting. Better than the source and
 * larger than it, which is the wrong trade for a converter: the curve is flat
 * enough that the last two tenths of the slider buy 1.2 dB for 700 kB, and
 * anybody who wants them can ask.
 */
const DEFAULT_QUALITY = 0.6;

/** Both spellings of a quality setting, since only the browser knows which it takes. */
export interface Av1Rate {
	/** An AV1 quantiser index, 0 to 63, 0 being the finest. */
	readonly quantizer: number;
	/** Bits for one frame, for a browser that will not take a quantiser. */
	readonly bitrate: number;
}

/**
 * `options.quality`, mapped twice.
 *
 * Where the browser accepts `bitrateMode: 'quantizer'` the setting becomes an
 * AV1 quantiser index straight off: 1 is index 0 and 0 is index 63, linearly,
 * because that index is already spaced to be roughly perceptual and bending it
 * again here would only make the slider disagree with every other AV1 tool.
 * This is `avifenc`'s own mapping, `((100 - quality) * 63 + 50) / 100`, to the
 * integer: 0.92 is quantiser 5 in both, and 0.6 is 25 in both. Note what that
 * means for a caller reusing one number across formats, because AVIF is far
 * more efficient than JPEG at the same index: 0.92 is an ordinary good setting
 * for a JPEG and an archival one here.
 * That is the path worth having. A quantiser is what the encoder acts on, so
 * the size of the file falls out of the picture instead of being imposed on
 * it, which is the right way round for a still image.
 *
 * Where it does not, the fallback is a bit rate, and a bit rate for a single
 * frame is a guess at the answer before the encoder has seen the question. It
 * is expressed in bits per pixel so at least it scales with the picture: 0.05
 * at the bottom and 2.0 at the top, on a curve rather than a straight line
 * because everything interesting happens in the last quarter of the slider.
 *
 * Neither end is lossless and this encoder cannot be. The picture was
 * converted to 4:2:0 Y'CbCr on its way into the frame, so three quarters of
 * the colour resolution was gone before the quantiser saw any of it.
 */
export function av1RateFor(width: number, height: number, quality: number): Av1Rate {
	const clamped = Math.min(1, Math.max(0, quality));
	const bitsPerPixel = 0.05 * 40 ** clamped;
	return {
		quantizer: Math.round((1 - clamped) * 63),
		// A floor under the rate, because a small picture at a low setting works
		// out to a few thousand bits and an encoder rejects a budget it cannot
		// spend on the headers alone.
		bitrate: Math.max(100_000, Math.round(width * height * bitsPerPixel)),
	};
}

/** A coded picture, with what its sequence header said about itself. */
interface CodedFrame {
	readonly image: AvifCodedImage;
	readonly header: Av1SequenceHeader;
}

/**
 * Turn an OBU chain into item data and an `av1C` record.
 *
 * The temporal delimiter goes. It is two bytes of "a frame started here",
 * which is a statement about a stream of frames, and a still picture item is
 * not one. Everything else is kept in the order it arrived, including any OBU
 * this package does not name, because dropping something on the grounds that
 * it was not recognised is how a decoder ends up missing a piece it needed.
 */
function codedFrame(bytes: Uint8Array, width: number, height: number): CodedFrame {
	const kept = new ByteWriter(bytes.length);
	let sequenceHeader: Uint8Array | undefined;
	let header: Av1SequenceHeader | undefined;

	for (const obu of splitObus(bytes)) {
		if (obu.type === OBU_TEMPORAL_DELIMITER) continue;
		if (obu.type === OBU_SEQUENCE_HEADER && !sequenceHeader) {
			sequenceHeader = bytes.subarray(obu.start, obu.end);
			header = parseSequenceHeader(obu.payload);
		}
		kept.bytesOf(bytes.subarray(obu.start, obu.end));
	}

	if (!sequenceHeader || !header) {
		fail('the browser returned an AV1 stream with no sequence header in it');
	}
	// A sequence header that describes a smaller picture than was asked for
	// means the encoder produced something other than the frame handed to it,
	// and the size in the container would then be a claim about a picture that
	// is not in the file.
	if (header.maxFrameWidth < width || header.maxFrameHeight < height) {
		fail('the browser encoded a smaller picture than it was given');
	}

	return {
		image: { data: kept.finish(), width, height, config: buildAv1C(sequenceHeader, header) },
		header,
	};
}

/**
 * Coverage, written into all three channels of an opaque picture.
 *
 * The alpha item is a coded picture in its own right and this encoder has no
 * monochrome spelling to reach for, so the cheapest correct thing is a grey
 * frame. Chroma subsampling then costs nothing, because there is no chroma:
 * all three channels agree everywhere, so the two colour difference planes are
 * flat and the luma plane is the coverage.
 */
function alphaFrame(image: RasterImage): Uint8ClampedArray {
	const out = new Uint8ClampedArray(image.width * image.height * 4);
	for (let at = 0; at < out.length; at += 4) {
		const coverage = image.data[at + 3] as number;
		out[at] = coverage;
		out[at + 1] = coverage;
		out[at + 2] = coverage;
		out[at + 3] = 255;
	}
	return out;
}

/**
 * Write an AVIF.
 *
 * `encodeFrame` defaults to the browser's own encoder and is a parameter so a
 * test can supply captured keyframes instead. Everything after the frames
 * comes back is byte writing that runs anywhere.
 */
export async function encodeAvif(
	image: RasterImage,
	options: EncodeOptions,
	context: EncodeContext,
	encodeFrame: Av1FrameEncoder = webCodecsAv1Encoder(),
): Promise<Uint8Array> {
	const quality = options.quality ?? DEFAULT_QUALITY;

	const encodePicture = async (
		width: number,
		height: number,
		rgba: Uint8ClampedArray,
	): Promise<CodedFrame> => {
		if (context.signal?.aborted) throw new CancelledError();
		const rate = av1RateFor(width, height, quality);
		const bytes = await encodeFrame({
			codec: av1CodecString(width, height),
			width,
			height,
			rgba,
			quantizer: rate.quantizer,
			bitrate: rate.bitrate,
		});
		return codedFrame(bytes, width, height);
	};

	const colour = await encodePicture(image.width, image.height, image.data);

	const alpha = image.hasAlpha
		? await encodePicture(image.width, image.height, alphaFrame(image))
		: undefined;

	const map = options.gainMap;
	const gainMap = map
		? await encodePicture(map.image.width, map.image.height, map.image.data)
		: undefined;

	return muxAvif({
		colour: colour.image,
		colourSpace: image.colourSpace,
		alpha: alpha?.image,
		gainMap:
			map && gainMap
				? { image: gainMap.image, metadata: map.metadata, iccProfile: map.iccProfile }
				: undefined,
		iccProfile: options.iccProfile,
		exif: options.exif,
		// What the bitstream said, rather than what a writer would prefer. A
		// `colr` box overrides the sequence header, so claiming full range over
		// the studio range samples every browser encoder produces would lift
		// the blacks of the picture and report nothing.
		fullRange: colour.header.fullRange,
	});
}
