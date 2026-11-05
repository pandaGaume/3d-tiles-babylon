<img src="https://raw.githubusercontent.com/pandaGaume/3d-tiles-core/main/assets/brand/spacexr-component.png" alt="SpaceXR Component" height="56">

# @spacexr/3d-tiles-babylon

Babylon.js 9 adaptation of [`@spacexr/3d-tiles-runtime`](https://github.com/pandaGaume/3d-tiles-core). The scene works in WGS84 ECEF metres with large world rendering, so tiles keep their exact 3D Tiles transforms. The package also drapes raster imagery on terrain and renders terrain through interchangeable engines.

## Install

```bash
npm install @spacexr/3d-tiles-babylon @spacexr/3d-tiles-runtime @babylonjs/core @babylonjs/loaders
```

`@babylonjs/loaders` is needed only for glTF content. Register its glTF loader once in the application:

```ts
import "@babylonjs/loaders/glTF/2.0/index.js";
```

## Modules

| Export                                                           | Role                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `createGeospatialEngine`, `createGeospatialScene`                | WebGL engine with large world rendering; right-handed scene without pointer-move picking                 |
| `createGeospatialWebGPUEngine`, `createGeospatialRendererEngine` | WebGPU engine with large world rendering and the adapter limits; WebGPU or WebGL by browser support      |
| `createGeospatialCamera`, `useEllipsoidUpVector`                 | `GeospatialCamera` orbiting a geodetic target, navigating along the ellipsoid surface normal             |
| `createEcefCameraFrame`, `BabylonCameraChangeTracker`            | Runtime camera frames and `CameraChangeFlags` from a Babylon camera                                      |
| `BabylonRuntimeDriver`                                           | Starts the runtime and runs a frame after rendering, only when the camera moved or loads settled         |
| `BabylonGltfTileAdapter`                                         | Activation and presentation ports for `.glb`, `.gltf` and external tilesets                              |
| `detectTileContentFormat`                                        | Recognizes `glb`, `gltf`, `tileset`, `b3dm`, `i3dm`, `pnts` and `cmpt` payloads from their bytes         |
| `createBabylonTileMatrix`                                        | glTF Y-up to 3D Tiles Z-up, then the tile local-to-ECEF transform                                        |
| `CopyrightAttributions`, `extractGltfCopyrights`                 | Ordered `asset.copyright` sources of presented content, as data providers require                        |
| `BabylonRuntimeMonitor`, `formatBytes`                           | Throttled snapshots joining runtime statistics with Babylon frame, draw call, GPU time and heap counters |
| `TextureArrayPool`                                               | RGBA8 pages or RGBA32F tables in one WebGL 2 texture array, written layer by layer and grown on the GPU  |
| `BabylonRasterPages`, `BabylonRasterTileAdapter`                 | Stitched imagery pages loaded into a pool, and the ports of an imagery runtime that publishes its cut    |
| `MeshRasterDrape`, `RasterDrapeMaterialPlugin`                   | `4^k` imagery pages per terrain mesh, `k` following the imagery cut, read through a per-mesh cell table  |
| `GpuTerrainEngine`                                               | Terrain engine instancing predefined grids, sized and placed per instance, heights read on the GPU       |
| `ITerrainEngine`, `MeshTerrainEngine`                            | Interchangeable terrain engines; the mesh engine builds one CPU mesh per tile, draped with imagery pages |
| `createGeodesicGridSource`, `TILE_METRICS`                       | Implicit Web Mercator quadtree of terrain tiles, with height ranges prepared by a DEM pyramid            |
| `DisplayedTiles`                                                 | Last known cut of a quadtree: levels across each tile edge, kept through tiles leaving the view          |

## glTF content

`BabylonGltfTileAdapter` fetches each content, recognizes its format from the payload and either grafts an external tileset or loads an `AssetContainer` under a root node carrying the tile transform. Presented content is enabled, hidden content is disabled and kept in the runtime cache, and released content is disposed.

Formats are never inferred from URIs: 3D Tiles content URIs may omit extensions and servers may report generic media types. Legacy `b3dm`, `i3dm`, `pnts` and `cmpt` content is reported as a load failure.

```ts
const attributions = new CopyrightAttributions();
attributions.subscribe((sources) => (footer.textContent = sources.join("; ")));

const content = new BabylonGltfTileAdapter(scene, {
    resolver, // base URI of external tilesets, for example a resolver keeping a session parameter
    createRequestError: (response, uri) => new Error(`HTTP ${response.status}`), // redact credentials
    attributions,
});
```

## WebGL and WebGPU

`createGeospatialRendererEngine(canvas, "webgpu")` creates a WebGPU engine where the browser supports WebGPU and a WebGL engine otherwise, and reports which one it created. Support is checked before the canvas is bound, since a canvas holding a WebGPU context can no longer hold a WebGL one. The WebGPU engine requests the maximum limits of the adapter: WebGPU only guarantees 256 texture array layers.

Shaders stay in GLSL, for the browsers and Babylon.js versions without WebGPU; on WebGPU, Babylon converts them to WGSL with its glslang and twgsl compilers, downloaded from the Babylon.js CDN on first use. glTF content, the geospatial camera, large world rendering, picking, the runtime, imagery draping and both terrain engines work on both. `TextureArrayPool` writes single layers with `texSubImage3D` on WebGL 2 and with Babylon's texture helper on WebGPU, where growing the array also copies float layers. Materials carrying the GLSL drape plugin are created with `forceGLSL`, so that Babylon converts them as a whole on WebGPU. The GPU terrain engine interleaves its instance attributes in one vertex buffer: WebGPU devices may bind only 8 vertex buffers to a pipeline.

```ts
const { engine, renderer } = await createGeospatialRendererEngine(canvas, "webgpu");
const scene = createGeospatialScene(engine);
```

## Render loop

`BabylonRuntimeDriver.start()` starts the runtime, submits the camera and processes the first frame. It then observes `scene.onAfterRenderObservable`: camera changes are submitted with their `CameraChangeFlags`, and at most one runtime frame runs at a time. The application keeps its own `engine.runRenderLoop`.

## Terrain engines

A terrain engine turns the terrain tiles a runtime presents into pixels. Engines implement `ITerrainEngine`: the activation and presentation ports of the runtime, resource statistics, and `beforeRender` and `afterRender` hooks for the render loop. The terrain runtime, the DEM pyramid, the imagery runtime and its pages are shared, so an application swaps engines without changing anything else.

`MeshTerrainEngine` builds one mesh per terrain tile on the CPU, from the DEM, with edges reconnected to the levels displayed next to each tile, surface normals identical across tile edges and `4^k` imagery pages draped per tile. Rebuilds after a presentation change take at most `junctionBudgetMilliseconds` per frame, 4 by default: cracks first, nearest tiles first.

`GpuTerrainEngine` leaves the CPU only the instance cut and the placement of each instance. The instances are the finer of the terrain and imagery cuts at each place (`DrapeInstanceCut` of `@spacexr/raster`), balanced across edges. Every instance draws the same predefined grid, refined on its four edges as in SpaceXR (the `Finer` variant of `@spacexr/grid` on every edge), so the terrain costs one draw call. Instance attributes size and place each grid: the tile centre relative to the camera, computed in double precision every frame, its rotation about the polar axis, the area of its imagery page, and the areas of its elevation pages for its interior, each edge and each corner. Instances join without cracks and without skirts: each edge and corner reads the DEM of the coarsest terrain tile touching it, and an edge midpoint lies on the edge of a coarser or same-level neighbour, or at the vertex of a finer one. The camera picks `PickSurface`, a coarse grid per terrain tile that is never drawn, since it cannot see vertices moved by the shader. Positions on the ellipsoid come from shapes computed in double precision once per level and row of tiles, and heights from 32-bit float elevation pages, both in texture arrays.

```ts
const terrain: ITerrainEngine = new MeshTerrainEngine({
    scene,
    labelLayer,
    wireframe: false,
    junctions: "fine",
    edgeHeights: "coarsest",
    elevation,
    imageryPages,
});
const runtime = new TileRuntime({ ...options, adapter: { ...ports, activation: terrain, presentation: terrain } });
engine.runRenderLoop(() => {
    terrain.beforeRender();
    scene.render();
    terrain.afterRender();
});
```

## Monitoring

```ts
const monitor = new BabylonRuntimeMonitor(engine, scene, runtime.instrumentation, { resources: adapter });
monitor.subscribe((snapshot) => console.log(snapshot.frame.framesPerSecond, snapshot.runtime.nodes.selected));
engine.runRenderLoop(() => {
    scene.render();
    monitor.update();
});
```

GPU frame time requires GPU timer queries. The monitor registers the time query extensions of WebGL and WebGPU. On WebGPU, timestamp queries are a device feature: `createGeospatialWebGPUEngine` enables every feature of the adapter, timestamp queries included; an engine created otherwise needs `enableAllFeatures` or the `timestamp-query` feature in its device descriptor.

## Whole bodies

`GpuTerrainEngine` renders any tiling. `ITerrainTiling` tells it where tiles lie and how they connect: `webMercatorTiling` by default, `cubeTiling` for a whole body on the cube index, poles included. `createCubeGridSource` builds the implicit quadtrees of the six faces. On the cube, heights are radial, the DEM of a tile on another face is read turned, and normals are computed at each pixel from the DEM. Babylon's `GeospatialCamera` keeps its centre about 2.87 degrees away from the poles and measures its yaw from the north. `OrbitalCamera` has no north in its state, so it can centre on a pole and cross it: drag to pan, drag with the right or middle button or with Ctrl to turn and tilt, use the wheel or a pinch to zoom, two fingers to turn, the arrow keys to pan, `+` and `-` to zoom, `Q` and `E` to turn, `Page Up` and `Page Down` to tilt. `MeshTerrainEngine` renders Web Mercator only.

```ts
import { createCubeGridSource, cubeTiling, GpuTerrainEngine } from "@spacexr/3d-tiles-babylon";
import { CUBE_TILE_TOPOLOGY, CubeTileSurface, ReferenceSurface } from "@spacexr/tiles";

const surface = new CubeTileSurface(ReferenceSurface.sphere(1737400));
// The geometric error of terrain tiles follows the cells of the grid.
const source = createCubeGridSource(surface, prepared, { maxLOD: 14, tileSize: 16 });
const terrain = new GpuTerrainEngine({ ...inputs, tiling: cubeTiling(surface) });
// Balance the runtime across faces: quadtreeBalance: { topology: CUBE_TILE_TOPOLOGY }
```

Elevation and imagery tiles hold their shared edges: pyramids take `prestitched: true`. See `docs/celestial-tiling.md` of 3d-tiles-core.

## License

Apache-2.0.
