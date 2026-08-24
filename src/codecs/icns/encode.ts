/**
 * An Apple icon suite (.icns) writer.
 *
 * Modern spellings only. Every entry this writes holds a whole PNG file, which
 * is what `iconutil` produces from an iconset and what macOS has preferred
 * since 10.7. The older forms are readable in `decode.ts` and are not written:
 * the 24 bit run length entries need a separate mask entry beside them and a
 * compressor nobody else would benefit from, and JPEG 2000 needs an encoder
 * this package has no way to carry.
 *
 * Two spellings exist for most sizes and both are written. A 32 pixel square
 * is `icp5` when it is a 32 point icon and `ic11` when it is a 16 point icon
 * drawn at twice the scale, and macOS picks between them by the scale of the
 * display rather than by size. Writing only one of the pair produces a file
 * that looks right in the Finder and blurs on a retina screen, or the reverse.
 */

import { EncodeFailedError } from '../../errors.js';
import { fitSquare } from '../../raster/resize.js';
import type { EncodeOptions, RasterImage } from '../../types.js';
import { encodePng } from '../png/encode.js';

const ENCODER_ID = 'icns-png';

interface Slot {
	readonly type: string;
	readonly side: number;
}

/**
 * The suite, smallest first, with the unscaled spelling before the retina one.
 *
 * `icp6` is deliberately absent. It is the 64 pixel unscaled slot and no
 * version of macOS has ever asked for it: 64 pixels is used as the retina form
 * of 32, which is `ic12`, and Apple's own iconset layout has no 64 point size
 * to fill `icp6` from.
 */
const SLOTS: readonly Slot[] = [
	{ type: 'icp4', side: 16 },
	{ type: 'icp5', side: 32 },
	{ type: 'ic11', side: 32 },
	{ type: 'ic12', side: 64 },
	{ type: 'ic07', side: 128 },
	{ type: 'ic08', side: 256 },
	{ type: 'ic13', side: 256 },
	{ type: 'ic09', side: 512 },
	{ type: 'ic14', side: 512 },
	{ type: 'ic10', side: 1024 },
];

const HEADER_BYTES = 8;
const ENTRY_HEADER_BYTES = 8;

function fail(detail: string): never {
	throw new EncodeFailedError('icns', ENCODER_ID, detail);
}

function writeType(out: Uint8Array, at: number, type: string): void {
	for (let i = 0; i < 4; i += 1) out[at + i] = type.charCodeAt(i);
}

/**
 * Write an icon suite holding `image` at every size it can honestly fill.
 *
 * Sizes larger than the source are left out rather than upscaled. A 64 pixel
 * drawing enlarged to 1024 is four blurred megapixels claiming to be artwork,
 * and macOS shows exactly that claim at full size in Quick Look and in the
 * Finder's preview pane. A source smaller than the smallest slot still gets
 * that one slot, because a suite with no entries in it is not a file anything
 * will open.
 *
 * `options` is passed through to the PNG encoder, so an ICC profile or a
 * colour tag on the source survives into every entry. Quality means nothing
 * here: PNG is lossless, and there is no alpha to composite away because every
 * slot carries it.
 */
export async function encodeIcns(
	image: RasterImage,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	const { width, height, data } = image;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		fail('the image has no width or no height, so there is nothing to write.');
	}
	if (data.length < width * height * 4) {
		fail('the pixel buffer is smaller than the width and height say it should be.');
	}

	// The longest side, not the shortest: a 100 by 40 drawing fits a 64 pixel
	// slot without either axis being stretched, and refusing that size because
	// the short axis is 40 would throw away half the sizes for no gain.
	const longest = Math.max(width, height);
	const wanted = SLOTS.filter((slot) => slot.side <= longest);
	const slots = wanted.length > 0 ? wanted : [SLOTS[0] as Slot];

	// One encode per distinct size rather than one per slot. `icp5` and `ic11`
	// hold the same 32 pixel square, and scaling and deflating it twice would
	// double the work to produce two identical byte strings.
	const pngs = new Map<number, Uint8Array>();
	for (const slot of slots) {
		if (pngs.has(slot.side)) continue;
		pngs.set(slot.side, await encodePng(fitSquare(image, slot.side), options));
	}

	let total = HEADER_BYTES;
	for (const slot of slots) {
		total += ENTRY_HEADER_BYTES + (pngs.get(slot.side) as Uint8Array).length;
	}

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	// Every length in an icon suite is big endian, which is the one thing it
	// kept from the Macintosh resource fork it grew out of.
	writeType(out, 0, 'icns');
	view.setUint32(4, total);

	let at = HEADER_BYTES;
	for (const slot of slots) {
		const png = pngs.get(slot.side) as Uint8Array;
		writeType(out, at, slot.type);
		// The length counts these eight bytes as well as the payload.
		view.setUint32(at + 4, ENTRY_HEADER_BYTES + png.length);
		out.set(png, at + ENTRY_HEADER_BYTES);
		at += ENTRY_HEADER_BYTES + png.length;
	}
	return out;
}
