import "./style.css";

import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
    BabylonGltfTileAdapter,
    BabylonRasterPages,
    BabylonRasterTileAdapter,
    BabylonRuntimeDriver,
    BabylonRuntimeMonitor,
    GpuTerrainEngine,
    MeshTerrainEngine,
    TILE_METRICS,
    createCubeGridSource,
    createGeodesicGridSource,
    cubeTiling,
    createGeospatialCamera,
    OrbitalCamera,
    metadataTileAddress,
    type IGridElevationOptions,
    type ITerrainEngine,
    type ITerrainEngineInputs,
    type IBabylonGltfTileHandle,
    type IBabylonRasterPage,
    createGeospatialRendererEngine,
    createGeospatialScene,
} from "@spacexr/3d-tiles-babylon";
import {
    DenseImplicitSubtreeLoader,
    EcefSpatialMetric,
    TileRuntime,
    VerticalScale,
    radialVerticalFrame,
    WebMercatorTileMetrics,
    type IEcefCameraFrame,
    type ITileAddress,
    type IEcefSpatialState,
    type IRuntimeAdapter,
} from "@spacexr/3d-tiles-runtime";
import { Ellipsoid, GeodeticSystem } from "@spacexr/geodesy";
import {
    CUBE_TILE_TOPOLOGY,
    CubeTileSurface,
    ReferenceSurface,
    cubeTileOfDirection,
    planetocentricDirection,
} from "@spacexr/tiles";
import {
    ChildHeightRanges,
    DemPyramid,
    WorkerDemDecoder,
    createMapzenTerrariumSource,
    cubeDemPyramid,
    webDemTileLoader,
    type IDemWorkerEndpoint,
} from "@spacexr/dem";

import DemDecoderWorker from "./dem-decoder.worker?worker";
import { createMoonObjects } from "./moon-objects";
import {
    datasetHeightAt,
    datasetImageryLoader,
    loadMoonDataset,
    terrainSubtrees,
} from "./moon-dataset";
import { debugImageryTile } from "./debug-imagery";
import {
    SYNTHETIC_MOON_RADIUS,
    loadSyntheticMoonTile,
    syntheticMoonHeight,
} from "./synthetic-moon";
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

/** PNG and elevation decoding take about 60 ms per tile; workers keep it off the render loop. */
function createDemDecoder(): WorkerDemDecoder {
    return new WorkerDemDecoder(
        Array.from(
            {
                length: Math.max(
                    1,
                    Math.min(4, (navigator.hardwareConcurrency || 2) - 1),
                ),
            },
            () => new DemDecoderWorker() as unknown as IDemWorkerEndpoint,
        ),
    );
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
    const parameters = new URLSearchParams(window.location.search);
    // `renderer=webgpu` runs the GLSL shaders, converted by Babylon, on its WebGPU engine where the browser supports it, WebGL otherwise.
    const { engine, renderer } = await createGeospatialRendererEngine(
        canvas,
        parameters.get("renderer") === "webgpu" ? "webgpu" : "webgl",
    );
    const scene = createGeospatialScene(engine);

    // `body=moon` shows a whole Moon on the cube index, poles included, with the GPU engine: synthetic, or
    // from the tile service named by `dataset`.
    const moon = parameters.get("body") === "moon";
    const datasetService = parameters.get("dataset");
    const moonDataset =
        moon && datasetService
            ? await loadMoonDataset(datasetService)
            : undefined;
    const moonRadius = moonDataset?.radius ?? SYNTHETIC_MOON_RADIUS;
    const geodeticSystem = moon
        ? new GeodeticSystem(Ellipsoid.sphere("Moon", moonRadius))
        : GeodeticSystem.WGS84;
    const moonSurface = moon
        ? (moonDataset?.elevation.surface ??
          new CubeTileSurface(ReferenceSurface.sphere(moonRadius)))
        : undefined;
    // Deepest level of the DEM of the Moon everywhere. A terrain tile has 16 cells per side and a DEM tile 256: the terrain
    // reaches the samples of the DEM four levels below it, whose tiles read sub-areas of the DEM tile, not interpolated tiles.
    const moonDemMaxLOD = moonDataset?.elevation.dataset.maxLOD ?? 10;
    const moonMaxLOD = moonDemMaxLOD + 4;
    // Deepest level of its DEM anywhere, such as the south polar cap of a dataset.
    const moonDemDeepestLOD =
        moonDataset?.elevation.deepestLOD ?? moonDemMaxLOD;
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
    // `debug` draws pages locally, `dataset` reads the tile service of the Moon; any other name loads
    // src/local/<name>.imagery.ts, kept out of the repository.
    const imagery =
        parameters.get("imagery") ?? (moonDataset ? "dataset" : "debug");
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
    // Everything in the scene reads this one scale; the slider only changes it.
    const verticalScale = new VerticalScale(initialScale);
    // On a sphere with terrain below its reference surface, the horizon reads the heights of each tile.
    const spatialOptions = {
        geodeticSystem,
        ...(moon ? { horizon: "tile-heights" as const } : {}),
    };
    const dem =
        elevationEnabled && !moon ? createMapzenTerrariumSource() : undefined;
    const childHeightRanges = new ChildHeightRanges();
    // Terrain subtrees with their own levels, "lod/x/y/maxLOD" separated by commas, for example "13/4252/2920/13".
    const subtrees = (parameters.get("subtrees") ?? "")
        .split(",")
        .filter(Boolean)
        .map((entry) => {
            const [lod, x, y, maxLOD] = entry.split("/").map(Number);
            if (![lod, x, y, maxLOD].every(Number.isInteger))
                throw new RangeError(
                    "Each subtree must be written lod/x/y/maxLOD.",
                );
            return { root: { lod: lod!, x: x!, y: y! }, maxLOD: maxLOD! };
        });
    // Tiles start at 0/0. Each DEM reports the tile range and prepares the ranges of its four children.
    const preparedHeights =
        dem || (moon && elevationEnabled)
            ? {
                  ranges: childHeightRanges,
                  verticalScale: () => verticalScale.value,
              }
            : undefined;
    const source = moonSurface
        ? createCubeGridSource(moonSurface, preparedHeights, {
              maxLOD: moonMaxLOD,
              // The error of a terrain tile follows the cells of its grid, not the samples of its DEM.
              tileSize: 16,
              ...(moonDataset
                  ? { subtrees: terrainSubtrees(moonDataset.elevation, 4) }
                  : {}),
          })
        : createGeodesicGridSource(preparedHeights, { subtrees });
    if (dem)
        requiredElement("attribution", HTMLElement).textContent =
            dem.source.attribution ?? "";

    const moonPyramid =
        moon && elevationEnabled
            ? moonDataset
                ? cubeDemPyramid(moonDataset.elevation, createDemDecoder(), {
                      cacheEntries: 512,
                      childHeightRanges,
                  })
                : new DemPyramid({
                      registration: "point",
                      load: loadSyntheticMoonTile,
                      maxLOD: moonDemMaxLOD,
                      cacheEntries: 512,
                      childHeightRanges,
                  })
            : undefined;
    const moonHeight =
        moonDataset && moonPyramid
            ? datasetHeightAt(moonPyramid, moonDemDeepestLOD)
            : syntheticMoonHeight;

    // Mont Blanc summit, 4808 m.
    const montBlanc = {
        latitude: 45.832622,
        longitude: 6.865175,
        height: 4808,
    };
    const target = moon
        ? {
              latitude: Number(parameters.get("lat") ?? "-85"),
              longitude: Number(parameters.get("lon") ?? "20"),
              height: 0,
          }
        : montBlanc;
    const pitchRadians =
        (Number(parameters.get("pitch") ?? "60") * Math.PI) / 180;
    const orbitRadius = Number(
        parameters.get("radius") ?? (moon ? "400000" : "25000"),
    );
    // The Moon orbits with a camera that can cross its poles; `yaw` sets the heading in degrees.
    const camera = moonSurface
        ? new OrbitalCamera(scene, {
              name: "orbital-camera",
              surface: moonSurface.reference,
              direction: planetocentricDirection(
                  target.latitude,
                  target.longitude,
              ),
              radius: orbitRadius,
              pitchRadians,
              headingRadians:
                  (Number(parameters.get("yaw") ?? "0") * Math.PI) / 180,
              radiusMin: 500,
              ...(elevationEnabled
                  ? {
                        heightAt: moonHeight,
                        verticalScale,
                    }
                  : {}),
          })
        : createGeospatialCamera(scene, {
              name: "geographic-camera",
              geodeticSystem,
              target: {
                  latitudeDegrees: target.latitude,
                  longitudeDegrees: target.longitude,
                  heightMeters: dem ? target.height * verticalScale.value : 0,
              },
              radius: orbitRadius,
              pitchRadians,
              radiusMin: 500,
          });

    if (solidRendering) {
        // Sun from the north-west, 45 degrees above the horizon of the target.
        const { east, north, up } =
            geodeticSystem.createLocalTangentPlaneDegrees(
                target.latitude,
                target.longitude,
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
                    // Cube tiles hold their shared edges: one more texel per side.
                    Promise.resolve(
                        debugImageryTile(address, moon ? 257 : 256),
                    ),
                maxLOD: 20,
                // Drawn pixel by pixel; on the cube, on its samples.
                registration: moon ? ("point" as const) : ("area" as const),
                attribution: "",
            }
          : imagery === "dataset" && moonDataset
            ? {
                  load: datasetImageryLoader(moonDataset.imagery),
                  maxLOD: moonDataset.imagery.deepestLOD,
                  // Tiles of the cube hold their shared edges.
                  registration: "point" as const,
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
              registration: imagerySource.registration,
              ...(moon ? {} : { wrapX: true }),
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
        const imagerySource = moonSurface
            ? createCubeGridSource(moonSurface, preparedHeights, {
                  maxLOD: imageryMetrics.maxLOD,
                  id: "imagery",
              })
            : createGeodesicGridSource(preparedHeights, {
                  metrics: imageryMetrics,
                  id: "imagery",
              });
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
                spatial: new EcefSpatialMetric(spatialOptions),
                activation: imageryAdapter,
                presentation: imageryAdapter,
            },
            // The geometric error of an imagery tile is one texel: at most two texels per screen pixel.
            maxScreenSpaceError: 2,
            refinementHysteresisRatio: hysteresis,
            coarseningDelayFrames: coarsenDelay,
            maxConcurrentLoads: 12,
            ...(moon ? { verticalScale } : {}),
            // Each imagery page holds a texture array layer of 257 x 257 texels: 512 pages bound the GPU memory.
            cache: {
                maxContentEntries: 512,
                ...(moon ? { workingSetFactor: 3 } : {}),
            },
        });
    }

    const elevation: IGridElevationOptions | undefined = moon
        ? moonPyramid
            ? { pyramid: moonPyramid, verticalScale }
            : undefined
        : dem
          ? {
                pyramid: new DemPyramid({
                    registration: dem.source.registration,
                    load: webDemTileLoader(dem, createDemDecoder()),
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
    // The mesh engine renders Web Mercator only.
    const engineName = moon ? "gpu" : (parameters.get("engine") ?? "mesh");
    if (engineName !== "mesh" && engineName !== "gpu")
        throw new RangeError("The engine parameter must be mesh or gpu.");
    const terrainInputs: ITerrainEngineInputs = {
        scene,
        labelLayer: tileLabels,
        wireframe: !solidRendering,
        junctions,
        edgeHeights,
        ...(moonSurface ? { tiling: cubeTiling(moonSurface) } : {}),
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
    verticalScaleInput.value = String(verticalScale.value);
    verticalScaleValue.value = `x${verticalScale.value}`;
    verticalScaleInput.disabled = !elevation;
    verticalScaleInput.addEventListener("input", () => {
        verticalScale.set(Number(verticalScaleInput.value));
        verticalScaleValue.value = `x${verticalScale.value}`;
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
        spatial: new EcefSpatialMetric(spatialOptions),
        activation: terrain,
        presentation: terrain,
    };
    const runtime = new TileRuntime({
        id: "implicit-grid-mapzen",
        uri: "memory://geodesic-grid/tileset.json",
        adapter,
        maxScreenSpaceError: 10,
        refinementHysteresisRatio: hysteresis,
        coarseningDelayFrames: coarsenDelay,
        maxConcurrentLoads: 12,
        instrumentation: { enabled: monitoringEnabled },
        // Neighbouring tiles stay within one level, so that every edge junction connects.
        quadtreeBalance:
            parameters.get("balance") === "0"
                ? false
                : moon
                  ? { topology: CUBE_TILE_TOPOLOGY, fillGaps: true }
                  : { wrapX: true },
        ...(moon ? { verticalScale } : {}),
        // Terrain tiles of the view and around it; their DEM tiles are cached by the DEM pyramid.
        cache: {
            maxContentEntries: 1024,
            ...(moon ? { workingSetFactor: 3 } : {}),
        },
    });

    const imageryRuntime = imageryPages
        ? createImageryRuntime(imageryPages)
        : undefined;

    // `objects=1` places a hierarchy of glTF objects on the Moon, from a 3D Tiles tileset with its own runtime.
    const objectsDirection = planetocentricDirection(
        target.latitude,
        target.longitude,
    );
    // Objects stand on the heights of a dataset once its tile below them is loaded.
    if (moonDataset && moonPyramid && parameters.get("objects") === "1")
        await moonPyramid.tileHeights(
            cubeTileOfDirection(objectsDirection, moonDemDeepestLOD),
        );
    const objectsScene =
        moonSurface && parameters.get("objects") === "1"
            ? createMoonObjects(
                  moonSurface.reference,
                  objectsDirection,
                  elevationEnabled
                      ? (direction) => {
                            const height = moonHeight(direction);
                            return Number.isNaN(height) ? 0 : height;
                        }
                      : () => 0,
              )
            : undefined;
    const objectPlacement = moonSurface
        ? {
              scale: verticalScale,
              frame: radialVerticalFrame(moonSurface.reference),
          }
        : undefined;
    // Only this scene needs the glTF loader: Web Mercator does not load it.
    if (objectsScene) await import("@babylonjs/loaders/glTF/2.0/index.js");
    const objectContent =
        objectsScene && objectPlacement
            ? new BabylonGltfTileAdapter(scene, {
                  vertical: objectPlacement,
                  fetch: async (input) => {
                      const bytes = objectsScene.contents.get(String(input));
                      return bytes
                          ? new Response(bytes.slice().buffer, {
                                headers: {
                                    "content-type": "model/gltf-binary",
                                },
                            })
                          : new Response(null, { status: 404 });
                  },
              })
            : undefined;
    const objectRuntime =
        objectsScene && objectContent && objectPlacement
            ? new TileRuntime<
                  IEcefCameraFrame,
                  IEcefSpatialState,
                  IBabylonGltfTileHandle,
                  never
              >({
                  id: "moon-objects",
                  uri: "memory://moon-objects/tileset.json",
                  adapter: {
                      tilesets: {
                          load: async () => ({ tileset: objectsScene.tileset }),
                      },
                      spatial: new EcefSpatialMetric({
                          ...spatialOptions,
                          vertical: objectPlacement,
                      }),
                      activation: objectContent,
                      presentation: objectContent,
                  },
                  maxScreenSpaceError: 8,
                  verticalScale,
              })
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

    // On the Moon, tiles beyond the edges of the image are ready when the camera turns. Web Mercator selects as before.
    const frustum = moon ? { frustumMargin: 0.25 } : {};
    const driver = new BabylonRuntimeDriver(runtime, scene, {
        camera,
        ...frustum,
        onError: (error) => {
            status.textContent = "Runtime frame failed";
            console.error("3D Tiles pipeline frame failed", error);
        },
    });
    const imageryDriver = imageryRuntime
        ? new BabylonRuntimeDriver(imageryRuntime, scene, {
              camera,
              ...frustum,
              onError: (error) =>
                  console.error("Imagery runtime frame failed", error),
          })
        : undefined;
    const objectDriver = objectRuntime
        ? new BabylonRuntimeDriver(objectRuntime, scene, {
              camera,
              ...frustum,
              onError: (error) =>
                  console.error("Objects runtime frame failed", error),
          })
        : undefined;
    status.textContent = "Loading the implicit quadtree...";
    await Promise.all([
        driver.start(),
        imageryDriver?.start(),
        objectDriver?.start(),
    ]);
    monitor.setStartupMilliseconds(performance.now() - startupStartedAt);
    const coverage = moon
        ? `${moonDataset ? `${moonDataset.elevation.dataset.body} dataset, DEM LOD 0..${moonDemDeepestLOD},` : "Synthetic Moon"} on the cube index, 6 faces, LOD 0..${moonDemDeepestLOD + moonMaxLOD - moonDemMaxLOD}`
        : `Global WebMercator coverage, ${source.tileset.root.children?.length ?? 0} roots, LOD ${TILE_METRICS.minLOD}..${TILE_METRICS.maxLOD}`;
    status.textContent = `${coverage} | ${renderer === "webgpu" ? "GLSL converted for WebGPU" : "WebGL"}`;

    // Objects of the example, for probes run from the browser console.
    (window as unknown as Record<string, unknown>).__SPACEXR_EXAMPLE__ = {
        renderer,
        camera,
        runtime,
        imageryRuntime,
        terrain,
        // Parts of the mesh engine, for the probes written against it.
        ...(terrain instanceof MeshTerrainEngine
            ? { pipeline: terrain.grids, drape: terrain.drape }
            : {}),
        imageryPages,
        verticalScale,
        objectRuntime,
        objectsScene,
        syntheticMoonHeight,
        moonHeight,
        moonDataset,
        moonPyramid,
        moonReference: moonSurface?.reference,
        scene,
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
            objectDriver?.dispose();
            unsubscribeEvents();
            void runtime.dispose();
            void imageryRuntime?.dispose();
            void objectRuntime?.dispose();
            objectContent?.dispose();
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
