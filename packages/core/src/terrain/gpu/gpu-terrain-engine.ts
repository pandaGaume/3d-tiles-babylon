import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type {
    IEcefSpatialState,
    ITileActivationContext,
    ITileAddress,
    ITileDeactivationContext,
    ITilePresentationContext,
} from "@spacexr/3d-tiles-runtime";
import { JunctionGridTopologyCache, NeighborLod, SAME_EDGE_LODS, type GridEdgeLods } from "@spacexr/grid";
import { DrapeInstanceCut, DrapeInstanceEdge, type IDrapeInstance } from "@spacexr/raster";
import { TileNeighbor, tileAreaInAncestor } from "@spacexr/tiles";

import type { IBabylonTileResourceStatistics } from "../../monitor/runtime-monitor";
import type { BabylonRasterPages } from "../../raster/raster-pages";
import type { ITerrainEngine, ITerrainEngineInputs } from "../terrain-engine";
import { regionWithHeights, tileIdentity, tileRegion } from "../terrain-tile";
import { ElevationPages } from "./elevation-pages";
import { GridShapes, tileCenterEcef, tileCenterLatitude, tileCenterLongitude } from "./grid-shapes";
import { InstancedGrid, INSTANCE_ATTRIBUTES } from "./instanced-grid";
import { INSTANCED_GRID_FRAGMENT, INSTANCED_GRID_VERTEX } from "./instanced-grid-shaders";

export interface IGpuTerrainEngineOptions {
    /** Cells per grid side. Defaults to 16, like the mesh engine. */
    cells?: number;
    /** Deepest instance below its terrain tile. Defaults to 6. */
    maxInstanceDepth?: number;
    /** Time a coarsened imagery level stays in the instance cut, in milliseconds. Defaults to 500. */
    holdMilliseconds?: number;
    /** Heights per elevation page side: the DEM tile size plus one. Defaults to 257. */
    elevationPageSize?: number;
    /** Skirt depth as a fraction of the tile width. Defaults to 0.02. */
    skirtRatio?: number;
}

/** Terrain tile known to the GPU engine. */
export interface IGpuTerrainHandle {
    readonly identity: ITileAddress;
    presented: boolean;
}

type Activation = ITileActivationContext<IEcefSpatialState, IGpuTerrainHandle, never>;
type Deactivation = ITileDeactivationContext<IEcefSpatialState, IGpuTerrainHandle, never>;
type Presentation = ITilePresentationContext<IEcefSpatialState, IGpuTerrainHandle, never>;

/** Instance with the resources it acquired and its centre in double precision. */
interface IPlacedInstance {
    instance: IDrapeInstance;
    center: { x: number; y: number; z: number };
    demTile: ITileAddress | undefined;
}

const EQUATOR_METRES = 2 * Math.PI * 6378137;

function key(address: ITileAddress): string {
    return `${address.lod}/${address.x}/${address.y}`;
}

/** Edge levels of the predefined grid drawn for a combination of junction edges. */
function edgeLodsOf(coarserEdges: number): GridEdgeLods {
    if (coarserEdges === 0) return SAME_EDGE_LODS;
    const lod = (bit: number): NeighborLod => ((coarserEdges & bit) !== 0 ? NeighborLod.Coarser : NeighborLod.Same);
    return {
        [TileNeighbor.N]: lod(DrapeInstanceEdge.N),
        [TileNeighbor.E]: lod(DrapeInstanceEdge.E),
        [TileNeighbor.S]: lod(DrapeInstanceEdge.S),
        [TileNeighbor.W]: lod(DrapeInstanceEdge.W),
    };
}

/**
 * The GPU terrain engine: predefined normalized grids instanced once per tile of the instance cut, sized and placed
 * by four instance attributes, with positions on the ellipsoid and heights read from texture arrays.
 *
 * The instance cut is the finer of the terrain cut and the imagery cut at each place, balanced across edges; each
 * instance draws the grid variant of its junction edges, so the terrain costs one draw call per variant in use. The
 * CPU only computes the cut when it changes, and the position of each tile centre relative to the camera every frame.
 * See `docs/draping.md` of 3d-tiles-core.
 */
export class GpuTerrainEngine implements ITerrainEngine<IGpuTerrainHandle> {
    public readonly name = "gpu";
    public readonly material: ShaderMaterial;
    public readonly shapes: GridShapes;
    public readonly elevations: ElevationPages;
    private readonly scene: Scene;
    private readonly cells: number;
    private readonly skirtRatio: number;
    private readonly elevation: ITerrainEngineInputs["elevation"];
    private readonly imageryPages: BabylonRasterPages | undefined;
    private readonly cut: DrapeInstanceCut;
    private readonly topologies: JunctionGridTopologyCache;
    private readonly grids = new Map<number, InstancedGrid>();
    private readonly placed = new Map<number, IPlacedInstance[]>();
    private readonly presented = new Map<string, IGpuTerrainHandle>();
    private readonly handles = new Set<IGpuTerrainHandle>();
    private readonly pageObserver: Observer<ITileAddress> | undefined;
    private readonly cameraObserver: Observer<Camera>;
    private verticalScale: number;
    private dirty = true;
    private created = 0;
    private released = 0;

    public constructor(inputs: ITerrainEngineInputs, options: IGpuTerrainEngineOptions = {}) {
        this.scene = inputs.scene;
        this.cells = options.cells ?? 16;
        this.skirtRatio = options.skirtRatio ?? 0.02;
        this.elevation = inputs.elevation;
        this.imageryPages = inputs.wireframe ? undefined : inputs.imageryPages;
        this.verticalScale = inputs.elevation?.verticalScale ?? 1;
        this.cut = new DrapeInstanceCut({
            ...(options.maxInstanceDepth === undefined ? {} : { maxDepth: options.maxInstanceDepth }),
            ...(options.holdMilliseconds === undefined ? {} : { holdMilliseconds: options.holdMilliseconds }),
        });
        this.topologies = new JunctionGridTopologyCache(this.cells);
        this.shapes = new GridShapes(this.scene, this.cells);
        this.elevations = new ElevationPages(this.scene, inputs.elevation?.pyramid, options.elevationPageSize ?? 257);

        this.material = new ShaderMaterial(
            "gpu-terrain",
            this.scene,
            { vertexSource: INSTANCED_GRID_VERTEX, fragmentSource: INSTANCED_GRID_FRAGMENT },
            {
                attributes: ["position", ...INSTANCE_ATTRIBUTES],
                uniforms: ["viewProjection", "cells", "verticalScale", "sunDirection", "baseColor", "ambient", "imagerySize"],
                samplers: ["shapes", "elevations", "imagery"],
                defines: this.imageryPages ? ["#define IMAGERY"] : [],
            },
        );
        this.material.backFaceCulling = false;
        this.material.wireframe = inputs.wireframe;
        this.material.setFloat("cells", this.cells);
        this.material.setFloat("verticalScale", this.verticalScale);
        this.material.setColor3("baseColor", new Color3(0.42, 0.45, 0.4));
        this.material.setFloat("ambient", 0.35);
        this.material.setTexture("shapes", this.shapes.pool);
        this.material.setTexture("elevations", this.elevations.pool);
        if (this.imageryPages) {
            this.material.setTexture("imagery", this.imageryPages.pool);
            this.material.setFloat("imagerySize", this.imageryPages.size);
        }
        this.updateSun();

        this.pageObserver = this.imageryPages?.changed.add(() => (this.dirty = true));
        // The camera position is known once the scene computed its matrices: place the instances then.
        this.cameraObserver = this.scene.onBeforeCameraRenderObservable.add(() => this.place());
    }

    public async activate(context: Activation): Promise<void> {
        for (const content of context.pendingContents) {
            if (context.signal.aborted) {
                await context.readiness.cancelled(content.id);
                continue;
            }
            try {
                const identity = tileIdentity(context);
                const heights = await this.elevation?.pyramid.tileHeights(identity);
                if (context.signal.aborted) {
                    await context.readiness.cancelled(content.id);
                    continue;
                }
                const handle: IGpuTerrainHandle = { identity, presented: false };
                this.handles.add(handle);
                this.created++;
                const accepted = await context.readiness.ready(content.id, {
                    kind: "renderable",
                    handle,
                    cacheKey: content.uri,
                    cost: { cpuBytes: 0, gpuBytes: 0, networkBytes: 0 },
                    // The tile starts at 0/0; its DEM gives the measured height range.
                    ...(heights && !Number.isNaN(heights.range.minimum) && !Number.isNaN(heights.range.maximum)
                        ? { tileBoundingVolume: { region: regionWithHeights(tileRegion(context), heights.range, this.verticalScale) } }
                        : {}),
                });
                if (!accepted) this.forget(handle);
            } catch (error) {
                if (context.signal.aborted) await context.readiness.cancelled(content.id);
                else await context.readiness.failed(content.id, error);
            }
        }
    }

    public deactivate(_context: Deactivation): void {
        // Selection and visual presentation remain separate.
    }

    public present(context: Presentation): void {
        for (const { handle } of context.resources) {
            if (handle.presented) continue;
            handle.presented = true;
            this.presented.set(key(handle.identity), handle);
            this.elevation?.pyramid.retain(handle.identity);
            // A tile shown again after its DEM left the cache reloads it.
            const pyramid = this.elevation?.pyramid;
            if (pyramid && !pyramid.isResident(handle.identity)) void pyramid.tileHeights(handle.identity).then(() => (this.dirty = true));
        }
        this.dirty = true;
    }

    public hide(context: Presentation): void {
        for (const { handle } of context.resources) this.unpresent(handle);
        this.dirty = true;
    }

    public release(context: Presentation): void {
        for (const { handle } of context.resources) this.forget(handle);
        this.dirty = true;
    }

    public getStatistics(): IBabylonTileResourceStatistics {
        let gpuBytes = this.shapes.pool.gpuBytes + this.elevations.pool.gpuBytes;
        for (const grid of this.grids.values()) gpuBytes += grid.gpuBytes;
        return {
            handles: this.handles.size,
            presented: this.presented.size,
            created: this.created,
            released: this.released,
            cpuBytes: 0,
            gpuBytes,
        };
    }

    public beforeRender(): void {
        const now = performance.now();
        const expiresAt = this.cut.expiresAt;
        if (this.dirty || (expiresAt !== undefined && now >= expiresAt)) this.rebuild(now);
    }

    public afterRender(): void {
        // No per-tile work after rendering.
    }

    public setVerticalScale(scale: number): void {
        this.verticalScale = scale;
        this.material.setFloat("verticalScale", scale);
    }

    public dispose(): void {
        this.scene.onBeforeCameraRenderObservable.remove(this.cameraObserver);
        if (this.pageObserver) this.imageryPages?.changed.remove(this.pageObserver);
        for (const instances of this.placed.values()) this.releaseResources(instances);
        this.placed.clear();
        for (const grid of this.grids.values()) grid.dispose();
        this.grids.clear();
        for (const handle of this.presented.values()) this.elevation?.pyramid.release(handle.identity);
        this.presented.clear();
        this.material.dispose();
        this.shapes.dispose();
        this.elevations.dispose();
    }

    private unpresent(handle: IGpuTerrainHandle): void {
        if (!handle.presented) return;
        handle.presented = false;
        this.presented.delete(key(handle.identity));
        this.elevation?.pyramid.release(handle.identity);
    }

    private forget(handle: IGpuTerrainHandle): void {
        this.unpresent(handle);
        if (this.handles.delete(handle)) this.released++;
    }

    /** Computes the instance cut and writes every instance attribute but the placement. */
    private rebuild(now: number): void {
        this.dirty = false;
        const terrain = [...this.presented.values()].map((handle) => handle.identity);
        const imagery = this.imageryPages ? this.imageryPages.presented.addresses() : [];
        const instances = this.cut.update(terrain, imagery, now);

        // Acquire the resources of the new cut before releasing those of the previous one, so shared ones stay.
        const byVariant = new Map<number, IPlacedInstance[]>();
        for (const instance of instances) {
            const demTile = this.elevation ? this.elevation.pyramid.rasters.areaOf(instance.terrain).ancestor : undefined;
            const placed: IPlacedInstance = { instance, center: tileCenterEcef(instance.address), demTile };
            const variant = byVariant.get(instance.coarserEdges);
            if (variant) variant.push(placed);
            else byVariant.set(instance.coarserEdges, [placed]);
        }
        const previous = [...this.placed.values()];
        this.placed.clear();
        for (const [variant, list] of byVariant) this.placed.set(variant, list);

        for (const [variant, list] of byVariant) this.write(this.grid(variant), list);
        for (const [variant, grid] of this.grids) if (!byVariant.has(variant)) grid.resize(0);
        for (const instances of previous) this.releaseResources(instances);
        this.place();
    }

    private grid(variant: number): InstancedGrid {
        let grid = this.grids.get(variant);
        if (!grid) {
            grid = new InstancedGrid(this.scene, `gpu-terrain-${variant}`, this.topologies.get(edgeLodsOf(variant)), this.material);
            this.grids.set(variant, grid);
        }
        return grid;
    }

    /** Writes the shape, rotation, elevation and imagery of the instances of one grid variant. */
    private write(grid: InstancedGrid, list: readonly IPlacedInstance[]): void {
        grid.resize(list.length);
        const place = grid.attribute("instPlace");
        const rotation = grid.attribute("instRotation");
        const elevation = grid.attribute("instElevation");
        const imagery = grid.attribute("instImagery");
        list.forEach(({ instance, demTile }, index) => {
            const { address } = instance;
            const offset = index * 4;
            place[offset + 3] = this.shapes.acquire(address.lod, address.y) ?? 0;

            const longitude = tileCenterLongitude(address);
            const width = (EQUATOR_METRES / 2 ** address.lod) * Math.cos(tileCenterLatitude(address));
            rotation.set([Math.cos(longitude), Math.sin(longitude), (2 * Math.PI) / 2 ** address.lod, width * this.skirtRatio], offset);

            const demLayer = demTile ? this.elevations.acquire(demTile) : undefined;
            if (demTile && demLayer !== undefined) {
                const area = tileAreaInAncestor(address, address.lod - demTile.lod);
                elevation.set([area.west, area.north, area.size, demLayer], offset);
            } else elevation.set([0, 0, 1, -1], offset);

            const cover = this.imageryPages?.resident.cover(address);
            if (cover) imagery.set([cover.west, cover.north, cover.size, cover.value], offset);
            else imagery.set([0, 0, 1, -1], offset);
        });
        grid.upload("instRotation", "instElevation", "instImagery");
    }

    /** Releases the shapes and elevation pages acquired for instances. */
    private releaseResources(instances: readonly IPlacedInstance[]): void {
        for (const { instance, demTile } of instances) {
            this.shapes.release(instance.address.lod, instance.address.y);
            if (demTile) this.elevations.release(demTile);
        }
    }

    /** Writes the tile centres relative to the camera, in double precision, and the sun direction. */
    private place(): void {
        const eye = this.scene.floatingOriginOffset;
        for (const [variant, list] of this.placed) {
            const grid = this.grids.get(variant);
            if (!grid) continue;
            const place = grid.attribute("instPlace");
            list.forEach(({ center }, index) => {
                place[index * 4] = center.x - eye.x;
                place[index * 4 + 1] = center.y - eye.y;
                place[index * 4 + 2] = center.z - eye.z;
            });
            grid.upload("instPlace");
        }
        this.updateSun();
    }

    private updateSun(): void {
        const sun = this.scene.lights.find((light): light is DirectionalLight => light instanceof DirectionalLight);
        const direction = sun ? sun.direction.negate().normalize() : new Vector3(0, 0, 1);
        this.material.setVector3("sunDirection", direction);
    }
}
