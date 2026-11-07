import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type {
    IEcefSpatialState,
    ITileActivationContext,
    ITileAddress,
    ITileDeactivationContext,
    ITilePresentationContext,
} from "@spacexr/3d-tiles-runtime";
import type { VerticalScale } from "@spacexr/3d-tiles-runtime";
import { completeTileCover, DrapeInstanceCut, type IDrapeInstance } from "@spacexr/raster";
import { parentTileAddress, tileAddressKey as key } from "@spacexr/tiles";

import type { IBabylonTileResourceStatistics } from "../../monitor/runtime-monitor";
import type { BabylonRasterPages } from "../../raster/raster-pages";
import { TERRAIN_CONFIG } from "../terrain-config";
import type { ITerrainEngine, ITerrainEngineInputs } from "../terrain-engine";
import { sharedVerticalScale } from "../mesh/geodesic-grid-pipeline";
import { regionWithHeights, tileIdentity, tileRegion } from "../terrain-tile";
import { webMercatorTiling, type ITerrainTiling } from "../terrain-tiling";
import { ElevationPages } from "./elevation-pages";
import { GridShapes } from "./grid-shapes";
import { InstancedGrid, INSTANCE_ATTRIBUTES, refinedGridTopology, type InstanceAttribute } from "./instanced-grid";
import { instancedGridPixelShader } from "./shaders/instancedGrid.fragment";
import { instancedGridVertexShader } from "./shaders/instancedGrid.vertex";
import { PickSurface } from "./pick-surface";

export interface IGpuTerrainEngineOptions {
    /** Cells per grid side. Defaults to {@link TERRAIN_CONFIG}, like the mesh engine. */
    cells?: number;
    /** Deepest instance below its terrain tile. Defaults to {@link TERRAIN_CONFIG}. */
    maxInstanceDepth?: number;
    /** Time a coarsened imagery level stays in the instance cut, in milliseconds. Defaults to {@link TERRAIN_CONFIG}. */
    holdMilliseconds?: number;
    /** Heights per elevation page side: the DEM tile size plus one. Defaults to {@link TERRAIN_CONFIG}. */
    elevationPageSize?: number;
    /** Cells per side of the grids the camera picks, one per terrain tile. Defaults to {@link TERRAIN_CONFIG}. */
    pickCells?: number;
}

/** Terrain tile known to the GPU engine. */
export interface IGpuTerrainHandle {
    readonly identity: ITileAddress;
    presented: boolean;
}

type Activation = ITileActivationContext<IEcefSpatialState, IGpuTerrainHandle, never>;
type Deactivation = ITileDeactivationContext<IEcefSpatialState, IGpuTerrainHandle, never>;
type Presentation = ITilePresentationContext<IEcefSpatialState, IGpuTerrainHandle, never>;

/** Elevation attributes of an instance: its interior, then its edges N, E, S, W and its corners NW, NE, SE, SW. */
const ELEVATION_ATTRIBUTES: readonly InstanceAttribute[] = [
    "instElevation",
    "instEdgeN",
    "instEdgeE",
    "instEdgeS",
    "instEdgeW",
    "instCornerNW",
    "instCornerNE",
    "instCornerSE",
    "instCornerSW",
];

/** Instance of the cut with its centre in double precision and the DEM tiles whose pages it acquired. */
interface IPlacedInstance {
    instance: IDrapeInstance;
    center: { x: number; y: number; z: number };
    demTiles: ITileAddress[];
}

/**
 * The GPU terrain engine: one predefined normalized grid, refined on its edges as in SpaceXR, instanced once per tile
 * of the instance cut and drawn in one draw call. Instance attributes size and place each grid; positions on the
 * ellipsoid and heights are read from texture arrays.
 *
 * The instance cut is the finer of the terrain cut and the imagery cut at each place, balanced across edges.
 * Neighbouring instances join without cracks and without skirts: edges read their heights from the coarsest DEM
 * touching them, and the edge midpoints of an instance lie on the edge of a coarser or same-level neighbour, or at
 * the vertices of finer ones. The CPU only computes the cut when it changes, the position of each tile centre relative
 * to the camera every frame, and a coarse surface the camera picks. See `docs/draping.md` of 3d-tiles-core.
 */
export class GpuTerrainEngine implements ITerrainEngine<IGpuTerrainHandle> {
    public readonly name = "gpu";
    public readonly material: ShaderMaterial;
    public readonly shapes: GridShapes;
    public readonly elevations: ElevationPages;
    public readonly grid: InstancedGrid;
    public readonly pickSurface: PickSurface;
    private readonly scene: Scene;
    private readonly tiling: ITerrainTiling;
    private readonly cells: number;
    private readonly elevation: ITerrainEngineInputs["elevation"];
    private readonly imageryPages: BabylonRasterPages | undefined;
    private readonly cut: DrapeInstanceCut;
    private readonly presented = new Map<string, IGpuTerrainHandle>();
    private readonly handles = new Set<IGpuTerrainHandle>();
    private readonly pageObserver: Observer<ITileAddress> | undefined;
    private readonly cameraObserver: Observer<Camera>;
    private placed: IPlacedInstance[] = [];
    private readonly verticalScale: VerticalScale;
    private readonly stopVerticalScale: () => void;
    /** DEM tiles of the cover being loaded. */
    private readonly fillRequests = new Set<string>();
    private dirty = true;
    private created = 0;
    private released = 0;

    public constructor(inputs: ITerrainEngineInputs, options: IGpuTerrainEngineOptions = {}) {
        this.scene = inputs.scene;
        this.tiling = inputs.tiling ?? webMercatorTiling();
        this.cells = options.cells ?? TERRAIN_CONFIG.grid.cells;
        this.elevation = inputs.elevation;
        this.imageryPages = inputs.wireframe ? undefined : inputs.imageryPages;
        this.verticalScale = sharedVerticalScale(inputs.elevation?.verticalScale);
        this.stopVerticalScale = this.verticalScale.subscribe((scale) => {
            this.material.setFloat("verticalScale", scale);
            this.pickSurface.setVerticalScale(scale);
        });
        this.cut = new DrapeInstanceCut({
            topology: this.tiling.topology,
            // Elevation may be deeper in places: both sides of an edge read the coarser data, on a tiling covering a body.
            ...(this.tiling.coverRoots && inputs.elevation
                ? { terrainDataLevel: (terrain: ITileAddress) => inputs.elevation!.pyramid.rasters.areaOf(terrain).ancestor.lod }
                : {}),
            maxDepth: options.maxInstanceDepth ?? TERRAIN_CONFIG.gpu.maxInstanceDepth,
            holdMilliseconds: options.holdMilliseconds ?? TERRAIN_CONFIG.gpu.holdMilliseconds,
        });
        // Shapes hold the half-cell lattice: the grid vertices and the edge midpoints.
        this.shapes = new GridShapes(this.scene, 2 * this.cells, this.tiling);
        this.elevations = new ElevationPages(
            this.scene,
            inputs.elevation?.pyramid,
            options.elevationPageSize ?? TERRAIN_CONFIG.dem.tileCells + 1,
        );
        this.pickSurface = new PickSurface(
            this.scene,
            inputs.elevation?.pyramid,
            this.verticalScale.value,
            options.pickCells ?? TERRAIN_CONFIG.gpu.pickCells,
            this.tiling,
        );

        this.material = new ShaderMaterial(
            "gpu-terrain",
            this.scene,
            { vertexSource: instancedGridVertexShader.shader, fragmentSource: instancedGridPixelShader.shader },
            {
                attributes: ["position", ...INSTANCE_ATTRIBUTES],
                uniforms: [
                    "viewProjection",
                    "cells",
                    "verticalScale",
                    "baseColor",
                    "sunDirection",
                    "sunColor",
                    "skyDirection",
                    "skyColor",
                    "groundColor",
                    "imagerySize",
                    "inverseRadiiSquared",
                ],
                samplers: ["shapes", "elevations", "imagery"],
                defines: [
                    ...(this.imageryPages ? ["#define IMAGERY"] : []),
                    ...(this.tiling.radialHeights ? ["#define RADIAL_HEIGHTS"] : []),
                ],
            },
        );
        this.material.backFaceCulling = false;
        this.material.wireframe = inputs.wireframe;
        this.material.setFloat("cells", this.cells);
        this.material.setFloat("verticalScale", this.verticalScale.value);
        // The shaded colour of the mesh engine where no imagery is draped.
        this.material.setColor3("baseColor", new Color3(0.47, 0.5, 0.45));
        this.material.setTexture("shapes", this.shapes.pool);
        this.material.setTexture("elevations", this.elevations.pool);
        const radii = this.tiling.referenceRadii;
        if (radii) this.material.setVector3("inverseRadiiSquared", new Vector3(1 / radii[0] ** 2, 1 / radii[1] ** 2, 1 / radii[2] ** 2));
        if (this.imageryPages) {
            this.material.setTexture("imagery", this.imageryPages.pool);
            this.material.setFloat("imagerySize", this.imageryPages.size);
        }
        this.updateLights();
        this.grid = new InstancedGrid(this.scene, "gpu-terrain", refinedGridTopology(this.cells), this.material);

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
                const heights = await this.elevation?.pyramid.tileHeights(identity, context.signal);
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
                        ? {
                              tileBoundingVolume: () =>
                                  this.tiling.boundingBox
                                      ? {
                                            box: this.tiling.boundingBox(
                                                identity,
                                                heights.range.minimum * this.verticalScale.value,
                                                heights.range.maximum * this.verticalScale.value,
                                            ) as never,
                                        }
                                      : { region: regionWithHeights(tileRegion(context), heights.range, this.verticalScale.value) },
                              // Web Mercator reads its heights from its region.
                              ...(this.tiling.boundingBox
                                  ? {
                                        tileHeightRange: () =>
                                            [
                                                heights.range.minimum * this.verticalScale.value,
                                                heights.range.maximum * this.verticalScale.value,
                                            ] as const,
                                    }
                                  : {}),
                          }
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
            const pyramid = this.elevation?.pyramid;
            pyramid?.retain(handle.identity);
            // A tile shown again after its DEM left the cache reloads it, then reads it again.
            if (pyramid && !pyramid.isResident(handle.identity))
                void pyramid.tileHeights(handle.identity).then(() => {
                    this.pickSurface.refresh(handle.identity);
                    this.dirty = true;
                });
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
        return {
            handles: this.handles.size,
            presented: this.presented.size,
            created: this.created,
            released: this.released,
            cpuBytes: 0,
            gpuBytes: this.shapes.pool.gpuBytes + this.elevations.pool.gpuBytes + this.grid.gpuBytes,
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
        this.verticalScale.set(scale);
    }

    public dispose(): void {
        this.stopVerticalScale();
        this.scene.onBeforeCameraRenderObservable.remove(this.cameraObserver);
        if (this.pageObserver) this.imageryPages?.changed.remove(this.pageObserver);
        this.releaseResources(this.placed);
        this.placed = [];
        for (const handle of this.presented.values()) this.elevation?.pyramid.release(handle.identity);
        this.presented.clear();
        this.grid.dispose();
        this.pickSurface.dispose();
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
        const instances = this.cut.update([...terrain, ...this.coverFill(terrain)], imagery, now);
        this.pickSurface.update(terrain);

        // Acquire the resources of the new cut before releasing those of the previous one, so shared ones stay.
        const previous = this.placed;
        const grid = this.grid;
        grid.resize(instances.length);
        const place = grid.attribute("instPlace");
        const rotation = grid.attribute("instRotation");
        const imageryAreas = grid.attribute("instImagery");
        const elevationAreas = ELEVATION_ATTRIBUTES.map((name) => grid.attribute(name));
        this.placed = instances.map((instance, index) => {
            const { address } = instance;
            const offset = index * 4;
            const demTiles: ITileAddress[] = [];
            place[offset + 3] = this.shapes.acquire(address) ?? 0;

            const center = this.tiling.center(address);
            if (this.tiling.radialHeights) {
                // Radial heights follow the direction of each vertex, from the tile centre; the shape is not turned.
                rotation.set([center.x, center.y, center.z, instance.finerEdges], offset);
            } else {
                const longitude = this.tiling.rotation(address);
                rotation.set([Math.cos(longitude), Math.sin(longitude), (2 * Math.PI) / 2 ** address.lod, instance.finerEdges], offset);
            }

            const cover = this.imageryPages?.resident.cover(address);
            imageryAreas.set(cover ? [cover.west, cover.north, cover.size, cover.value] : [0, 0, 1, -1], offset);

            const own = this.elevationArea(address, instance.terrain, demTiles);
            const sources = [instance.terrain, ...instance.edgeTerrain, ...instance.cornerTerrain];
            sources.forEach((terrainTile, slot) => {
                // A neighbour DEM not in memory falls back to the instance's own.
                const area = slot === 0 ? own : (this.elevationArea(address, terrainTile, demTiles) ?? own);
                elevationAreas[slot]!.set(area ?? [0, 0, 1, -1], offset);
            });
            return { instance, center, demTiles };
        });
        grid.upload("instRotation", "instImagery", ...ELEVATION_ATTRIBUTES);
        this.releaseResources(previous);
        this.place();
    }

    /**
     * Tiles drawn where the selection left no tile, on a tiling covering a whole body: a selection is computed for a camera
     * that has since moved, and coarse terrain is better than a hole at the edges of the image. A tile whose DEM is not in
     * memory is requested, and reads the DEM of its nearest ancestor in memory until it arrives.
     */
    private coverFill(terrain: readonly ITileAddress[]): ITileAddress[] {
        const roots = this.tiling.coverRoots;
        const pyramid = this.elevation?.pyramid;
        if (!roots || !pyramid) return [];
        return completeTileCover(terrain, roots, (address) => {
            if (pyramid.isResident(address)) return true;
            const requestKey = key(address);
            if (!this.fillRequests.has(requestKey)) {
                this.fillRequests.add(requestKey);
                void pyramid
                    .tileHeights(address)
                    .catch((error: unknown) => console.error("A terrain tile of the cover failed", error))
                    .finally(() => {
                        this.fillRequests.delete(requestKey);
                        this.dirty = true;
                    });
            }
            for (let ancestor = parentTileAddress(address); ancestor; ancestor = parentTileAddress(ancestor)) {
                if (pyramid.isResident(ancestor)) return true;
            }
            return false;
        });
    }

    /**
     * Area of a tile in the DEM tile serving a terrain tile and the layer of its page, acquiring the page.
     *
     * @returns `undefined` when there is no elevation or the DEM tile is not in memory.
     */
    private elevationArea(
        address: ITileAddress,
        terrain: ITileAddress,
        demTiles: ITileAddress[],
    ): [number, number, number, number] | undefined {
        if (!this.elevation) return undefined;
        let demTile = this.elevation.pyramid.rasters.areaOf(terrain).ancestor;
        let layer = this.elevations.acquire(demTile);
        // On a tiling covering a whole body, a tile of the cover reads its nearest ancestor until its DEM arrives.
        while (layer === undefined && this.tiling.coverRoots) {
            const parent = parentTileAddress(demTile);
            if (!parent) break;
            demTile = parent;
            layer = this.elevations.acquire(demTile);
        }
        if (layer === undefined) return undefined;
        demTiles.push(demTile);
        // The tile is never coarser than the DEM tile; it may lie outside it, on its edge, for a neighbour's DEM, turned
        // across a cube face. The fraction of the layer holds the quarter turns.
        const area = this.tiling.demArea(address, demTile);
        return [area.west, area.north, area.size, layer + area.turns / 4];
    }

    /** Releases the shapes and elevation pages acquired for instances. */
    private releaseResources(instances: readonly IPlacedInstance[]): void {
        for (const { instance, demTiles } of instances) {
            this.shapes.release(instance.address);
            for (const demTile of demTiles) this.elevations.release(demTile);
        }
    }

    /** Writes the tile centres relative to the camera, in double precision, and the light uniforms. */
    private place(): void {
        const eye = this.scene.floatingOriginOffset;
        const place = this.grid.attribute("instPlace");
        this.placed.forEach(({ center }, index) => {
            place[index * 4] = center.x - eye.x;
            place[index * 4 + 1] = center.y - eye.y;
            place[index * 4 + 2] = center.z - eye.z;
        });
        this.grid.upload("instPlace");
        this.updateLights();
    }

    /** Passes the first directional and hemispheric lights of the scene, as the standard material sees them. */
    private updateLights(): void {
        const sun = this.scene.lights.find((light): light is DirectionalLight => light instanceof DirectionalLight && light.isEnabled());
        const sky = this.scene.lights.find((light): light is HemisphericLight => light instanceof HemisphericLight && light.isEnabled());
        this.material.setVector3("sunDirection", sun ? sun.direction.negate().normalize() : Vector3.Up());
        this.material.setColor3("sunColor", sun ? sun.diffuse.scale(sun.intensity) : Color3.White());
        this.material.setVector3("skyDirection", sky ? sky.direction.normalizeToNew() : Vector3.Up());
        this.material.setColor3("skyColor", sky ? sky.diffuse.scale(sky.intensity) : Color3.Black());
        this.material.setColor3("groundColor", sky ? sky.groundColor.scale(sky.intensity) : Color3.Black());
    }
}
