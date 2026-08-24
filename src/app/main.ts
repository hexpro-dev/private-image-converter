/**
 * The offline application.
 *
 * The flagship deliverable, not a demo. It is what makes the privacy claim
 * checkable rather than something a reader has to believe: one file, no
 * requests, runs from a disc with the network off.
 *
 * Vanilla DOM on purpose. A framework here would be several times the size of
 * everything it renders, and this file is downloaded by people who intend to
 * read it.
 */

import { convert } from '../convert.js';
import { detectCapabilities } from '../detect/capabilities.js';
import { FORMATS, isDisplayable } from '../formats.js';
import { isConverterError } from '../errors.js';
import { downloadBlob, outputName } from '../dom/download.js';
import type { ConvertResult, FormatId } from '../types.js';

declare const __VERSION__: string;

const $ = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`missing element: ${id}`);
	return element as T;
};

const drop = $<HTMLDivElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const target = $<HTMLSelectElement>('target');
const quality = $<HTMLInputElement>('quality');
const qualityValue = $<HTMLSpanElement>('quality-value');
const qualityField = $<HTMLDivElement>('quality-field');
const keepMetadata = $<HTMLInputElement>('keep-metadata');
const notice = $<HTMLDivElement>('notice');
const results = $<HTMLElement>('results');

function say(text: string, kind: 'info' | 'error' = 'info'): void {
	notice.textContent = text;
	notice.dataset.kind = kind;
	notice.hidden = false;
}

function clearNotice(): void {
	notice.hidden = true;
	notice.textContent = '';
}

function updateQualityVisibility(): void {
	const format = target.value as FormatId;
	qualityField.style.display = FORMATS[format].lossy ? '' : 'none';
	qualityValue.textContent = quality.value;
}

/**
 * Describe what happened, in one line.
 *
 * The decode path is named rather than hidden. Somebody whose browser fell
 * back to a software decoder is entitled to know that is why it took a moment,
 * and somebody whose browser used the hardware should be able to see that too.
 */
function describe(result: ConvertResult): string {
	const { report } = result;
	const size = (n: number): string =>
		n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
	const parts = [
		`${FORMATS[report.from].label} to ${FORMATS[report.to].label}`,
		`${report.width} by ${report.height}`,
		`${size(report.sourceBytes)} to ${size(report.outputBytes)}`,
		`${Math.round(report.decodeMs + report.encodeMs)} ms`,
	];
	if (report.tiles && report.tiles > 1) parts.push(`${report.tiles} tiles`);
	if (report.frames) parts.push(`${report.frames} frames`);
	if (report.colourSpace === 'display-p3') parts.push('Display P3 kept');
	return parts.join(', ');
}

function metadataLine(result: ConvertResult): string | undefined {
	const meta = result.report.metadata;
	if (!meta) return undefined;
	if (keepMetadata.checked) return 'Camera metadata kept.';
	const removed: string[] = [];
	if (meta.hasLocation) removed.push('where it was taken');
	if (meta.capturedAt) removed.push('when it was taken');
	if (meta.cameraModel) removed.push(meta.cameraModel);
	if (removed.length === 0) return `Removed ${meta.tagCount} metadata tags.`;
	return `Removed ${removed.join(', ')}.`;
}

function render(result: ConvertResult, filename: string, blob: Blob): void {
	const card = document.createElement('article');
	card.className = 'result';

	// The preview is the converted file itself, so what is shown is what will be
	// saved rather than a re-render of the source. Where the browser cannot
	// render the format, the slot carries its name instead: a broken image icon
	// beside a successful conversion reads as a failure.
	let thumb: HTMLElement;
	if (isDisplayable(result.report.to)) {
		const image = document.createElement('img');
		image.className = 'result__thumb';
		image.alt = '';
		const preview = URL.createObjectURL(blob);
		image.src = preview;
		// Not revoked on a timer: the thumbnail stays on screen for as long as
		// the page is open, and revoking under a live img blanks it in Safari.
		image.addEventListener('error', () => URL.revokeObjectURL(preview), { once: true });
		thumb = image;
	} else {
		const slot = document.createElement('span');
		slot.className = 'result__thumb result__thumb--label';
		slot.textContent = FORMATS[result.report.to].label;
		slot.setAttribute('aria-hidden', 'true');
		thumb = slot;
	}

	const body = document.createElement('div');
	body.className = 'result__body';

	const name = document.createElement('p');
	name.className = 'result__name';
	name.textContent = filename;

	const meta = document.createElement('p');
	meta.className = 'result__meta';
	meta.textContent = describe(result);

	body.append(name, meta);

	const stripped = metadataLine(result);
	if (stripped) {
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent = stripped;
		body.append(line);
	}

	if (result.report.droppedGainMap) {
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent = 'This was an HDR photograph. The result is the standard range version.';
		body.append(line);
	}

	if (result.report.droppedFrames) {
		// Said out loud, because a moving picture that comes back still is the
		// one result somebody is most likely to think went wrong.
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent = `This was an animation. ${FORMATS[result.report.to].label} holds one picture, so this is the first frame. GIF and APNG keep all of them.`;
		body.append(line);
	}

	if (result.report.decodePath === 'plugin') {
		const badge = document.createElement('span');
		badge.className = 'badge';
		badge.textContent = 'Software decoder, slower';
		body.append(badge);
	}

	const save = document.createElement('button');
	save.className = 'button button--primary';
	save.type = 'button';
	save.textContent = 'Save';
	save.addEventListener('click', () => {
		try {
			downloadBlob(blob, filename);
		} catch {
			say(
				'This browser refused the save. You can right click the preview and save it instead.',
				'error',
			);
		}
	});

	card.append(thumb, body, save);
	results.prepend(card);
}

let running = false;

async function take(files: readonly File[]): Promise<void> {
	if (files.length === 0 || running) return;
	running = true;
	clearNotice();
	say(files.length === 1 ? 'Converting.' : `Converting ${files.length} images.`);

	const to = target.value as FormatId;
	for (const file of files) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const result = await convert(bytes, {
				to,
				quality: FORMATS[to].lossy ? Number(quality.value) : undefined,
				metadata: keepMetadata.checked ? 'preserve' : 'strip',
			});
			const blob = new Blob([result.bytes as BlobPart], { type: result.mime });
			render(result, outputName(file.name, result.extension), blob);
			clearNotice();
		} catch (error) {
			// A converter error carries a sentence written to be read. Anything
			// else is a bug here and says so rather than pretending otherwise.
			say(
				isConverterError(error) ? error.message : 'Something went wrong converting that file.',
				'error',
			);
		}
	}
	running = false;
}

drop.addEventListener('dragover', (event) => {
	event.preventDefault();
	drop.dataset.dragging = 'true';
});
drop.addEventListener('dragleave', () => {
	drop.dataset.dragging = 'false';
});
drop.addEventListener('drop', (event) => {
	event.preventDefault();
	drop.dataset.dragging = 'false';
	void take(Array.from(event.dataTransfer?.files ?? []));
});
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		fileInput.click();
	}
});

fileInput.addEventListener('change', () => {
	void take(Array.from(fileInput.files ?? []));
	// Cleared so choosing the same file twice fires again, which matters when
	// the first attempt failed.
	fileInput.value = '';
});

document.addEventListener('paste', (event) => {
	const items = event.clipboardData?.items;
	if (!items) return;
	const files: File[] = [];
	for (const item of items) {
		if (item.kind !== 'file') continue;
		const file = item.getAsFile();
		if (file) files.push(file);
	}
	void take(files);
});

target.addEventListener('change', updateQualityVisibility);
quality.addEventListener('input', () => {
	qualityValue.textContent = quality.value;
});
updateQualityVisibility();

const version = document.getElementById('version');
if (version) version.textContent = `Version ${__VERSION__}.`;

void (async () => {
	const capabilities = await detectCapabilities();
	const heic = document.getElementById('fact-heic');
	if (heic) {
		heic.textContent = capabilities.nativeDecode.has('image/heic')
			? 'Read directly by this browser.'
			: capabilities.hevcVideoDecoder
				? 'Read here, using the hardware video decoder in this machine.'
				: 'Not available in this browser. Safari reads HEIC directly, and Chrome and Edge read it on a machine with hardware video decoding.';
	}
	const colour = document.getElementById('fact-colour');
	if (colour) {
		colour.textContent = capabilities.displayP3Canvas
			? 'Wide gamut images keep their colour. Display P3 is preserved and tagged.'
			: 'This browser works in sRGB, so wide gamut images are converted to it.';
	}
	const formats = new Set<string>();
	for (const mime of capabilities.canvasEncode) formats.add(mime);
	const network = document.getElementById('fact-network');
	if (network && formats.size === 0 && !capabilities.compressionStream) {
		network.textContent = 'None. This browser is too old to run the converter, though.';
	}
})();
