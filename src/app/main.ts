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
const status = $<HTMLDivElement>('status');
const alert = $<HTMLDivElement>('alert');
const results = $<HTMLElement>('results');

/**
 * Put a notice on screen, in the live region that suits it.
 *
 * Both regions are in the document from the start and are never hidden: a
 * region that appears at the same moment as its text is often not announced.
 * Errors go to the alert, which interrupts, and progress to the status, which
 * waits its turn. Each line is a paragraph of its own, so a batch with several
 * failures reads as several sentences rather than one run on.
 */
function say(lines: string | readonly string[], kind: 'info' | 'error' = 'info'): void {
	clearNotice();
	const box = document.createElement('div');
	box.className = 'notice';
	box.dataset.kind = kind;
	for (const line of typeof lines === 'string' ? [lines] : lines) {
		const paragraph = document.createElement('p');
		paragraph.textContent = line;
		box.append(paragraph);
	}
	(kind === 'error' ? alert : status).append(box);
}

/**
 * Tell a screen reader something a sighted person can already see.
 *
 * A finished conversion is a new card at the top of the list. That is plain on
 * screen and silent otherwise, so the same news goes into the status region,
 * out of sight.
 */
function announce(text: string): void {
	clearNotice();
	const line = document.createElement('p');
	line.className = 'visually-hidden';
	line.textContent = text;
	status.append(line);
}

function clearNotice(): void {
	status.textContent = '';
	alert.textContent = '';
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
	if (report.highDynamicRange) parts.push('high dynamic range kept');
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

/** Numbers the cards, for the ids their Save buttons point at. */
let resultCount = 0;

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
	name.id = `result-${++resultCount}`;

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

	if (result.report.gainMap === 'dropped') {
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent =
			'This was an HDR photograph. The result is the standard range version. AVIF keeps the HDR.';
		body.append(line);
	}

	if (result.report.gainMap === 'kept') {
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent =
			'This was an HDR photograph and it still is. The brightness map came across unchanged.';
		body.append(line);
	}

	if (result.report.toneMapped) {
		// The exposure is worth saying because it was chosen rather than given.
		// Somebody who disagrees with it can only argue with a number they can
		// see, and there is a setting behind this that takes one.
		const stops = result.report.exposureStops ?? 0;
		const line = document.createElement('p');
		line.className = 'result__meta';
		line.textContent =
			stops === 0
				? 'This held more brightness than the result can. The exposure was metered off the picture.'
				: `This held more brightness than the result can. The exposure was set ${stops} stops from the metered one.`;
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
	// Every card has a button called Save. The file name tells them apart, as a
	// description, so the name stays the word on the button.
	save.setAttribute('aria-describedby', name.id);
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
	say(files.length === 1 ? 'Converting.' : `Converting ${files.length} images.`);

	const to = target.value as FormatId;
	const failures: string[] = [];
	let lastName = '';
	for (const file of files) {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const result = await convert(bytes, {
				to,
				quality: FORMATS[to].lossy ? Number(quality.value) : undefined,
				metadata: keepMetadata.checked ? 'preserve' : 'strip',
			});
			const blob = new Blob([result.bytes as BlobPart], { type: result.mime });
			lastName = outputName(file.name, result.extension);
			render(result, lastName, blob);
		} catch (error) {
			// A converter error carries a sentence written to be read. Anything
			// else is a bug here and says so rather than pretending otherwise.
			const reason = isConverterError(error)
				? error.message
				: 'Something went wrong converting that file.';
			failures.push(files.length === 1 ? reason : `${file.name}: ${reason}`);
		}
	}
	running = false;

	// Said once, at the end. Clearing the notice after each success used to
	// wipe the error for an earlier file in the same batch before anybody had
	// read it.
	const converted = files.length - failures.length;
	if (failures.length > 0) {
		say(
			files.length === 1 ? failures : [`Converted ${converted} of ${files.length}.`, ...failures],
			'error',
		);
	} else {
		announce(
			files.length === 1
				? `Converted. ${lastName} is first in the list.`
				: `Converted ${converted} images. They are first in the list.`,
		);
	}
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
// The whole drop area opens the picker for a pointer. From the keyboard the
// file input is the control: it is focusable, its label shows the focus ring,
// and Enter or Space opens it. The area is not a button itself, because a
// button holding a heading, a label and an input is a control nested in a
// control, which a screen reader cannot present as either.
drop.addEventListener('click', (event) => {
	// The label opens the picker on its own, and the click it sends to the input
	// bubbles here as well.
	if (event.target instanceof Element && event.target.closest('label, input')) return;
	fileInput.click();
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
