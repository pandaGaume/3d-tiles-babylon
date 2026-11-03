import { NeighborLod } from "@spacexr/grid";
import { TileNeighbor } from "@spacexr/tiles";
import { describe, expect, it } from "vitest";

import { DisplayedTiles } from "../src/displayed-tiles";

describe("DisplayedTiles", () => {
    function displayed(...keys: string[]): DisplayedTiles {
        const tiles = new DisplayedTiles();
        for (const key of keys) {
            const [lod, x, y] = key.split("/").map(Number);
            tiles.add({ lod: lod!, x: x!, y: y! });
        }
        return tiles;
    }

    it("finds the same level, a coarser ancestor or finer facing children across each edge", () => {
        // Tile 5/10/10, its east neighbour at the same level, its north neighbour's parent,
        // the southern children of nothing, and the eastern children of its west neighbour.
        const tiles = displayed("5/10/10", "5/11/10", "4/5/4", "6/19/20");
        const tile = { lod: 5, x: 10, y: 10 };

        expect(tiles.lodAcross(tile, TileNeighbor.E)).toBe(5);
        expect(tiles.lodAcross(tile, TileNeighbor.N)).toBe(4);
        expect(tiles.lodAcross(tile, TileNeighbor.W)).toBe(6);
        expect(tiles.lodAcross(tile, TileNeighbor.S)).toBeUndefined();
    });

    it("wraps columns around the antimeridian", () => {
        const tiles = displayed("3/7/2");

        expect(tiles.lodAcross({ lod: 3, x: 0, y: 2 }, TileNeighbor.W)).toBe(3);
    });

    it("lets only one tile of a junction adapt", () => {
        const tiles = displayed("5/10/10", "4/5/4", "6/19/20");
        const tile = { lod: 5, x: 10, y: 10 };

        expect(tiles.edgeLods(tile, "fine")).toEqual({
            [TileNeighbor.N]: NeighborLod.Coarser,
            [TileNeighbor.E]: NeighborLod.Same,
            [TileNeighbor.S]: NeighborLod.Same,
            [TileNeighbor.W]: NeighborLod.Same,
        });
        expect(tiles.edgeLods(tile, "coarse")).toEqual({
            [TileNeighbor.N]: NeighborLod.Same,
            [TileNeighbor.E]: NeighborLod.Same,
            [TileNeighbor.S]: NeighborLod.Same,
            [TileNeighbor.W]: NeighborLod.Finer,
        });
    });

    it("clamps neighbours more than one level apart", () => {
        // 3/3/2 is the level 3 ancestor of 6/24/22, the northern neighbour of 6/24/23.
        const tiles = displayed("3/3/2");

        expect(
            tiles.edgeLods({ lod: 6, x: 24, y: 23 }, "fine")[TileNeighbor.N],
        ).toBe(NeighborLod.Coarser);
    });

    it("counts duplicate presentations", () => {
        const tiles = displayed("5/1/1", "5/1/1");
        tiles.delete({ lod: 5, x: 1, y: 1 });

        expect(tiles.has({ lod: 5, x: 1, y: 1 })).toBe(true);
    });
});
