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
    selectSurfaceLevels,
    webMercatorSurfaceNormal,
    type DemPyramid,
    type IHeightRange,
    type SurfaceLevelPolicy,
} from "@spacexr/dem";
import { DisplayedTiles, type JunctionPolicy } from "./displayed-tiles";
import {
    composeElevatedPositions,
    type IElevatedGridGeometry,
    projectElevatedGrid,
    projectGridTopologyToEllipsoid,
} from "./geodesic-grid-geometry";

const GRID_SUBDIVISIONS = 16;
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
    /** DEM surface, which also records the ranges prepared for child tiles. */
    pyramid: DemPyramid;
    /** Initial vertical scale applied to every height. Defaults to 1. */
    verticalScale?: number;
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
 * DEM of the levels the policy selects, so their edges meet.
 */
export type EdgeHeightPolicy = SurfaceLevelPolicy;

/** Height in metres at normalized tile coordinates, `u` west to east and `v` north to south. */
type HeightSampler = (u: number, v: number) => number;

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
                const heights = await this.elevation?.pyramid.tileHeights(
                    tileIdentity(context),
                );
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
        return [...selectSurfaceLevels(levels, this.edgeHeights)];
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
        const pyramid = this.elevation!.pyramid;
        for (
            let vertex = 0;
            vertex < topology.coordinates.length / 2;
            vertex++
        ) {
            const u = topology.coordinates[vertex * 2]!;
            const v = topology.coordinates[vertex * 2 + 1]!;
            const x = (column + u) / count;
            const y = (row + v) / count;
            // One grid cell at the displayed level: the samples fall on the neighbouring vertices, so normals
            // describe the mesh surface rather than DEM detail the triangles cannot show.
            const gradient = pyramid.surfaceGradient(
                x,
                y,
                this.surfaceLevels(handle.identity, u, v),
                this.subdivisions,
            );
            if (!gradient) continue;
            const up = {
                x: elevated.up[vertex * 3]!,
                y: elevated.up[vertex * 3 + 1]!,
                z: elevated.up[vertex * 3 + 2]!,
            };
            if (up.x === 0 && up.y === 0) continue;
            const normal = webMercatorSurfaceNormal(
                gradient,
                up,
                this.verticalScale,
            );
            // Keep the orientation Babylon gives the mesh: its winding convention decides which side is lit.
            const meshSide =
                normals[vertex * 3]! * normal.x +
                    normals[vertex * 3 + 1]! * normal.y +
                    normals[vertex * 3 + 2]! * normal.z <
                0
                    ? -1
                    : 1;
            normals[vertex * 3] = normal.x * meshSide;
            normals[vertex * 3 + 1] = normal.y * meshSide;
            normals[vertex * 3 + 2] = normal.z * meshSide;
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
                  const height = this.elevation!.pyramid.surfaceHeight(
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
