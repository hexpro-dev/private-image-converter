/**
 * An X PixMap writer, version 3.
 *
 * The output is C that compiles: the XPM marker comment, a `static char *`
 * array of string literals, and a trailing semicolon. That is the point of the
 * format rather than a nicety, and it is why the character alphabet below
 * leaves out the quote and the backslash. A pixel drawn as a quote would end
 * the string it sits in and turn the rest of the picture into a syntax error in
 * somebody else's build.
 *
 * XPM is an indexed format, so the work is quantisation, which lives in
 * `raster/quantise.ts` and is shared with every other palettised writer here.
 * An image that already has few enough colours keeps all of them exactly; only a
 * photograph is approximated.
 */

import { EncodeFailedError } from '../../errors.js';
import { quantise } from '../../raster/quantise.js';
import type { EncodeOptions, RasterImage } from '../../types.js';

const ENCODER_ID = 'xpm-pure';

/** What the palette can hold at one character a pixel. See `ALPHABET`. */
const MAX_COLOURS = 256;

/**
 * The characters a pixel may be spelled with.
 *
 * Printable ASCII without the quote and the backslash, which cannot appear
 * unescaped inside a C string, and without the space, which is legal but makes
 * a pixel row impossible to read in a diff and trips writers that trim their
 * lines. Ninety-two characters, so a palette of up to ninety-two colours fits at
 * one character a pixel and everything up to 256 fits in two.
 */
const ALPHABET = (() => {
	let out = '';
	for (let code = 0x21; code <= 0x7e; code += 1) {
		const character = String.fromCharCode(code);
		if (character === '"' || character === '\\') continue;
		out += character;
	}
	return out;
})();

const HEX = '0123456789abcdef';

export interface XpmEncodeOptions extends EncodeOptions {
	/**
	 * The C identifier the file declares.
	 *
	 * An XPM is included into a program, so the name is part of the interface
	 * rather than decoration: two pixmaps included together and both called
	 * `image` will not compile. Anything C cannot use in an identifier is
	 * replaced with an underscore, so a caller can pass a title straight
	 * through.
	 */
	readonly name?: string;
}

function fail(detail: string): never {
	throw new EncodeFailedError('xpm', ENCODER_ID, detail);
}

/**
 * Turn anything into something C will accept as an identifier.
 *
 * A leading digit is worth handling rather than refusing: `2019_logo` is an
 * ordinary thing to call a picture, and an underscore in front of it costs
 * nothing.
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

/** The `n`th key of `charsPerPixel` characters, counting in base ALPHABET.length. */
function keyOf(index: number, charsPerPixel: number): string {
	let key = '';
	let left = index;
	for (let i = 0; i < charsPerPixel; i += 1) {
		key = (ALPHABET[left % ALPHABET.length] as string) + key;
		left = Math.floor(left / ALPHABET.length);
	}
	return key;
}

function hexOf(value: number): string {
	return `${HEX[value >> 4] as string}${HEX[value & 0x0f] as string}`;
}

export function encodeXpm(image: RasterImage, options: XpmEncodeOptions = {}): Uint8Array {
	const { width, height } = image;

	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		fail('the image has no pixels to write.');
	}
	if (image.data.length < width * height * 4) {
		fail('the pixel buffer is shorter than the width and height say it should be.');
	}

	const name = identifierOf(options.name);
	const maxColours = Math.max(2, Math.min(MAX_COLOURS, options.palette ?? MAX_COLOURS));
	const indexed = quantise(image, { maxColours });
	const { indices, palette } = indexed;
	const entries = palette.colours.length / 4;
	const charsPerPixel = entries <= ALPHABET.length ? 1 : 2;

	const lines: string[] = [
		'/* XPM */',
		`static char * ${name}[] = {`,
		'/* columns rows colours characters-per-pixel */',
		`"${width} ${height} ${entries} ${charsPerPixel}",`,
		'/* colours */',
	];

	const keys: string[] = [];
	for (let i = 0; i < entries; i += 1) {
		const key = keyOf(i, charsPerPixel);
		keys.push(key);
		const at = i * 4;
		// The transparent entry is written as the keyword rather than as a
		// colour, because the format has no alpha channel: a quantised image's
		// transparent slot is fully transparent or it is not in the table.
		const colour =
			i === palette.transparentIndex
				? 'None'
				: `#${hexOf(palette.colours[at] as number)}${hexOf(palette.colours[at + 1] as number)}${hexOf(palette.colours[at + 2] as number)}`;
		lines.push(`"${key} c ${colour}",`);
	}

	lines.push('/* pixels */');
	for (let y = 0; y < height; y += 1) {
		let row = '';
		for (let x = 0; x < width; x += 1) {
			row += keys[indices[y * width + x] as number] as string;
		}
		// Every row but the last is followed by a comma. The array is an
		// initialiser, so a comma after the final string would also compile, but
		// libXpm's own writer leaves it off and a diff against one of its files
		// is easier to read when this one does too.
		lines.push(y === height - 1 ? `"${row}"` : `"${row}",`);
	}
	lines.push('};');

	const text = `${lines.join('\n')}\n`;
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
	return out;
}
