/**
 * Hand the finished file to the person.
 *
 * There is no upload here and there is no server, so there is nothing to
 * download from. The file is built in the tab and handed to the browser
 * through an object URL, which is the only mechanism a page has for saying
 * "save this" about bytes it made itself.
 */

import { CodecUnavailableError } from '../errors.js';

/**
 * How long to hold the object URL open after the click.
 *
 * Revoking immediately is the obvious thing and it is wrong: the browser has
 * not necessarily finished reading the blob when `click` returns, and Safari
 * in particular cancels the save. A minute is far longer than any save needs
 * and short enough that a long session does not accumulate them.
 */
const REVOKE_AFTER_MS = 60_000;

export function downloadBlob(blob: Blob, filename: string): void {
	if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
		throw new CodecUnavailableError('download', 'This environment cannot save files.');
	}

	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = 'noopener';
	// Appended rather than clicked detached, because Firefox ignores a click on
	// an element that is not in the document.
	anchor.style.display = 'none';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
	downloadBlob(new Blob([bytes as BlobPart], { type: mime }), filename);
}

/**
 * The output file's name.
 *
 * Keeps the original stem and swaps the extension, so a converted
 * `IMG_2059.HEIC` arrives as `IMG_2059.png` and stays recognisable next to its
 * original. A name with no extension gains one rather than losing anything.
 */
export function outputName(sourceName: string, extension: string): string {
	const trimmed = sourceName.replace(/[\\/]/g, '').trim();
	if (trimmed === '') return `image.${extension}`;
	const dot = trimmed.lastIndexOf('.');
	const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
	// A stem of nothing but dots is what a path like `../../etc/passwd` leaves
	// behind once its separators are gone. Saving that as `....png` is not
	// dangerous, just useless, so it falls back with everything else.
	return `${/^\.*$/.test(stem) ? 'image' : stem}.${extension}`;
}
