import "./style.css";

import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
    BabylonRuntimeDriver,
    BabylonRuntimeMonitor,
    createGeospatialCamera,
    createGeospatialEngine,
    createGeospatialScene,
} from "@spacexr/3d-tiles-babylon";
import {
    DenseImplicitSubtreeLoader,
    EcefSpatialMetric,
    TileRuntime,
    type IEcefCameraFrame,
    type IEcefSpatialState,
    type IRuntimeAdapter,
} from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem } from "@spacexr/geodesy";
import {
    WorkerDemDecoder,
    createMapzenTerrariumSource,
    type IDemWorkerEndpoint,
} from "@spacexr/tiles";

import {
    BabylonGeodesicGridPipeline,
    type IBabylonGeodesicGridHandle,
} from "./babylon-geodesic-grid-pipeline";
import { ChildHeightRanges } from "./child-height-ranges";
import DemDecoderWorker from "./dem-decoder.worker?worker";
import { createGeodesicGridSource } from "./grid-source";
import { clearMonitorPanel, renderMonitorPanel } from "./monitor-panel";

function requiredElement<TElement extends HTMLElement>(
    id: string,
    constructor: { new (): TElement },
): TElement {
    const element = document.getElementById(id);
    if (!(element instanceof constructor))
        throw new Error(`Required element #${id} is missing.`);
    return element;
}

async function run(): Promise<void> {
    const startupStartedAt = performance.now();
    const canvas = requiredElement("render-canvas", HTMLCanvasElement);
    const status = requiredElement("runtime-status", HTMLSpanElement);
    const panel = {
        tiles: requiredElement("runtime-statistics", HTMLSpanElement),
        memory: requiredElement("memory-statistics", HTMLSpanElement),
        cleanup: requiredElement("cleanup-statistics", HTMLSpanElement),
        renderer: requiredElement("renderer-statistics", HTMLSpanElement),
        frame: requiredElement("frame-statistics", HTMLSpanElement),
    };
    const tileLabels = requiredElement("tile-labels", HTMLDivElement);
    const engine = createGeospatialEngine(canvas);
    const scene = createGeospatialScene(engine);

    const geodeticSystem = GeodeticSystem.WGS84;
    const parameters = new URLSearchParams(window.location.search);
    const monitoringEnabled = parameters.get("monitor") !== "0";
    const solidRendering = parameters.get("solid") === "1";
    const elevationEnabled = parameters.get("elevation") !== "0";
    const verticalScaleInput = requiredElement(
        "vertical-scale",
        HTMLInputElement,
    );
    const verticalScaleValue = requiredElement(
        "vertical-scale-value",
        HTMLOutputElement,
    );
    const initialScale = Number(
        parameters.get("scale") ?? parameters.get("exaggeration") ?? "1",
    );
    if (!Number.isFinite(initialScale) || initialScale < 0)
        throw new RangeError("The scale parameter must be non-negative.");
    let verticalScale = initialScale;
    const dem = elevationEnabled ? createMapzenTerrariumSource() : undefined;
    const childHeightRanges = new ChildHeightRanges();
    // Tiles start at 0/0. Each DEM reports the tile range and prepares the ranges of its four children.
    const source = createGeodesicGridSource(
        dem
            ? { ranges: childHeightRanges, verticalScale: () => verticalScale }
            : undefined,
    );
    if (dem)
        requiredElement("attribution", HTMLElement).textContent =
            dem.source.attribution ?? "";

    // Mont Blanc summit, 4808 m.
    const montBlanc = {
        latitude: 45.832622,
        longitude: 6.865175,
        height: 4808,
    };
    const camera = createGeospatialCamera(scene, {
        name: "geographic-camera",
        geodeticSystem,
        target: {
            latitudeDegrees: montBlanc.latitude,
            longitudeDegrees: montBlanc.longitude,
            heightMeters: dem ? montBlanc.height * verticalScale : 0,
        },
        radius: Number(parameters.get("radius") ?? "25000"),
        pitchRadians: (Number(parameters.get("pitch") ?? "60") * Math.PI) / 180,
        radiusMin: 500,
    });

    if (solidRendering) {
        // Sun from the north-west, 45 degrees above the Mont Blanc horizon.
        const { east, north, up } =
            geodeticSystem.createLocalTangentPlaneDegrees(
                montBlanc.latitude,
                montBlanc.longitude,
            ).basis;
        const toSun = new Vector3(
            up.x + (north.x - east.x) * Math.SQRT1_2,
            up.y + (north.y - east.y) * Math.SQRT1_2,
            up.z + (north.z - east.z) * Math.SQRT1_2,
        ).normalize();
        const sun = new DirectionalLight("sun", toSun.negate(), scene);
        sun.intensity = 1.1;
        const sky = new HemisphericLight(
            "sky",
            new Vector3(up.x, up.y, up.z),
            scene,
        );
        sky.intensity = 0.25;
        sky.groundColor = new Color3(0.1, 0.1, 0.12);
    }

    const pipeline = new BabylonGeodesicGridPipeline(scene, tileLabels, {
        wireframe: !solidRendering,
        ...(dem
            ? {
                  elevation: {
                      dem,
                      // PNG and elevation decoding take about 60 ms per tile; workers keep it off the render loop.
                      demDecoder: new WorkerDemDecoder(
                          Array.from(
                              {
                                  length: Math.max(
                                      1,
                                      Math.min(
                                          4,
                                          (navigator.hardwareConcurrency || 2) -
                                              1,
                                      ),
                                  ),
                              },
                              () =>
                                  new DemDecoderWorker() as unknown as IDemWorkerEndpoint,
                          ),
                      ),
                      verticalScale,
                      childHeightRanges,
                  },
              }
            : {}),
    });
    verticalScaleInput.value = String(verticalScale);
    verticalScaleValue.value = `x${verticalScale}`;
    verticalScaleInput.disabled = !dem;
    verticalScaleInput.addEventListener("input", () => {
        verticalScale = Number(verticalScaleInput.value);
        verticalScaleValue.value = `x${verticalScale}`;
        pipeline.setVerticalScale(verticalScale);
    });

    const adapter: IRuntimeAdapter<
        IEcefCameraFrame,
        IEcefSpatialState,
        IBabylonGeodesicGridHandle,
        never
    > = {
        tilesets: { load: async () => ({ tileset: source.tileset }) },
        subtrees: new DenseImplicitSubtreeLoader(),
        implicitTiles: source.resolver,
        spatial: new EcefSpatialMetric({ geodeticSystem }),
        activation: pipeline,
        presentation: pipeline,
    };
    const runtime = new TileRuntime({
        id: "implicit-geodesic-grid",
        uri: "memory://geodesic-grid/tileset.json",
        adapter,
        maxScreenSpaceError: 10,
        refinementHysteresisRatio: 0.2,
        maxConcurrentLoads: 12,
        instrumentation: { enabled: monitoringEnabled },
        cache: {
            maxContentEntries: 1024,
            maxMaterializedTiles: 4096,
            unusedFrameRetention: 180,
        },
    });

    const monitor = new BabylonRuntimeMonitor(
        engine,
        scene,
        runtime.instrumentation,
        { enabled: monitoringEnabled, resources: pipeline },
    );
    if (monitor.enabled)
        monitor.subscribe((snapshot) => renderMonitorPanel(panel, snapshot));
    else clearMonitorPanel(panel);
    const unsubscribeEvents = runtime.events.subscribe((event) => {
        if (event.type !== "error") return;
        status.textContent = `Pipeline error: ${event.phase}`;
        console.error("3D Tiles pipeline error", event.error);
    });

    const driver = new BabylonRuntimeDriver(runtime, scene, {
        camera,
        onError: (error) => {
            status.textContent = "Runtime frame failed";
            console.error("3D Tiles pipeline frame failed", error);
        },
    });
    status.textContent = "Loading the implicit quadtree...";
    await driver.start();
    monitor.setStartupMilliseconds(performance.now() - startupStartedAt);
    status.textContent = `Global WebMercator coverage, ${source.dataSources.length} roots, LOD ${source.metrics.minLOD}..${source.metrics.maxLOD}`;

    engine.runRenderLoop(() => {
        scene.render();
        monitor.update();
        pipeline.updateDebugLabels();
    });

    const resize = (): void => engine.resize();
    window.addEventListener("resize", resize);
    window.addEventListener(
        "beforeunload",
        () => {
            window.removeEventListener("resize", resize);
            driver.dispose();
            unsubscribeEvents();
            void runtime.dispose();
            monitor.dispose();
            pipeline.dispose();
            scene.dispose();
            engine.dispose();
        },
        { once: true },
    );
}

void run().catch((error: unknown) => {
    const status = document.getElementById("runtime-status");
    if (status)
        status.textContent =
            error instanceof Error
                ? error.message
                : "The pipeline example could not start.";
    console.error("Babylon implicit geodesic grid example failed", error);
});
