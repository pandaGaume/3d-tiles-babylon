import { createHeightGrid, DemPyramid } from "@spacexr/dem";
import { CUBE_TILE_TOPOLOGY, CubeTileSurface, ReferenceSurface, cubeTileDirection, TileNeighbor, type ITileAddress } from "@spacexr/tiles";
import { describe, expect, it } from "vitest";
import { cubeTiling } from "../src/terrain/terrain-tiling";
import { elevationPageTexels } from "../src/terrain/gpu/elevation-pages";

const size = 17,
    stride = size + 2;
const surface = new CubeTileSurface(ReferenceSurface.sphere(3396190));
const tiling = cubeTiling(surface);
function grid(address: ITileAddress) {
    const values = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            const d = cubeTileDirection(address, x / (size - 1), y / (size - 1));
            values[y * size + x] = 1200 * d.x * d.x + 5000 * d.y + 700 * d.z;
        }
    return createHeightGrid(size, size, values);
}
describe("elevation page gutters", () => {
    it("gives both pages the same central slope at a shared DEM edge, including after a neighbour arrives", async () => {
        const left = { face: 1, lod: 3, x: 3, y: 2 },
            right = { ...left, x: 4 };
        const pyramid = new DemPyramid({ registration: "point", maxLOD: 3, load: async (address) => grid(address) });
        await pyramid.tileHeights(left);
        const before = elevationPageTexels(pyramid, left, size, tiling);
        expect([...before].every(Number.isFinite)).toBe(true);
        await pyramid.tileHeights(right);
        const a = elevationPageTexels(pyramid, left, size, tiling),
            b = elevationPageTexels(pyramid, right, size, tiling);
        let changed = false;
        for (let y = 1; y <= size; y++) {
            const slopeA = (a[y * stride + size + 1]! - a[y * stride + size - 1]!) / 2;
            const slopeB = (b[y * stride + 2]! - b[y * stride]!) / 2;
            expect(slopeA).toBe(slopeB);
            changed ||= before[y * stride + size + 1] !== a[y * stride + size + 1];
        }
        expect(changed).toBe(true);
    });
    it("turns gutter samples across cube faces using the existing cube topology", async () => {
        const address = { face: 1, lod: 2, x: 1, y: 0 };
        const neighbor = CUBE_TILE_TOPOLOGY.neighbor(address, TileNeighbor.N)!;
        expect(neighbor.turns).not.toBe(0);
        const pyramid = new DemPyramid({ registration: "point", maxLOD: 2, load: async (tile) => grid(tile) });
        await pyramid.tileHeights(address);
        await pyramid.tileHeights(neighbor.address);
        const padded = elevationPageTexels(pyramid, address, size, tiling);
        for (let x = 0; x < size; x++) {
            const expected = grid(neighbor.address).data[(size - 1 - x) * size + size - 2];
            expect(padded[x + 1]).toBe(expected);
        }
    });
});
