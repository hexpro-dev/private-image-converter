/**
 * Turn a decode plan and a tile decoder into a finished raster.
 *
 * The tile decoder is injected rather than imported. In a browser it is
 * WebCodecs; in a unit test it is a fake or a native decoder driven from the
 * test process. That seam is what makes the grid arithmetic, the crop and the
 * orientation testable at all, because none of them need a codec to be wrong.
 */

import type { RasterImage } from '../types.js';
import { applyOrientation, blit, createRaster, crop } from '../raster/image.js';
import type { HeifPicturePlan, HeifTile } from './image.js';

/** What a tile decoder is handed. Mirrors `VideoDecoderConfig` without naming it. */
export interface TileDecoderConfig {
	readonly codec: string;
	/** The raw `hvcC` record, passed through as the decoder description. */
	readonly description: Uint8Array;
	readonly codedWidth: number;
	readonly codedHeight: number;
}

/**
 * Decode every tile, in order.
 *
 * Returning an array rather than calling back per tile keeps the contract
 * small. Implementations are free to decode them through one decoder instance,
 * which is what a browser wants: constructing 48 decoders for one photograph
 * is slower than the decode.
 */
export type TileDecoder = (
	config: TileDecoderConfig,
	tiles: readonly HeifTile[],
	signal?: AbortSignal,
) => Promise<readonly RasterImage[]>;

export async function assembleHeifImage(
	plan: HeifPicturePlan,
	decodeTiles: TileDecoder,
	signal?: AbortSignal,
): Promise<RasterImage> {
	const first = plan.tiles[0] as HeifTile;
	const config: TileDecoderConfig = {
		codec: plan.codecString,
		description: plan.config.raw,
		codedWidth: first.width,
		codedHeight: first.height,
	};

	// Copied into an array of this function's own so that a slot can be emptied
	// once the tile in it has been blitted. The copy frees nothing by itself:
	// both arrays point at the same rasters, and it is the clearing in the loop
	// below that drops the last reference to one. Clearing the decoder's own
	// array would save the copy and mutate a value the caller still holds, which
	// is a trap for them and throws outright on the frozen array a careful
	// implementation hands back. The decoder's array is never named, so nothing
	// keeps it alive past this line.
	const pending: (RasterImage | undefined)[] = [...(await decodeTiles(config, plan.tiles, signal))];
	if (pending.length !== plan.tiles.length) {
		throw new Error(
			`the tile decoder returned ${pending.length} tiles for ${plan.tiles.length} requested`,
		);
	}

	let assembled: RasterImage;
	if (plan.tiles.length === 1 && first.x === 0 && first.y === 0) {
		// A single untiled image is already the whole picture, and a buffer to
		// copy it into is close to 200 megabytes for a 48 megapixel photograph.
		assembled = pending[0] as RasterImage;
	} else {
		// Allocated at the cropped size rather than at the padded grid, because
		// nothing needs the padding to exist. `blit` clips at the destination
		// edges by design, since the last row and column of tiles hang over the
		// real image in almost every photograph, and `planPicture` refuses any
		// grid claiming to be larger than its tiles cover. So a destination this
		// size drops exactly the overhang the crop below used to drop, one row at
		// a time, for free.
		//
		// Restoring `canvasWidth` by `canvasHeight` here for symmetry with the
		// plan costs a 201 megabyte allocation and a 195 megabyte copy on a 48
		// megapixel photograph, and changes not one pixel of the result. No test
		// comparing output would notice; the allocation test in
		// tests/heif/container.test.ts is what notices.
		assembled = createRaster(plan.width, plan.height, plan.colourSpace, false);
		for (let i = 0; i < plan.tiles.length; i += 1) {
			const tile = plan.tiles[i] as HeifTile;
			blit(assembled, pending[i] as RasterImage, tile.x, tile.y);
			// The pixels are in the output now, so let the collector have the
			// tile. This does not lower the peak on its own: `TileDecoder` hands
			// back every tile at once, so all 48 are live at the moment the output
			// is allocated, and only a decoder that yields tiles as it finishes
			// them would move that. What it does buy is the tiles being collected
			// before `applyOrientation` allocates the turned copy, which is a
			// second full sized raster on every portrait photograph a phone takes.
			pending[i] = undefined;
		}
	}

	// A no-op for the branch above, which allocated at exactly this size: the
	// early return inside `crop` is load bearing rather than incidental, and it
	// is what keeps the tiled path to one full sized buffer. It still has work to
	// do for the single tile branch, where a decoder is entitled to hand back a
	// raster at the coded size rather than at the declared one.
	const cropped = crop(
		{ ...assembled, colourSpace: plan.colourSpace },
		0,
		0,
		plan.width,
		plan.height,
	);
	return applyOrientation(cropped, plan.orientation);
}
