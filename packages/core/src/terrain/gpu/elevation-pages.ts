import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ITileAddress } from "@spacexr/3d-tiles-runtime";
import type { DemPyramid } from "@spacexr/dem";

import { TextureArrayPool } from "../../raster/texture-array-pool";

interface IElevationPage {
    address: ITileAddress;
    layer: number;
    users: number;
}

function key(address: ITileAddress): string {
    return `${address.lod}/${address.x}/${address.y}`;
}

/**
 * Heights of the DEM tiles in use, one 32-bit float layer each in a texture array: the stitched height grid of the
 * tile, `(w + 1) x (h + 1)` heights in point registration, so neighbouring pages share their edge heights. A page is
 * written again when a neighbour completes its stitched edges. Missing heights are written as 0.
 */
export class ElevationPages {
    public readonly pool: TextureArrayPool;
    private readonly pages = new Map<string, IElevationPage>();
    private readonly buffer: Float32Array;
    private readonly stopObserving: () => void;
    private readonly growObserver: Observer<TextureArrayPool>;

    public constructor(
        scene: Scene,
        private readonly pyramid: DemPyramid | undefined,
        /** Heights per page side: the DEM tile size plus one. */
        public readonly size = 257,
    ) {
        this.pool = new TextureArrayPool(scene, { size, format: "r32f", initialLayers: 64 });
        this.buffer = new Float32Array(size * size);
        this.stopObserving =
            pyramid?.rasters.observeStitched((changed) => {
                for (const address of changed) {
                    const page = this.pages.get(key(address));
                    if (page) this.write(page);
                }
            }) ?? (() => undefined);
        // Float layers are not copied when the pool grows: write every page again.
        this.growObserver = this.pool.onGrowObservable.add(() => {
            for (const page of this.pages.values()) this.write(page);
        });
    }

    /** Layers holding a page. */
    public get count(): number {
        return this.pages.size;
    }

    /**
     * Uses the page of a DEM tile until it is released as many times.
     *
     * @returns Its layer, or `undefined` when the DEM tile is not in memory or the texture array is full.
     */
    public acquire(address: ITileAddress): number | undefined {
        const pageKey = key(address);
        const existing = this.pages.get(pageKey);
        if (existing) {
            existing.users++;
            return existing.layer;
        }
        if (!this.pyramid?.rasters.stitchedGrid(address)) return undefined;
        const layer = this.pool.reserve();
        if (layer === undefined) return undefined;
        const page = { address: { ...address }, layer, users: 1 };
        this.pages.set(pageKey, page);
        this.write(page);
        return layer;
    }

    /** Releases a page acquired with {@link acquire}; its layer returns to the pool once unused. */
    public release(address: ITileAddress): void {
        const pageKey = key(address);
        const page = this.pages.get(pageKey);
        if (!page || --page.users > 0) return;
        this.pages.delete(pageKey);
        this.pool.release(page.layer);
    }

    public dispose(): void {
        this.stopObserving();
        this.pool.onGrowObservable.remove(this.growObserver);
        this.pages.clear();
        this.pool.dispose();
    }

    private write(page: IElevationPage): void {
        const grid = this.pyramid?.rasters.stitchedGrid(page.address);
        if (!grid) return;
        if (grid.width !== this.size || grid.height !== this.size)
            throw new RangeError(`Expected ${this.size} x ${this.size} stitched heights, received ${grid.width} x ${grid.height}.`);
        const heights = grid.data;
        for (let index = 0; index < heights.length; index++) {
            const height = heights[index]!;
            this.buffer[index] = Number.isNaN(height) ? 0 : height;
        }
        this.pool.write(page.layer, this.buffer);
    }
}
