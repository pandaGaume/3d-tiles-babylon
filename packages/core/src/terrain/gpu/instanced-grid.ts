import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { IGridTopology } from "@spacexr/grid";

/** Instance attributes of the GPU terrain engine, four floats each; see the vertex shader. */
export const INSTANCE_ATTRIBUTES = ["instPlace", "instRotation", "instElevation", "instImagery"] as const;
export type InstanceAttribute = (typeof INSTANCE_ATTRIBUTES)[number];

/** Vertices of a predefined grid with its skirt: `u, v` and `1` for skirt vertices, and triangle indices. */
export interface ISkirtedGridGeometry {
    positions: Float32Array;
    indices: Uint32Array;
}

/**
 * Adds a skirt to a normalized grid topology: every boundary edge, an edge of a single triangle, is extruded below
 * the surface by a vertex copy marked `1`, which the shader moves down along the ellipsoid normal.
 */
export function skirtedGridGeometry(topology: IGridTopology): ISkirtedGridGeometry {
    const vertexCount = topology.coordinates.length / 2;
    const edges = new Map<string, [number, number]>();
    const indices = topology.indices;
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
        for (let corner = 0; corner < 3; corner++) {
            const a = indices[triangle + corner]!;
            const b = indices[triangle + ((corner + 1) % 3)]!;
            const edgeKey = a < b ? `${a}/${b}` : `${b}/${a}`;
            if (edges.has(edgeKey)) edges.delete(edgeKey);
            else edges.set(edgeKey, [a, b]);
        }
    }
    const skirtOf = new Map<number, number>();
    const positions: number[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex++)
        positions.push(topology.coordinates[vertex * 2]!, topology.coordinates[vertex * 2 + 1]!, 0);
    const skirt = (vertex: number): number => {
        let copy = skirtOf.get(vertex);
        if (copy === undefined) {
            copy = positions.length / 3;
            positions.push(topology.coordinates[vertex * 2]!, topology.coordinates[vertex * 2 + 1]!, 1);
            skirtOf.set(vertex, copy);
        }
        return copy;
    };
    const skirtIndices: number[] = [];
    // Boundary edges keep the winding of their triangle, so the skirt faces outward.
    for (const [a, b] of edges.values()) skirtIndices.push(a, skirt(a), b, b, skirt(a), skirt(b));
    const all = new Uint32Array(indices.length + skirtIndices.length);
    all.set(indices);
    all.set(skirtIndices, indices.length);
    return { positions: new Float32Array(positions), indices: all };
}

/**
 * One predefined grid drawn once per instance: a Babylon mesh whose instance attributes are vertex buffers with a
 * divisor of one, drawn with `forcedInstanceCount`.
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
        const geometry = skirtedGridGeometry(topology);
        const vertexData = new VertexData();
        vertexData.positions = geometry.positions;
        vertexData.indices = geometry.indices;
        vertexData.applyToMesh(this.mesh, false);
        this.mesh.material = material;
        // Instances are placed in the shader: the mesh has no meaningful bounds, and the runtimes cull the tiles.
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.doNotSyncBoundingInfo = true;
        this.mesh.isPickable = false;
        this.reserve(64);
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
    public upload(...names: InstanceAttribute[]): void {
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
