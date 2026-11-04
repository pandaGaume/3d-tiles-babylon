import "./style.css";

import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
    BabylonRasterPages,
    BabylonRasterTileAdapter,
    BabylonRuntimeDriver,
    BabylonRuntimeMonitor,
    GpuTerrainEngine,
    MeshTerrainEngine,
    TILE_METRICS,
    createGeodesicGridSource,
    createGeospatialCamera,
    metadataTileAddress,
    type IGridElevationOptions,
    type ITerrainEngine,
    type ITerrainEngineInputs,
    type IBabylonRasterPage,
    createGeospatialEngine,
    createGeospatialScene,
} from "@spacexr/3d-tiles-babylon";
import {
    DenseImplicitSubtreeLoader,
    EcefSpatialMetric,
    TileRuntime,
    WebMercatorTileMetrics,
    type IEcefCameraFrame,
    type ITileAddress,
    type IEcefSpatialState,
    type IRuntimeAdapter,
} from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem } from "@spacexr/geodesy";
import {
    ChildHeightRanges,
    DemPyramid,
    WorkerDemDecoder,
    createMapzenTerrariumSource,
    webDemTileLoader,
    type IDemWorkerEndpoint,
} from "@spacexr/dem";

import DemDecoderWorker from "./dem-decoder.worker?worker";
import { debugImageryTile } from "./debug-imagery";
import { loadLocalImagery } from "./local-imagery";
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
    const junctions = parameters.get("junctions") ?? "fine";
    if (junctions !== "fine" && junctions !== "coarse" && junctions !== "none")
        throw new RangeError(
            "The junctions parameter must be fine, coarse or none.",
        );
    const edgeHeights = parameters.get("heights") ?? "coarsest";
    if (
        edgeHeights !== "coarsest" &&
        edgeHeights !== "finest" &&
        edgeHeights !== "average"
    )
        throw new RangeError(
            "The heights parameter must be coarsest, finest or average.",
        );
    // Refined tiles coarsen only once their error drops below (1 - hysteresis) times the threshold.
    const hysteresis = Number(parameters.get("hysteresis") ?? "0.2");
    // Refined tiles wait this many frames before coarsening, so that a neighbour leaving the view does not flicker them.
    const coarsenDelay = Number(parameters.get("coarsenDelay") ?? "20");
    // Main-thread milliseconds per frame for rebuilding grids whose neighbours changed; the rest waits for the next frames.
    const junctionBudget = Number(parameters.get("junctionBudget") ?? "4");
    const demInterpolation = parameters.get("interpolation") ?? "cubic";
    if (
        demInterpolation !== "nearest" &&
        demInterpolation !== "linear" &&
        demInterpolation !== "bilinear" &&
        demInterpolation !== "cubic"
    )
        throw new RangeError(
            "The interpolation parameter must be cubic, bilinear, linear or nearest.",
        );
    // `debug` draws pages locally; any other name loads src/local/<name>.imagery.ts, kept out of the repository.
    const imagery = parameters.get("imagery") ?? "debug";
    // Imagery drapes shaded grids only; wireframe grids keep their level colours.
    const imageryEnabled = solidRendering && imagery !== "none";
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

    // Imagery is a second implicit quadtree, refined on texel size instead of geometric error.
    const imagerySource = !imageryEnabled
        ? undefined
        : imagery === "debug"
          ? {
                load: (address: ITileAddress) =>
                    Promise.resolve(debugImageryTile(address)),
                maxLOD: 20,
                attribution: "",
            }
          : await loadLocalImagery(imagery);
    const imageryMetrics = new WebMercatorTileMetrics({
        minLOD: 3,
        maxLOD: imagerySource?.maxLOD ?? 20,
        tileSize: 256,
    });
    const imageryPages = imagerySource
        ? new BabylonRasterPages(scene, {
              load: imagerySource.load,
              maxLOD: imageryMetrics.maxLOD,
              wrapX: true,
              tileSize: imageryMetrics.tileSize,
          })
        : undefined;
    if (imagerySource?.attribution) {
        const attribution = requiredElement("attribution", HTMLElement);
        attribution.textContent = [
            imagerySource.attribution,
            attribution.textContent,
        ]
            .filter(Boolean)
            .join(" | ");
    }
    // Deepest drape below each terrain tile: up to 4^kmax imagery pages per tile.
    const maxDrapeDepth = Number(parameters.get("kmax") ?? "4");

    function createImageryRuntime(
        pages: BabylonRasterPages,
    ): TileRuntime<
        IEcefCameraFrame,
        IEcefSpatialState,
        IBabylonRasterPage,
        never
    > {
        // Imagery tiles share the height ranges prepared by the terrain DEM, for culling and distances.
        const imagerySource = createGeodesicGridSource(
            dem
                ? {
                      ranges: childHeightRanges,
                      verticalScale: () => verticalScale,
                  }
                : undefined,
            { metrics: imageryMetrics, id: "imagery" },
        );
        const imageryAdapter = new BabylonRasterTileAdapter<IEcefSpatialState>(
            pages,
            {
                addressOf: (context) => metadataTileAddress(context.tile),
            },
        );
        return new TileRuntime({
            id: "implicit-grid-mapzen-imagery",
            uri: "memory://imagery/tileset.json",
            adapter: {
                tilesets: {
                    load: async () => ({ tileset: imagerySource.tileset }),
                },
                subtrees: new DenseImplicitSubtreeLoader(),
                implicitTiles: imagerySource.resolver,
                spatial: new EcefSpatialMetric({ geodeticSystem }),
                activation: imageryAdapter,
                presentation: imageryAdapter,
            },
            // The geometric error of an imagery tile is one texel: at most two texels per screen pixel.
            maxScreenSpaceError: 2,
            refinementHysteresisRatio: hysteresis,
            // Children outside the view load in the background, so that turning the camera never falls back to their parent.
            preloadSiblings: true,
            coarseningDelayFrames: coarsenDelay,
            maxConcurrentLoads: 12,
            cache: {
                maxContentEntries: 512,
                maxMaterializedTiles: 4096,
                unusedFrameRetention: 180,
            },
        });
    }

    const elevation: IGridElevationOptions | undefined = dem
        ? {
              pyramid: new DemPyramid({
                  load: webDemTileLoader(
                      dem,
                      // PNG and elevation decoding take about 60 ms per tile; workers keep it off the render loop.
                      new WorkerDemDecoder(
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
                  ),
                  maxLOD: dem.source.metrics.maxLOD,
                  // Room for the DEM tiles retained by the displayed cut, and for the tiles loading around it.
                  cacheEntries: 512,
                  // Levels below the DEM are generated down to the deepest grid level.
                  generation: {
                      maxLOD: TILE_METRICS.maxLOD,
                      interpolation: demInterpolation,
                  },
                  // The grid covers every longitude.
                  wrapX: true,
                  childHeightRanges,
              }),
              verticalScale,
          }
        : undefined;
    // The engine turning terrain tiles into pixels; the runtimes, the DEM and the imagery pages stay shared.
    const engineName = parameters.get("engine") ?? "mesh";
    if (engineName !== "mesh" && engineName !== "gpu")
        throw new RangeError("The engine parameter must be mesh or gpu.");
    const terrainInputs: ITerrainEngineInputs = {
        scene,
        labelLayer: tileLabels,
        wireframe: !solidRendering,
        junctions,
        edgeHeights,
        ...(elevation ? { elevation } : {}),
        ...(imageryPages ? { imageryPages } : {}),
    };
    const terrain: ITerrainEngine =
        engineName === "gpu"
            ? new GpuTerrainEngine(terrainInputs)
            : new MeshTerrainEngine(terrainInputs, {
                  maxDrapeDepth,
                  junctionBudgetMilliseconds: junctionBudget,
              });
    verticalScaleInput.value = String(verticalScale);
    verticalScaleValue.value = `x${verticalScale}`;
    verticalScaleInput.disabled = !dem;
    verticalScaleInput.addEventListener("input", () => {
        verticalScale = Number(verticalScaleInput.value);
        verticalScaleValue.value = `x${verticalScale}`;
        terrain.setVerticalScale(verticalScale);
    });

    const adapter: IRuntimeAdapter<
        IEcefCameraFrame,
        IEcefSpatialState,
        unknown,
        never
    > = {
        tilesets: { load: async () => ({ tileset: source.tileset }) },
        subtrees: new DenseImplicitSubtreeLoader(),
        implicitTiles: source.resolver,
        spatial: new EcefSpatialMetric({ geodeticSystem }),
        activation: terrain,
        presentation: terrain,
    };
    const runtime = new TileRuntime({
        id: "implicit-grid-mapzen",
        uri: "memory://geodesic-grid/tileset.json",
        adapter,
        maxScreenSpaceError: 10,
        refinementHysteresisRatio: hysteresis,
        // Children outside the view load in the background, so that turning the camera never falls back to their parent.
        preloadSiblings: true,
        coarseningDelayFrames: coarsenDelay,
        maxConcurrentLoads: 12,
        instrumentation: { enabled: monitoringEnabled },
        // Neighbouring tiles stay within one level, so that every edge junction connects.
        quadtreeBalance:
            parameters.get("balance") === "0" ? false : { wrapX: true },
        cache: {
            maxContentEntries: 1024,
            maxMaterializedTiles: 4096,
            unusedFrameRetention: 180,
        },
    });

    const imageryRuntime = imageryPages
        ? createImageryRuntime(imageryPages)
        : undefined;

    const monitor = new BabylonRuntimeMonitor(
        engine,
        scene,
        runtime.instrumentation,
        { enabled: monitoringEnabled, resources: terrain },
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
    const imageryDriver = imageryRuntime
        ? new BabylonRuntimeDriver(imageryRuntime, scene, {
              camera,
              onError: (error) =>
                  console.error("Imagery runtime frame failed", error),
          })
        : undefined;
    status.textContent = "Loading the implicit quadtree...";
    await Promise.all([driver.start(), imageryDriver?.start()]);
    monitor.setStartupMilliseconds(performance.now() - startupStartedAt);
    status.textContent = `Global WebMercator coverage, ${source.dataSources.length} roots, LOD ${source.metrics.minLOD}..${source.metrics.maxLOD}`;

    // Objects of the example, for probes run from the browser console.
    (window as unknown as Record<string, unknown>).__SPACEXR_EXAMPLE__ = {
        runtime,
        imageryRuntime,
        terrain,
        // Parts of the mesh engine, for the probes written against it.
        ...(terrain instanceof MeshTerrainEngine
            ? { pipeline: terrain.grids, drape: terrain.drape }
            : {}),
        imageryPages,
    };

    engine.runRenderLoop(() => {
        terrain.beforeRender();
        scene.render();
        monitor.update();
        terrain.afterRender();
    });

    const resize = (): void => engine.resize();
    window.addEventListener("resize", resize);
    window.addEventListener(
        "beforeunload",
        () => {
            window.removeEventListener("resize", resize);
            driver.dispose();
            imageryDriver?.dispose();
            unsubscribeEvents();
            void runtime.dispose();
            void imageryRuntime?.dispose();
            // The engine releases its imagery bindings before the pages they read.
            terrain.dispose();
            imageryPages?.dispose();
            monitor.dispose();
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
    console.error("Babylon implicit grid Mapzen example failed", error);
});
