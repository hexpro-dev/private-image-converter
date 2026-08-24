/**
 * Browser adapters.
 *
 * Everything in this package that touches a `File`, a `Blob` or the document
 * lives here, so that the rest of it can be imported into a server side render
 * without a top level `document` throwing at import time.
 *
 * ## No Web Worker in this package, deliberately
 *
 * Converting a large image is genuinely CPU bound and belongs off the main
 * thread, which is the opposite of the conclusion the sibling QR package
 * reached about its own work. The reason it is still not here is the plugin
 * seam: a host that registers a software HEIC decoder registers it into its
 * own module graph, and a worker created inside this package would start with
 * an empty registry and silently lose that decoder, which is exactly the
 * browser where it was needed. A worker also cannot be created from a blob
 * under `file://` in Chrome, and the offline build has to work there.
 *
 * So the package stays worker-agnostic and every entry point is a plain
 * function over bytes. An application that wants a worker writes a four line
 * one, imports this package inside it and registers whatever it needs, which
 * is what the website does.
 */

import { convert } from '../convert.js';
import type { ConvertOptions, ConvertResult } from '../types.js';
import { outputName } from './download.js';

export { downloadBlob, downloadBytes, outputName } from './download.js';

export interface FileConversion extends ConvertResult {
	/** The finished file, ready to be saved or shown. */
	readonly blob: Blob;
	/** The source name with its extension swapped. */
	readonly filename: string;
}

export async function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convert a `File` from a picker, a drop or the clipboard.
 *
 * The file's name and reported type are used for the output name and for
 * nothing else. What it actually is comes from its bytes, because a file
 * picker's type is a guess from the extension and an iPhone photograph shared
 * through a chat application arrives called `image.jpg` with HEIC inside it
 * often enough that trusting the name is a support ticket waiting to happen.
 */
export async function convertFile(
	file: File | Blob,
	options: ConvertOptions,
): Promise<FileConversion> {
	const bytes = await bytesFromBlob(file);
	const result = await convert(bytes, options);
	const name = 'name' in file && typeof file.name === 'string' ? file.name : 'image';
	return {
		...result,
		blob: new Blob([result.bytes as BlobPart], { type: result.mime }),
		filename: outputName(name, result.extension),
	};
}

/**
 * Read every file a drop or a picker produced.
 *
 * Returns a plain array because a `FileList` is not one and every caller
 * immediately wants to map over it.
 */
export function filesFrom(list: FileList | null | undefined): File[] {
	if (!list) return [];
	return Array.from(list);
}

/** The image files on a paste event, if any. */
export function filesFromClipboard(event: ClipboardEvent): File[] {
	const items = event.clipboardData?.items;
	if (!items) return [];
	const out: File[] = [];
	for (const item of items) {
		if (item.kind !== 'file') continue;
		const file = item.getAsFile();
		if (file) out.push(file);
	}
	return out;
}
