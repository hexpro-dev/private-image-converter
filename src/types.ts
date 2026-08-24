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
	| 'jpeg'
	| 'webp'
	| 'avif'
	| 'gif'
	| 'bmp'
	| 'ico'
	| 'tiff'
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

/** How an encode was performed. */
export type EncodePath = 'pure' | 'canvas' | 'plugin';

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
	/** True when the container carried an HDR gain map this decoder discarded. */
	readonly droppedGainMap?: boolean;
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
}

export interface EncodeOptions {
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
	available(capabilities: Capabilities): Promise<boolean>;
	encode(image: RasterImage, options: EncodeOptions, context: EncodeContext): Promise<Uint8Array>;
}

/* ── Conversion ───────────────────────────────────────────────────────── */

export interface ConvertOptions extends EncodeOptions {
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
	readonly maxPixels?: number;
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
	readonly colourSpace: ColourSpace;
	readonly orientation: Orientation;
	readonly tiles?: number;
	/**
	 * What the source file was carrying, when it carried anything.
	 *
	 * Present so an interface can say what it removed rather than only that it
	 * removed something. "The location this was taken and the time" lands
	 * differently from "metadata".
	 */
	readonly metadata?: import('./metadata/exif.js').ExifSummary;
	/** True when an HDR gain map was present and discarded. */
	readonly droppedGainMap?: boolean;
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
