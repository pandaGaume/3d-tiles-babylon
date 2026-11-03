import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import type { EngineOptions } from "@babylonjs/core/Engines/thinEngine.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Scene } from "@babylonjs/core/scene.js";

export interface IGeospatialEngineOptions {
    /** Defaults to true. */
    antialias?: boolean;
    /** Defaults to true. */
    adaptToDeviceRatio?: boolean;
    /** Merged over the geospatial defaults: stencil and large world rendering. */
    engineOptions?: EngineOptions;
}

export interface IGeospatialSceneOptions {
    clearColor?: Color4;
}

/**
 * Creates a WebGL engine for planetary ECEF coordinates. Large world rendering renders relative to the camera, so
 * tiles stay stable millions of metres away from the origin.
 */
export function createGeospatialEngine(canvas: HTMLCanvasElement, options: IGeospatialEngineOptions = {}): Engine {
    return new Engine(
        canvas,
        options.antialias ?? true,
        { stencil: true, useLargeWorldRendering: true, ...options.engineOptions },
        options.adaptToDeviceRatio ?? true,
    );
}

/**
 * Creates a scene that uses the glTF and 3D Tiles right-handed convention. The engine may be a WebGL engine from
 * {@link createGeospatialEngine} or a WebGPU engine created with `useLargeWorldRendering`.
 */
export function createGeospatialScene(engine: AbstractEngine, options: IGeospatialSceneOptions = {}): Scene {
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = options.clearColor ?? new Color4(0.008, 0.035, 0.09, 1);
    // Pointer moves would otherwise ray cast every tile mesh to raise hover events.
    scene.skipPointerMovePicking = true;
    return scene;
}
