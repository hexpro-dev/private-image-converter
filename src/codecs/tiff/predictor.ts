/**
 * Horizontal differencing, TIFF's one useful predictor.
 *
 * The writer replaces every sample with the difference from the sample one
 * pixel to its left, which turns a smooth gradient into a run of small numbers
 * and gives the compressor after it something to work with. Undoing it is a
 * running sum along each row.
 *
 * Two details decide whether an image comes back or comes back striped. The
 * sum runs per sample, so red is added to red rather than to the green beside
 * it, which for a chunky RGB image means stepping three bytes at a time. And
 * for sixteen and thirty-two bit samples it runs over whole samples in the
 * file's byte order, not over bytes: adding byte by byte gives a picture that
 * is almost right and wrong in the low bits of every second byte.
 *
 * Each row starts again from its own first pixel, so a corrupt row cannot
 * smear into the rest of the image.
 */

/**
 * Undo predictor 2 over a decompressed strip or tile, in place.
 *
 * `samplesPerPixel` is the count in this buffer rather than in the image: a
 * planar file stores one sample per plane, so each plane is undone as if it
 * were a single channel image. The buffer is exactly `rows` rows of
 * `columns * samplesPerPixel` samples, which is what the caller allocated for
 * it, so nothing here has to bounds check.
 */
export function undoHorizontalDifferencing(
	buffer: Uint8Array,
	columns: number,
	rows: number,
	samplesPerPixel: number,
	bitsPerSample: number,
	littleEndian: boolean,
): void {
	const perRow = columns * samplesPerPixel;

	if (bitsPerSample === 8) {
		for (let row = 0; row < rows; row += 1) {
			const at = row * perRow;
			for (let i = samplesPerPixel; i < perRow; i += 1) {
				// Wrapped to a byte on the way in by the writer, so wrapping on
				// the way out is not a lapse: a sample of 250 differenced against
				// 10 is stored as 16 and has to come back as 10.
				buffer[at + i] =
					((buffer[at + i] as number) + (buffer[at + i - samplesPerPixel] as number)) & 0xff;
			}
		}
		return;
	}

	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

	if (bitsPerSample === 16) {
		for (let row = 0; row < rows; row += 1) {
			const at = row * perRow * 2;
			for (let i = samplesPerPixel; i < perRow; i += 1) {
				const here = at + i * 2;
				const left = here - samplesPerPixel * 2;
				const sum =
					(view.getUint16(here, littleEndian) + view.getUint16(left, littleEndian)) & 0xffff;
				view.setUint16(here, sum, littleEndian);
			}
		}
		return;
	}

	for (let row = 0; row < rows; row += 1) {
		const at = row * perRow * 4;
		for (let i = samplesPerPixel; i < perRow; i += 1) {
			const here = at + i * 4;
			const left = here - samplesPerPixel * 4;
			// `>>> 0` because the sum of two values near 2^32 overflows into a
			// double, and `setUint32` would then store the wrong low bits.
			const sum = (view.getUint32(here, littleEndian) + view.getUint32(left, littleEndian)) >>> 0;
			view.setUint32(here, sum, littleEndian);
		}
	}
}
