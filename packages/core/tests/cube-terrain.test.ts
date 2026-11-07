import { createHeightGrid, DemPyramid, type IHeightGrid } from "@spacexr/dem";
import { DrapeInstanceCut } from "@spacexr/raster";
import {
    CUBE_TILE_TOPOLOGY,
    CubeTileSurface,
    ReferenceSurface,
    TILE_EDGE_NEIGHBORS,
    TileNeighbor,
    childTileAddresses,
    cubeTileDirection,
    turnedTileCoordinates,
    type ICartesian3,
    type ITileAddress,
} from "@spacexr/tiles";
import { describe, expect, it } from "vitest";

import { TERRAIN_CONFIG, TILE_METRICS, createCubeGridSource, cubeTiling, metadataTileAddress, webMercatorTiling } from "../src";
import { instancedGridPixelShader } from "../src/terrain/gpu/shaders/instancedGrid.fragment";
import { instancedGridVertexShader } from "../src/terrain/gpu/shaders/instancedGrid.vertex";

const SIZE = 17;
const MOON = new CubeTileSurface(ReferenceSurface.sphere(1737400));
/** A relief that depends on the direction alone, so that any shifted or turned read shows. */
const relief = ({ x, y, z }: ICartesian3): number => 1000 * x + 2000 * y * y + 3000 * z * x + 500 * Math.sin(9 * y);

function tile(address: ITileAddress): IHeightGrid {
    const data = new Float32Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row++) {
        for (let column = 0; column < SIZE; column++) {
            data[row * SIZE + column] = relief(cubeTileDirection(address, column / (SIZE - 1), row / (SIZE - 1)));
        }
    }
    return createHeightGrid(SIZE, SIZE, data);
}

/** The read of the vertex shader: a point of an instance through its area in a page, turned, bilinearly. */
function read(grid: IHeightGrid, instance: ITileAddress, page: ITileAddress, u: number, v: number): number {
    const { west, north, size, turns } = CUBE_TILE_TOPOLOGY.areaIn(instance, page);
    const [a, b] = turnedTileCoordinates(u, v, turns);
    const x = (west + a * size) * (SIZE - 1);
    const y = (north + b * size) * (SIZE - 1);
    const column = Math.min(Math.max(Math.floor(x), 0), SIZE - 2);
    const row = Math.min(Math.max(Math.floor(y), 0), SIZE - 2);
    const fx = Math.min(Math.max(x - column, 0), 1);
    const fy = Math.min(Math.max(y - row, 0), 1);
    const at = (dx: number, dy: number): number => grid.data[(row + dy) * SIZE + column + dx]!;
    return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
}

describe("cube terrain", () => {
    it("reads the DEM of a tile on another face at the same direction, along every face edge", () => {
        const lod = 3;
        const last = 2 ** lod - 1;
        for (let face = 0; face < 6; face++) {
            for (const edge of TILE_EDGE_NEIGHBORS) {
                const instance: ITileAddress = {
                    face,
                    lod,
                    x: edge === TileNeighbor.W ? 0 : edge === TileNeighbor.E ? last : 3,
                    y: edge === TileNeighbor.N ? 0 : edge === TileNeighbor.S ? last : 3,
                };
                const neighbor = CUBE_TILE_TOPOLOGY.neighbor(instance, edge)!.address;
                const own = tile(instance);
                const across = tile(neighbor);
                // A page at the sample spacing of the tile: the points of the edge lie on samples of both.
                for (let i = 0; i < SIZE; i++) {
                    const t = i / (SIZE - 1);
                    const u = edge === TileNeighbor.W ? 0 : edge === TileNeighbor.E ? 1 : t;
                    const v = edge === TileNeighbor.N ? 0 : edge === TileNeighbor.S ? 1 : t;
                    const expected = relief(cubeTileDirection(instance, u, v));
                    expect(read(own, instance, instance, u, v)).toBeCloseTo(expected, 2);
                    expect(read(across, instance, neighbor, u, v)).toBeCloseTo(expected, 2);
                }
            }
        }
    });

    it("gives the shader the same quarter turns as the tiles", () => {
        // turnedTileCoordinates(u, v, 1) is (1 - v, u), and so on: the shader decodes them from the fraction of the layer.
        expect(turnedTileCoordinates(0.25, 0.5, 1)).toEqual([0.5, 0.25]);
        expect(turnedTileCoordinates(0.25, 0.5, 2)).toEqual([0.75, 0.5]);
        expect(turnedTileCoordinates(0.25, 0.5, 3)).toEqual([0.5, 0.75]);
        expect(instancedGridVertexShader.shader).toContain("if (turns == 1) turned = vec2(1.0 - uv.y, uv.x);");
        expect(instancedGridVertexShader.shader).toContain("else if (turns == 2) turned = vec2(1.0 - uv.x, 1.0 - uv.y);");
        expect(instancedGridVertexShader.shader).toContain("else if (turns == 3) turned = vec2(uv.y, 1.0 - uv.x);");
    });

    it("gives both sides of a face edge the DEM of the coarser terrain tile", () => {
        // Face 1 refined along its north edge, which meets the east edge of face 4.
        const coarse = { face: 4, lod: 1, x: 1, y: 0 };
        const refined = childTileAddresses({ face: 1, lod: 1, x: 1, y: 0 });
        const terrain = [coarse, ...refined];
        const instances = new DrapeInstanceCut({ topology: CUBE_TILE_TOPOLOGY }).update(terrain, [], 0);
        const north = instances.find(({ address }) => address.face === 1 && address.y === 0 && address.x === 2)!;
        expect(north.edgeTerrain[0]).toEqual(coarse);
        expect(CUBE_TILE_TOPOLOGY.neighbor(north.address, TileNeighbor.N)?.turns).toBe(3);
    });

    it("loads prestitched elevation for tiles of different faces", async () => {
        const pyramid = new DemPyramid({ registration: "point", maxLOD: 2, load: (address) => Promise.resolve(tile(address)) });
        const address = { face: 5, lod: 2, x: 1, y: 2 };
        const heights = await pyramid.tileHeights(address);
        expect(heights?.sampler(0.5, 0.5)).toBeCloseTo(relief(cubeTileDirection(address, 0.5, 0.5)), 2);
        expect(pyramid.isResident(address)).toBe(true);
        expect(pyramid.isResident({ ...address, face: 4 })).toBe(false);
    });
});

describe("shaders", () => {
    it("declare no variable named with a word reserved by WGSL, which WebGL cannot detect", () => {
        const reserved = [
            "as",
            "enable",
            "final",
            "from",
            "let",
            "loop",
            "match",
            "mod",
            "module",
            "override",
            "ref",
            "self",
            "super",
            "type",
            "use",
            "where",
        ];
        for (const source of [instancedGridVertexShader.shader, instancedGridPixelShader.shader]) {
            const declared = [...source.matchAll(/\b(?:int|float|bool|vec[234]|ivec[234])\s+([A-Za-z_]\w*)/g)].map((match) => match[1]);
            expect(declared.filter((name) => reserved.includes(name!))).toEqual([]);
        }
    });

    it("only declares the fragment normal inputs with radial heights", () => {
        expect(instancedGridPixelShader.shader).toContain("joinedGradient(vTile)");
        expect(instancedGridPixelShader.shader).toMatch(/#ifdef RADIAL_HEIGHTS[\s\S]*#else\s+vec3 normal = normalize\(vNormal\);/);
    });
});

describe("terrain tilings", () => {
    it("bound cube tiles with boxes and keep regions on Web Mercator", () => {
        expect(cubeTiling(MOON).radialHeights).toBe(true);
        expect(cubeTiling(MOON).boundingBox?.({ face: 2, lod: 3, x: 1, y: 1 }, -10, 10)).toHaveLength(12);
        const mercator = webMercatorTiling();
        expect(mercator.radialHeights).toBe(false);
        expect(mercator.boundingBox).toBeUndefined();
        expect(mercator.topology.neighbor({ lod: 1, x: 0, y: 0 }, TileNeighbor.W)?.address).toEqual({ lod: 1, x: 1, y: 0 });
    });

    it("give the tiles sharing a pole one normal", () => {
        const tiling = cubeTiling(MOON);
        const corners = [
            { x: 0, y: 0, u: 1, v: 1 },
            { x: 1, y: 0, u: 0, v: 1 },
            { x: 0, y: 1, u: 1, v: 0 },
            { x: 1, y: 1, u: 0, v: 0 },
        ];
        const normals = corners.map(({ x, y, u, v }) => {
            const address = { face: 4, lod: 1, x, y };
            return tiling.surfaceNormal(address, u, v, tiling.surface.up(address, u, v), [0, 0], 1);
        });
        for (const normal of normals) {
            const angle = Math.acos(Math.min(1, normal.x * normals[0]!.x + normal.y * normals[0]!.y + normal.z * normals[0]!.z));
            expect(angle).toBeLessThan((0.01 * Math.PI) / 180);
        }
    });

    it("give a Web Mercator tile the error of the cells of its grid", () => {
        expect(TILE_METRICS.tileSize).toBe(TERRAIN_CONFIG.grid.cells);
    });

    it("give a cube tile the error of the cells of its grid", () => {
        const errorWith = (tileSize?: number): number =>
            createCubeGridSource(MOON, undefined, { maxLOD: 4, ...(tileSize === undefined ? {} : { tileSize }) }).tileset.geometricError;

        expect(errorWith()).toBe(errorWith(TERRAIN_CONFIG.grid.cells));
        expect(errorWith(2 * TERRAIN_CONFIG.grid.cells)).toBeCloseTo(errorWith() / 2, 6);
    });

    it("build a grid source with the face in the metadata of its tiles", () => {
        const { tileset, resolver } = createCubeGridSource(MOON, undefined, { maxLOD: 4 });
        const north = tileset.root.children![4]!;
        expect(north.metadata?.properties).toEqual({ face: 4, lod: 0, x: 0, y: 0 });
        expect(metadataTileAddress({ id: "t", source: north })).toEqual({ face: 4, lod: 0, x: 0, y: 0 });
        const override = resolver.resolve({
            documentUri: "",
            rootTile: north,
            implicitTiling: north.implicitTiling!,
            coordinates: { level: 1, x: 1, y: 0 },
            computedBoundingVolume: { sphere: [0, 0, 0, 1] },
            computedGeometricError: 1,
            computedContents: [],
        });
        expect(override?.metadata?.properties).toEqual({ face: 4, lod: 1, x: 1, y: 0 });
        expect(override?.contents?.[0]?.uri).toBe("cube-grid://tile/4/1/1/0");
    });
});
