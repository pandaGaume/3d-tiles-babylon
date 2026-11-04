import { createGridTopology, createJunctionGridTopology, NeighborLod, SAME_EDGE_LODS } from "@spacexr/grid";
import { TileNeighbor } from "@spacexr/tiles";
import { describe, expect, it } from "vitest";

import { skirtedGridGeometry } from "../src/terrain/gpu/instanced-grid";

describe("skirtedGridGeometry", () => {
    it("repeats every boundary vertex once as a skirt vertex and extrudes every boundary edge", () => {
        const topology = createGridTopology(4);
        const { positions, indices } = skirtedGridGeometry(topology);
        const surface = topology.coordinates.length / 2;

        // 25 surface vertices, of which 16 lie on the boundary; 16 boundary edges, two triangles each.
        expect(positions.length / 3).toBe(surface + 16);
        expect(indices.length).toBe(topology.indices.length + 16 * 6);
        for (let vertex = surface; vertex < positions.length / 3; vertex++) {
            const [u, v, skirt] = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!];
            expect(skirt).toBe(1);
            expect(u === 0 || u === 1 || v === 0 || v === 1).toBe(true);
        }
    });

    it("does not extrude inner edges, and follows the coarser edges of a junction variant", () => {
        const coarserNorth = createJunctionGridTopology(4, 4, { ...SAME_EDGE_LODS, [TileNeighbor.N]: NeighborLod.Coarser });
        const { positions } = skirtedGridGeometry(coarserNorth);
        const skirtVertices = [];
        for (let vertex = 0; vertex < positions.length / 3; vertex++) if (positions[vertex * 3 + 2] === 1) skirtVertices.push(vertex);

        // The north edge keeps 3 of its 5 vertices: 14 boundary vertices instead of 16.
        expect(skirtVertices).toHaveLength(14);
        expect(skirtVertices.every((vertex) => positions[vertex * 3 + 1] !== 0 || [0, 0.5, 1].includes(positions[vertex * 3]!))).toBe(true);
    });
});
