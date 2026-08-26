/**
 * Every public interface and type alias in this package.
 *
 * Values live where they are produced. This file is types only, so it compiles
 * to `export {}` and is excluded from coverage.
 */

/* ── Formats ──────────────────────────────────────────────────────────── */

/**
 * The formats this package knows by name.
 *
 * A closed union rather than a string, so a `switch` over it is exhaustive and
 * the website's error-message map is a compile error when a format is added.
 * A format appears here once it can be either read or written; `heic` is
 * read-only and always will be, which is recorded in `FORMATS` rather than by
 * leaving it out.
 */
export type FormatId =
	| 'heic'
	| 'png'
	| 'apng'
	| 'jpeg'
	| 'jxl'
	| 'webp'
	| 'avif'
	| 'gif'
	| 'bmp'
	| 'ico'
	| 'tiff'
	| 'raw'
	| 'psd'
	| 'dds'
	| 'hdr'
	| 'exr'
	| 'pcx'
	| 'icns'
	| 'ras'
	| 'xbm'
	| 'xpm'
	| 'qoi'
	| 'tga'
	| 'pnm'
	| 'farbfeld'
	| 'svg';

/** Static facts about a format. See `FORMATS` in `formats.ts`. */
export interface FormatInfo {
	readonly id: FormatId;
	/** Canonical MIME type. Used for blobs and for native probes. */
	readonly mime: string;
	/** Every MIME type seen in the wild for this format, canonical one first. */
	readonly mimes: readonly string[];
	/** Canonical extension, without the dot. */
	readonly extension: string;
	readonly extensions: readonly string[];
	/** Human-facing short name. Not translated: these are format names. */
	readonly label: string;
	readonly alpha: boolean;
	/** Lossy formats take a quality setting; lossless ones ignore it. */
	readonly lossy: boolean;
	readonly animated: boolean;
}

/* ── Rasters ──────────────────────────────────────────────────────────── */

/**
 * The colour space a raster's numbers are in.
 *
 * This is carried on the raster rather than assumed, because getting it wrong
 * is silent. An iPhone HEIC decodes to Display P3 values; writing those into a
 * default sRGB canvas without either tagging or converting produces an image
 * that is visibly flat, and forcing the opposite conversion on something
 * already in sRGB oversaturates it by roughly the same amount. Neither failure
 * throws, and on a wide-gamut display both look plausible.
 */
export type ColourSpace = 'srgb' | 'display-p3';

/**
 * A decoded image, as straight (non-premultiplied) RGBA bytes.
 *
 * Deliberately not a canvas. iOS Safari caps a single canvas at about
 * 16.7 million pixels and holds a budget across all live canvases, so a 48
 * megapixel photo cannot exist as one canvas there at all. Tiles composite
 * into this buffer, and a canvas is only involved when the chosen output
 * format needs the browser's encoder.
 */
export interface RasterImage {
	readonly data: Uint8ClampedArray;
	readonly width: number;
	readonly height: number;
	readonly colourSpace: ColourSpace;
	/**
	 * Whether any pixel is actually translucent.
	 *
	 * The buffer is always RGBA; this records whether the alpha channel
	 * carries information, so an encoder can pick a cheaper representation and
	 * a lossy encoder knows whether it needs to flatten first.
	 */
	readonly hasAlpha: boolean;
}

/* ── Light ────────────────────────────────────────────────────────────── */

/**
 * A decoded image as light rather than as a picture of one.
 *
 * `RasterImage` is display referred: its numbers have already been through a
 * transfer curve and 255 means "as bright as this screen goes". A `FloatImage`
 * is scene referred and linear, so 1 is a diffuse white surface and there is no
 * ceiling above it. Radiance and OpenEXR both store that, and reducing it to
 * bytes is a decision about how a picture should look rather than a decoding
 * step, which is why it now happens on the way out instead of on the way in.
 *
 * Always four channels, matching `RasterImage`, so the two are interchangeable
 * everywhere except in what a sample means. Alpha is straight coverage in 0 to
 * 1 and is not light: nothing tone maps it.
 *
 * Sixteen bytes a pixel, against four. That is the reason a decoder only
 * produces one when something downstream has said it can use it.
 */
export interface FloatImage {
	readonly data: Float32Array;
	readonly width: number;
	readonly height: number;
	readonly colourSpace: ColourSpace;
	readonly hasAlpha: boolean;
}

/**
 * How to reduce unbounded light to eight bits.
 *
 * Lives here rather than beside the implementation because it is now a
 * conversion option: the caller chooses the exposure, and until this existed
 * the choice was made inside the decoder where nothing could reach it.
 */
export interface ToneMapOptions {
	/**
	 * Exposure in stops, relative to the automatic choice.
	 *
	 * Left unset, the picture is metered: the log-average luminance is placed
	 * at middle grey, which is the same rule a camera's average metering uses
	 * and lands within a stop of right on almost everything.
	 */
	readonly stops?: number;
	/**
	 * Skip the roll-off and clip at white instead.
	 *
	 * Correct when the file is already display referred, which happens with
	 * EXRs written out of a compositor as a final frame. Wrong for anything
	 * scene referred, where it flattens every highlight to white.
	 */
	readonly clip?: boolean;
	readonly colourSpace?: ColourSpace;
}

/**
 * An HDR gain map, as the file stored it.
 *
 * A modern HDR photograph is not one picture with more bits in it. It is an
 * ordinary SDR picture plus a second, usually smaller, monochrome picture
 * saying how much brighter each part of it should get, and a short block of
 * parameters saying how to read that second picture against the headroom of
 * whatever screen is showing it. At zero headroom the gain map contributes
 * nothing, which is why the same file looks correct on a display that cannot
 * show any of it.
 *
 * `metadata` is carried as bytes and never parsed. Every value that defines
 * what the picture should look like lives in there, so copying the block
 * unchanged into a container that uses the same specification reproduces the
 * photograph exactly, while reading it in order to write it back out again
 * could only introduce error. The one thing worth knowing about it is which
 * specification wrote it, and that is recorded separately.
 */
export interface GainMap {
	readonly image: RasterImage;
	readonly metadata: Uint8Array;
	/** Which specification's parameter block `metadata` holds. */
	readonly standard: 'iso-21496-1';
	/** The gain map's own colour tag, when it carried one. */
	readonly iccProfile?: Uint8Array;
}

/** What tone mapping did, so the report can say it rather than imply it. */
export interface ToneMapResult {
	readonly image: RasterImage;
	/**
	 * The exposure that was applied, in stops away from a meter reading of
	 * middle grey. Zero means the metering was taken as it came.
	 */
	readonly stops: number;
	/** The luminance mapped to white, before the roll-off. 1 when clipping. */
	readonly white: number;
}

/* ── Animation ──────────────────────────────────────────────── */

/**
 * One frame of an animation, already composited.
 *
 * Every frame is a whole picture at the animation's dimensions, not the small
 * dirty rectangle the file stored. GIF and APNG both encode frames as patches
 * with a disposal rule and a blend rule, and reproducing those rules is the
 * decoder's job precisely once. A converter that received patches would have
 * to reimplement them for every target format, and the two specifications
 * disagree about what "restore to background" means, so the disagreement would
 * arrive in the output rather than being settled in the reader.
 */
export interface AnimationFrame {
	readonly image: RasterImage;
	/**
	 * How long this frame is shown, in milliseconds.
	 *
	 * Not the raw field. GIF stores hundredths of a second and treats 0 and 1
	 * as "as fast as possible", which browsers render as 100ms; APNG stores a
	 * rational that can divide by zero. Both are resolved here, so an encoder
	 * writing the other format converts a duration rather than a convention.
	 */
	readonly delayMs: number;
}

export interface Animation {
	readonly frames: readonly AnimationFrame[];
	/** How many times to play. 0 means forever, which is what most files mean. */
	readonly loopCount: number;
}

/** A right-angle rotation, in degrees anticlockwise, as HEIF `irot` records it. */
export type Rotation = 0 | 90 | 180 | 270;

/** A mirror axis, as HEIF `imir` records it. */
export type Mirror = 'none' | 'horizontal' | 'vertical';

/**
 * The orientation correction applied to a decoded image.
 *
 * Reported rather than hidden, because "the tool rotated my photo" and "the
 * tool failed to rotate my photo" are the same complaint from opposite
 * directions and there is no way to tell them apart without knowing what was
 * applied.
 */
export interface Orientation {
	readonly rotation: Rotation;
	readonly mirror: Mirror;
	/** Where the correction came from. `none` means the pixels were already upright. */
	readonly source: 'none' | 'heif-irot' | 'exif' | 'decoder';
}

/* ── Capabilities ─────────────────────────────────────────────────────── */

/**
 * What this browser can actually do, measured rather than inferred.
 *
 * Every field here is the result of a probe. None of it is derived from the
 * user agent string, because the interesting cases (a Chromium build on a
 * machine with no HEVC decode hardware, a Safari old enough to lack HEIC) are
 * invisible from the user agent and would be wrong in exactly the direction
 * that breaks the tool.
 */
export interface Capabilities {
	/** MIME types `createImageBitmap` decoded when handed a real sample. */
	readonly nativeDecode: ReadonlySet<string>;
	/** MIME types a canvas actually produced, verified by sniffing the output. */
	readonly canvasEncode: ReadonlySet<string>;
	/** `VideoDecoder` exists and reported a supported HEVC configuration. */
	readonly hevcVideoDecoder: boolean;
	/**
	 * `VideoEncoder` exists and reported a supported AV1 configuration.
	 *
	 * What makes writing AVIF possible at all. Eight bit only, and deliberately
	 * probed as such: every Chromium tested refuses a ten bit AV1 configuration
	 * under all three acceleration preferences, so a probe that asked for ten
	 * would report no AVIF support at all rather than the eight bit support
	 * that is really there.
	 */
	readonly av1VideoEncoder: boolean;
	/** A 2D context accepted `colorSpace: 'display-p3'` and reported it back. */
	readonly displayP3Canvas: boolean;
	/** `CompressionStream('deflate')` exists. Required by the PNG encoder. */
	readonly compressionStream: boolean;
	readonly offscreenCanvas: boolean;
	readonly imageDecoder: boolean;
}

/* ── Codec contracts ──────────────────────────────────────────────────── */

/**
 * How a decode was performed.
 *
 * This reaches the interface and is shown to the person using it. `plugin`
 * means a software decoder supplied by the host application ran, which is
 * correct but slower than the hardware path, and saying so is better than
 * letting somebody conclude the tool is simply slow.
 */
export type DecodePath = 'native-image' | 'webcodecs' | 'pure' | 'plugin';

/**
 * How an encode was performed.
 *
 * `webcodecs` is the mirror of the decode path of the same name and means a
 * video encoder wrote a single still frame. That is not a workaround: an AVIF
 * is one AV1 keyframe in a HEIF container, so a video encoder is the only
 * thing in a browser that can produce one, and every AVIF encoder anywhere
 * does the same thing with a different copy of the same codec.
 */
export type EncodePath = 'pure' | 'canvas' | 'webcodecs' | 'plugin';

export interface DecodeContext {
	readonly capabilities: Capabilities;
	readonly signal?: AbortSignal;
	/** Refuse images larger than this many pixels. See `DEFAULT_MAX_PIXELS`. */
	readonly maxPixels: number;
}

export interface DecodeOutput {
	/**
	 * The decoded image, already the right way up.
	 *
	 * Uprighting is the decoder's job, without exception. The alternative,
	 * where a decoder reports an orientation for the caller to apply, was tried
	 * and produced exactly the bug it was meant to avoid: the HEIF path applies
	 * `irot` while assembling the tile grid, the converter applied it a second
	 * time, and every portrait photograph came out rotated by 540 degrees. Both
	 * halves looked correct in isolation.
	 */
	readonly image: RasterImage;
	/** What was applied to get there. Reported, never re-applied. */
	readonly orientation: Orientation;
	/**
	 * The HDR gain map, when the container had one and this decoder read it.
	 *
	 * Present means it can be carried to an output format that understands one.
	 * Absent with `hasGainMap` set on the plan means the file had one and this
	 * rung could not reach it, which is the difference between "there was no
	 * HDR here" and "there was, and it is gone".
	 */
	readonly gainMap?: GainMap;
	/** True when the container carried an HDR gain map this decoder discarded. */
	readonly droppedGainMap?: boolean;
	/**
	 * True when the file carried transparency this decoder could not apply.
	 *
	 * The picture came back opaque and is meant to have holes in it. Absent
	 * means either the file was opaque or the transparency was applied, which
	 * from a caller's point of view are the same thing and need no report.
	 */
	readonly droppedAlpha?: boolean;
	/**
	 * True when the source had more frames than this reader was willing to take.
	 *
	 * Distinct from `ConvertOptions.frames`, which is the caller asking for one
	 * frame. This is the reader reaching its own cap, and it has to reach the
	 * report or an interface says "all 300 frames kept" about a 500 frame GIF.
	 */
	readonly truncatedFrames?: boolean;
	/** Raw EXIF payload (TIFF header onwards), if the container carried one. */
	readonly exif?: Uint8Array;
	/**
	 * The source's ICC profile, when it had one worth carrying.
	 *
	 * Threaded through to the encoder so a wide gamut photograph comes out
	 * tagged with the profile the camera meant, rather than with P3 numbers and
	 * nothing to say so, which renders washed out everywhere.
	 */
	readonly iccProfile?: Uint8Array;
	/** Number of separately decoded tiles, for containers that are tiled. */
	readonly tiles?: number;
	/**
	 * Every frame, when the source was animated.
	 *
	 * Additive rather than replacing `image`, which stays the first frame. A
	 * caller that only wants a picture keeps working without knowing this field
	 * exists, and one converting to a still format gets the frame a person
	 * would expect to see rather than an error.
	 */
	readonly animation?: Animation;
}

/**
 * A decoder for one or more formats.
 *
 * Registered rather than imported by the converter, so adding a format is
 * adding a file plus one `registerDecoder` call. A decoder never sniffs: the
 * registry has already identified the format from the bytes and is asking this
 * decoder whether it can handle it here, in this browser, now.
 */
export interface Decoder {
	readonly id: string;
	readonly formats: readonly FormatId[];
	readonly path: DecodePath;
	/**
	 * Lower runs first.
	 *
	 * The ladder is ordered by cost to the person waiting, not by preference in
	 * the abstract: a hardware decode beats a software one, and anything built
	 * into the browser beats a megabyte of downloaded WebAssembly.
	 */
	readonly priority: number;
	/** Whether this decoder can run at all here. Memoised by the registry. */
	available(capabilities: Capabilities): Promise<boolean>;
	decode(bytes: Uint8Array, context: DecodeContext): Promise<DecodeOutput>;
	/**
	 * Decode to unbounded linear light, for the formats that store it.
	 *
	 * A second entry point rather than an extra field on `DecodeOutput`,
	 * because the two answers cost very different amounts and only the caller
	 * knows which it needs. A decoder that offered both would either tone map
	 * every EXR on the way to an EXR, throwing the work away, or return
	 * sixteen bytes a pixel to a caller writing a GIF.
	 *
	 * When this is present `convert` calls it in preference to `decode` and
	 * tone maps at the encoder instead, which is what makes the exposure
	 * setting mean anything.
	 */
	decodeFloat?(bytes: Uint8Array, context: DecodeContext): Promise<FloatDecodeOutput>;
	/**
	 * Read the declared size out of the header, without decoding anything.
	 *
	 * Optional, and worth implementing wherever the header and the pixels are
	 * separated by a decompressor. `maxPixels` is otherwise checked against the
	 * image that came back, which is too late to be a defence: a four kilobyte
	 * PNG whose IHDR claims twenty thousand by fifteen thousand has already
	 * been handed a gigabyte-shaped inflate budget by the time anything
	 * measures it. Formats that carry their pixels uncompressed can skip this,
	 * because a file that small cannot contain an image that large and their
	 * readers already refuse a header the file cannot back up.
	 *
	 * Returns nothing when the header cannot be read at all, which leaves the
	 * decision to `decode` and its error messages.
	 */
	measure?(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined;
}

/**
 * What a float decode returns.
 *
 * Deliberately smaller than `DecodeOutput`. The formats that carry light do
 * not carry animation, tiles or gain maps, and a shape that promised those
 * fields would be promising something no implementation can fill.
 */
export interface FloatDecodeOutput {
	readonly image: FloatImage;
	readonly orientation: Orientation;
	readonly exif?: Uint8Array;
	readonly iccProfile?: Uint8Array;
}

export interface EncodeOptions {
	/**
	 * An HDR gain map to write alongside the picture.
	 *
	 * Only an encoder that declares `gainMaps` looks at this. Everything else
	 * ignores it, and `convert` reports that it was dropped rather than letting
	 * it disappear quietly.
	 */
	readonly gainMap?: GainMap;
	/** 0 to 1, for lossy formats. Ignored by lossless ones. */
	readonly quality?: number;
	/**
	 * What to composite translucent pixels onto when the target has no alpha.
	 *
	 * Defaults to white, because the alternative default (black) turns every
	 * transparent logo into a black rectangle, which reads as corruption.
	 */
	readonly background?: readonly [number, number, number];
	/**
	 * An ICC profile to embed, for encoders that can carry one.
	 *
	 * Passed through from the source where there was one. Carrying the original
	 * profile is better than writing a synthetic tag, because it is exactly
	 * what the camera meant and it survives every reader that understands ICC
	 * at all, which is more of them than understand the newer compact tags.
	 */
	readonly iccProfile?: Uint8Array;
	/**
	 * Tag the output with its colour space when no ICC profile is embedded.
	 *
	 * Only meaningful for encoders that can carry a compact colour tag. Left
	 * off for plain sRGB, where an extra chunk in a file somebody is about to
	 * hand to another tool is a needless risk for no gain.
	 */
	readonly writeColourTag?: boolean;
	/**
	 * Reduce to a colour table of at most this many entries.
	 *
	 * Only meaningful for encoders that can write one. Left unset, an encoder
	 * that has the choice still writes a palette when the image happens to have
	 * few enough colours already, because that is lossless and smaller. Setting
	 * it asks for quantisation, which is not.
	 */
	readonly palette?: number;
	/**
	 * An EXIF payload to write, from the TIFF header onwards.
	 *
	 * Only an encoder that can carry one looks at it. `convert` supplies this
	 * when the caller asked to preserve metadata and the source had any, and
	 * rewrites the orientation tag to 1 first: the decoder contract says the
	 * pixels arrive upright, so carrying the original orientation through would
	 * tell every future reader to rotate an already rotated photograph.
	 */
	readonly exif?: Uint8Array;
	/**
	 * The frames to write, for an encoder that can animate.
	 *
	 * Ignored by every encoder that cannot, which is most of them, so passing
	 * it is always safe. An animating encoder handed nothing here writes a
	 * single frame from the image it was given.
	 */
	readonly animation?: Animation;
}

export interface EncodeContext {
	readonly capabilities: Capabilities;
	readonly signal?: AbortSignal;
}

export interface Encoder {
	readonly id: string;
	readonly format: FormatId;
	readonly path: EncodePath;
	readonly priority: number;
	/**
	 * Whether this encoder writes `EncodeOptions.animation` rather than ignoring it.
	 *
	 * Declared rather than inferred from the format, because the two are not
	 * the same question. WebP is an animated format and no browser will write
	 * an animated one, so a converter that read the format table would prepare
	 * every frame, hand them over, and then report an animation that is not in
	 * the file.
	 */
	readonly animates?: boolean;
	/**
	 * Whether this encoder writes light rather than a picture of it.
	 *
	 * Declared rather than inferred from `encodeFloat` being present, for the
	 * same reason `animates` is declared: an encoder may be able to take floats
	 * and still be the wrong place to send them.
	 */
	readonly floats?: boolean;
	/**
	 * Whether this encoder writes `EncodeOptions.gainMap` rather than dropping it.
	 */
	readonly gainMaps?: boolean;
	/**
	 * Whether this encoder writes `EncodeOptions.exif`.
	 *
	 * Declared rather than inferred, because the report tells somebody whether
	 * their metadata survived and there is no way to check after the fact
	 * without parsing the file back. An encoder that quietly ignored the field
	 * while the interface said "kept" would be the worst of the three possible
	 * outcomes: worse than dropping it, and worse than saying so.
	 */
	readonly exif?: boolean;
	available(capabilities: Capabilities): Promise<boolean>;
	encode(image: RasterImage, options: EncodeOptions, context: EncodeContext): Promise<Uint8Array>;
	/**
	 * Write unbounded linear light without reducing it first.
	 *
	 * Called only when `floats` is set and the decode produced light. An
	 * encoder that implements this is the reason an EXR can reach a Radiance
	 * file with its range intact instead of going through eight bits on the
	 * way.
	 */
	encodeFloat?(
		image: FloatImage,
		options: EncodeOptions,
		context: EncodeContext,
	): Promise<Uint8Array>;
}

/* ── Conversion ───────────────────────────────────────────────────────── */

/**
 * `animation` is not inherited on purpose.
 *
 * `convert` decides what frames the encoder receives, from the source and from
 * `frames` below. A caller that set it here would be quietly overruled, and an
 * option that is accepted and ignored is worse than one that does not exist.
 */
export interface ConvertOptions extends Omit<EncodeOptions, 'animation'> {
	readonly to: FormatId;
	/**
	 * Whether to carry EXIF through to the output.
	 *
	 * Defaults to `strip`. A phone photo's EXIF carries the coordinates of
	 * somebody's house and the time they were standing in it, and a tool whose
	 * whole claim is privacy should not preserve that by accident. Preserving
	 * it is a choice the person makes.
	 */
	readonly metadata?: 'strip' | 'preserve';
	/**
	 * Whether to keep a wide-gamut image wide.
	 *
	 * `preserve` keeps Display P3 where the output format and the browser can
	 * carry it and converts to sRGB where they cannot. `srgb` always converts.
	 */
	readonly colour?: 'preserve' | 'srgb';
	/**
	 * Cap the longest side, keeping the aspect ratio.
	 *
	 * Never upscales: asking for a longer side than the picture has leaves it
	 * alone. It is expressed as one number rather than a width and a height
	 * because a portrait photograph and a landscape one both want "no bigger
	 * than this", and asking for both invites the stretch that nobody wants.
	 *
	 * Applied before the alpha flatten and the gamut narrow, so those run over
	 * the smaller picture, and applied per frame for an animation.
	 */
	readonly resize?: { readonly longestSide: number };
	readonly maxPixels?: number;
	/**
	 * What to do with an animated source.
	 *
	 * `all` keeps every frame when the target can hold them and falls back to
	 * the first frame when it cannot, which is the answer somebody dropping a
	 * GIF on a PNG button wants. `first` always takes one frame, which is how
	 * you get a still out of an animation on purpose. Defaults to `all`.
	 */
	readonly frames?: 'all' | 'first';
	/**
	 * How to reduce a high dynamic range source when the target cannot hold it.
	 *
	 * Ignored for every ordinary format, because an eight bit source has
	 * nothing to reduce. It applies when the source was Radiance or OpenEXR and
	 * the target is anything that is not, which is where a person converting a
	 * render wants to say "one stop darker" and, until the tone map moved to
	 * the encoder, had nowhere to say it.
	 */
	readonly tone?: ToneMapOptions;
	readonly signal?: AbortSignal;
}

/** What happened, in enough detail to explain it to somebody. */
export interface ConvertReport {
	readonly from: FormatId;
	readonly to: FormatId;
	readonly decodePath: DecodePath;
	readonly decoderId: string;
	readonly encodePath: EncodePath;
	readonly encoderId: string;
	readonly width: number;
	readonly height: number;
	/**
	 * What the picture measured before it was resized, when it was.
	 *
	 * Absent when nothing changed, so an interface tests for the field rather
	 * than comparing two pairs of numbers to discover there is nothing to say.
	 */
	readonly resizedFrom?: { readonly width: number; readonly height: number };
	readonly colourSpace: ColourSpace;
	readonly orientation: Orientation;
	readonly tiles?: number;
	/**
	 * How many frames were written, when more than one was.
	 *
	 * Absent for a still image rather than 1, so an interface can test for the
	 * field instead of comparing against a number that means "not animated".
	 */
	readonly frames?: number;
	/** True when the source was animated and only its first frame was kept. */
	readonly droppedFrames?: boolean;
	/**
	 * True when the source had more frames than the reader would take.
	 *
	 * Separate from `droppedFrames`, which is all of them but one. This is the
	 * tail of a very long animation, and saying so is the difference between a
	 * report that is true and one that claims to have kept everything.
	 */
	readonly truncatedFrames?: boolean;
	/**
	 * True when the source carried transparency that could not be applied.
	 *
	 * Only a HEIC does this today: it stores its alpha as a separate auxiliary
	 * image, and one that is malformed or a different size from the picture is
	 * let go of rather than being allowed to refuse the photograph. The result
	 * is a complete picture with no holes in it, which is worth saying out loud
	 * because it looks like a working conversion.
	 */
	readonly droppedAlpha?: boolean;
	/**
	 * What the source file was carrying, when it carried anything.
	 *
	 * Present so an interface can say what it removed rather than only that it
	 * removed something. "The location this was taken and the time" lands
	 * differently from "metadata".
	 */
	readonly metadata?: import('./metadata/exif.js').ExifSummary;
	/**
	 * What happened to that metadata.
	 *
	 * Absent when the source carried none. `kept` means the output format can
	 * hold EXIF, the caller asked for it, and it was written. `stripped` means
	 * it is gone, which is the default and is what somebody converting a
	 * photograph to put on the internet usually wants. There is no third value
	 * for "asked for but the format cannot hold it", because from the reader's
	 * point of view that is the same as stripped and the format is on the row
	 * beside it.
	 */
	readonly metadataKept?: 'kept' | 'stripped';
	/**
	 * What happened to the source's HDR gain map.
	 *
	 * Absent when there was none. `kept` means the output carries the same
	 * parameters the source did and will display as HDR wherever the source
	 * would have. `dropped` means the output is the SDR base picture, which is
	 * a complete photograph rather than a broken one, but not the bright one.
	 */
	readonly gainMap?: 'kept' | 'dropped';
	/**
	 * True when unbounded light was reduced to eight bits to write this file.
	 *
	 * Set for Radiance and OpenEXR sources going anywhere that is not Radiance
	 * or OpenEXR. `exposureStops` says what exposure the reduction used.
	 */
	readonly toneMapped?: boolean;
	/** The exposure tone mapping applied, in stops. Only set when it ran. */
	readonly exposureStops?: number;
	/** True when the output carries more range than eight bits a channel. */
	readonly highDynamicRange?: boolean;
	readonly sourceBytes: number;
	readonly outputBytes: number;
	readonly decodeMs: number;
	readonly encodeMs: number;
}

export interface ConvertResult {
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly extension: string;
	readonly report: ConvertReport;
}
