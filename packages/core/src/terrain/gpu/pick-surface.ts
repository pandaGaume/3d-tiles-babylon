import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ITileAddress } from "@spacexr/3d-tiles-runtime";
import type { DemPyramid } from "@spacexr/dem";
import { GeodeticSystem } from "@spacexr/geodesy";
import { createGridTopology } from "@spacexr/grid";

import { tileCenterEcef, webMercatorLatitude } from "./grid-shapes";

function key(address: ITileAddress): string {
    return `${address.lod}/${address.x}/${address.y}`;
}

/**
 * Surface the camera picks when the terrain is displaced on the GPU: one coarse grid per presented terrain tile,
 * elevated on the CPU from the DEM in memory, never rendered.
 *
 * Babylon cameras pick meshes on the CPU, which cannot see vertices moved by a shader. The pick grids are pickable,
 * visible and enabled, but their layer mask matches no camera, so they never reach the screen. Each grid is placed at
 * its tile centre, so its vertices stay precise.
 */
export class PickSurface {
    private readonly meshes = new Map<string, { address: ITileAddress; mesh: Mesh }>();
    private readonly indices: Uint32Array;
    private readonly coordinates: Float32Array;
    private verticalScale: number;

    public constructor(
        private readonly scene: Scene,
        private readonly pyramid: DemPyramid | undefined,
        verticalScale: number,
        /** Cells per side of each pick grid. */
        private readonly cells = 8,
        private readonly system: GeodeticSystem = GeodeticSystem.WGS84,
    ) {
        this.verticalScale = verticalScale;
        const topology = createGridTopology(cells);
        this.indices = topology.indices;
        this.coordinates = topology.coordinates;
    }

    /** Pick grids in the scene. */
    public get size(): number {
        return this.meshes.size;
    }

    /** Keeps one pick grid per terrain tile of the cut, building the missing ones and removing the others. */
    public update(terrainCut: Iterable<ITileAddress>): void {
        const wanted = new Map<string, ITileAddress>();
        for (const address of terrainCut) wanted.set(key(address), address);
        for (const [tileKey, entry] of this.meshes) {
            if (wanted.has(tileKey)) continue;
            entry.mesh.dispose();
            this.meshes.delete(tileKey);
        }
        for (const [tileKey, address] of wanted) {
            if (this.meshes.has(tileKey)) continue;
            this.meshes.set(tileKey, { address, mesh: this.build(address) });
        }
    }

    /** Rebuilds the pick grids for another vertical scale. */
    public setVerticalScale(scale: number): void {
        this.verticalScale = scale;
        for (const entry of this.meshes.values()) {
            entry.mesh.dispose();
            entry.mesh = this.build(entry.address);
        }
    }

    /** Rebuilds the pick grid of a tile, after its DEM arrived. */
    public refresh(address: ITileAddress): void {
        const entry = this.meshes.get(key(address));
        if (!entry) return;
        entry.mesh.dispose();
        entry.mesh = this.build(address);
    }

    public dispose(): void {
        for (const entry of this.meshes.values()) entry.mesh.dispose();
        this.meshes.clear();
    }

    private build(address: ITileAddress): Mesh {
        const center = tileCenterEcef(address, this.system);
        const count = 2 ** address.lod;
        const positions = new Float32Array((this.coordinates.length / 2) * 3);
        const point = { x: 0, y: 0, z: 0 };
        for (let vertex = 0; vertex < this.coordinates.length / 2; vertex++) {
            const x = (address.x + this.coordinates[vertex * 2]!) / count;
            const y = (address.y + this.coordinates[vertex * 2 + 1]!) / count;
            const sampled = this.pyramid?.heightAt(x, y, address.lod) ?? 0;
            const height = Number.isNaN(sampled) ? 0 : sampled * this.verticalScale;
            this.system.geodeticRadiansToEcef(webMercatorLatitude(y), x * 2 * Math.PI - Math.PI, height, point);
            positions[vertex * 3] = point.x - center.x;
            positions[vertex * 3 + 1] = point.y - center.y;
            positions[vertex * 3 + 2] = point.z - center.z;
        }
        const mesh = new Mesh(`gpu-terrain-pick-${key(address)}`, this.scene);
        const data = new VertexData();
        data.positions = positions;
        data.indices = this.indices;
        data.applyToMesh(mesh, false);
        mesh.position = new Vector3(center.x, center.y, center.z);
        // Matches no camera: picked, never drawn.
        mesh.layerMask = 0;
        mesh.isPickable = true;
        mesh.doNotSyncBoundingInfo = false;
        return mesh;
    }
}
