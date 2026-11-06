# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added

- The Moon of the implicit grid example follows the depth of its dataset from place to place: terrain refines further only inside its subtrees, such as the south polar cap, and both sides of an edge read the coarser data.
- `frustumMargin` of `BabylonRuntimeDriver` and `createEcefCameraFrame` selects tiles in a frustum wider than the view, so that the edges of the image keep terrain while the camera turns. It defaults to 0; the Moon of the implicit grid example uses 0.25.
- The GPU terrain engine draws a whole cover of the body: where the selection, computed for a camera that has since moved, left no tile, it draws the coarser tiles beside the cut, which read the DEM of their nearest ancestor in memory until theirs arrives. `cubeTiling` enables it with `coverRoots`, and `completeTileCover` of `@spacexr/raster` computes it. Web Mercator has no cover and draws as before.
- The implicit grid example reads a whole Moon from a tile service with `body=moon&dataset=<address>`: `elevation.json` and `imagery.json` give the radius, the levels and the URLs. The GPU terrain engine reports the heights of the DEM tiles of the cube with `tileHeightRange`, and the Moon uses `horizon: "tile-heights"` of `EcefSpatialMetric`, which keeps terrain below the reference surface visible from a camera above it. Web Mercator is unchanged.
- The normals of the GPU engine on the cube read the DEM across tile edges, turned across cube faces, which removes shading seams along tile edges. The Moon of the example no longer generates levels below its DEM, whose slope showed as a checkerboard.
- `VerticalScale` can be shared by a scene: terrain engines accept it in `elevation.verticalScale`, besides a number, and `OrbitalCamera` and `BabylonGltfTileAdapter` read it. `BabylonGltfTileAdapter` moves objects with it, with its `vertical` option. The implicit grid example places glTF objects on the Moon with `objects=1`.
- Sources declare their `registration`, which is required, and `prestitched` is deprecated; `ILocalImagery` of the example gains it. Terrain and imagery of `area` sources move half a pixel to the south-east, to their true place: see `docs/raster.md` of 3d-tiles-core.
- Web Mercator is the official terrain engine and the cube an alternative under test: `ITerrainTiling` holds what differs between them, so Web Mercator computes shapes, centres, pick grids and DEM areas as it did before the cube.
- `OrbitalCamera` orbits a point of a body and can cross its poles: `OrbitFrame` holds the direction of the point and a tangent direction, carried together along great circles, with no north in its state. It follows the terrain with `heightAt` and stays above it. The Moon of the implicit grid example uses it.
- Whole bodies on the cube index, poles included, with the GPU terrain engine: `ITerrainTiling` tells the engine where tiles lie and how they connect, with `webMercatorTiling` and `cubeTiling`. Shapes, picking, instance cuts and bounding volumes follow the tiling; heights are radial on the cube, DEM tiles on another face are read turned, and normals are computed at each pixel from the DEM. `createCubeGridSource` builds the six implicit quadtrees. The implicit grid example shows a synthetic Moon with `body=moon`.
- `@spacexr/3d-tiles-babylon` package, extracted from the Babylon.js examples of 3d-tiles-core:
  - `createEcefCameraFrame`, `BabylonCameraChangeTracker` and `createBabylonTileMatrix` bridge Babylon cameras and glTF Y-up content to the runtime ECEF frames;
  - `createGeospatialEngine`, `createGeospatialScene`, `createGeospatialCamera` and `useEllipsoidUpVector` set up large world rendering and a `GeospatialCamera` navigating along the geodetic surface normal;
  - `BabylonRuntimeDriver` runs runtime frames from the render loop, only when the camera moves or loads settle;
  - `BabylonGltfTileAdapter` loads `.glb` and `.gltf` content and external tilesets through the split activation and presentation ports, recognizing formats from their bytes with `detectTileContentFormat`;
  - `CopyrightAttributions` and `extractGltfCopyrights` aggregate glTF `asset.copyright` sources of presented content;
  - `BabylonRuntimeMonitor` joins runtime statistics with Babylon frame, draw call, GPU time and heap counters.
- Google Photorealistic 3D Tiles and implicit grid examples, moved from 3d-tiles-core.

- Imagery draping on terrain, for the mesh draping engine of the 3d-tiles-core `docs/draping.md`:
  - `TextureArrayPool`, ported from the SpaceXR `Texture3`, holds RGBA8 pages or RGBA32F tables in one WebGL 2 texture array, writes single layers with `texSubImage3D` and grows, copying RGBA8 layers on the GPU;
  - `BabylonRasterPages` loads stitched imagery pages into the pool, rewrites the pages a neighbour completes and indexes the resident pages;
  - `BabylonRasterTileAdapter` lets a second runtime traverse an imagery quadtree on texel size, keep its pages resident and publish the presented imagery cut;
  - `MeshRasterDrape` and `RasterDrapeMaterialPlugin` drape each terrain mesh with `4^k` pages, `k` from 0 to 4 following the imagery cut, through a per-mesh cell table read with `texelFetch`, on shared standard materials.
- The implicit grid example drapes a local debug imagery, a checkerboard labelled with each page address, on shaded grids (`solid=1`, `imagery=none` disables it), or the imagery of a local module ignored by git (`imagery=<name>` loads `src/local/<name>.imagery.ts`); `kmax` sets the deepest drape, 4 by default.
- The implicit grid example generates DEM levels 16 to 18 from Terrarium level 15 instead of overzooming it, with the interpolation chosen by the `interpolation` URL parameter: `cubic` (default), `bilinear`, `linear` or `nearest`.
- `ITerrainEngine` makes terrain engines interchangeable behind the runtime ports and two render loop hooks. `MeshTerrainEngine`, the CPU engine, moves from the implicit grid example to `@spacexr/3d-tiles-babylon` with the grid pipeline, its geometry, `DisplayedTiles` and the geodesic grid source; the example selects it with `engine=mesh`.

- `GpuTerrainEngine` renders terrain on the GPU, selected in the implicit grid example with `engine=gpu`: one predefined grid refined on its edges, as in SpaceXR, instanced once per tile of the `DrapeInstanceCut` and drawn in one draw call, sized and placed by instance attributes, joined to its neighbours without cracks and without skirts, with positions from double-precision shapes per tile row (`GridShapes`) and heights from 32-bit float elevation pages (`ElevationPages`). `TextureArrayPool` accepts the `r32f` format. The render loop drops from 7.3 to 3.1 ms at the 90th percentile on the same navigation. The camera picks a coarse surface of the terrain tiles that is never drawn (`PickSurface`), and the terrain is lit like the standard material of the mesh engine, by the first directional and hemispheric lights of the scene.
- `createGeodesicGridSource` accepts `subtrees`, grid subtrees with their own levels registered with the runtime, and the implicit grid example sets them with the `subtrees` URL parameter.

- `createGeospatialWebGPUEngine` and `createGeospatialRendererEngine` create a WebGPU engine with large world rendering and the maximum limits of the adapter, falling back to WebGL where the browser lacks WebGPU. Shaders stay in GLSL, converted to WGSL by Babylon on WebGPU. Both examples take a `renderer=webgpu` URL parameter.

- Imagery draping and the GPU terrain engine run on the WebGPU engine of Babylon.js, their GLSL shaders converted: `TextureArrayPool` has a WebGPU backend, which writes single layers through Babylon's texture helper and copies every layer, float layers included, when the array grows. The drape plugin declares itself GLSL only and its materials are created with `forceGLSL`, pages are sampled at an explicit level so that the converted shaders keep WGSL's uniform control flow, and the GPU terrain engine interleaves its 12 instance attributes in one vertex buffer, within the 8 vertex buffers WebGPU devices may bind.

### Changed

- Shaders are written in their own `.glsl` files instead of strings in TypeScript, so that editors and linters can read them. The new private `packages/tools` compiles them into generated modules, following the approach of SpaceXR, and `npm run check` fails when a module is out of date. The GLSL itself is unchanged.
- The CI builds against the branch of 3d-tiles-core with the name of the pull request branch when there is one, and `main` otherwise, so that a change spanning both repositories no longer fails until core merges.
- The status of the renderer is stated as it is: the package renders with WebGL, every shader is written in GLSL, and none is written for WebGPU. `renderer=webgpu` runs those shaders converted by Babylon.js, and the status line of the examples says so.
- The Google example uses the split activation and presentation ports instead of the legacy content adapter, and detects external tilesets from the payload instead of the media type or `.json` extension.
- The implicit grid example builds its grids with `@spacexr/grid`: alternating diagonals, and edges reconnected to the levels of detail displayed next to each tile whenever the presentation changes. The `junctions` URL parameter selects which tile adapts: `fine` (default), `coarse` or `none`.
- The implicit grid example samples stitched DEM tiles in `point` registration, which removes the height cracks between grids of the same level.
- Edge vertices touched by tiles of several levels take one height computed identically by every tile touching them, from the stitched DEM of the `coarsest` (default), `finest` or `average` displayed level, chosen with the `heights` URL parameter. Junctions between consecutive levels then meet exactly.
- The implicit grid example enables the 2:1 quadtree balance of the runtime (`balance=0` disables it), so that every tile edge joins levels at most one apart, and its shading uses normals of the stitched DEM surface, identical on both sides of a tile edge.
- The example dev servers watch the packages linked from 3d-tiles-core, so that rebuilding core reloads them.
- The implicit grid monitor shows the number of unbalanced tile edges reported by the runtime.
- The examples serve the packages linked from 3d-tiles-core without Vite pre-bundling.
- The implicit grid example is renamed `babylon-implicit-grid-mapzen` and takes its elevation from a `DemPyramid` of `@spacexr/dem`: DEM caching, stitching, overzoom, child ranges, surface heights, gradients and normals moved from the example to the package.
- Grid rebuilds after a presentation change take at most 4 ms per frame (`junctionBudgetMilliseconds`, `junctionBudget` in the example), cracks first and nearest tiles first, so that a wave of loaded tiles spreads over several frames.

### Fixed

- The monitor reports GPU frame time on the WebGPU engine: `createGeospatialWebGPUEngine` enables the features of the adapter, timestamp queries included, and the monitor registers the WebGPU time query extension.
- The example dev servers serve the dependencies Vite pre-bundles with `Cache-Control: no-store`. Vite marks them immutable for a year, but `vite --force` rebuilds them at every start: a browser keeping the chunks of an earlier session mixed two builds of Babylon.js in one page, whose shader includes went missing, and Babylon compiled the HTML page it fetched in their place.
- Turning the camera in the Google example no longer reloads the tiles it just saw. The cause was in the runtime defaults, fixed in 3d-tiles-core: a cache retention of 120 runtime frames, about 6 seconds while the camera turns, and 256 cached contents. The examples now only set their memory budgets and the parameters of their tilesets.

- The example dev servers start with `vite --force`: Vite serves the packages linked from 3d-tiles-core with a version query that a restart alone does not change, so browsers kept running the previous build of a rebuilt package from their cache.

- `createGeospatialCamera` imports the Babylon ray module, without which the `GeospatialCamera` could not pick the surface under the pointer to zoom and rotate around it ("Ray needs to be imported before").
- Imagery no longer flickers while the camera turns: a mesh drape is written as soon as the mesh is registered, before its first draw, and its depth decreases only after the imagery cut has stayed coarser for `depthHoldMilliseconds`, 500 ms by default.
- The implicit grid example retains the DEM tiles of the displayed and ghost tiles, and reloads the DEM of a tile shown again after it left the cache: with siblings preloaded, the DEM cache otherwise evicted DEM tiles still displayed, and their edges cracked.
- The implicit grid example keeps the last known level of tiles that left the view (ghosts) when connecting the edges of their neighbours, so that turning the camera no longer rebuilds edges back and forth.
- Presenting terrain tiles no longer stalls frames for 30 to 50 ms: the signature that detects edge height changes lists the known tiles touching the tile boundary in one pass (`DisplayedTiles.touchingBoundary`), instead of sampling every edge vertex.
- The implicit grid example enables `preloadSiblings` in both runtimes, so that turning the camera no longer falls back to coarser terrain and imagery; `hysteresis` sets the refinement hysteresis ratio, 0.2 by default, and `coarsenDelay` the coarsening delay, 20 frames by default.

- GPU frame time monitoring with Babylon.js 9.33, which no longer registers time queries when `Engine` is imported.
