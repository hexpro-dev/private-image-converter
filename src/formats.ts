/**
 * Static facts about each format, as reviewable data rather than scattered
 * conditionals.
 *
 * Published on its own subpath, `@hexpro/private-image-converter/formats`, as
 * well as through the root. An interface needs this table to label a picker
 * and to decide whether a result can be previewed, and it needs that long
 * before anybody converts anything. Reaching it through the root barrel drags
 * every codec into the same chunk, which on a page that loads the converter
 * lazily is two hundred kilobytes downloaded for a dropdown. This file imports
 * nothing but the type definitions.
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
		mimes: ['image/png'],
		extension: 'png',
		extensions: ['png'],
		label: 'PNG',
		alpha: true,
		lossy: false,
		animated: false,
	},
	apng: {
		id: 'apng',
		mime: 'image/apng',
		mimes: ['image/apng'],
		extension: 'apng',
		extensions: ['apng'],
		label: 'APNG',
		alpha: true,
		lossy: false,
		animated: true,
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
	jxl: {
		id: 'jxl',
		mime: 'image/jxl',
		mimes: ['image/jxl'],
		extension: 'jxl',
		extensions: ['jxl'],
		label: 'JPEG XL',
		alpha: true,
		lossy: true,
		animated: true,
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
	raw: {
		id: 'raw',
		// Camera raw has no media type of its own worth using. Every vendor
		// invented one, none of them are registered, and a file picker reports
		// an empty string for all of them anyway.
		mime: 'image/x-dcraw',
		mimes: ['image/x-dcraw', 'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-sony-arw'],
		extension: 'dng',
		extensions: [
			'dng',
			'cr2',
			'cr3',
			'nef',
			'nrw',
			'arw',
			'srf',
			'sr2',
			'raf',
			'orf',
			'rw2',
			'pef',
			'srw',
			'raw',
			'3fr',
			'iiq',
			'erf',
			'mos',
			'dcr',
			'kdc',
		],
		label: 'Camera raw',
		alpha: false,
		lossy: true,
		animated: false,
	},
	psd: {
		id: 'psd',
		mime: 'image/vnd.adobe.photoshop',
		mimes: ['image/vnd.adobe.photoshop', 'application/x-photoshop', 'image/psd'],
		extension: 'psd',
		extensions: ['psd', 'psb'],
		label: 'Photoshop',
		alpha: true,
		lossy: false,
		animated: false,
	},
	dds: {
		id: 'dds',
		mime: 'image/vnd-ms.dds',
		mimes: ['image/vnd-ms.dds', 'image/x-dds'],
		extension: 'dds',
		extensions: ['dds'],
		label: 'DDS',
		alpha: true,
		lossy: true,
		animated: false,
	},
	hdr: {
		id: 'hdr',
		mime: 'image/vnd.radiance',
		mimes: ['image/vnd.radiance', 'image/x-hdr'],
		extension: 'hdr',
		extensions: ['hdr', 'pic', 'rgbe'],
		label: 'Radiance HDR',
		alpha: false,
		lossy: false,
		animated: false,
	},
	exr: {
		id: 'exr',
		mime: 'image/x-exr',
		mimes: ['image/x-exr', 'image/aces'],
		extension: 'exr',
		extensions: ['exr'],
		label: 'OpenEXR',
		alpha: true,
		lossy: false,
		animated: false,
	},
	pcx: {
		id: 'pcx',
		mime: 'image/x-pcx',
		mimes: ['image/x-pcx', 'image/vnd.zbrush.pcx'],
		extension: 'pcx',
		extensions: ['pcx', 'pcc'],
		label: 'PCX',
		alpha: false,
		lossy: false,
		animated: false,
	},
	icns: {
		id: 'icns',
		mime: 'image/icns',
		mimes: ['image/icns', 'image/x-icns'],
		extension: 'icns',
		extensions: ['icns'],
		label: 'Apple icon',
		alpha: true,
		lossy: false,
		animated: false,
	},
	ras: {
		id: 'ras',
		mime: 'image/x-cmu-raster',
		mimes: ['image/x-cmu-raster', 'image/x-sun-raster'],
		extension: 'ras',
		extensions: ['ras', 'sun', 'im1', 'im8', 'im24', 'im32'],
		label: 'Sun raster',
		alpha: true,
		lossy: false,
		animated: false,
	},
	xbm: {
		id: 'xbm',
		mime: 'image/x-xbitmap',
		mimes: ['image/x-xbitmap', 'image/x-xbm'],
		extension: 'xbm',
		extensions: ['xbm'],
		label: 'XBM',
		alpha: true,
		lossy: false,
		animated: false,
	},
	xpm: {
		id: 'xpm',
		mime: 'image/x-xpixmap',
		mimes: ['image/x-xpixmap', 'image/x-xpm'],
		extension: 'xpm',
		extensions: ['xpm'],
		label: 'XPM',
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
			'image/x-portable-arbitrarymap',
		],
		extension: 'ppm',
		extensions: ['pnm', 'ppm', 'pgm', 'pbm', 'pam'],
		label: 'PNM',
		// PAM, the seventh member of the family, is the one with an alpha
		// channel, and it is written whenever the picture has one. Saying no
		// here would make the converter flatten every translucent image before
		// handing it to an encoder that could have kept it.
		alpha: true,
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

/**
 * Formats a browser will render in an `img` element.
 *
 * Worth knowing before showing a preview of a conversion. QOI, TGA, PNM,
 * farbfeld, PCX, Sun raster, XBM, XPM, HDR, EXR, DDS, PSD and the Apple icon
 * suite are perfectly good files that no browser can display, so a preview of
 * one is a broken image icon sitting next to a successful conversion, which
 * reads as a failure. AVIF and WebP are here because every current browser
 * decodes them, and a stale one showing a broken thumbnail is a smaller problem
 * than never previewing them at all. JPEG XL is not, because only Safari reads
 * it and a broken thumbnail everywhere else is the likelier outcome.
 */
const DISPLAYABLE = new Set<FormatId>([
	'png',
	'apng',
	'jpeg',
	'webp',
	'avif',
	'gif',
	'bmp',
	'ico',
	'svg',
]);

export function isDisplayable(format: FormatId): boolean {
	return DISPLAYABLE.has(format);
}

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
