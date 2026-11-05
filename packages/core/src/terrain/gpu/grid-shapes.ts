import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ITileAddress } from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem } from "@spacexr/geodesy";
import { buildGridTileShape, type IGridTileShape } from "@spacexr/grid";
import { WebMercatorTileSurface, type ITileSurface } from "@spacexr/tiles";

import { TextureArrayPool } from "../../raster/texture-array-pool";

/** Latitude in radians of a Web Mercator ordinate, `y` southward in `[0, 1]` over the whole pyramid. */
export function webMercatorLatitude(y: number): number {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
}

/** Longitude in radians of the centre of a tile column. */
export function tileCenterLongitude(address: ITileAddress): number {
    return ((address.x + 0.5) / 2 ** address.lod) * 2 * Math.PI - Math.PI;
}

/** Latitude in radians of the centre of a tile row, halfway along its Web Mercator ordinate. */
export function tileCenterLatitude(address: Pick<ITileAddress, "lod" | "y">): number {
    return webMercatorLatitude((address.y + 0.5) / 2 ** address.lod);
}

/** ECEF position of the centre of a tile on the ellipsoid, in double precision. */
export function tileCenterEcef(address: ITileAddress, system: GeodeticSystem = GeodeticSystem.WGS84): { x: number; y: number; z: number } {
    return system.geodeticRadiansToEcef(tileCenterLatitude(address), tileCenterLongitude(address), 0);
}

/** Texels of a shape: per vertex, its position relative to the tile centre and its latitude from the up vector. */
function shapeTexels(shape: IGridTileShape): Float32Array {
    const { positions, ups } = shape;
    const data = new Float32Array((positions.length / 3) * 4);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
        data[vertex * 4] = positions[vertex * 3]!;
        data[vertex * 4 + 1] = positions[vertex * 3 + 1]!;
        data[vertex * 4 + 2] = positions[vertex * 3 + 2]!;
        data[vertex * 4 + 3] = Math.asin(ups[vertex * 3 + 2]!);
    }
    return data;
}

/**
 * Shape of every tile of one Web Mercator level and row: per vertex of a grid of `cells x cells` cells, the position on
 * the ellipsoid relative to the tile centre, in a frame rotated so that the centre longitude is 0, and the geodetic
 * latitude in radians. Rows of vertices run from north to south, `(cells + 1)^2` texels of four floats.
 *
 * Every tile of the row is this shape rotated about the polar axis by the longitude of its centre. The positions are
 * computed in double precision and only hold distances within a tile, so 32-bit floats keep them precise.
 */
export function gridShape(lod: number, row: number, cells: number, system: GeodeticSystem = GeodeticSystem.WGS84): Float32Array {
    return shapeTexels(buildGridTileShape({ lod, x: 0, y: row }, new WebMercatorTileSurface(system), cells));
}

interface IShapeEntry {
    address: ITileAddress;
    layer: number;
    users: number;
}

/** Shapes in use, one layer each in a float texture array shared by every instance: one per key of the surface. */
export class GridShapes {
    public readonly pool: TextureArrayPool;
    private readonly entries = new Map<string, IShapeEntry>();
    private readonly growObserver: Observer<TextureArrayPool>;

    public constructor(
        scene: Scene,
        public readonly cells: number,
        private readonly surface: ITileSurface = new WebMercatorTileSurface(),
    ) {
        this.pool = new TextureArrayPool(scene, { size: cells + 1, format: "rgba32f", initialLayers: 64 });
        // Float layers are not copied when a WebGL 2 pool grows: write every shape again.
        this.growObserver = this.pool.onGrowObservable.add((pool) => {
            if (pool.layersKeptOnGrowth) return;
            for (const entry of this.entries.values()) this.write(entry);
        });
    }

    /** Layers holding a shape. */
    public get size(): number {
        return this.entries.size;
    }

    /**
     * Uses the shape of a tile until it is released as many times.
     *
     * @returns Its layer, or `undefined` when the texture array is full.
     */
    public acquire(address: ITileAddress): number | undefined {
        const shapeKey = this.surface.shape(address).key;
        const existing = this.entries.get(shapeKey);
        if (existing) {
            existing.users++;
            return existing.layer;
        }
        const layer = this.pool.reserve();
        if (layer === undefined) return undefined;
        const entry = { address: { ...address }, layer, users: 1 };
        this.entries.set(shapeKey, entry);
        this.write(entry);
        return layer;
    }

    /** Releases a shape acquired with {@link acquire}; its layer returns to the pool once unused. */
    public release(address: ITileAddress): void {
        const shapeKey = this.surface.shape(address).key;
        const entry = this.entries.get(shapeKey);
        if (!entry || --entry.users > 0) return;
        this.entries.delete(shapeKey);
        this.pool.release(entry.layer);
    }

    public dispose(): void {
        this.pool.onGrowObservable.remove(this.growObserver);
        this.entries.clear();
        this.pool.dispose();
    }

    private write(entry: IShapeEntry): void {
        this.pool.write(entry.layer, shapeTexels(buildGridTileShape(entry.address, this.surface, this.cells)));
    }
}
