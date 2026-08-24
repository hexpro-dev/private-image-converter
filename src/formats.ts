/**
 * Static facts about each format, as reviewable data rather than scattered
 * conditionals.
 *
 * `mimes` lists every type string seen in the wild, canonical first, because
 * browsers and operating systems disagree: an iPhone HEIC arrives as
 * `image/heic` from a file picker on macOS and as an empty string from some
 * Android file managers, and a TGA has no registered type at all.
 */

import type { FormatId, FormatInfo } from './types.js';

export const FORMATS: { readonly [K in FormatId]: FormatInfo } = {
	heic: {
		id: 'heic',
		mime: 'image/heic',
		mimes: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
		extension: 'heic',
		extensions: ['heic', 'heif', 'hif'],
		label: 'HEIC',
		alpha: true,
		lossy: true,
		animated: false,
	},
	png: {
		id: 'png',
		mime: 'image/png',
		mimes: ['image/png', 'image/apng'],
		extension: 'png',
		extensions: ['png', 'apng'],
		label: 'PNG',
		alpha: true,
		lossy: false,
		animated: false,
	},
	jpeg: {
		id: 'jpeg',
		mime: 'image/jpeg',
		mimes: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
		extension: 'jpg',
		extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
		label: 'JPEG',
		alpha: false,
		lossy: true,
		animated: false,
	},
	webp: {
		id: 'webp',
		mime: 'image/webp',
		mimes: ['image/webp'],
		extension: 'webp',
		extensions: ['webp'],
		label: 'WebP',
		alpha: true,
		lossy: true,
		animated: true,
	},
	avif: {
		id: 'avif',
		mime: 'image/avif',
		mimes: ['image/avif', 'image/avif-sequence'],
		extension: 'avif',
		extensions: ['avif', 'avifs'],
		label: 'AVIF',
		alpha: true,
		lossy: true,
		animated: true,
	},
	gif: {
		id: 'gif',
		mime: 'image/gif',
		mimes: ['image/gif'],
		extension: 'gif',
		extensions: ['gif'],
		label: 'GIF',
		alpha: true,
		lossy: false,
		animated: true,
	},
	bmp: {
		id: 'bmp',
		mime: 'image/bmp',
		mimes: ['image/bmp', 'image/x-ms-bmp', 'image/x-bmp'],
		extension: 'bmp',
		extensions: ['bmp', 'dib'],
		label: 'BMP',
		alpha: true,
		lossy: false,
		animated: false,
	},
	ico: {
		id: 'ico',
		mime: 'image/x-icon',
		mimes: ['image/x-icon', 'image/vnd.microsoft.icon'],
		extension: 'ico',
		extensions: ['ico', 'cur'],
		label: 'ICO',
		alpha: true,
		lossy: false,
		animated: false,
	},
	tiff: {
		id: 'tiff',
		mime: 'image/tiff',
		mimes: ['image/tiff', 'image/tif'],
		extension: 'tif',
		extensions: ['tif', 'tiff'],
		label: 'TIFF',
		alpha: true,
		lossy: false,
		animated: false,
	},
	qoi: {
		id: 'qoi',
		mime: 'image/qoi',
		mimes: ['image/qoi', 'image/x-qoi'],
		extension: 'qoi',
		extensions: ['qoi'],
		label: 'QOI',
		alpha: true,
		lossy: false,
		animated: false,
	},
	tga: {
		id: 'tga',
		// TGA has no registered media type. This one is conventional rather
		// than official, and nothing native is ever asked to honour it.
		mime: 'image/x-tga',
		mimes: ['image/x-tga', 'image/x-targa', 'image/tga'],
		extension: 'tga',
		extensions: ['tga', 'icb', 'vda', 'vst'],
		label: 'TGA',
		alpha: true,
		lossy: false,
		animated: false,
	},
	pnm: {
		id: 'pnm',
		mime: 'image/x-portable-anymap',
		mimes: [
			'image/x-portable-anymap',
			'image/x-portable-pixmap',
			'image/x-portable-graymap',
			'image/x-portable-bitmap',
		],
		extension: 'ppm',
		extensions: ['pnm', 'ppm', 'pgm', 'pbm'],
		label: 'PNM',
		alpha: false,
		lossy: false,
		animated: false,
	},
	farbfeld: {
		id: 'farbfeld',
		mime: 'image/x-farbfeld',
		mimes: ['image/x-farbfeld'],
		extension: 'ff',
		extensions: ['ff'],
		label: 'farbfeld',
		alpha: true,
		lossy: false,
		animated: false,
	},
	svg: {
		id: 'svg',
		mime: 'image/svg+xml',
		mimes: ['image/svg+xml'],
		extension: 'svg',
		extensions: ['svg'],
		label: 'SVG',
		alpha: true,
		lossy: false,
		animated: false,
	},
};

export const FORMAT_IDS: readonly FormatId[] = Object.keys(FORMATS) as FormatId[];

export function formatInfo(id: FormatId): FormatInfo {
	return FORMATS[id];
}

/**
 * Best-effort format for a MIME type.
 *
 * Only used to label things a browser handed us. Never used to decide how to
 * decode: that comes from the bytes, because a file picker's MIME type is a
 * guess from the extension and the extension is whatever somebody typed.
 */
export function formatForMime(mime: string): FormatId | undefined {
	const wanted = mime.toLowerCase().split(';')[0]?.trim();
	if (!wanted) return undefined;
	for (const id of FORMAT_IDS) {
		if (FORMATS[id].mimes.includes(wanted)) return id;
	}
	return undefined;
}

/** Best-effort format for a file name. Same caveat as `formatForMime`. */
export function formatForExtension(name: string): FormatId | undefined {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return undefined;
	const ext = name.slice(dot + 1).toLowerCase();
	for (const id of FORMAT_IDS) {
		if (FORMATS[id].extensions.includes(ext)) return id;
	}
	return undefined;
}
