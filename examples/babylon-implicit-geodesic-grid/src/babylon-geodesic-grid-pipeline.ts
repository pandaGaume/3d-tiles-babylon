import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type {
    IBabylonTileResourceStatistics,
    IBabylonTileResourceStatisticsProvider,
} from "@spacexr/3d-tiles-babylon";
import {
    NO_METADATA,
    type IEcefSpatialState,
    type ITileActivationAdapter,
    type ITileActivationContext,
    type ITileDeactivationContext,
    type ITilePresentationAdapter,
    type ITilePresentationContext,
    type ITileAddress,
    type MetadataHandle,
} from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem } from "@spacexr/geodesy";
import {
    JunctionGridTopologyCache,
    type IGridTopology,
    SAME_EDGE_LODS,
    edgeLodsKey,
    type GridEdgeLods,
} from "@spacexr/grid";
import {
    ancestorTileAddress,
    heightRangeInArea,
    loadDemTile,
    sampleHeightBilinear,
    StitchedHeightGrids,
    TileNeighbor,
    tileNeighborAddress,
    type DemInfos,
    type IDemTileSource,
    type IHeightRange,
    type IDemDecoder,
    type QuadrantHeightRanges,
} from "@spacexr/tiles";

import type { ChildHeightRanges } from "./child-height-ranges";
import { DisplayedTiles, type JunctionPolicy } from "./displayed-tiles";
import {
    composeElevatedPositions,
    type IElevatedGridGeometry,
    projectElevatedGrid,
    projectGridTopologyToEllipsoid,
} from "./geodesic-grid-geometry";

const GRID_SUBDIVISIONS = 16;
/** DEM tiles kept in memory, so that grids deeper than the DEM reuse their common ancestor. */
const DEM_CACHE_ENTRIES = 256;
const LOD_COLORS = [
    "#2f80ed",
    "#00c2ff",
    "#12b886",
    "#ffd43b",
    "#ff922b",
    "#fa5252",
    "#cc5de8",
    "#845ef7",
] as const;

export interface IBabylonGeodesicGridHandle {
    mesh: Mesh;
    identity: ITileAddress;
    center: Vector3;
    label: HTMLSpanElement;
    presented: boolean;
    metadataHandle: MetadataHandle;
    estimatedCpuBytes: number;
    estimatedGpuBytes: number;
    /** Present when the grid carries DEM heights. */
    elevated: IElevatedGridGeometry | undefined;
    region: readonly number[];
    /** Unscaled heights of the tile, kept to rebuild the grid when its neighbours change. */
    heightAt: HeightSampler | undefined;
    /** Neighbour levels the current grid connects to. */
    lods: GridEdgeLods;
    /** Levels of detail displayed along the edges when the grid was built. */
    edgeLevels: string;
}

/** Elevation applied to grid vertices, one DEM tile per grid tile. */
export interface IGridElevationOptions {
    dem: IDemTileSource;
    /** Decodes DEM tiles, preferably in workers. */
    demDecoder: IDemDecoder;
    /** Initial vertical scale applied to every height. Defaults to 1. */
    verticalScale?: number;
    /** Receives the quadrant ranges of each loaded tile, prepared for its four children. */
    childHeightRanges?: ChildHeightRanges;
}

export interface IBabylonGeodesicGridPipelineOptions {
    wireframe?: boolean;
    /** Displaces vertices with DEM heights. Without it, grids lie on the region minimum height. */
    elevation?: IGridElevationOptions;
    /** Tile adapting its edge between two levels of detail. Defaults to `fine`. */
    junctions?: JunctionPolicy;
    /** Heights of the edge vertices shared with other levels. Defaults to `coarsest`. */
    edgeHeights?: EdgeHeightPolicy;
}

/**
 * Height of a tile edge vertex touched by tiles of several levels of detail.
 * Every tile touching the vertex computes the same height from the stitched
 * DEM of these levels, so their edges meet:
 *
 * - `coarsest`: the DEM of the coarsest level, which keeps coarse tiles intact;
 * - `finest`: the DEM of the finest level, which keeps the finest detail;
 * - `average`: the mean over the distinct DEM levels.
 */
export type EdgeHeightPolicy = "coarsest" | "finest" | "average";

/** Height in metres at normalized tile coordinates, `u` west to east and `v` north to south. */
type HeightSampler = (u: number, v: number) => number;

/** Unscaled heights of one grid tile and the ranges measured with them. */
interface ITileHeights {
    sampler: HeightSampler;
    /** Range of the tile. */
    range: IHeightRange;
    /** Ranges of the four children, in north-west, north-east, south-west, south-east order. */
    quadrants: QuadrantHeightRanges;
}

/** Region whose height interval is a measured range multiplied by a vertical scale. */
function regionWithHeights(
    region: readonly number[],
    range: IHeightRange,
    scale: number,
): [number, number, number, number, number, number] {
    return [
        region[0]!,
        region[1]!,
        region[2]!,
        region[3]!,
        range.minimum * scale,
        range.maximum * scale,
    ];
}

function tileRegion(
    context: ITileActivationContext<
        IEcefSpatialState,
        IBabylonGeodesicGridHandle,
        never
    >,
): readonly number[] {
    const region = context.tile.source.boundingVolume.region;
    if (!region)
        throw new Error(
            `Tile ${context.tile.id} does not expose a geodetic region.`,
        );
    return region;
}

function tileIdentity(
    context: ITileActivationContext<
        IEcefSpatialState,
        IBabylonGeodesicGridHandle,
        never
    >,
): ITileAddress {
    const properties = context.tile.source.metadata?.properties;
    const readCoordinate = (name: "lod" | "x" | "y"): number => {
        const value = properties?.[name];
        if (typeof value !== "number" || !Number.isSafeInteger(value))
            throw new Error(
                `Tile ${context.tile.id} has no valid ${name} metadata.`,
            );
        return value;
    };
    return {
        lod: readCoordinate("lod"),
        x: readCoordinate("x"),
        y: readCoordinate("y"),
    };
}

function regionCenter(region: readonly number[]): Vector3 {
    const [west, south, east, north, minimumHeight, maximumHeight] = region;
    if (
        west === undefined ||
        south === undefined ||
        east === undefined ||
        north === undefined ||
        minimumHeight === undefined ||
        maximumHeight === undefined
    )
        throw new RangeError("The 3D Tiles region is incomplete.");

    const center = GeodeticSystem.WGS84.geodeticRadiansToEcef(
        (south + north) / 2,
        (west + east) / 2,
        (minimumHeight + maximumHeight) / 2,
    );
    return new Vector3(center.x, center.y, center.z);
}

function lodColor(lod: number): string {
    return LOD_COLORS[lod % LOD_COLORS.length]!;
}

/**
 * Babylon implementation of the renderer-neutral runtime ports.
 *
 * The adapter shares only normalized grid topology. It computes unique ECEF
 * positions for each tile from its 3D Tiles region and the WGS84 ellipsoid.
 * A future shader implementation can reuse the same topology and move that
 * projection to the GPU, allowing instances without changing runtime ports.
 */
export class BabylonGeodesicGridPipeline
    implements
        IBabylonTileResourceStatisticsProvider,
        ITileActivationAdapter<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
        ITilePresentationAdapter<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >
{
    private readonly handles = new Set<IBabylonGeodesicGridHandle>();
    private readonly materialsByLod = new Map<number, StandardMaterial>();
    private readonly topologies: JunctionGridTopologyCache;
    private readonly displayed = new DisplayedTiles();
    private readonly junctions: JunctionPolicy;
    private readonly edgeHeights: EdgeHeightPolicy;
    private readonly subdivisions: number;
    private junctionsDirty = false;
    private readonly labelLayer: HTMLElement;
    private readonly scene: Scene;
    private readonly wireframe: boolean;
    private readonly elevation: IGridElevationOptions | undefined;
    /** DEM tiles with the extra column and row of their east, south and south-east neighbours. */
    private readonly stitchedDem = new StitchedHeightGrids({ wrapX: true });
    private readonly demCache = new Map<
        string,
        Promise<DemInfos | undefined>
    >();
    private verticalScale: number;
    private createdHandleCount = 0;
    private releasedHandleCount = 0;

    public constructor(
        scene: Scene,
        labelLayer: HTMLElement,
        options: IBabylonGeodesicGridPipelineOptions = {},
        subdivisions = GRID_SUBDIVISIONS,
    ) {
        this.scene = scene;
        this.labelLayer = labelLayer;
        this.wireframe = options.wireframe ?? true;
        this.elevation = options.elevation;
        this.verticalScale = options.elevation?.verticalScale ?? 1;
        this.junctions = options.junctions ?? "fine";
        this.edgeHeights = options.edgeHeights ?? "coarsest";
        this.subdivisions = subdivisions;
        this.topologies = new JunctionGridTopologyCache(subdivisions);
    }

    public async activate(
        context: ITileActivationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
    ): Promise<void> {
        for (const content of context.pendingContents) {
            if (context.signal.aborted) {
                await context.readiness.cancelled(content.id);
                continue;
            }
            try {
                const heights = await this.loadHeights(tileIdentity(context));
                if (context.signal.aborted) {
                    await context.readiness.cancelled(content.id);
                    continue;
                }
                const handle = this.createHandle(
                    context,
                    content.id,
                    heights?.sampler,
                );
                const accepted = await context.readiness.ready(content.id, {
                    kind: "renderable",
                    handle,
                    cacheKey: content.uri,
                    cost: {
                        cpuBytes: handle.estimatedCpuBytes,
                        gpuBytes: handle.estimatedGpuBytes,
                        networkBytes: 0,
                    },
                    // The tile starts at 0/0; its DEM gives the measured height range.
                    ...(heights &&
                    !Number.isNaN(heights.range.minimum) &&
                    !Number.isNaN(heights.range.maximum)
                        ? {
                              tileBoundingVolume: {
                                  region: regionWithHeights(
                                      tileRegion(context),
                                      heights.range,
                                      this.verticalScale,
                                  ),
                              },
                          }
                        : {}),
                });
                if (!accepted) this.disposeHandle(handle);
            } catch (error) {
                if (context.signal.aborted)
                    await context.readiness.cancelled(content.id);
                else await context.readiness.failed(content.id, error);
            }
        }
    }

    public deactivate(
        _context: ITileDeactivationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
    ): void {
        // Selection and visual presentation intentionally remain separate.
    }

    public present(
        context: ITilePresentationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
    ): void {
        for (const resource of context.resources) {
            resource.handle.metadataHandle = resource.metadataHandle;
            if (!resource.handle.presented)
                this.displayed.add(resource.handle.identity);
            resource.handle.presented = true;
            resource.handle.mesh.isVisible = true;
        }
        this.junctionsDirty = true;
    }

    public hide(
        context: ITilePresentationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
    ): void {
        for (const resource of context.resources) {
            if (resource.handle.presented)
                this.displayed.delete(resource.handle.identity);
            resource.handle.presented = false;
            resource.handle.mesh.isVisible = false;
            resource.handle.label.style.display = "none";
        }
        this.junctionsDirty = true;
    }

    public release(
        context: ITilePresentationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
    ): void {
        for (const resource of context.resources)
            this.disposeHandle(resource.handle);
    }

    /**
     * Reconnects the edges of the presented grids to the levels of detail
     * displayed next to them. Call once per frame, before rendering; it only
     * works after a presentation change, and only rebuilds the grids whose
     * neighbour levels changed, in their topology or in their edge heights.
     */
    public updateJunctions(): void {
        if (!this.junctionsDirty) return;
        this.junctionsDirty = false;
        for (const handle of this.handles) {
            if (!handle.presented) continue;
            const lods = this.displayed.edgeLods(
                handle.identity,
                this.junctions,
            );
            const edgeLevels = handle.heightAt
                ? this.edgeLevelsSignature(handle.identity)
                : "";
            if (
                edgeLodsKey(lods) !== edgeLodsKey(handle.lods) ||
                edgeLevels !== handle.edgeLevels
            ) {
                handle.edgeLevels = edgeLevels;
                this.applyGeometry(handle, lods);
            }
        }
    }

    /** Projects labels for the current presentation cut into screen space. */
    public updateDebugLabels(): void {
        const camera = this.scene.activeCamera;
        if (!camera) return;

        const engine = this.scene.getEngine();
        const width = engine.getRenderWidth();
        const height = engine.getRenderHeight();
        const viewport = camera.viewport.toGlobal(width, height);
        const transform = this.scene.getTransformMatrix();
        const margin = 80;

        for (const handle of this.handles) {
            if (!handle.presented) {
                handle.label.style.display = "none";
                continue;
            }

            const projected = Vector3.Project(
                handle.center,
                Matrix.IdentityReadOnly,
                transform,
                viewport,
            );
            const insideViewport =
                projected.z >= 0 &&
                projected.z <= 1 &&
                projected.x >= -margin &&
                projected.x <= width + margin &&
                projected.y >= -margin &&
                projected.y <= height + margin;
            if (!insideViewport) {
                handle.label.style.display = "none";
                continue;
            }

            handle.label.style.display = "block";
            handle.label.style.transform = `translate3d(${projected.x}px, ${projected.y}px, 0) translate(-50%, -50%)`;
        }
    }

    public dispose(): void {
        for (const handle of [...this.handles]) this.disposeHandle(handle);
        for (const material of this.materialsByLod.values()) material.dispose();
        this.materialsByLod.clear();
    }

    /** Returns the resources that are actually retained by the Babylon adapter. */
    public getStatistics(): IBabylonTileResourceStatistics {
        let presented = 0;
        let cpuBytes = 0;
        let gpuBytes = 0;
        for (const handle of this.handles) {
            if (handle.presented) presented++;
            cpuBytes += handle.estimatedCpuBytes;
            gpuBytes += handle.estimatedGpuBytes;
        }
        return {
            handles: this.handles.size,
            presented,
            created: this.createdHandleCount,
            released: this.releasedHandleCount,
            cpuBytes,
            gpuBytes,
        };
    }

    /** Current vertical scale applied to DEM heights. */
    public get currentVerticalScale(): number {
        return this.verticalScale;
    }

    /**
     * Changes the vertical scale of every elevated grid in place. Tiles keep
     * the bounding volume reported with the scale they were loaded with; new
     * tiles report volumes for the new scale.
     */
    public setVerticalScale(scale: number): void {
        if (!Number.isFinite(scale) || scale < 0)
            throw new RangeError("The vertical scale must be non-negative.");
        this.verticalScale = scale;
        for (const handle of this.handles) {
            if (!handle.elevated) continue;
            const positions = composeElevatedPositions(handle.elevated, scale);
            const normals = this.surfaceNormals(
                handle,
                this.topologies.get(handle.lods),
                handle.elevated,
                positions,
            );
            handle.mesh.updateVerticesData(
                VertexBuffer.PositionKind,
                positions,
            );
            handle.mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
            handle.mesh.refreshBoundingInfo();
        }
    }

    /**
     * Loads the heights of a grid tile with its range and the ranges of its
     * four children, which are recorded for the next zoom level.
     *
     * Beyond the DEM maximum level, the ancestor DEM tile is sampled on the
     * matching sub-area (overzoom), and ranges cover every DEM sample that can
     * influence a bilinear sample in the area. Returns `undefined` when
     * elevation is disabled or the DEM tile does not exist.
     *
     * The DEM tile is stitched with its east, south and south-east neighbours
     * and sampled in `point` registration, so that neighbouring grids read the
     * same samples on their shared edge.
     */
    private async loadHeights(
        identity: ITileAddress,
    ): Promise<ITileHeights | undefined> {
        if (!this.elevation) return undefined;
        const { dem } = this.elevation;
        const demLod = Math.min(identity.lod, dem.source.metrics.maxLOD);
        const levels = identity.lod - demLod;
        const ancestor = ancestorTileAddress(identity, levels);
        const neighbors = [TileNeighbor.E, TileNeighbor.S, TileNeighbor.SE]
            .map((position) =>
                tileNeighborAddress(ancestor, position, { wrapX: true }),
            )
            .filter((address) => address !== undefined);
        const [demGrid] = await Promise.all([
            this.cachedDem(ancestor),
            // A missing neighbour only leaves the repeated edge of the tile.
            ...neighbors.map((address) =>
                this.cachedDem(address).catch(() => undefined),
            ),
        ]);
        if (!demGrid) return undefined;
        if (!this.stitchedDem.has(ancestor))
            this.stitchedDem.add(ancestor, demGrid);
        const grid = this.stitchedDem.get(ancestor)!;

        const scale = 2 ** levels;
        const west = (identity.x - ancestor.x * scale) / scale;
        const north = (identity.y - ancestor.y * scale) / scale;
        const size = 1 / scale;
        const half = size / 2;
        const rangeOf = (
            areaWest: number,
            areaNorth: number,
            areaSize: number,
        ) =>
            heightRangeInArea(
                grid,
                areaWest,
                areaNorth,
                areaWest + areaSize,
                areaNorth + areaSize,
                "point",
            );
        const range = rangeOf(west, north, size);
        const quadrants: QuadrantHeightRanges = [
            rangeOf(west, north, half),
            rangeOf(west + half, north, half),
            rangeOf(west, north + half, half),
            rangeOf(west + half, north + half, half),
        ];
        this.elevation.childHeightRanges?.recordChildren(identity, quadrants);
        return {
            sampler: (u, v) =>
                sampleHeightBilinear(
                    grid,
                    west + u * size,
                    north + v * size,
                    "point",
                ),
            range,
            quadrants,
        };
    }

    /**
     * Loads a DEM tile once and shares it between grids. The request is not
     * bound to one activation signal, because other grids may await it.
     */
    private cachedDem(address: ITileAddress): Promise<DemInfos | undefined> {
        const { dem, demDecoder } = this.elevation!;
        const key = `${address.lod}/${address.x}/${address.y}`;
        const cached = this.demCache.get(key);
        if (cached) {
            this.demCache.delete(key);
            this.demCache.set(key, cached);
            return cached;
        }
        const loading = loadDemTile(dem, address, demDecoder).then((tile) => {
            // Stitching completes the neighbours already loaded as well.
            if (tile?.content && this.demCache.has(key))
                this.stitchedDem.add(address, tile.content);
            return tile?.content;
        });
        loading.catch(() => this.demCache.delete(key));
        this.demCache.set(key, loading);
        if (this.demCache.size > DEM_CACHE_ENTRIES) {
            const oldest = this.demCache.keys().next().value;
            if (oldest !== undefined) {
                this.demCache.delete(oldest);
                const [lod, x, y] = oldest.split("/").map(Number);
                this.stitchedDem.delete({ lod: lod!, x: x!, y: y! });
            }
        }
        return loading;
    }

    private createHandle(
        context: ITileActivationContext<
            IEcefSpatialState,
            IBabylonGeodesicGridHandle,
            never
        >,
        contentId: string,
        heightAt?: HeightSampler,
    ): IBabylonGeodesicGridHandle {
        const region = tileRegion(context);
        const identity = tileIdentity(context);
        const mesh = new Mesh(`geodesic-grid-${contentId}`, this.scene);
        mesh.material = this.materialForLod(identity.lod);
        mesh.isVisible = false;
        mesh.alwaysSelectAsActiveMesh = true;

        const label = this.labelLayer.ownerDocument.createElement("span");
        label.className = "tile-label";
        label.textContent = `X ${identity.x}  Y ${identity.y}  LOD ${identity.lod}`;
        label.style.setProperty("--tile-color", lodColor(identity.lod));
        this.labelLayer.append(label);

        const handle: IBabylonGeodesicGridHandle = {
            mesh,
            identity,
            center: regionCenter(region),
            label,
            presented: false,
            metadataHandle: NO_METADATA,
            estimatedCpuBytes: 0,
            estimatedGpuBytes: 0,
            elevated: undefined,
            region,
            heightAt,
            lods: SAME_EDGE_LODS,
            edgeLevels: "",
        };
        // Neighbours are unknown until presentation; updateJunctions adapts the edges then.
        this.applyGeometry(handle, SAME_EDGE_LODS);
        this.handles.add(handle);
        this.createdHandleCount++;
        return handle;
    }

    /**
     * DEM height at a point of the pyramid, normalized `x` eastward and `y`
     * southward, from a loaded stitched DEM tile of the level containing it.
     * Stitched tiles share their edge samples, so either side of a tile edge
     * gives the same value. `NaN` when no such DEM tile is loaded.
     */
    private demHeight(x: number, y: number, demLod: number): number {
        const count = 2 ** demLod;
        const column = x * count;
        const row = y * count;
        const columns = Number.isInteger(column)
            ? [column, column - 1]
            : [Math.floor(column)];
        const rows = Number.isInteger(row) ? [row, row - 1] : [Math.floor(row)];
        for (const tileRow of rows) {
            if (tileRow < 0 || tileRow >= count) continue;
            for (const tileColumn of columns) {
                const grid = this.stitchedDem.get({
                    lod: demLod,
                    x: ((tileColumn % count) + count) % count,
                    y: tileRow,
                });
                if (grid)
                    return sampleHeightBilinear(
                        grid,
                        column - tileColumn,
                        row - tileRow,
                        "point",
                    );
            }
        }
        return Number.NaN;
    }

    /**
     * Displayed levels whose DEM surface a vertex follows: the level of its tile
     * inside the tile; on its edges, the levels chosen by the edge height policy
     * among the tiles displayed at that point, so that every tile touching the
     * vertex agrees on its height and normal.
     */
    private surfaceLevels(tile: ITileAddress, u: number, v: number): number[] {
        if (u !== 0 && u !== 1 && v !== 0 && v !== 1) return [tile.lod];
        const count = 2 ** tile.lod;
        const levels = this.displayed
            .touching((tile.x + u) / count, (tile.y + v) / count)
            .map((displayed) => displayed.lod);
        if (levels.length === 0) return [tile.lod];
        if (this.edgeHeights === "coarsest") return [levels[0]!];
        if (this.edgeHeights === "finest") return [levels[levels.length - 1]!];
        return levels;
    }

    /** DEM level sampled for a displayed level: overzoomed levels share the deepest DEM. */
    private demLevel(lod: number): number {
        return Math.min(lod, this.elevation!.dem.source.metrics.maxLOD);
    }

    /** Mean DEM height over levels, ignoring missing samples. */
    private surfaceHeight(
        x: number,
        y: number,
        levels: readonly number[],
    ): number {
        let sum = 0;
        let count = 0;
        for (const level of levels) {
            const height = this.demHeight(x, y, this.demLevel(level));
            if (Number.isNaN(height)) continue;
            sum += height;
            count++;
        }
        return count === 0 ? Number.NaN : sum / count;
    }

    /**
     * Height gradient of the DEM surface, in metres per normalized pyramid
     * unit along `x` and `y`, from central differences one grid cell apart.
     * Missing neighbours fall back to one-sided differences.
     */
    private surfaceGradient(
        x: number,
        y: number,
        levels: readonly number[],
    ): [number, number] | undefined {
        let gradientX = 0;
        let gradientY = 0;
        let count = 0;
        const difference = (
            before: number,
            center: number,
            after: number,
            step: number,
        ): number | undefined => {
            if (!Number.isNaN(before) && !Number.isNaN(after))
                return (after - before) / (2 * step);
            if (!Number.isNaN(after) && !Number.isNaN(center))
                return (after - center) / step;
            if (!Number.isNaN(before) && !Number.isNaN(center))
                return (center - before) / step;
            return undefined;
        };
        for (const level of levels) {
            // One grid cell at the displayed level: the samples fall on the neighbouring vertices, so normals
            // describe the mesh surface rather than DEM detail the triangles cannot show.
            const step = 1 / (this.subdivisions * 2 ** level);
            const demLod = this.demLevel(level);
            const center = this.demHeight(x, y, demLod);
            const alongX = difference(
                this.demHeight(x - step, y, demLod),
                center,
                this.demHeight(x + step, y, demLod),
                step,
            );
            const alongY = difference(
                this.demHeight(x, y - step, demLod),
                center,
                this.demHeight(x, y + step, demLod),
                step,
            );
            if (alongX === undefined || alongY === undefined) continue;
            gradientX += alongX;
            gradientY += alongY;
            count++;
        }
        return count === 0 ? undefined : [gradientX / count, gradientY / count];
    }

    /**
     * Normals of the DEM surface rather than of the mesh: a vertex shared by
     * several tiles receives the same normal in each of them, which removes the
     * shading seams along tile edges. Vertices without DEM keep mesh normals.
     */
    private surfaceNormals(
        handle: IBabylonGeodesicGridHandle,
        topology: IGridTopology,
        elevated: IElevatedGridGeometry,
        positions: number[],
    ): number[] {
        const normals: number[] = [];
        VertexData.ComputeNormals(positions, elevated.indices, normals);
        const { lod, x: column, y: row } = handle.identity;
        const count = 2 ** lod;
        const circumference =
            2 * Math.PI * GeodeticSystem.WGS84.ellipsoid.semiMajorAxis;
        for (
            let vertex = 0;
            vertex < topology.coordinates.length / 2;
            vertex++
        ) {
            const u = topology.coordinates[vertex * 2]!;
            const v = topology.coordinates[vertex * 2 + 1]!;
            const x = (column + u) / count;
            const y = (row + v) / count;
            const gradient = this.surfaceGradient(
                x,
                y,
                this.surfaceLevels(handle.identity, u, v),
            );
            if (!gradient) continue;
            const upX = elevated.up[vertex * 3]!;
            const upY = elevated.up[vertex * 3 + 1]!;
            const upZ = elevated.up[vertex * 3 + 2]!;
            const horizontal = Math.hypot(upX, upY);
            if (horizontal === 0) continue;
            // East and north of the local tangent plane; y grows southward on the map.
            const [eastX, eastY] = [-upY / horizontal, upX / horizontal];
            const [northX, northY, northZ] = [
                -upZ * eastY,
                upZ * eastX,
                upX * eastY - upY * eastX,
            ];
            // Web Mercator is conformal: one normalized unit spans circumference * cos(latitude) on the ground.
            const metres = circumference * horizontal;
            const slopeEast = (gradient[0] * this.verticalScale) / metres;
            const slopeNorth = (-gradient[1] * this.verticalScale) / metres;
            const normalX = upX - slopeEast * eastX - slopeNorth * northX;
            const normalY = upY - slopeEast * eastY - slopeNorth * northY;
            const normalZ = upZ - slopeNorth * northZ;
            // Keep the orientation Babylon gives the mesh: its winding convention decides which side is lit.
            const meshSide =
                normals[vertex * 3]! * normalX +
                    normals[vertex * 3 + 1]! * normalY +
                    normals[vertex * 3 + 2]! * normalZ <
                0
                    ? -1
                    : 1;
            const length = Math.hypot(normalX, normalY, normalZ) * meshSide;
            normals[vertex * 3] = normalX / length;
            normals[vertex * 3 + 1] = normalY / length;
            normals[vertex * 3 + 2] = normalZ / length;
        }
        return normals;
    }

    /** Levels of detail displayed at the points of the tile edges, to detect when edge heights change. */
    private edgeLevelsSignature(tile: ITileAddress): string {
        const count = 2 ** tile.lod;
        const steps = 2 * this.subdivisions;
        const levels: string[] = [];
        for (let step = 0; step < steps; step++) {
            const t = step / steps;
            // Clockwise from the north-west corner, half a cell apart.
            for (const [u, v] of [
                [t, 0],
                [1, t],
                [1 - t, 1],
                [0, 1 - t],
            ] as const) {
                levels.push(
                    this.displayed
                        .touching((tile.x + u) / count, (tile.y + v) / count)
                        .map((displayed) => displayed.lod)
                        .join(","),
                );
            }
        }
        return levels.join(";");
    }

    /** Builds the grid of a tile for the given neighbour levels and uploads it to its mesh. */
    private applyGeometry(
        handle: IBabylonGeodesicGridHandle,
        lods: GridEdgeLods,
    ): void {
        const topology = this.topologies.get(lods);
        const ownHeight = handle.heightAt;
        const { lod, x: column, y: row } = handle.identity;
        const count = 2 ** lod;
        const heightAt: HeightSampler | undefined = ownHeight
            ? (u, v) => {
                  const height = this.surfaceHeight(
                      (column + u) / count,
                      (row + v) / count,
                      this.surfaceLevels(handle.identity, u, v),
                  );
                  return Number.isNaN(height) ? ownHeight(u, v) : height;
              }
            : undefined;
        // Rows follow Web Mercator so that vertices line up with DEM pixels.
        const elevated = heightAt
            ? projectElevatedGrid(topology, handle.region, heightAt)
            : undefined;
        const geometry = elevated
            ? {
                  positions: composeElevatedPositions(
                      elevated,
                      this.verticalScale,
                  ),
                  uvs: elevated.uvs,
                  indices: elevated.indices,
              }
            : projectGridTopologyToEllipsoid(
                  topology,
                  handle.region,
                  GeodeticSystem.WGS84,
                  { latitudeInterpolation: "mercator" },
              );
        const normals: number[] = [];
        if (elevated)
            normals.push(
                ...this.surfaceNormals(
                    handle,
                    topology,
                    elevated,
                    geometry.positions,
                ),
            );
        else
            VertexData.ComputeNormals(
                geometry.positions,
                geometry.indices,
                normals,
            );

        const vertexData = new VertexData();
        vertexData.positions = geometry.positions;
        vertexData.uvs = geometry.uvs;
        vertexData.indices = geometry.indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(handle.mesh, elevated !== undefined);

        handle.elevated = elevated;
        handle.lods = lods;
        handle.estimatedCpuBytes =
            (geometry.positions.length + normals.length) *
                Float64Array.BYTES_PER_ELEMENT +
            geometry.uvs.byteLength +
            geometry.indices.byteLength;
        handle.estimatedGpuBytes =
            (geometry.positions.length + normals.length) *
                Float32Array.BYTES_PER_ELEMENT +
            geometry.uvs.byteLength +
            geometry.indices.byteLength;
    }

    private materialForLod(lod: number): StandardMaterial {
        const existing = this.materialsByLod.get(lod);
        if (existing) return existing;

        const color = Color3.FromHexString(lodColor(lod));
        const material = new StandardMaterial(
            `geodesic-grid-material-lod-${lod}`,
            this.scene,
        );
        material.specularColor = Color3.Black();
        if (this.wireframe) {
            material.diffuseColor = color.scale(0.55);
            material.emissiveColor = color;
            material.disableLighting = true;
        } else {
            // Shaded relief: the scene lights reveal slopes; a faint emissive keeps the LOD tint in shadows.
            material.diffuseColor = color.scale(0.9);
            material.emissiveColor = color.scale(0.08);
            material.twoSidedLighting = true;
        }
        material.wireframe = this.wireframe;
        material.backFaceCulling = false;
        material.useLogarithmicDepth = true;
        this.materialsByLod.set(lod, material);
        return material;
    }

    private disposeHandle(handle: IBabylonGeodesicGridHandle): void {
        if (!this.handles.delete(handle)) return;
        if (handle.presented) {
            this.displayed.delete(handle.identity);
            this.junctionsDirty = true;
        }
        this.releasedHandleCount++;
        handle.label.remove();
        handle.mesh.dispose(false, false);
    }
}
