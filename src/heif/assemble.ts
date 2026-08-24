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
import type { HeifImagePlan, HeifTile } from './image.js';

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
	plan: HeifImagePlan,
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

	const decoded = await decodeTiles(config, plan.tiles, signal);
	if (decoded.length !== plan.tiles.length) {
		throw new Error(
			`the tile decoder returned ${decoded.length} tiles for ${plan.tiles.length} requested`,
		);
	}

	// A single untiled image skips the intermediate buffer entirely, which
	// matters more than it looks: for a 48 megapixel photograph that buffer is
	// close to 200 megabytes and allocating a second one halves the size of
	// image the tab can handle.
	let assembled: RasterImage;
	if (plan.tiles.length === 1 && first.x === 0 && first.y === 0) {
		assembled = decoded[0] as RasterImage;
	} else {
		assembled = createRaster(plan.canvasWidth, plan.canvasHeight, plan.colourSpace, false);
		for (let i = 0; i < plan.tiles.length; i += 1) {
			const tile = plan.tiles[i] as HeifTile;
			blit(assembled, decoded[i] as RasterImage, tile.x, tile.y);
		}
	}

	const cropped = crop(
		{ ...assembled, colourSpace: plan.colourSpace },
		0,
		0,
		plan.width,
		plan.height,
	);
	return applyOrientation(cropped, plan.orientation);
}
