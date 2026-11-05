import { cubeTileBoundingBox, type ITileAddress } from "@spacexr/3d-tiles-runtime";
import type { GeodeticSystem } from "@spacexr/geodesy";
import {
    CUBE_TILE_TOPOLOGY,
    WebMercatorTileSurface,
    flatTileTopology,
    type CubeTileSurface,
    type ITileSurface,
    type ITileTopology,
} from "@spacexr/tiles";

/**
 * How terrain tiles lie on a body. The engines stay the same whatever the tiling: they ask it where a tile is and how
 * tiles connect.
 */
export interface ITerrainTiling {
    /** Places the tiles on the body. */
    surface: ITileSurface;
    /** Connects the tiles, across cube faces when needed. */
    topology: ITileTopology;
    /** Heights move vertices along the ray from the centre of the body instead of the normal of its ellipsoid. */
    radialHeights: boolean;
    /** Bounding box of a tile with a measured height range; without it, tiles keep a `region`. */
    boundingBox?: (address: ITileAddress, minimumHeight: number, maximumHeight: number) => number[];
}

/** Web Mercator tiling on an ellipsoid, without the poles. */
export function webMercatorTiling(system?: GeodeticSystem): ITerrainTiling {
    return { surface: new WebMercatorTileSurface(system), topology: flatTileTopology({ wrapX: true }), radialHeights: false };
}

/** Cube tiling on a reference surface, which covers a whole body. */
export function cubeTiling(surface: CubeTileSurface): ITerrainTiling {
    return {
        surface,
        topology: CUBE_TILE_TOPOLOGY,
        radialHeights: true,
        boundingBox: (address, minimumHeight, maximumHeight) => cubeTileBoundingBox(address, surface, minimumHeight, maximumHeight),
    };
}
