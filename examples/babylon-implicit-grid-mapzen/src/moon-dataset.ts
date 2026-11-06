import type { DemPyramid } from "@spacexr/dem";
import {
    BrowserImageDecoder,
    type IImageDecoder,
    type IRasterGrid,
} from "@spacexr/raster";
import {
    CelestialTileSource,
    cubeFaceCoordinates,
    cubeTileOfDirection,
    type ICartesian3,
    type ITileAddress,
} from "@spacexr/tiles";

/** Elevation and imagery of a body, from the descriptors of a tile service. */
export interface IMoonDataset {
    elevation: CelestialTileSource;
    imagery: CelestialTileSource;
    /** Radius of the reference sphere, read from the descriptors, in metres. */
    radius: number;
}

async function loadSource(
    service: string,
    name: string,
): Promise<CelestialTileSource> {
    const url = new URL(`${name}.json`, `${service.replace(/\/+$/, "")}/`);
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${url.href} answered ${response.status}.`);
    return new CelestialTileSource(await response.json());
}

/**
 * Reads `elevation.json` and `imagery.json` of a tile service. Their URL templates carry the revision of the dataset, so
 * the descriptors are read at each start and tile URLs are never built by hand.
 *
 * @throws RangeError When a descriptor holds other content, or when the two do not describe the same sphere.
 */
export async function loadMoonDataset(service: string): Promise<IMoonDataset> {
    const [elevation, imagery] = await Promise.all([
        loadSource(service, "elevation"),
        loadSource(service, "imagery"),
    ]);
    if (elevation.dataset.content !== "elevation")
        throw new RangeError("elevation.json does not hold elevation.");
    if (imagery.dataset.content !== "imagery")
        throw new RangeError("imagery.json does not hold imagery.");
    const [a, b, c] = elevation.dataset.referenceRadii;
    // The spatial metric of the runtime takes an ellipsoid of two axes.
    if (a !== b || b !== c)
        throw new RangeError("This example renders spherical bodies only.");
    if (imagery.dataset.referenceRadii.some((radius) => radius !== a))
        throw new RangeError(
            "The elevation and imagery of a dataset must share their reference surface.",
        );
    return { elevation, imagery, radius: a };
}

/**
 * Terrain subtrees following the subtrees of a dataset: the terrain refines further only where the data does.
 *
 * @param source - Elevation of the dataset.
 * @param levelsBelowDem - Levels of terrain tiles below a DEM tile until their cells reach its samples.
 */
export function terrainSubtrees(
    source: CelestialTileSource,
    levelsBelowDem: number,
): { root: ITileAddress & { face: number }; maxLOD: number }[] {
    const { subtrees } = source.dataset;
    const declared = new Set(
        subtrees.map(({ face, lod, x, y }) => `${face}/${lod}/${x}/${y}`),
    );
    return (
        subtrees
            // The outermost tiles, whose parents the subtrees do not declare.
            .filter(
                ({ face, lod, x, y }) =>
                    !declared.has(
                        `${face}/${lod - 1}/${Math.floor(x / 2)}/${Math.floor(y / 2)}`,
                    ),
            )
            .map(({ face, lod, x, y }) => ({
                root: { face, lod, x, y },
                maxLOD: source.deepestLOD + levelsBelowDem,
            }))
    );
}

/** Loads the imagery tiles of a dataset, which hold their shared edges. */
export function datasetImageryLoader(
    source: CelestialTileSource,
    decoder: IImageDecoder = new BrowserImageDecoder(),
): (
    address: ITileAddress,
) => Promise<IRasterGrid<Uint8Array | Uint8ClampedArray> | undefined> {
    return async (address) => {
        const result = await source.fetchTile(address);
        return result.status === "absent"
            ? undefined
            : decoder.decode(result.bytes);
    };
}

/** Deepest tiles kept by {@link datasetHeightAt}: the camera asks for the point it orbits and the point below it. */
const FOLLOWED_TILES = 4;

/**
 * Height of the terrain in a direction, for a camera: synchronous, and independent of the tiles on screen, as the point
 * below the camera often is not. It loads and keeps the tile of `demMaxLOD` in the directions asked, which holds every
 * sample of the dataset, and keeps the faces of level 0, which answer while a tile loads.
 *
 * @param demMaxLOD - Deepest level of the dataset, not of the generated levels below it.
 * @returns A function giving metres over the reference surface, `NaN` until a tile covers the direction.
 */
export function datasetHeightAt(
    pyramid: DemPyramid,
    demMaxLOD: number,
): (direction: Readonly<ICartesian3>) => number {
    const load = (address: ITileAddress): void => {
        pyramid.retain(address);
        pyramid.tileHeights(address).catch((error: unknown) => {
            console.error("A height tile of the camera failed", error);
        });
    };
    for (let face = 0; face < 6; face++) load({ face, lod: 0, x: 0, y: 0 });

    // Most recently asked first.
    const followed: ITileAddress[] = [];
    const follow = (address: ITileAddress): void => {
        const index = followed.findIndex(
            ({ face, x, y }) =>
                face === address.face && x === address.x && y === address.y,
        );
        if (index === 0) return;
        if (index > 0) {
            followed.unshift(...followed.splice(index, 1));
            return;
        }
        load(address);
        followed.unshift(address);
        if (followed.length > FOLLOWED_TILES) pyramid.release(followed.pop()!);
    };

    return (direction) => {
        follow(cubeTileOfDirection(direction, demMaxLOD));
        const { face, u, v } = cubeFaceCoordinates(direction);
        for (let lod = demMaxLOD; lod >= 0; lod--) {
            const height = pyramid.heightAt(u, v, lod, face);
            if (!Number.isNaN(height)) return height;
        }
        return Number.NaN;
    };
}
