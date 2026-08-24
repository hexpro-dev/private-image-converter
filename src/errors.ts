/**
 * The error taxonomy.
 *
 * One base class carrying a code from a closed union, one subclass per failure
 * with the structured fields a caller needs to react, and a message written to
 * be shown to a person as it is. The website maps `code` to a translated
 * sentence and never prints `message`; the offline app prints `message`
 * directly, because it has no translation layer. Both have to be true at once,
 * so the messages are written in the same plain register as the site copy.
 *
 * No message ever interpolates a file name. Somebody's photograph is called
 * `IMG_2059.HEIC`, but it is just as often called something they would not
 * want on screen, and an error message is the one string that gets screenshot
 * and pasted into a bug report.
 */

import { FORMATS, FORMAT_IDS } from './formats.js';
import type { DecodePath, FormatId } from './types.js';

export type ConverterErrorCode =
	| 'input/empty'
	| 'input/unknown-format'
	| 'input/too-large'
	| 'decode/unsupported-here'
	| 'decode/failed'
	| 'encode/unsupported'
	| 'encode/failed'
	| 'heif/malformed'
	| 'heif/unsupported-feature'
	| 'codec/unavailable'
	| 'cancelled';

export class ConverterError extends Error {
	readonly code: ConverterErrorCode;

	constructor(code: ConverterErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		// Set from the constructed class rather than repeated in each subclass.
		this.name = new.target.name;
	}
}

export function isConverterError(value: unknown): value is ConverterError {
	return value instanceof ConverterError;
}

/* ── Input ────────────────────────────────────────────────────────────── */

export class EmptyInputError extends ConverterError {
	constructor() {
		super('input/empty', 'That file is empty.');
	}
}

/**
 * The list of formats in the message, built from the table rather than typed.
 *
 * Every format this package names can be read; the read-only ones are read
 * only because there is no honest way to write them. So the readable list is
 * the whole table, and building it here means the sentence cannot fall behind
 * the code, which is exactly what a hand-written list of twenty-six names
 * would do on the first Tuesday somebody added a twenty-seventh.
 */
function readableList(): string {
	const labels = FORMAT_IDS.map((id) => FORMATS[id].label);
	const last = labels[labels.length - 1];
	return `${labels.slice(0, -1).join(', ')} and ${last}`;
}

export class UnknownFormatError extends ConverterError {
	/** The first bytes, for a caller that wants to report them. Never in the message. */
	readonly head: Uint8Array;

	constructor(head: Uint8Array) {
		super(
			'input/unknown-format',
			`That does not look like an image this tool recognises. It reads ${readableList()}.`,
		);
		this.head = head;
	}
}

export class ImageTooLargeError extends ConverterError {
	readonly pixels: number;
	readonly maxPixels: number;

	constructor(pixels: number, maxPixels: number) {
		const mp = (n: number) => (n / 1_000_000).toFixed(0);
		super(
			'input/too-large',
			`That image is about ${mp(pixels)} megapixels, and this tool stops at ${mp(maxPixels)}. Converting it would most likely run the tab out of memory before it finished.`,
		);
		this.pixels = pixels;
		this.maxPixels = maxPixels;
	}
}

/* ── Decode ───────────────────────────────────────────────────────────── */

/**
 * The format was recognised, but nothing available in this browser can read it.
 *
 * This is the error behind the HEIC support gap, and it is the one that most
 * needs to say something useful. `tried` records which rungs of the ladder were
 * considered, so the message can distinguish "your browser has no HEVC
 * hardware" from "this build has no fallback decoder loaded".
 */
export class UnsupportedHereError extends ConverterError {
	readonly format: FormatId;
	readonly tried: readonly DecodePath[];

	constructor(format: FormatId, tried: readonly DecodePath[], message?: string) {
		super(
			'decode/unsupported-here',
			message ??
				`This browser cannot read ${format.toUpperCase()} images, and no fallback decoder is loaded.`,
		);
		this.format = format;
		this.tried = tried;
	}
}

export class DecodeFailedError extends ConverterError {
	readonly format: FormatId;
	readonly decoderId: string;

	constructor(format: FormatId, decoderId: string, detail: string, options?: ErrorOptions) {
		super(
			'decode/failed',
			`That ${format.toUpperCase()} file could not be read: ${detail}`,
			options,
		);
		this.format = format;
		this.decoderId = decoderId;
	}
}

/* ── Encode ───────────────────────────────────────────────────────────── */

export class EncodeUnsupportedError extends ConverterError {
	readonly format: FormatId;

	constructor(format: FormatId, message?: string) {
		super(
			'encode/unsupported',
			message ?? `This browser cannot write ${format.toUpperCase()} images.`,
		);
		this.format = format;
	}
}

export class EncodeFailedError extends ConverterError {
	readonly format: FormatId;
	readonly encoderId: string;

	constructor(format: FormatId, encoderId: string, detail: string, options?: ErrorOptions) {
		super('encode/failed', `The ${format.toUpperCase()} could not be written: ${detail}`, options);
		this.format = format;
		this.encoderId = encoderId;
	}
}

/* ── HEIF ─────────────────────────────────────────────────────────────── */

/** Where in the container the parse gave up. Reported, never guessed past. */
export type HeifStage =
	| 'ftyp'
	| 'meta'
	| 'item-info'
	| 'item-location'
	| 'item-properties'
	| 'item-references'
	| 'primary-item'
	| 'grid'
	| 'decoder-config'
	| 'tile-data';

export class HeifMalformedError extends ConverterError {
	readonly stage: HeifStage;
	readonly offset?: number;

	constructor(stage: HeifStage, detail: string, offset?: number) {
		super('heif/malformed', `This HEIC file is damaged or truncated: ${detail}`);
		this.stage = stage;
		this.offset = offset;
	}
}

/**
 * A structure this reader deliberately does not implement.
 *
 * Separate from `HeifMalformedError` because the file is fine and we are not.
 * Listed in the README as a refusal rather than a gap, so that the message can
 * be honest about which it is.
 */
export class HeifUnsupportedFeatureError extends ConverterError {
	readonly feature: string;

	constructor(feature: string, detail: string) {
		super(
			'heif/unsupported-feature',
			`This HEIC file uses ${detail}, which this tool cannot read.`,
		);
		this.feature = feature;
	}
}

/* ── Platform ─────────────────────────────────────────────────────────── */

export class CodecUnavailableError extends ConverterError {
	readonly api: string;

	constructor(api: string, detail: string) {
		super('codec/unavailable', detail);
		this.api = api;
	}
}

export class CancelledError extends ConverterError {
	constructor() {
		super('cancelled', 'That conversion was stopped.');
	}
}
