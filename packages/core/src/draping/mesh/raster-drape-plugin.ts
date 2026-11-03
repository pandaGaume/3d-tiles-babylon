import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";

import type { TextureArrayPool } from "../../raster/texture-array-pool";

/** Binding of one mesh: its drape depth and the layer of its cell table, `-1` without table. */
export interface IMeshRasterDrape {
    depth: number;
    tableLayer: number;
}

const NO_DRAPE: IMeshRasterDrape = { depth: 0, tableLayer: -1 };

/** Source of the drape of each mesh, kept by the draping engine. */
export interface IMeshRasterDrapeSource {
    /** Imagery pages, RGBA8. */
    readonly pages: TextureArrayPool;
    /** Cell tables, RGBA32F: per cell, the page layer, `-1` without page, then `west, north, size` in the page. */
    readonly tables: TextureArrayPool;
    drapeOf(mesh: AbstractMesh): IMeshRasterDrape | undefined;
}

class RasterDrapeDefines extends MaterialDefines {
    public RASTERDRAPE = false;
}

/**
 * Standard material plugin colouring terrain tiles with imagery pages.
 *
 * A terrain tile draped at depth `k` is divided into `2^k x 2^k` cells, each sampling its own page. The cells of a
 * mesh are described by a table, one texel per cell, read with `texelFetch`; each mesh receives its depth and table
 * layer when it is drawn, so tiles of every level share one material. Lighting is unchanged: the page colour replaces
 * the diffuse colour, and a cell without page keeps the material colour. The mesh UVs are the tile coordinates
 * `(u, 1 - v)`, `u` east and `v` south.
 */
export class RasterDrapeMaterialPlugin extends MaterialPluginBase {
    private enabled = true;

    public constructor(
        material: Material,
        private readonly source: IMeshRasterDrapeSource,
    ) {
        super(material, "RasterDrape", 200, new RasterDrapeDefines());
        this.registerForExtraEvents = true;
        this._enable(true);
    }

    public override getClassName(): string {
        return "RasterDrapeMaterialPlugin";
    }

    /** Shows the material colour instead of the imagery when false. */
    public get isEnabled(): boolean {
        return this.enabled;
    }

    public set isEnabled(value: boolean) {
        if (this.enabled === value) return;
        this.enabled = value;
        this.markAllDefinesAsDirty();
    }

    public override isCompatible(): boolean {
        // Texture arrays need WebGL 2.
        return this._material.getScene().getEngine().getCaps().texture2DArrayMaxLayerCount > 0;
    }

    public override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
        defines["RASTERDRAPE"] = this.enabled;
        // The tile coordinates come from the mesh UVs.
        if (this.enabled) defines._needUVs = true;
    }

    public override getSamplers(samplers: string[]): void {
        samplers.push("drapePages", "drapeTables");
    }

    public override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [{ name: "drapeInfo", size: 4, type: "vec4" }],
            fragment: `#ifdef RASTERDRAPE
uniform vec4 drapeInfo;
#endif`,
        };
    }

    public override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
        this.bindDrape(uniformBuffer, subMesh);
    }

    /** Called for every mesh drawn, even when the material does not rebind: each mesh has its own drape. */
    public override hardBindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
        this.bindDrape(uniformBuffer, subMesh);
    }

    public override getCustomCode(shaderType: string): Record<string, string> | null {
        if (shaderType === "vertex")
            return {
                CUSTOM_VERTEX_DEFINITIONS: `#if defined(RASTERDRAPE) && defined(UV1)
varying vec2 vDrapeUV;
#endif`,
                CUSTOM_VERTEX_MAIN_END: `#if defined(RASTERDRAPE) && defined(UV1)
vDrapeUV = uv;
#endif`,
            };
        if (shaderType === "fragment")
            return {
                CUSTOM_FRAGMENT_DEFINITIONS: `#if defined(RASTERDRAPE) && defined(UV1)
precision highp sampler2DArray;
uniform highp sampler2DArray drapePages;
uniform highp sampler2DArray drapeTables;
varying vec2 vDrapeUV;

vec4 rasterDrapeColor(vec2 tile) {
    // drapeInfo: x = depth, y = table layer.
    if (drapeInfo.y < 0.0) return vec4(0.0);
    float cells = exp2(drapeInfo.x);
    vec2 cell = clamp(floor(tile * cells), 0.0, cells - 1.0);
    vec4 entry = texelFetch(drapeTables, ivec3(ivec2(cell), int(drapeInfo.y)), 0);
    if (entry.x < 0.0) return vec4(0.0);
    // Point registration: the first and last texels lie on the page edges.
    float texels = float(textureSize(drapePages, 0).x);
    vec2 page = entry.yz + (tile * cells - cell) * entry.w;
    vec2 coordinates = (page * (texels - 1.0) + 0.5) / texels;
    return vec4(texture(drapePages, vec3(coordinates, entry.x)).rgb, 1.0);
}
#endif`,
                CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#if defined(RASTERDRAPE) && defined(UV1)
vec4 drapeColor = rasterDrapeColor(vec2(vDrapeUV.x, 1.0 - vDrapeUV.y));
if (drapeColor.a > 0.0) {
    baseColor.rgb = drapeColor.rgb;
    diffuseColor = vec3(1.0);
}
#endif`,
            };
        return null;
    }

    private bindDrape(uniformBuffer: UniformBuffer, subMesh: SubMesh): void {
        if (!this.enabled) return;
        const drape = this.source.drapeOf(subMesh.getMesh()) ?? NO_DRAPE;
        uniformBuffer.updateFloat4("drapeInfo", drape.depth, drape.tableLayer, 0, 0);
        uniformBuffer.setTexture("drapePages", this.source.pages);
        uniformBuffer.setTexture("drapeTables", this.source.tables);
    }
}
