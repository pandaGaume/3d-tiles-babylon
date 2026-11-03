import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import type { Plane } from "@babylonjs/core/Maths/math.plane.js";
import type { IEcefCameraFrame, IPlane } from "@spacexr/3d-tiles-runtime";

function planeToRuntimePlane(plane: Plane): IPlane {
    return { x: plane.normal.x, y: plane.normal.y, z: plane.normal.z, w: plane.d };
}

/**
 * Captures a Babylon camera as the renderer-neutral ECEF camera frame. The scene must use ECEF world coordinates,
 * which `useLargeWorldRendering` keeps precise on the GPU.
 */
export function createEcefCameraFrame(camera: Camera, engine: AbstractEngine): IEcefCameraFrame {
    return {
        id: camera.id,
        position: {
            x: camera.globalPosition.x,
            y: camera.globalPosition.y,
            z: camera.globalPosition.z,
        },
        viewportHeight: engine.getRenderHeight() * camera.viewport.height,
        verticalFovRadians: camera.fov,
        frustumPlanes: Frustum.GetPlanes(camera.getTransformationMatrix()).map(planeToRuntimePlane),
        timestamp: performance.now(),
    };
}
