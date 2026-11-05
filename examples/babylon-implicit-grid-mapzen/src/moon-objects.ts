import type { ITile, ITileset } from "@spacexr/3d-tiles-core";
import type { ICartesian3, ReferenceSurface } from "@spacexr/tiles";

/** A box in the axes of a tile, Z up, in metres. */
interface IBox {
    size: readonly [number, number, number];
    /** Centre of the box. */
    center: readonly [number, number, number];
    color: readonly [number, number, number];
}

/** Six faces of four vertices each, with their normals, in the Y-up axes of glTF. */
function boxBuffers(box: IBox): {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint16Array;
} {
    const [sx, sy, sz] = [box.size[0] / 2, box.size[2] / 2, box.size[1] / 2];
    const [cx, cy, cz] = [box.center[0], box.center[2], -box.center[1]];
    const faces: readonly (readonly [
        readonly number[],
        readonly number[],
        readonly number[],
    ])[] = [
        [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, -1],
        ],
        [
            [-1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ],
        [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, 1],
        ],
        [
            [0, -1, 0],
            [1, 0, 0],
            [0, 0, -1],
        ],
        [
            [0, 0, 1],
            [1, 0, 0],
            [0, -1, 0],
        ],
        [
            [0, 0, -1],
            [1, 0, 0],
            [0, 1, 0],
        ],
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    faces.forEach(([n, u, v], face) => {
        for (const [a, b] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ] as const) {
            positions.push(
                cx + (n[0]! + a * u[0]! + b * v[0]!) * sx,
                cy + (n[1]! + a * u[1]! + b * v[1]!) * sy,
                cz + (n[2]! + a * u[2]! + b * v[2]!) * sz,
            );
            normals.push(n[0]!, n[1]!, n[2]!);
        }
        const first = face * 4;
        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    });
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint16Array(indices),
    };
}

/** A binary glTF holding a box. */
export function boxGlb(box: IBox): Uint8Array {
    const { positions, normals, indices } = boxBuffers(box);
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index++) {
        minimum[index % 3] = Math.min(minimum[index % 3]!, positions[index]!);
        maximum[index % 3] = Math.max(maximum[index % 3]!, positions[index]!);
    }
    const binary = new Uint8Array(
        positions.byteLength +
            normals.byteLength +
            indices.byteLength +
            ((4 - (indices.byteLength % 4)) % 4),
    );
    binary.set(new Uint8Array(positions.buffer), 0);
    binary.set(new Uint8Array(normals.buffer), positions.byteLength);
    binary.set(
        new Uint8Array(indices.buffer),
        positions.byteLength + normals.byteLength,
    );
    const json = {
        asset: { version: "2.0", generator: "3d-tiles-babylon example" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
            {
                primitives: [
                    {
                        attributes: { POSITION: 0, NORMAL: 1 },
                        indices: 2,
                        material: 0,
                    },
                ],
            },
        ],
        materials: [
            {
                pbrMetallicRoughness: {
                    baseColorFactor: [...box.color, 1],
                    metallicFactor: 0,
                    roughnessFactor: 1,
                },
                emissiveFactor: box.color.map((value) => value * 0.25),
            },
        ],
        accessors: [
            {
                bufferView: 0,
                componentType: 5126,
                count: positions.length / 3,
                type: "VEC3",
                min: minimum,
                max: maximum,
            },
            {
                bufferView: 1,
                componentType: 5126,
                count: normals.length / 3,
                type: "VEC3",
            },
            {
                bufferView: 2,
                componentType: 5123,
                count: indices.length,
                type: "SCALAR",
            },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
            {
                buffer: 0,
                byteOffset: positions.byteLength,
                byteLength: normals.byteLength,
            },
            {
                buffer: 0,
                byteOffset: positions.byteLength + normals.byteLength,
                byteLength: indices.byteLength,
            },
        ],
        buffers: [{ byteLength: binary.byteLength }],
    };
    const text = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(
        text.length + ((4 - (text.length % 4)) % 4),
    ).fill(0x20);
    padded.set(text);
    const glb = new Uint8Array(12 + 8 + padded.length + 8 + binary.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, padded.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(padded, 20);
    view.setUint32(20 + padded.length, binary.length, true);
    view.setUint32(24 + padded.length, 0x004e4942, true);
    glb.set(binary, 28 + padded.length);
    return glb;
}

/** Column-major transform of a local frame on a body: X and Y tangent, Z along the up direction. */
function localFrame(
    up: Readonly<ICartesian3>,
    origin: Readonly<ICartesian3>,
): number[] {
    // The axis of the body gives the tangents, away from the poles; the X axis near them.
    const axis =
        Math.abs(up.z) > 0.999 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const east = normalized({
        x: axis.y * up.z - axis.z * up.y,
        y: axis.z * up.x - axis.x * up.z,
        z: axis.x * up.y - axis.y * up.x,
    });
    const north = {
        x: up.y * east.z - up.z * east.y,
        y: up.z * east.x - up.x * east.z,
        z: up.x * east.y - up.y * east.x,
    };
    return [
        east.x,
        east.y,
        east.z,
        0,
        north.x,
        north.y,
        north.z,
        0,
        up.x,
        up.y,
        up.z,
        0,
        origin.x,
        origin.y,
        origin.z,
        1,
    ];
}

function normalized(vector: Readonly<ICartesian3>): ICartesian3 {
    const length = Math.hypot(vector.x, vector.y, vector.z);
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

export interface IMoonObjects {
    tileset: ITileset;
    /** Contents of the tiles, by URI. */
    contents: ReadonlyMap<string, Uint8Array>;
    /** Local X axis of the base, and its origin, for the probes. */
    baseDirection: ICartesian3;
    roverDirection: ICartesian3;
}

/**
 * Two objects on the terrain, placed in body-fixed coordinates by tile transforms, below a tile without a position.
 *
 * ```
 * root, no position
 * ├── base (transform on the terrain), a plate
 * │   └── mast (no transform), a tall box
 * │       └── beacon (transform: on top of the mast), a cube
 * └── rover (transform on the terrain, kilometres away), a box
 * ```
 *
 * @param reference - Reference surface of the body.
 * @param direction - Where the base stands.
 * @param heightAt - Height of the terrain over the reference surface in a direction.
 */
export function createMoonObjects(
    reference: ReferenceSurface,
    direction: Readonly<ICartesian3>,
    heightAt: (direction: Readonly<ICartesian3>) => number,
): IMoonObjects {
    const baseFrame = localFrame(
        direction,
        reference.point(direction, heightAt(direction)),
    );
    // 4 km along the second axis of the base, on the terrain there.
    const north = { x: baseFrame[4]!, y: baseFrame[5]!, z: baseFrame[6]! };
    const angle = 4000 / reference.radius(direction);
    const roverDirection = normalized({
        x: direction.x * Math.cos(angle) + north.x * Math.sin(angle),
        y: direction.y * Math.cos(angle) + north.y * Math.sin(angle),
        z: direction.z * Math.cos(angle) + north.z * Math.sin(angle),
    });
    const roverFrame = localFrame(
        roverDirection,
        reference.point(roverDirection, heightAt(roverDirection)),
    );

    const mastHeight = 800;
    const contents = new Map<string, Uint8Array>([
        [
            "memory://moon-objects/base.glb",
            boxGlb({
                size: [600, 600, 40],
                center: [0, 0, 20],
                color: [0.95, 0.75, 0.1],
            }),
        ],
        [
            "memory://moon-objects/mast.glb",
            boxGlb({
                size: [40, 40, mastHeight],
                center: [0, 0, mastHeight / 2],
                color: [0.85, 0.15, 0.1],
            }),
        ],
        [
            "memory://moon-objects/beacon.glb",
            boxGlb({
                size: [120, 120, 120],
                center: [0, 0, 60],
                color: [0.95, 0.95, 0.95],
            }),
        ],
        [
            "memory://moon-objects/rover.glb",
            boxGlb({
                size: [300, 150, 100],
                center: [0, 0, 50],
                color: [0.1, 0.8, 0.3],
            }),
        ],
    ]);
    const content = (name: string): { uri: string } => ({
        uri: `memory://moon-objects/${name}.glb`,
    });
    const beacon: ITile = {
        geometricError: 0,
        // prettier-ignore
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, mastHeight, 1],
        boundingVolume: { sphere: [0, 0, 60, 110] },
        content: content("beacon"),
    };
    const mast: ITile = {
        // Far enough for its beacon to appear from about 20 km, and for itself from about 30 km.
        geometricError: 200,
        boundingVolume: {
            sphere: [0, 0, mastHeight / 2 + 60, mastHeight / 2 + 120],
        },
        content: content("mast"),
        children: [beacon],
    };
    const base: ITile = {
        geometricError: 300,
        transform: baseFrame as never,
        boundingVolume: {
            sphere: [0, 0, mastHeight / 2, mastHeight / 2 + 500],
        },
        content: content("base"),
        children: [mast],
    };
    const rover: ITile = {
        geometricError: 0,
        transform: roverFrame as never,
        boundingVolume: { sphere: [0, 0, 50, 200] },
        content: content("rover"),
    };
    const centre = reference.point(roverDirection, heightAt(roverDirection));
    return {
        tileset: {
            asset: { version: "1.1" },
            geometricError: 1000,
            root: {
                geometricError: 100,
                refine: "ADD",
                boundingVolume: {
                    sphere: [centre.x, centre.y, centre.z, 9000],
                },
                children: [base, rover],
            },
        },
        contents,
        baseDirection: { x: direction.x, y: direction.y, z: direction.z },
        roverDirection,
    };
}
