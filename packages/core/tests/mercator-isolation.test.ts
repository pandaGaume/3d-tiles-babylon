import { GeodeticSystem } from "@spacexr/geodesy";
import { describe, expect, it } from "vitest";

import { webMercatorTiling } from "../src";
import { tileCenterEcef, tileCenterLongitude, webMercatorLatitude } from "../src/terrain/gpu/grid-shapes";
import { instancedGridPixelShader } from "../src/terrain/gpu/shaders/instancedGrid.fragment";
import { instancedGridVertexShader } from "../src/terrain/gpu/shaders/instancedGrid.vertex";

/** A shader as compiled without a define: the `#ifdef` branches removed, the `#else` branches kept. */
function withoutDefine(source: string, define: string): string {
    const kept: string[] = [];
    const stack: boolean[] = [];
    for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === `#ifdef ${define}`) stack.push(false);
        else if (stack.length > 0 && trimmed === "#else") stack[stack.length - 1] = true;
        else if (stack.length > 0 && trimmed === "#endif") stack.pop();
        else if (stack.every(Boolean)) kept.push(line);
    }
    return kept.join("\n");
}

describe("the Web Mercator path", () => {
    it("holds nothing of the cube in its shaders", () => {
        for (const shader of [instancedGridVertexShader.shader, instancedGridPixelShader.shader]) {
            const mercator = withoutDefine(shader, "RADIAL_HEIGHTS");
            for (const token of ["turns", "floor(reference", "inverseRadiiSquared", "vUp", "vEast", "shapePosition", "heightGradient"]) {
                expect(mercator).not.toContain(token);
            }
        }
    });

    it("computes the latitude of a shape exactly, without going through a float up vector", () => {
        const texels = webMercatorTiling().shapeTexels({ lod: 7, x: 13, y: 31 }, 4);

        for (let row = 0; row <= 4; row++) {
            expect(texels[(row * 5 + 2) * 4 + 3]).toBe(new Float32Array([webMercatorLatitude((31 + row / 4) / 128)])[0]);
        }
    });

    it("shares a shape along a row, whichever column asks for it", () => {
        const tiling = webMercatorTiling();

        expect(tiling.shapeKey({ lod: 7, x: 13, y: 31 })).toBe(tiling.shapeKey({ lod: 7, x: 90, y: 31 }));
        expect(tiling.shapeTexels({ lod: 7, x: 90, y: 31 }, 4)).toEqual(tiling.shapeTexels({ lod: 7, x: 13, y: 31 }, 4));
    });

    it("places tiles with the functions of the engine", () => {
        const tiling = webMercatorTiling();
        const address = { lod: 9, x: 265, y: 180 };

        expect(tiling.center(address)).toEqual(tileCenterEcef(address, GeodeticSystem.WGS84));
        expect(tiling.rotation(address)).toBe(tileCenterLongitude(address));
    });

    it("reads a DEM tile without turning it or wrapping columns", () => {
        const tiling = webMercatorTiling();

        expect(tiling.demArea({ lod: 5, x: 9, y: 6 }, { lod: 3, x: 2, y: 1 })).toEqual({ west: 0.25, north: 0.5, size: 0.25, turns: 0 });
        expect(tiling.demArea({ lod: 3, x: 0, y: 1 }, { lod: 3, x: 7, y: 1 })).toEqual({ west: -7, north: 0, size: 1, turns: 0 });
    });
});
