import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { createJunctionGridTopology, NeighborLod, type IGridTopology } from "@spacexr/grid";
import { TileNeighbor } from "@spacexr/tiles";

/**
 * Instance attributes of the GPU terrain engine, four floats each; see the vertex shader. The elevation references
 * are the area of the instance in a DEM tile, `west, north, size`, and the layer of its page: its own, then those of
 * its edges N, E, S, W and of its corners NW, NE, SE, SW.
 */
export const INSTANCE_ATTRIBUTES = [
    "instPlace",
    "instRotation",
    "instImagery",
    "instElevation",
    "instEdgeN",
    "instEdgeE",
    "instEdgeS",
    "instEdgeW",
    "instCornerNW",
    "instCornerNE",
    "instCornerSE",
    "instCornerSW",
] as const;
export type InstanceAttribute = (typeof INSTANCE_ATTRIBUTES)[number];

/**
 * The predefined grid of every instance, as in SpaceXR: `cells x cells` cells whose four edges are refined with a
 * vertex in the middle of each cell side, the `Finer` junction variant on every edge. Its edges then hold the vertices
 * of any neighbour one level finer, and the shader moves the edge midpoints onto the edge of a coarser neighbour.
 */
export function refinedGridTopology(cells: number): IGridTopology {
    return createJunctionGridTopology(cells, cells, {
        [TileNeighbor.N]: NeighborLod.Finer,
        [TileNeighbor.E]: NeighborLod.Finer,
        [TileNeighbor.S]: NeighborLod.Finer,
        [TileNeighbor.W]: NeighborLod.Finer,
    });
}

/**
 * One predefined grid drawn once per instance: a Babylon mesh whose instance attributes are vertex buffers with a
 * divisor of one, drawn with `forcedInstanceCount`. `position` holds the `u, v` of each vertex.
 */
export class InstancedGrid {
    public readonly mesh: Mesh;
    private readonly data = new Map<InstanceAttribute, Float32Array>();
    private readonly buffers = new Map<InstanceAttribute, VertexBuffer>();
    private capacity = 0;
    private instances = 0;

    public constructor(
        private readonly scene: Scene,
        name: string,
        topology: IGridTopology,
        material: Material,
    ) {
        this.mesh = new Mesh(name, scene);
        const positions = new Float32Array((topology.coordinates.length / 2) * 3);
        for (let vertex = 0; vertex < topology.coordinates.length / 2; vertex++) {
            positions[vertex * 3] = topology.coordinates[vertex * 2]!;
            positions[vertex * 3 + 1] = topology.coordinates[vertex * 2 + 1]!;
        }
        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = topology.indices;
        vertexData.applyToMesh(this.mesh, false);
        this.mesh.material = material;
        // Instances are placed in the shader: the mesh has no meaningful bounds, and the runtimes cull the tiles.
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
        this.mesh.isPickable = false;
        this.reserve(256);
        this.resize(0);
    }

    /** Instances drawn. */
    public get count(): number {
        return this.instances;
    }

    /** Bytes of the instance buffers. */
    public get gpuBytes(): number {
        return this.capacity * INSTANCE_ATTRIBUTES.length * 16;
    }

    /** Values of an attribute, four floats per instance, valid up to {@link count} instances. */
    public attribute(name: InstanceAttribute): Float32Array {
        return this.data.get(name)!;
    }

    /** Sets the number of instances, growing the buffers when needed; their values must be written next. */
    public resize(count: number): void {
        if (count > this.capacity) this.reserve(Math.max(count, Math.ceil(this.capacity * 1.5)));
        this.instances = count;
        this.mesh.forcedInstanceCount = count;
        this.mesh.setEnabled(count > 0);
    }

    /** Uploads the values of attributes after they were written. */
    public upload(...names: readonly InstanceAttribute[]): void {
        for (const name of names) this.buffers.get(name)!.updateDirectly(this.data.get(name)!, 0);
    }

    public dispose(): void {
        for (const buffer of this.buffers.values()) buffer.dispose();
        this.mesh.dispose();
    }

    private reserve(capacity: number): void {
        const engine = this.scene.getEngine();
        for (const name of INSTANCE_ATTRIBUTES) {
            const data = new Float32Array(capacity * 4);
            const previous = this.data.get(name);
            if (previous) data.set(previous);
            this.data.set(name, data);
            this.buffers.get(name)?.dispose();
            const buffer = new VertexBuffer(engine, data, name, { updatable: true, stride: 4, size: 4, instanced: true, divisor: 1 });
            this.buffers.set(name, buffer);
            this.mesh.setVerticesBuffer(buffer);
        }
        this.capacity = capacity;
    }
}
