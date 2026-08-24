/**
 * Turn an SVG into pixels, using the browser's own renderer.
 *
 * There is no other honest way to do this. An SVG is a document: it has text
 * with font fallback, gradients, filters, clip paths, transforms and a cascade,
 * and a renderer for it is a browser. So the file goes into an `img` element
 * and the browser draws it.
 *
 * That route is also the safe one, which is the reason to prefer it over
 * anything cleverer. An SVG loaded through `img` runs in the browser's own
 * sandbox for the case: script does not execute, external references are not
 * fetched, and the document cannot reach the page around it. An SVG dropped on
 * this tool is a file from a stranger, and the tool's whole claim is that
 * nothing leaves the tab, so a rendering path that could fetch a remote font or
 * a remote image would quietly break the one promise that matters. `img` is
 * the only path where the browser guarantees it does not.
 *
 * Browser only, and so not covered by the Node suite. It is on the manual
 * checklist in RELEASING.md instead.
 */

import { DecodeFailedError } from '../../errors.js';
import type { RasterImage } from '../../types.js';
import {
	canvasCanHold,
	context2d,
	contextColourSpace,
	requireCanvas,
} from '../../raster/canvas.js';

const DECODER_ID = 'svg';

export interface SvgRasteriseOptions {
	/** Multiply the intrinsic size by this. Defaults to 1. */
	readonly scale?: number;
	/** Never produce an image wider or taller than this. Defaults to 4096. */
	readonly maxSide?: number;
}

/**
 * The size an SVG with no width and height gets.
 *
 * CSS says a replaced element with no intrinsic dimensions is 300 by 150, and
 * every browser agrees. Inventing a different default here would make the tool
 * disagree with the browser tab next to it about the same file.
 */
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

/** CSS absolute units, in pixels. Relative units cannot be resolved without a page. */
const UNITS: Readonly<Record<string, number>> = {
	'': 1,
	px: 1,
	pt: 96 / 72,
	pc: 16,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	q: 96 / 101.6,
};

function parseLength(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*([a-z%]*)\s*$/i.exec(value);
	if (!match) return undefined;
	const unit = (match[2] ?? '').toLowerCase();
	// A percentage is a fraction of a containing block that does not exist
	// here, so it is not a size. Falling through to the view box is right.
	const factor = UNITS[unit];
	if (factor === undefined) return undefined;
	const number = Number(match[1]);
	return Number.isFinite(number) && number > 0 ? number * factor : undefined;
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return match?.[2] ?? match?.[3];
}

export interface SvgIntrinsicSize {
	readonly width: number;
	readonly height: number;
	/** True when the size came from the document rather than from the fallback. */
	readonly declared: boolean;
}

/**
 * The size the document asks to be drawn at.
 *
 * Read from the opening tag with a regular expression rather than through
 * `DOMParser`, because this also has to answer for a file that will then be
 * refused, and building a document out of a stranger's markup to ask its width
 * is more machinery and more surface than the question needs.
 */
export function svgIntrinsicSize(source: string): SvgIntrinsicSize {
	const open = /<svg\b[^>]*>/i.exec(source)?.[0];
	if (!open) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, declared: false };

	const width = parseLength(attribute(open, 'width'));
	const height = parseLength(attribute(open, 'height'));
	if (width !== undefined && height !== undefined) return { width, height, declared: true };

	const viewBox = attribute(open, 'viewBox')
		?.trim()
		.split(/[\s,]+/);
	if (viewBox?.length === 4) {
		const boxWidth = Number(viewBox[2]);
		const boxHeight = Number(viewBox[3]);
		if (boxWidth > 0 && boxHeight > 0) {
			// One dimension given and a view box: the other follows from the
			// aspect ratio, which is what a browser does and what somebody who
			// wrote `width="800"` and nothing else expects.
			if (width !== undefined)
				return { width, height: (width * boxHeight) / boxWidth, declared: true };
			if (height !== undefined)
				return { width: (height * boxWidth) / boxHeight, height, declared: true };
			return { width: boxWidth, height: boxHeight, declared: true };
		}
	}
	if (width !== undefined) return { width, height: width, declared: true };
	if (height !== undefined) return { width: height, height, declared: true };
	return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, declared: false };
}

export function svgRasteriseAvailable(): boolean {
	return (
		typeof document !== 'undefined' &&
		typeof Image === 'function' &&
		typeof URL !== 'undefined' &&
		typeof URL.createObjectURL === 'function'
	);
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve(element);
		element.onerror = () => reject(new Error('the browser could not render it'));
		element.src = url;
	});
}

export async function rasteriseSvg(
	bytes: Uint8Array,
	options: SvgRasteriseOptions = {},
): Promise<RasterImage> {
	if (!svgRasteriseAvailable()) {
		throw new DecodeFailedError('svg', DECODER_ID, 'this environment has no renderer for it');
	}

	const source = new TextDecoder().decode(bytes);
	const intrinsic = svgIntrinsicSize(source);
	const maxSide = options.maxSide ?? 4096;
	const requested = Math.max(0.01, options.scale ?? 1);
	// Clamp by the longer side rather than by area, so a wide banner and a tall
	// poster both come out at a usable size instead of one of them collapsing.
	const fit = Math.min(1, maxSide / Math.max(intrinsic.width, intrinsic.height) / requested);
	const scale = requested * fit;
	const width = Math.max(1, Math.round(intrinsic.width * scale));
	const height = Math.max(1, Math.round(intrinsic.height * scale));

	if (!canvasCanHold(width, height)) {
		throw new DecodeFailedError(
			'svg',
			DECODER_ID,
			`it asks to be drawn at ${width} by ${height}, which is larger than this browser can hold in a drawing surface`,
		);
	}

	// The declared type matters: a blob served as anything else is refused by
	// the image element, and a blob with no type is sniffed, which for markup
	// means it is refused as well.
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/svg+xml' }));
	try {
		const element = await loadImage(url).catch((error: unknown) => {
			throw new DecodeFailedError(
				'svg',
				DECODER_ID,
				'the browser could not render it, which usually means the markup is not well formed',
				{ cause: error },
			);
		});
		const canvas = requireCanvas(width, height);
		const context = context2d(canvas, 'srgb');
		context.drawImage(element as unknown as CanvasImageSource, 0, 0, width, height);
		const pixels = context.getImageData(0, 0, width, height);
		let hasAlpha = false;
		for (let i = 3; i < pixels.data.length; i += 4) {
			if (pixels.data[i] !== 255) {
				hasAlpha = true;
				break;
			}
		}
		return {
			data: pixels.data,
			width,
			height,
			colourSpace: contextColourSpace(context),
			hasAlpha,
		};
	} finally {
		// A blob URL keeps its blob alive for as long as the document does.
		// Converting a folder of icons without this leaks every one of them.
		URL.revokeObjectURL(url);
	}
}
