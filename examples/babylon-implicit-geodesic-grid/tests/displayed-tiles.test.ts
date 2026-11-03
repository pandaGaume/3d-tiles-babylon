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

    it("lists the displayed tiles touching a point, from the coarsest level", () => {
        // 4/4/4 covers [0.25, 0.3125]; its east neighbour is split into 5/10/8 and 5/10/9.
        const tiles = displayed("4/4/4", "5/10/8", "5/10/9");

        // On the shared edge, at the corner of the two finer tiles.
        expect(tiles.touching(0.3125, 0.28125)).toEqual([
            { lod: 4, x: 4, y: 4 },
            { lod: 5, x: 10, y: 8 },
        ]);
        // Inside the coarse tile only.
        expect(tiles.touching(0.27, 0.27)).toEqual([{ lod: 4, x: 4, y: 4 }]);

        tiles.delete({ lod: 4, x: 4, y: 4 });
        expect(tiles.touching(0.3125, 0.28125)).toEqual([
            { lod: 5, x: 10, y: 8 },
        ]);
    });

    it("finds tiles touching a point across the antimeridian", () => {
        const tiles = displayed("2/3/1");

        expect(tiles.touching(0, 0.3)).toEqual([{ lod: 2, x: 3, y: 1 }]);
    });
});
