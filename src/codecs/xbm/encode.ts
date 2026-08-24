/**
 * An X BitMap writer.
 *
 * The output is the C that X11's own `bitmap` editor emits: two `#define` lines,
 * a `static unsigned char` array, twelve bytes to a line, lowercase hexadecimal.
 * That shape matters more than it sounds, because the usual thing to do with an
 * XBM is paste it into a source file, and a diff against a file some other tool
 * wrote is a great deal easier to read when the two agree on the layout.
 *
 * Everything about the picture that is not a single bit is thrown away here.
 * There is one plane, one bit a pixel, and no room in the format for a palette,
 * a grey level or an alpha channel, so the encoder's only real decision is where
 * to put the line between set and clear.
 */

import { EncodeFailedError } from '../../errors.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'xbm-pure';

/** What X11's tools emit, and what a diff against one of their files expects. */
const VALUES_PER_LINE = 12;

const HEX = '0123456789abcdef';

export interface XbmEncodeOptions extends EncodeOptions {
	/**
	 * The C identifier the file declares.
	 *
	 * An XBM is included into a program, so the name is part of the interface
	 * rather than decoration: two bitmaps included together and both called
	 * `image` will not compile. Anything C cannot use as an identifier is
	 * replaced with an underscore, so a caller can pass a title through without
	 * having to sanitise it first.
	 */
	readonly name?: string;
}

function fail(detail: string): never {
	throw new EncodeFailedError('xbm', ENCODER_ID, detail);
}

/**
 * Turn anything into something C will accept as an identifier.
 *
 * A leading digit is the case worth handling rather than refusing: `2019_logo`
 * is a perfectly ordinary thing to call a picture and an underscore in front of
 * it costs nothing.
 */
function identifierOf(name: string | undefined): string {
	if (name === undefined) return 'image';
	let out = '';
	for (const character of name) {
		out += /[A-Za-z0-9_]/.test(character) ? character : '_';
	}
	if (out.length === 0) return 'image';
	return /^[0-9]/.test(out) ? `_${out}` : out;
}

/**
 * Rec. 601 luminance, on the sRGB bytes as they are stored.
 *
 * Not converted to linear light first, deliberately. The threshold this feeds
 * is the one every bitmap tool from X11 onwards has used, and matching them
 * matters more here than being photometrically right: a stipple pattern that
 * comes out of this encoder has to look like the stipple somebody else's tool
 * produced from the same picture, or half the pixels move.
 */
function luminance(r: number, g: number, b: number): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function encodeXbm(image: RasterImage, options: XbmEncodeOptions = {}): Uint8Array {
	const { width, height, data } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the image has no pixels to write.');
	}
	if (data.length < width * height * 4) {
		fail('the pixel buffer is shorter than the width and height say it should be.');
	}

	const name = identifierOf(options.name);
	const bytesPerRow = Math.ceil(width / 8);
	const total = bytesPerRow * height;

	let text = `#define ${name}_width ${width}\n#define ${name}_height ${height}\n`;
	text += `static unsigned char ${name}_bits[] = {\n`;

	const values: string[] = [];
	for (let i = 0; i < total; i += 1) {
		const y = Math.floor(i / bytesPerRow);
		const firstX = (i % bytesPerRow) * 8;
		let unit = 0;
		for (let bit = 0; bit < 8; bit += 1) {
			const x = firstX + bit;
			// The last byte of a row runs past the right hand edge whenever the
			// width is not a multiple of eight. Those bits are padding and are
			// left clear, which is what makes a nine pixel wide bitmap two bytes
			// a row rather than an error.
			if (x >= width) break;
			const at = (y * width + x) * 4;
			// A translucent pixel is not ink. Without the alpha test every
			// transparent pixel of a logo, which is usually stored as black with
			// nothing behind it, would come out as foreground and the picture
			// would arrive as a solid rectangle with a hole in the shape of the
			// thing somebody wanted.
			if ((data[at + 3] as number) < 128) continue;
			const dark =
				luminance(data[at] as number, data[at + 1] as number, data[at + 2] as number) < 128;
			// Least significant bit first, which is the order the format packs a
			// row in and the opposite of every other bit-packed format here.
			if (dark) unit |= 1 << bit;
		}
		values.push(`0x${HEX[unit >> 4] as string}${HEX[unit & 0x0f] as string}`);
	}

	for (let i = 0; i < values.length; i += VALUES_PER_LINE) {
		const line = values.slice(i, i + VALUES_PER_LINE).join(', ');
		const last = i + VALUES_PER_LINE >= values.length;
		text += `   ${line}${last ? ' };' : ','}\n`;
	}

	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
	return out;
}
