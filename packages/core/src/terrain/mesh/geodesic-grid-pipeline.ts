import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";

import type { MeshRasterDrape } from "../../draping/mesh/mesh-raster-drape";
import type { IBabylonTileResourceStatistics, IBabylonTileResourceStatisticsProvider } from "../../monitor/runtime-monitor";
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
    VerticalScale,
} from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem } from "@spacexr/geodesy";
import { JunctionGridTopologyCache, type IGridTopology, SAME_EDGE_LODS, edgeLodsKey, type GridEdgeLods } from "@spacexr/grid";
import { selectSurfaceLevels, webMercatorSurfaceNormal, type DemPyramid, type SurfaceLevelPolicy } from "@spacexr/dem";
import { DisplayedTiles, type JunctionPolicy } from "../displayed-tiles";
import { regionCenter, regionWithHeights, tileIdentity, tileRegion } from "../terrain-tile";
import {
    composeElevatedPositions,
    type IElevatedGridGeometry,
    projectElevatedGrid,
    projectGridTopologyToEllipsoid,
} from "./geodesic-grid-geometry";

const GRID_SUBDIVISIONS = 16;
const LOD_COLORS = ["#2f80ed", "#00c2ff", "#12b886", "#ffd43b", "#ff922b", "#fa5252", "#cc5de8", "#845ef7"] as const;

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
    /** Vertical scale applied to every height: its initial value, or the scale shared by the scene. Defaults to 1. */
    verticalScale?: number | VerticalScale;
}

/** The vertical scale of an engine: the scale shared by the scene, or its own from an initial value. */
export function sharedVerticalScale(value: number | VerticalScale | undefined): VerticalScale {
    return value instanceof VerticalScale ? value : new VerticalScale(value ?? 1);
}

export interface IBabylonGeodesicGridPipelineOptions {
    wireframe?: boolean;
    /** Displaces vertices with DEM heights. Without it, grids lie on the region minimum height. */
    elevation?: IGridElevationOptions;
    /** Tile adapting its edge between two levels of detail. Defaults to `fine`. */
    junctions?: JunctionPolicy;
    /** Heights of the edge vertices shared with other levels. Defaults to `coarsest`. */
    edgeHeights?: EdgeHeightPolicy;
    /** Drapes imagery pages on shaded grids. Wireframe grids keep their level colours. */
    drape?: MeshRasterDrape;
    /**
     * Main-thread time per frame for the grids rebuilt by
     * {@link BabylonGeodesicGridPipeline.updateJunctions}, in milliseconds.
     * The rest waits for the next frames. Defaults to 4.
     */
    junctionBudgetMilliseconds?: number;
}

/**
 * Height of a tile edge vertex touched by tiles of several levels of detail.
 * Every tile touching the vertex computes the same height from the stitched
 * DEM of the levels the policy selects, so their edges meet.
 */
export type EdgeHeightPolicy = SurfaceLevelPolicy;

/** A grid to rebuild by `updateJunctions`, with its new edge levels. */
interface IJunctionRebuild {
    handle: IBabylonGeodesicGridHandle;
    lods: GridEdgeLods;
    edgeLevels: string;
    /** Squared distance from the camera to the tile centre. */
    distance: number;
}

/** Height in metres at normalized tile coordinates, `u` west to east and `v` north to south. */
type HeightSampler = (u: number, v: number) => number;

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
        ITileActivationAdapter<IEcefSpatialState, IBabylonGeodesicGridHandle, never>,
        ITilePresentationAdapter<IEcefSpatialState, IBabylonGeodesicGridHandle, never>
{
    private readonly handles = new Set<IBabylonGeodesicGridHandle>();
    private readonly materialsByLod = new Map<number, StandardMaterial>();
    private readonly topologies: JunctionGridTopologyCache;
    // The DEM tiles of the known cut stay in memory: edge heights and normals read them across tiles.
    private readonly displayed = new DisplayedTiles({
        onTrack: (address) => this.elevation?.pyramid.retain(address),
        onForget: (address) => this.elevation?.pyramid.release(address),
    });
    private readonly junctions: JunctionPolicy;
    private readonly edgeHeights: EdgeHeightPolicy;
    private readonly subdivisions: number;
    private junctionsDirty = false;
    private readonly junctionBudgetMilliseconds: number;
    private readonly labelLayer: HTMLElement;
    private readonly scene: Scene;
    private readonly wireframe: boolean;
    private readonly elevation: IGridElevationOptions | undefined;
    private readonly drape: MeshRasterDrape | undefined;
    private readonly verticalScale: VerticalScale;
    private readonly stopVerticalScale: () => void;
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
        this.drape = options.wireframe === false ? options.drape : undefined;
        this.verticalScale = sharedVerticalScale(options.elevation?.verticalScale);
        this.stopVerticalScale = this.verticalScale.subscribe((scale) => this.applyVerticalScale(scale));
        this.junctions = options.junctions ?? "fine";
        this.edgeHeights = options.edgeHeights ?? "coarsest";
        this.junctionBudgetMilliseconds = options.junctionBudgetMilliseconds ?? 4;
        this.subdivisions = subdivisions;
        this.topologies = new JunctionGridTopologyCache(subdivisions);
    }

    public async activate(context: ITileActivationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>): Promise<void> {
        for (const content of context.pendingContents) {
            if (context.signal.aborted) {
                await context.readiness.cancelled(content.id);
                continue;
            }
            try {
                const heights = await this.elevation?.pyramid.tileHeights(tileIdentity(context));
                if (context.signal.aborted) {
                    await context.readiness.cancelled(content.id);
                    continue;
                }
                const handle = this.createHandle(context, content.id, heights?.sampler);
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
                    ...(heights && !Number.isNaN(heights.range.minimum) && !Number.isNaN(heights.range.maximum)
                        ? {
                              tileBoundingVolume: () => ({
                                  region: regionWithHeights(tileRegion(context), heights.range, this.verticalScale.value),
                              }),
                          }
                        : {}),
                });
                if (!accepted) this.disposeHandle(handle);
            } catch (error) {
                if (context.signal.aborted) await context.readiness.cancelled(content.id);
                else await context.readiness.failed(content.id, error);
            }
        }
    }

    public deactivate(_context: ITileDeactivationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>): void {
        // Selection and visual presentation intentionally remain separate.
    }

    public present(context: ITilePresentationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>): void {
        for (const resource of context.resources) {
            const handle = resource.handle;
            handle.metadataHandle = resource.metadataHandle;
            if (!handle.presented) this.displayed.add(handle.identity);
            handle.presented = true;
            handle.mesh.isVisible = true;
            // A tile shown again after its DEM left the cache reloads it, then rebuilds its edges.
            const pyramid = this.elevation?.pyramid;
            if (pyramid && handle.heightAt && !pyramid.isResident(handle.identity))
                void pyramid.tileHeights(handle.identity).then(() => {
                    handle.edgeLevels = "";
                    this.junctionsDirty = true;
                });
        }
        this.junctionsDirty = true;
    }

    public hide(context: ITilePresentationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>): void {
        for (const resource of context.resources) {
            if (resource.handle.presented) this.displayed.hide(resource.handle.identity);
            resource.handle.presented = false;
            resource.handle.mesh.isVisible = false;
            resource.handle.label.style.display = "none";
        }
        this.junctionsDirty = true;
    }

    public release(context: ITilePresentationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>): void {
        for (const resource of context.resources) this.disposeHandle(resource.handle);
    }

    /**
     * Reconnects the edges of the presented grids to the levels of detail
     * displayed next to them. Call once per frame, before rendering; it only
     * works after a presentation change, and only rebuilds the grids whose
     * neighbour levels changed, in their topology or in their edge heights.
     *
     * Rebuilds stop once they have taken the frame budget, and the rest wait
     * for the next frames, so that a wave of loaded tiles does not stall one
     * frame. Topology changes, which open cracks, go before edge heights, and
     * nearer grids before farther ones; one grid is rebuilt in every frame
     * whatever its cost, so that the backlog always shrinks.
     */
    public updateJunctions(): void {
        if (!this.junctionsDirty) return;
        this.junctionsDirty = false;
        const topologyChanges: IJunctionRebuild[] = [];
        const heightChanges: IJunctionRebuild[] = [];
        const eye = this.scene.activeCamera?.globalPosition ?? Vector3.Zero();
        for (const handle of this.handles) {
            if (!handle.presented) continue;
            const lods = this.displayed.edgeLods(handle.identity, this.junctions);
            const edgeLevels = handle.heightAt ? this.edgeLevelsSignature(handle.identity) : "";
            const rebuild = {
                handle,
                lods,
                edgeLevels,
                distance: Vector3.DistanceSquared(handle.center, eye),
            };
            if (edgeLodsKey(lods) !== edgeLodsKey(handle.lods)) topologyChanges.push(rebuild);
            else if (edgeLevels !== handle.edgeLevels) heightChanges.push(rebuild);
        }
        const nearestFirst = (left: IJunctionRebuild, right: IJunctionRebuild): number => left.distance - right.distance;
        const rebuilds = [...topologyChanges.sort(nearestFirst), ...heightChanges.sort(nearestFirst)];
        const start = performance.now();
        for (const [index, { handle, lods, edgeLevels }] of rebuilds.entries()) {
            if (index > 0 && performance.now() - start >= this.junctionBudgetMilliseconds) {
                this.junctionsDirty = true;
                return;
            }
            handle.edgeLevels = edgeLevels;
            this.applyGeometry(handle, lods);
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

            const projected = Vector3.Project(handle.center, Matrix.IdentityReadOnly, transform, viewport);
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
        this.stopVerticalScale();
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
        return this.verticalScale.value;
    }

    /**
     * Changes the vertical scale of every elevated grid in place. Tiles keep
     * the bounding volume reported with the scale they were loaded with, unless
     * their runtime was given the same `VerticalScale`; new tiles report volumes
     * for the new scale.
     */
    public setVerticalScale(scale: number): void {
        this.verticalScale.set(scale);
    }

    private applyVerticalScale(scale: number): void {
        for (const handle of this.handles) {
            if (!handle.elevated) continue;
            const positions = composeElevatedPositions(handle.elevated, scale);
            const normals = this.surfaceNormals(handle, this.topologies.get(handle.lods), handle.elevated, positions);
            handle.mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
            handle.mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
            handle.mesh.refreshBoundingInfo();
        }
    }

    private createHandle(
        context: ITileActivationContext<IEcefSpatialState, IBabylonGeodesicGridHandle, never>,
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
        this.drape?.add(mesh, identity);
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
        const levels = this.displayed.touching((tile.x + u) / count, (tile.y + v) / count).map((displayed) => displayed.lod);
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
        for (let vertex = 0; vertex < topology.coordinates.length / 2; vertex++) {
            const u = topology.coordinates[vertex * 2]!;
            const v = topology.coordinates[vertex * 2 + 1]!;
            const x = (column + u) / count;
            const y = (row + v) / count;
            // One grid cell at the displayed level: the samples fall on the neighbouring vertices, so normals
            // describe the mesh surface rather than DEM detail the triangles cannot show.
            const gradient = pyramid.surfaceGradient(x, y, this.surfaceLevels(handle.identity, u, v), this.subdivisions);
            if (!gradient) continue;
            const up = {
                x: elevated.up[vertex * 3]!,
                y: elevated.up[vertex * 3 + 1]!,
                z: elevated.up[vertex * 3 + 2]!,
            };
            if (up.x === 0 && up.y === 0) continue;
            const normal = webMercatorSurfaceNormal(gradient, up, this.verticalScale.value);
            // Keep the orientation Babylon gives the mesh: its winding convention decides which side is lit.
            const meshSide =
                normals[vertex * 3]! * normal.x + normals[vertex * 3 + 1]! * normal.y + normals[vertex * 3 + 2]! * normal.z < 0 ? -1 : 1;
            normals[vertex * 3] = normal.x * meshSide;
            normals[vertex * 3 + 1] = normal.y * meshSide;
            normals[vertex * 3 + 2] = normal.z * meshSide;
        }
        return normals;
    }

    /**
     * Known tiles touching the tile boundary, to detect when edge heights
     * change: the levels at each edge vertex depend only on them. One pass over
     * the known tiles, instead of sampling every edge vertex, which took most of
     * the frames that presented tiles.
     */
    private edgeLevelsSignature(tile: ITileAddress): string {
        return this.displayed
            .touchingBoundary(tile)
            .map((other) => `${other.lod}/${other.x}/${other.y}`)
            .sort()
            .join(";");
    }

    /** Builds the grid of a tile for the given neighbour levels and uploads it to its mesh. */
    private applyGeometry(handle: IBabylonGeodesicGridHandle, lods: GridEdgeLods): void {
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
        const elevated = heightAt ? projectElevatedGrid(topology, handle.region, heightAt) : undefined;
        const geometry = elevated
            ? {
                  positions: composeElevatedPositions(elevated, this.verticalScale.value),
                  uvs: elevated.uvs,
                  indices: elevated.indices,
              }
            : projectGridTopologyToEllipsoid(topology, handle.region, GeodeticSystem.WGS84, { latitudeInterpolation: "mercator" });
        const normals: number[] = [];
        if (elevated) normals.push(...this.surfaceNormals(handle, topology, elevated, geometry.positions));
        else VertexData.ComputeNormals(geometry.positions, geometry.indices, normals);

        const vertexData = new VertexData();
        vertexData.positions = geometry.positions;
        vertexData.uvs = geometry.uvs;
        vertexData.indices = geometry.indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(handle.mesh, elevated !== undefined);

        handle.elevated = elevated;
        handle.lods = lods;
        handle.estimatedCpuBytes =
            (geometry.positions.length + normals.length) * Float64Array.BYTES_PER_ELEMENT +
            geometry.uvs.byteLength +
            geometry.indices.byteLength;
        handle.estimatedGpuBytes =
            (geometry.positions.length + normals.length) * Float32Array.BYTES_PER_ELEMENT +
            geometry.uvs.byteLength +
            geometry.indices.byteLength;
    }

    private materialForLod(lod: number): StandardMaterial {
        const existing = this.materialsByLod.get(lod);
        if (existing) return existing;

        const color = Color3.FromHexString(lodColor(lod));
        // The drape plugin is written in GLSL: on WebGPU, Babylon converts the whole material to WGSL.
        const material = new StandardMaterial(`geodesic-grid-material-lod-${lod}`, this.scene, this.drape !== undefined);
        material.specularColor = Color3.Black();
        if (this.wireframe) {
            material.diffuseColor = color.scale(0.55);
            material.emissiveColor = color;
            material.disableLighting = true;
        } else if (this.drape) {
            // Imagery replaces the level colour, which only shows where no page has arrived yet.
            material.diffuseColor = color.scale(0.9);
            material.emissiveColor = Color3.Black();
            material.twoSidedLighting = true;
            this.drape.attach(material);
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
        // A ghost leaves with its resource as well.
        if (handle.presented || this.displayed.isGhost(handle.identity)) {
            this.displayed.delete(handle.identity);
            this.junctionsDirty = true;
        }
        this.releasedHandleCount++;
        handle.label.remove();
        this.drape?.remove(handle.mesh);
        handle.mesh.dispose(false, false);
    }
}
