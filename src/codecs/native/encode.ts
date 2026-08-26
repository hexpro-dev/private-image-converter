/**
 * Encode with the browser's own image pipeline.
 *
 * The only way to write JPEG and WebP without carrying an encoder, so it is
 * how those two are produced.
 *
 * The trap here is worth stating plainly, because it silently ships broken
 * files: a canvas asked for a type it does not support does not throw and does
 * not return null. It returns a PNG. Safari has never supported WebP output
 * and does exactly this, so somebody clicks "convert to WebP", gets
 * `photo.webp`, and it is a PNG that half the things they hand it to will
 * reject. Every encode here therefore checks what actually came back.
 */

import { EncodeFailedError } from '../../errors.js';
import type { EncodeOptions, FormatId, RasterImage } from '../../types.js';
import { rasterToCanvas, toBlob } from '../../raster/canvas.js';
import { flatten } from '../../raster/image.js';

const MAGIC: Partial<Record<FormatId, readonly number[]>> = {
	png: [0x89, 0x50, 0x4e, 0x47],
	jpeg: [0xff, 0xd8, 0xff],
	webp: [0x52, 0x49, 0x46, 0x46],
	avif: [],
};

function looksLike(bytes: Uint8Array, format: FormatId): boolean {
	if (format === 'avif') {
		// AVIF has its brand after the box header rather than a fixed prefix.
		let brand = '';
		for (let i = 8; i < 12; i += 1) brand += String.fromCharCode(bytes[i] ?? 0);
		return brand === 'avif';
	}
	if (format === 'webp') {
		let tag = '';
		for (let i = 8; i < 12; i += 1) tag += String.fromCharCode(bytes[i] ?? 0);
		if (tag !== 'WEBP') return false;
	}
	const signature = MAGIC[format];
	if (!signature) return false;
	for (let i = 0; i < signature.length; i += 1) {
		if (bytes[i] !== signature[i]) return false;
	}
	return true;
}

export async function encodeNative(
	image: RasterImage,
	format: FormatId,
	mime: string,
	options: EncodeOptions = {},
): Promise<Uint8Array> {
	// No size check here. `rasterToCanvas` probes the surface it actually needs
	// and throws `SurfaceTooLargeError`, which is a decline the ladder walks
	// past rather than a refusal that ends the conversion.

	// JPEG has no alpha channel. Compositing first is better than letting the
	// encoder do it, because the encoder composites onto black without saying
	// so and a transparent logo comes out as a black rectangle.
	const source = format === 'jpeg' ? flatten(image, options.background) : image;

	const canvas = rasterToCanvas(source);
	const blob = await toBlob(canvas, mime, options.quality);
	if (!blob) {
		throw new EncodeFailedError(format, 'native', 'the browser produced nothing');
	}
	const bytes = new Uint8Array(await blob.arrayBuffer());

	if (!looksLike(bytes, format)) {
		throw new EncodeFailedError(
			format,
			'native',
			'this browser does not support that output format and quietly returned a different one instead',
		);
	}
	return bytes;
}
