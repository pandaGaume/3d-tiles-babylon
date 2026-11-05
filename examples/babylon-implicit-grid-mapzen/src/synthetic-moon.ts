import type { ICartesian3, ITileAddress } from "@spacexr/tiles";
import { createHeightGrid, type IHeightGrid } from "@spacexr/dem";
import { cubeTileDirection, planetocentricDirection } from "@spacexr/tiles";

/** Radius of the reference sphere of the synthetic Moon, as LOLA, in metres. */
export const SYNTHETIC_MOON_RADIUS = 1737400;

interface ICrater {
    center: ICartesian3;
    /** Angular radius, in radians. */
    radius: number;
    /** Depth at the centre, in metres. */
    depth: number;
}

/** A deterministic scatter of craters of many sizes, with deep ones around the south pole. */
function createCraters(): ICrater[] {
    const craters: ICrater[] = [
        {
            center: planetocentricDirection(-89.6, 130),
            radius: 0.006,
            depth: 4000,
        },
        { center: planetocentricDirection(-88, 30), radius: 0.02, depth: 3000 },
        {
            center: planetocentricDirection(-86, -70),
            radius: 0.035,
            depth: 3500,
        },
        { center: planetocentricDirection(89, 0), radius: 0.02, depth: 3000 },
        // Across the turned edge between faces 1 and 4, across the edge between faces 0 and 1, and on a vertex of the cube.
        { center: planetocentricDirection(45, 90), radius: 0.06, depth: 4000 },
        { center: planetocentricDirection(0, 45), radius: 0.06, depth: 4000 },
        {
            center: planetocentricDirection(35.264, 45),
            radius: 0.06,
            depth: 4000,
        },
    ];
    let seed = 7;
    const random = (): number => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    for (let index = 0; index < 90; index++) {
        const latitude = (Math.asin(2 * random() - 1) * 180) / Math.PI;
        const radius = 0.012 + 0.14 * random() ** 3;
        craters.push({
            center: planetocentricDirection(latitude, 360 * random() - 180),
            radius,
            depth: 1500 + 40000 * radius * random(),
        });
    }
    return craters;
}

const CRATERS = createCraters();

/**
 * Height of the synthetic Moon in a direction. Being a function of the direction alone, it takes the same value on both
 * sides of every tile edge and cube face edge: a crack or a shifted edge in the terrain is a bug of the tiling.
 */
export function syntheticMoonHeight(direction: Readonly<ICartesian3>): number {
    let height =
        600 *
        Math.sin(5 * direction.x + 1) *
        Math.sin(5 * direction.y + 2) *
        Math.sin(5 * direction.z + 3);
    for (const { center, radius, depth } of CRATERS) {
        const cosine =
            center.x * direction.x +
            center.y * direction.y +
            center.z * direction.z;
        if (cosine < Math.cos(radius * 1.4)) continue;
        const distance = Math.acos(Math.min(1, cosine)) / radius;
        // A bowl with a raised rim that fades outside.
        height +=
            distance < 1
                ? depth * (distance * distance - 1) + 0.12 * depth
                : 0.12 * depth * (1 - (distance - 1) / 0.4);
    }
    return height;
}

/**
 * Elevation tile of the synthetic Moon, as a tile service would serve it: `(tileSize + 1)^2` radial heights in point
 * registration, which hold their shared edges.
 */
export function syntheticMoonTile(
    address: ITileAddress,
    tileSize = 256,
): IHeightGrid {
    const side = tileSize + 1;
    const data = new Float32Array(side * side);
    const direction = { x: 0, y: 0, z: 0 };
    for (let row = 0; row < side; row++) {
        for (let column = 0; column < side; column++) {
            cubeTileDirection(
                address,
                column / tileSize,
                row / tileSize,
                direction,
            );
            data[row * side + column] = syntheticMoonHeight(direction);
        }
    }
    return createHeightGrid(side, side, data);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Loads tiles of the synthetic Moon one at a time, each in its own task: a tile takes about 60 ms on the main thread, and
 * a real tile service costs none of it.
 */
export function loadSyntheticMoonTile(
    address: ITileAddress,
): Promise<IHeightGrid> {
    const tile = queue.then(
        () =>
            new Promise<IHeightGrid>((resolve) => {
                setTimeout(() => resolve(syntheticMoonTile(address)));
            }),
    );
    queue = tile;
    return tile;
}
