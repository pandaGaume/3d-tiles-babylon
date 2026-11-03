import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { CameraChangeFlags, type IEcefCameraFrame } from "@spacexr/3d-tiles-runtime";

import { BabylonCameraChangeTracker } from "../camera/camera-change-tracker";
import { createEcefCameraFrame } from "../spatial/camera-frame";

/** Part of `TileRuntime` driven frame by frame. */
export interface IFrameDrivenRuntime {
    readonly hasPendingWork: boolean;
    start(): Promise<void>;
    onCameraChanged(camera: IEcefCameraFrame, changes?: CameraChangeFlags): void;
    processFrame(): Promise<unknown>;
}

export interface IBabylonRuntimeDriverOptions {
    /** Camera submitted to the runtime. Defaults to the active camera of the scene when the driver starts. */
    camera?: Camera;
    /** Receives failures of frames processed after start. Defaults to `console.error`. */
    onError?: (error: unknown) => void;
}

/**
 * Drives a 3D Tiles runtime from the Babylon render loop.
 *
 * After each rendered frame, the driver submits camera changes and runs at most one runtime frame at a time, only
 * when the camera moved or when settled loads require a refresh. A still camera therefore costs no traversal.
 */
export class BabylonRuntimeDriver {
    private camera: Camera | undefined;
    private tracker: BabylonCameraChangeTracker | undefined;
    private observer: Observer<Scene> | null = null;
    private framePending = false;
    private disposed = false;
    private readonly onError: (error: unknown) => void;

    public constructor(
        private readonly runtime: IFrameDrivenRuntime,
        private readonly scene: Scene,
        options: IBabylonRuntimeDriverOptions = {},
    ) {
        this.camera = options.camera;
        this.onError = options.onError ?? ((error) => console.error("3D Tiles runtime frame failed", error));
    }

    /**
     * Starts the runtime, processes the first frame for the current camera and then follows the render loop. The
     * returned promise rejects when the runtime cannot start.
     */
    public async start(): Promise<void> {
        if (this.disposed) throw new Error("The runtime driver has been disposed.");
        if (this.tracker) return;
        const camera = this.camera ?? this.scene.activeCamera;
        if (!camera) throw new Error("The scene has no active camera to drive the runtime.");
        this.camera = camera;
        this.tracker = new BabylonCameraChangeTracker(camera, this.scene.getEngine());

        await this.runtime.start();
        // Babylon computes camera matrices while rendering; before the first frame they must be forced.
        camera.getViewMatrix(true);
        camera.getProjectionMatrix(true);
        this.tracker.capture();
        this.runtime.onCameraChanged(this.cameraFrame(), CameraChangeFlags.All);
        await this.runtime.processFrame();
        if (this.disposed) return;
        this.observer = this.scene.onAfterRenderObservable.add(() => this.update());
    }

    /** Submits camera changes and starts a runtime frame when work is pending. Called after each rendered frame. */
    public update(): void {
        if (!this.tracker || this.disposed) return;
        const changes = this.tracker.capture();
        if (changes !== CameraChangeFlags.None) this.runtime.onCameraChanged(this.cameraFrame(), changes);
        if (this.framePending || !this.runtime.hasPendingWork) return;
        this.framePending = true;
        void this.runtime
            .processFrame()
            .catch((error: unknown) => {
                if (!this.disposed) this.onError(error);
            })
            .finally(() => {
                this.framePending = false;
            });
    }

    /** Stops following the render loop. The runtime itself is disposed by its owner. */
    public dispose(): void {
        this.disposed = true;
        this.scene.onAfterRenderObservable.remove(this.observer);
        this.observer = null;
    }

    private cameraFrame(): IEcefCameraFrame {
        return createEcefCameraFrame(this.camera!, this.scene.getEngine());
    }
}
