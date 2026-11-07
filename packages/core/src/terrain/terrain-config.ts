import type { RasterInterpolation } from "@spacexr/raster";

import config from "./terrain-config.json";

/** Settings of the terrain, held in `terrain-config.json`: change them there, not in the code. */
export interface ITerrainConfig {
    grid: {
        /** Cells per side of a terrain grid, on every tiling. The geometric error of a terrain tile is the ground size of its cells. */
        cells: number;
    };
    selection: {
        /** Screen-space error above which a terrain tile refines, in pixels. */
        screenSpaceError: number;
        /** A refined tile coarsens once its error drops below `1 - hysteresis` times the threshold. */
        hysteresis: number;
        /** Time a refined tile waits before coarsening. */
        coarseningDelayMilliseconds: number;
        maxConcurrentLoads: number;
        /** Terrain tiles kept in the cache of the runtime. */
        contentCacheEntries: number;
    };
    /** How the threshold of new refinements follows the apparent speed of the camera. */
    motion: {
        /** Factor on the threshold at full speed. 1 leaves the threshold fixed. */
        maxScale: number;
        /** Apparent speed at and below which the threshold is unchanged. */
        restPixelsPerSecond: number;
        /** Apparent speed at and above which the factor is `maxScale`. */
        fullPixelsPerSecond: number;
        /** Time the speed must stay lower before the factor drops. */
        releaseMilliseconds: number;
    };
    dem: {
        /** Cells per side of a DEM tile. */
        tileCells: number;
        /** DEM tiles kept in memory. */
        cacheEntries: number;
        /** Time a DEM load nobody waits for any more goes on before it is aborted. */
        abortDelayMilliseconds: number;
        /** How levels below the source are generated. */
        interpolation: RasterInterpolation;
    };
    imagery: {
        /** Texels per side of an imagery tile. Its geometric error is one texel. */
        tileCells: number;
        minLOD: number;
        maxLOD: number;
        screenSpaceError: number;
        contentCacheEntries: number;
        /** Deepest drape below a terrain tile of the mesh engine: up to `4^maxDrapeDepth` imagery pages per tile. */
        maxDrapeDepth: number;
    };
    objects: {
        screenSpaceError: number;
    };
    mercator: {
        minLOD: number;
        maxLOD: number;
    };
    cube: {
        /** Budgets of the runtime cache follow what the view uses, times this factor. */
        workingSetFactor: number;
        /** Tiles are selected in a frustum wider than the view by this fraction. */
        frustumMargin: number;
        /** Deepest DEM level of the synthetic Moon. */
        syntheticDemMaxLOD: number;
    };
    mesh: {
        /** Main-thread time per frame for rebuilding grids whose neighbours changed. */
        junctionBudgetMilliseconds: number;
    };
    gpu: {
        /** Cells per side of the grids the camera picks. */
        pickCells: number;
        /** Deepest instance below its terrain tile. */
        maxInstanceDepth: number;
        /** Time a coarsened imagery level stays in the instance cut. */
        holdMilliseconds: number;
    };
}

/** The settings of `terrain-config.json`. */
export const TERRAIN_CONFIG: Readonly<ITerrainConfig> = config as ITerrainConfig;
