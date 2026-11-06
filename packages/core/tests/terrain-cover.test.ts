import { CubeTileSurface, ReferenceSurface } from "@spacexr/tiles";
import { describe, expect, it } from "vitest";

import { cubeTiling, webMercatorTiling } from "../src";

describe("terrain cover", () => {
    it("covers the six faces of the cube", () => {
        const { coverRoots } = cubeTiling(new CubeTileSurface(ReferenceSurface.sphere(1000)));
        expect(coverRoots).toHaveLength(6);
        expect(coverRoots!.map((root) => root.face)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(coverRoots!.every((root) => root.lod === 0 && root.x === 0 && root.y === 0)).toBe(true);
    });

    it("leaves Web Mercator without a cover, which draws as before", () => {
        expect(webMercatorTiling().coverRoots).toBeUndefined();
    });
});
