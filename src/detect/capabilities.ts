/**
 * What this browser can actually do, measured once.
 *
 * Nothing here reads the user agent. The cases that matter are invisible from
 * it: a Chromium build on a machine with no HEVC decode hardware reports the
 * same string as one that has it, and Safari's canvas quietly hands back a PNG
 * when asked for a WebP rather than refusing. Both are only knowable by trying.
 */

import type { Capabilities } from '../types.js';
import { PROBE_AVIF, PROBE_HEIC, PROBE_WEBP, fromBase64 } from './probes.js';
import { sniffFormat } from './sniff.js';

/**
 * A HEVC configuration representative of what an iPhone writes.
 *
 * Main Still Picture, level 3.0, which is what every tiled HEIC on a phone
 * uses because each tile is only 512 by 512. Probing with the still picture
 * profile matters on Windows, where Chromium only gained it in a later
 * release than the rest of HEVC.
 */
const HEVC_PROBE_CODECS = ['hvc1.3.E.L90.B0', 'hvc1.1.6.L93.B0'] as const;

async function canDecodeNatively(bytes: Uint8Array, mime: string): Promise<boolean> {
	if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') return false;
	try {
		const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
		const worked = bitmap.width > 0 && bitmap.height > 0;
		bitmap.close();
		return worked;
	} catch {
		return false;
	}
}

/**
 * Whether a canvas will really write this type.
 *
 * A canvas asked for a type it does not support does not throw and does not
 * return null. It returns a PNG, with `type` set to `image/png`, and a caller
 * that trusts the request writes a file called `photo.webp` containing a PNG.
 * Safari does this for WebP on every version shipped so far, so the output is
 * sniffed rather than believed.
 */
async function canvasWrites(mime: string): Promise<boolean> {
	try {
		const canvas = makeCanvas(1, 1);
		if (!canvas) return false;
		const context = canvas.getContext('2d');
		if (!context) return false;
		context.fillStyle = '#808080';
		context.fillRect(0, 0, 1, 1);
		const blob = await toBlob(canvas, mime);
		if (!blob) return false;
		if (blob.type !== mime) return false;
		const head = new Uint8Array(await blob.arrayBuffer());
		const sniffed = sniffFormat(head);
		return sniffed !== undefined && mimeMatchesFormat(mime, sniffed);
	} catch {
		return false;
	}
}

function mimeMatchesFormat(mime: string, sniffed: string): boolean {
	if (mime === 'image/png') return sniffed === 'png';
	if (mime === 'image/jpeg') return sniffed === 'jpeg';
	if (mime === 'image/webp') return sniffed === 'webp';
	if (mime === 'image/avif') return sniffed === 'avif';
	return false;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(width: number, height: number): AnyCanvas | undefined {
	if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
	return undefined;
}

function toBlob(canvas: AnyCanvas, mime: string, quality?: number): Promise<Blob | null> {
	if ('convertToBlob' in canvas) {
		return canvas.convertToBlob({ type: mime, quality }).catch(() => null);
	}
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), mime, quality);
	});
}

async function hasHevcVideoDecoder(): Promise<boolean> {
	const decoder = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
	if (typeof decoder?.isConfigSupported !== 'function') return false;
	for (const codec of HEVC_PROBE_CODECS) {
		try {
			// Older Chromium threw here instead of resolving false, which is
			// why this is inside the loop's try rather than around it.
			const support = await decoder.isConfigSupported({ codec, codedWidth: 512, codedHeight: 512 });
			if (support.supported === true) return true;
		} catch {
			continue;
		}
	}
	return false;
}

function hasDisplayP3Canvas(): boolean {
	try {
		const canvas = makeCanvas(1, 1);
		if (!canvas) return false;
		// `getContextAttributes` is declared on the HTML context but not on the
		// offscreen one, though both implement it, so the shape is stated here
		// rather than asserted onto a union that does not have it.
		const context = canvas.getContext('2d', { colorSpace: 'display-p3' }) as {
			getContextAttributes?: () => { colorSpace?: string };
		} | null;
		if (!context) return false;
		// A browser that does not understand the option ignores it silently, so
		// the answer has to come back off the context rather than from the call
		// having not thrown.
		return context.getContextAttributes?.().colorSpace === 'display-p3';
	} catch {
		return false;
	}
}

let cached: Promise<Capabilities> | undefined;

/**
 * Probe this environment.
 *
 * Memoised, because the answers cannot change within a page and the probes
 * decode four images and encode four more. Call `resetCapabilities` in a test
 * that changes the environment underneath it.
 */
export function detectCapabilities(): Promise<Capabilities> {
	cached ??= probe();
	return cached;
}

export function resetCapabilities(): void {
	cached = undefined;
}

async function probe(): Promise<Capabilities> {
	const nativeDecode = new Set<string>();
	const canvasEncode = new Set<string>();

	// PNG, JPEG and GIF are decodable everywhere a canvas exists, but they are
	// still probed rather than assumed: this same code runs under Node in the
	// test suite, where none of it exists, and an assumption would make the
	// capability set a lie there.
	const decodeProbes: [string, Uint8Array][] = [
		['image/heic', fromBase64(PROBE_HEIC)],
		['image/avif', fromBase64(PROBE_AVIF)],
		['image/webp', fromBase64(PROBE_WEBP)],
	];
	for (const [mime, bytes] of decodeProbes) {
		if (await canDecodeNatively(bytes, mime)) nativeDecode.add(mime);
	}
	if (typeof createImageBitmap === 'function') {
		for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/bmp']) {
			nativeDecode.add(mime);
		}
	}

	for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) {
		if (await canvasWrites(mime)) canvasEncode.add(mime);
	}

	return {
		nativeDecode,
		canvasEncode,
		hevcVideoDecoder: await hasHevcVideoDecoder(),
		displayP3Canvas: hasDisplayP3Canvas(),
		compressionStream: typeof CompressionStream === 'function',
		offscreenCanvas: typeof OffscreenCanvas === 'function',
		imageDecoder: typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function',
	};
}

/**
 * A capability set with nothing available.
 *
 * The starting point for a test, and what a host can pass when it wants to
 * know what a pure path alone would manage.
 */
export function emptyCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
	return {
		nativeDecode: new Set(),
		canvasEncode: new Set(),
		hevcVideoDecoder: false,
		displayP3Canvas: false,
		compressionStream: false,
		offscreenCanvas: false,
		imageDecoder: false,
		...overrides,
	};
}

export { makeCanvas, toBlob };
