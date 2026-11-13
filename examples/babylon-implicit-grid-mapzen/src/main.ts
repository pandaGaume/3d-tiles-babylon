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
    MotionRefinementScale,
    TERRAIN_CONFIG,
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
import { TilesetJsonCodec } from "@spacexr/3d-tiles-core";
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
    createMapzenNormalsSource,
    decodeMapzenNormalPixels,
    cubeDemPyramid,
    webDemTileLoader,
    type IDemWorkerEndpoint,
} from "@spacexr/dem";

import { PngDataDecoder } from "@spacexr/raster";

import DemDecoderWorker from "./dem-decoder.worker?worker";
import { createMoonObjects } from "./moon-objects";
import { addObjectsEnvironment } from "./objects-environment";
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
import places from "./places.json";

interface IPlace {
    latitude: number;
    longitude: number;
    /** Height of the point the camera orbits, in metres. */
    height: number;
}

/**
 * The point the camera orbits on Web Mercator. `place` names an entry of places.json, `mont-blanc` by default. `lat`
 * and `lon`, in degrees, give any other point instead, at `height` metres, 0 by default.
 */
function cameraTarget(parameters: URLSearchParams): IPlace {
    const latitude = parameters.get("lat");
    const longitude = parameters.get("lon");
    if (latitude !== null || longitude !== null) {
        const point = {
            latitude: Number(latitude),
            longitude: Number(longitude),
            height: Number(parameters.get("height") ?? "0"),
        };
        if (
            latitude === null ||
            longitude === null ||
            !Object.values(point).every(Number.isFinite) ||
            Math.abs(point.latitude) > 90 ||
            Math.abs(point.longitude) > 180
        )
            throw new RangeError(
                "lat and lon must both be given, in degrees, and height in metres.",
            );
        return point;
    }
    const name = parameters.get("place") ?? "mont-blanc";
    const place = (places as Record<string, IPlace | undefined>)[name];
    if (!place)
        throw new RangeError(
            `place must be one of ${Object.keys(places).join(", ")}.`,
        );
    return {
        latitude: place.latitude,
        longitude: place.longitude,
        height: Number(parameters.get("height") ?? place.height),
    };
}

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
    // `renderer=webgpu` runs the WGSL shaders on the WebGPU engine of Babylon where the browser supports it, WebGL and GLSL
    // otherwise. The GPU terrain of the cube has no WGSL shaders yet: on WebGPU, Babylon converts its GLSL ones.
    // `antialias=0` removes multisampling, whose resolved edges depend on the hardware and the graphics API.
    const antialias = parameters.get("antialias") !== "0";
    const { engine, renderer } = await createGeospatialRendererEngine(
        canvas,
        parameters.get("renderer") === "webgpu" ? "webgpu" : "webgl",
        { webgl: { antialias }, webgpu: { antialias } },
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
    // `grid` sets the cells per side of the terrain grids of the Moon, to compare them. The error of a tile follows them.
    const gridCells = moon
        ? Number(parameters.get("grid") ?? TERRAIN_CONFIG.grid.cells)
        : TERRAIN_CONFIG.grid.cells;
    if (![4, 8, 16, 32, 64, 128, 256].includes(gridCells))
        throw new RangeError(
            "The grid parameter must be a power of 2 from 4 to 256.",
        );
    // Deepest level of the DEM of the Moon everywhere. With fewer cells per side in a terrain tile than in a DEM tile, the
    // terrain reaches the samples of the DEM levels below it, whose tiles read sub-areas of the DEM tile, not interpolated tiles.
    const moonDemMaxLOD =
        moonDataset?.elevation.dataset.maxLOD ??
        TERRAIN_CONFIG.cube.syntheticDemMaxLOD;
    const levelsBelowDem = Math.log2(TERRAIN_CONFIG.dem.tileCells / gridCells);
    const moonMaxLOD = moonDemMaxLOD + levelsBelowDem;
    // Deepest level of its DEM anywhere, such as the south polar cap of a dataset.
    const moonDemDeepestLOD =
        moonDataset?.elevation.deepestLOD ?? moonDemMaxLOD;
    // DEM tiles kept in memory.
    const demCacheEntries = Number(
        parameters.get("demCache") ?? TERRAIN_CONFIG.dem.cacheEntries,
    );
    // Time a DEM load nobody waits for any more goes on before it is aborted.
    const demAbortDelay = Number(
        parameters.get("demAbortDelay") ??
            TERRAIN_CONFIG.dem.abortDelayMilliseconds,
    );
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
    const hysteresis = Number(
        parameters.get("hysteresis") ?? TERRAIN_CONFIG.selection.hysteresis,
    );
    // Refined tiles wait this long before coarsening, so that a neighbour leaving the view does not flicker them.
    const coarsenDelay = Number(
        parameters.get("coarsenDelay") ??
            TERRAIN_CONFIG.selection.coarseningDelayMilliseconds,
    );
    // Main-thread milliseconds per frame for rebuilding grids whose neighbours changed; the rest waits for the next frames.
    const junctionBudget = Number(
        parameters.get("junctionBudget") ??
            TERRAIN_CONFIG.mesh.junctionBudgetMilliseconds,
    );
    const demInterpolation =
        parameters.get("interpolation") ?? TERRAIN_CONFIG.dem.interpolation;
    if (
        demInterpolation !== "nearest" &&
        demInterpolation !== "linear" &&
        demInterpolation !== "bilinear" &&
        demInterpolation !== "cubic"
    )
        throw new RangeError(
            "The interpolation parameter must be cubic, bilinear, linear or nearest.",
        );
    const demGeneratedLevels = Number(
        parameters.get("demGeneratedLevels") ??
            TERRAIN_CONFIG.dem.generatedLevels,
    );
    if (
        !moon &&
        (!Number.isInteger(demGeneratedLevels) ||
            demGeneratedLevels < 0 ||
            demGeneratedLevels > 8)
    )
        throw new RangeError(
            "demGeneratedLevels must be an integer from 0 to 8.",
        );
    // `debug` draws pages locally, `dataset` reads the tile service of the Moon; any other name loads
    // src/local/<name>.imagery.ts, kept out of the repository.
    const imagery =
        parameters.get("imagery") ?? (moonDataset ? "dataset" : "debug");
    // Uniform ambient is an explicit diagnostic comparison; normal terrain lighting stays the default.
    const lighting = parameters.get("lighting") ?? "terrain";
    if (lighting !== "ambient" && lighting !== "terrain")
        throw new RangeError("lighting must be ambient or terrain.");
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
              tileSize: gridCells,
              ...(moonDataset
                  ? {
                        subtrees: terrainSubtrees(
                            moonDataset.elevation,
                            levelsBelowDem,
                        ),
                    }
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
                      cacheEntries: demCacheEntries,
                      abortDelayMilliseconds: demAbortDelay,
                      childHeightRanges,
                  })
                : new DemPyramid({
                      registration: "point",
                      load: loadSyntheticMoonTile,
                      maxLOD: moonDemMaxLOD,
                      cacheEntries: demCacheEntries,
                      abortDelayMilliseconds: demAbortDelay,
                      childHeightRanges,
                  })
            : undefined;
    const moonHeight =
        moonDataset && moonPyramid
            ? datasetHeightAt(moonPyramid, moonDemDeepestLOD)
            : syntheticMoonHeight;

    // On Web Mercator, the camera orbits a place of places.json, or the point `lat` and `lon` give, at `height` metres.
    const target = moon
        ? {
              latitude: Number(parameters.get("lat") ?? "-85"),
              longitude: Number(parameters.get("lon") ?? "20"),
              height: 0,
          }
        : cameraTarget(parameters);
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
              radiusMin: TERRAIN_CONFIG.orbitalCamera.radiusMin,
              altitudeMin: TERRAIN_CONFIG.orbitalCamera.altitudeMin,
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
        sun.intensity = lighting === "ambient" ? 0 : 1.1;
        const sky = new HemisphericLight(
            "sky",
            new Vector3(up.x, up.y, up.z),
            scene,
        );
        sky.intensity = lighting === "ambient" ? 1 : 0.25;
        sky.groundColor =
            lighting === "ambient"
                ? Color3.White()
                : new Color3(0.1, 0.1, 0.12);
    }

    // Imagery is a second implicit quadtree, refined on texel size instead of geometric error.
    const imagerySource = !imageryEnabled
        ? undefined
        : imagery === "debug"
          ? {
                load: (address: ITileAddress) =>
                    // Cube tiles hold their shared edges: one more texel per side.
                    Promise.resolve(
                        debugImageryTile(
                            address,
                            TERRAIN_CONFIG.imagery.tileCells + (moon ? 1 : 0),
                        ),
                    ),
                maxLOD: TERRAIN_CONFIG.imagery.maxLOD,
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
    // A physical DEM tile covers n by n imagery tiles. Generated DEM levels do not advance this limit.
    const imagerySubdivision = Number(
        parameters.get("imagerySubdivision") ??
            TERRAIN_CONFIG.imagery.demSubdivision,
    );
    if (!moon && ![2, 4, 8].includes(imagerySubdivision))
        throw new RangeError("imagerySubdivision must be 2, 4 or 8.");
    const imagerySourceMaxLOD =
        imagerySource?.maxLOD ?? TERRAIN_CONFIG.imagery.maxLOD;
    const imageryMaxLOD =
        !moon && dem
            ? Math.min(
                  imagerySourceMaxLOD,
                  dem.source.metrics.maxLOD + Math.log2(imagerySubdivision),
              )
            : imagerySourceMaxLOD;
    const imageryMetrics = new WebMercatorTileMetrics({
        minLOD: TERRAIN_CONFIG.imagery.minLOD,
        maxLOD: imageryMaxLOD,
        tileSize: TERRAIN_CONFIG.imagery.tileCells,
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
    const maxDrapeDepth = Number(
        parameters.get("kmax") ?? TERRAIN_CONFIG.imagery.maxDrapeDepth,
    );

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
                  tileSize: imageryMetrics.tileSize,
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
            selectionStrategy: moon ? "active" : "base",
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
            maxScreenSpaceError: TERRAIN_CONFIG.imagery.screenSpaceError,
            refinementHysteresisRatio: hysteresis,
            coarseningDelayMilliseconds: coarsenDelay,
            maxConcurrentLoads: TERRAIN_CONFIG.selection.maxConcurrentLoads,
            ...(moon ? { verticalScale } : {}),
            // Each imagery page holds a texture array layer: these pages bound the GPU memory.
            cache: {
                maxContentEntries: TERRAIN_CONFIG.imagery.contentCacheEntries,
                ...(moon
                    ? { workingSetFactor: TERRAIN_CONFIG.cube.workingSetFactor }
                    : {}),
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
                    cacheEntries: demCacheEntries,
                    abortDelayMilliseconds: demAbortDelay,
                    // Generated height resolution is independent of the geometric quadtree and imagery.
                    ...(demGeneratedLevels > 0
                        ? {
                              generation: {
                                  maxLOD:
                                      dem.source.metrics.maxLOD +
                                      demGeneratedLevels,
                                  interpolation: demInterpolation,
                              },
                          }
                        : {}),
                    // The grid covers every longitude.
                    wrapX: true,
                    childHeightRanges,
                }),
                verticalScale,
            }
          : undefined;
    // The engine turning terrain tiles into pixels; the runtimes, the DEM and the imagery pages stay shared.
    const engineName = parameters.get("engine") ?? (moon ? "gpu" : "mesh");
    if (engineName !== "mesh" && engineName !== "gpu")
        throw new RangeError("The engine parameter must be mesh or gpu.");
    const normalMode = parameters.get("normals") ?? "mapzen";
    if (normalMode !== "mapzen" && normalMode !== "dem")
        throw new RangeError("normals must be mapzen or dem.");
    const normalSource =
        !moon &&
        dem &&
        solidRendering &&
        engineName === "gpu" &&
        lighting === "terrain" &&
        normalMode === "mapzen"
            ? createMapzenNormalsSource()
            : undefined;
    const normalMaxLOD = Number(parameters.get("normalMaxLOD") ?? 15);
    if (
        !Number.isInteger(normalMaxLOD) ||
        normalMaxLOD < 0 ||
        normalMaxLOD > 15
    )
        throw new RangeError("normalMaxLOD must be an integer from 0 to 15.");
    const normalDecoder = new PngDataDecoder();
    const normalPages = normalSource
        ? new BabylonRasterPages(scene, {
              load: async (address, signal) => {
                  const result = await normalSource.fetchTile(address, signal);
                  return result.status === "absent"
                      ? undefined
                      : decodeMapzenNormalPixels(
                            await normalDecoder.decode(result.bytes, signal),
                        );
              },
              maxLOD: Math.min(normalMaxLOD, normalSource.metrics.maxLOD),
              registration: normalSource.registration,
              tileSize: normalSource.metrics.tileSize,
              wrapX: true,
              cacheEntries: 256,
              initialLayers: 16,
          })
        : undefined;
    const terrainInputs: ITerrainEngineInputs = {
        scene,
        labelLayer: tileLabels,
        wireframe: !solidRendering,
        lighting,
        ...(moon ? {} : { geometrySelection: "runtime" as const }),
        junctions,
        edgeHeights,
        ...(moonSurface ? { tiling: cubeTiling(moonSurface) } : {}),
        ...(elevation ? { elevation } : {}),
        ...(imageryPages ? { imageryPages } : {}),
        ...(normalPages ? { normalPages } : {}),
    };
    const terrain: ITerrainEngine =
        engineName === "gpu"
            ? new GpuTerrainEngine(terrainInputs, { cells: gridCells })
            : new MeshTerrainEngine(terrainInputs, {
                  cells: gridCells,
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
    // New detail waits while the camera moves fast. `motion=0` leaves the threshold fixed.
    const motionScale =
        !moon || parameters.get("motion") === "0"
            ? undefined
            : new MotionRefinementScale(TERRAIN_CONFIG.motion);
    const runtime = new TileRuntime({
        id: "implicit-grid-mapzen",
        selectionStrategy: moon ? "active" : "base",
        uri: "memory://geodesic-grid/tileset.json",
        adapter,
        maxScreenSpaceError: Number(
            parameters.get("sse") ?? TERRAIN_CONFIG.selection.screenSpaceError,
        ),
        refinementHysteresisRatio: hysteresis,
        ...(motionScale
            ? { refinementThresholdScale: () => motionScale.scale }
            : {}),
        coarseningDelayMilliseconds: coarsenDelay,
        maxConcurrentLoads: TERRAIN_CONFIG.selection.maxConcurrentLoads,
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
            maxContentEntries: TERRAIN_CONFIG.selection.contentCacheEntries,
            ...(moon
                ? { workingSetFactor: TERRAIN_CONFIG.cube.workingSetFactor }
                : {}),
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
    // `tileset` places the objects of a 3D Tiles tileset on the Moon, with the transforms it declares in the frame of the body.
    const objectsTileset = moonSurface ? parameters.get("tileset") : null;
    const objectsTilesetUri = objectsTileset
        ? new URL(objectsTileset, window.location.href).toString()
        : undefined;
    // Only these scenes need the glTF loader: Web Mercator does not load it.
    if (objectsScene || objectsTilesetUri) {
        await import("@babylonjs/loaders/glTF/2.0/index.js");
        // Like the lights, the horizon the objects reflect holds for the target.
        addObjectsEnvironment(
            scene,
            planetocentricDirection(target.latitude, target.longitude),
        );
    }
    const objectContent =
        (objectsScene || objectsTilesetUri) && objectPlacement
            ? new BabylonGltfTileAdapter(scene, {
                  vertical: objectPlacement,
                  ...(objectsScene
                      ? {
                            fetch: async (input: RequestInfo | URL) => {
                                const bytes = objectsScene.contents.get(
                                    String(input),
                                );
                                return bytes
                                    ? new Response(bytes.slice().buffer, {
                                          headers: {
                                              "content-type":
                                                  "model/gltf-binary",
                                          },
                                      })
                                    : new Response(null, { status: 404 });
                            },
                        }
                      : {}),
              })
            : undefined;
    const objectRuntime =
        (objectsScene || objectsTilesetUri) && objectContent && objectPlacement
            ? new TileRuntime<
                  IEcefCameraFrame,
                  IEcefSpatialState,
                  IBabylonGltfTileHandle,
                  never
              >({
                  id: "moon-objects",
                  uri:
                      objectsTilesetUri ?? "memory://moon-objects/tileset.json",
                  adapter: {
                      tilesets: {
                          load: async ({ uri, signal }) => {
                              if (objectsScene)
                                  return { tileset: objectsScene.tileset };
                              const response = await fetch(uri, { signal });
                              if (!response.ok)
                                  throw new Error(
                                      `Tileset request failed with HTTP ${response.status}: ${uri}`,
                                  );
                              return {
                                  tileset: new TilesetJsonCodec().decode(
                                      await response.text(),
                                  ),
                                  baseUri: uri,
                              };
                          },
                      },
                      spatial: new EcefSpatialMetric({
                          ...spatialOptions,
                          vertical: objectPlacement,
                      }),
                      activation: objectContent,
                      presentation: objectContent,
                  },
                  maxScreenSpaceError: TERRAIN_CONFIG.objects.screenSpaceError,
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

    // Mercator selects the real view, and loads its periphery without drawing it. The cube keeps its existing periphery,
    // for its imagery and objects too.
    const periphery = {
        frustumMargin: Number(
            parameters.get("frustumMargin") ??
                TERRAIN_CONFIG.selection.frustumMargin,
        ),
    };
    const frustum = moon ? periphery : {};
    const driver = new BabylonRuntimeDriver(runtime, scene, {
        camera,
        manual: !moon,
        ...periphery,
        ...(motionScale
            ? {
                  motion: {
                      scale: motionScale,
                      surfaceDistance: () =>
                          "frame" in camera
                              ? camera.frame.radius
                              : camera.radius,
                  },
              }
            : {}),
        onError: (error) => {
            status.textContent = "Runtime frame failed";
            console.error("3D Tiles pipeline frame failed", error);
        },
    });
    const imageryDriver = imageryRuntime
        ? new BabylonRuntimeDriver(imageryRuntime, scene, {
              camera,
              manual: !moon,
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
    status.textContent = `${coverage} | ${renderer === "webgpu" ? (moon && engineName === "gpu" ? "WebGPU, GLSL converted" : "WebGPU, WGSL") : "WebGL, GLSL"}`;

    // Objects of the example, for probes run from the browser console.
    (window as unknown as Record<string, unknown>).__SPACEXR_EXAMPLE__ = {
        renderer,
        camera,
        runtime,
        motionScale,
        imageryRuntime,
        terrain,
        // Parts of the mesh engine, for the probes written against it.
        ...(terrain instanceof MeshTerrainEngine
            ? { pipeline: terrain.grids, drape: terrain.drape }
            : {}),
        imageryPages,
        normalPages,
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

    if (moon) {
        engine.runRenderLoop(() => {
            terrain.beforeRender();
            scene.render();
            monitor.update();
            terrain.afterRender();
        });
    } else {
        // The selection and its junctions are published before drawing this camera. Network work stays asynchronous.
        scene.onBeforeRenderObservable.add(() => terrain.beforeRender());
        // Each frame waits for the selection of its camera, then draws inside a frame of the engine, which submits it:
        // WebGPU only presents the canvas texture of a frame whose commands were submitted.
        const frame = async (): Promise<void> => {
            if (scene.isDisposed) return;
            camera.update();
            try {
                await Promise.all([
                    driver.updateBeforeRender(),
                    imageryDriver?.updateBeforeRender(),
                ]);
                if (scene.isDisposed) return;
                engine.beginFrame();
                scene.render(false);
                engine.endFrame();
                monitor.update();
                terrain.afterRender();
            } catch (error: unknown) {
                console.error("Mercator frame failed", error);
            }
            requestAnimationFrame(() => void frame());
        };
        requestAnimationFrame(() => void frame());
    }

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
            normalPages?.dispose();
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
