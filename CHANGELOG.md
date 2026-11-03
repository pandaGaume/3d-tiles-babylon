# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added

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

### Changed

- The Google example uses the split activation and presentation ports instead of the legacy content adapter, and detects external tilesets from the payload instead of the media type or `.json` extension.
- The implicit grid example builds its grids with `@spacexr/grid`: alternating diagonals, and edges reconnected to the levels of detail displayed next to each tile whenever the presentation changes. The `junctions` URL parameter selects which tile adapts: `fine` (default), `coarse` or `none`.
- The implicit grid example samples stitched DEM tiles in `point` registration, which removes the height cracks between grids of the same level.
- Edge vertices touched by tiles of several levels take one height computed identically by every tile touching them, from the stitched DEM of the `coarsest` (default), `finest` or `average` displayed level, chosen with the `heights` URL parameter. Junctions between consecutive levels then meet exactly.
- The implicit grid example enables the 2:1 quadtree balance of the runtime (`balance=0` disables it), so that every tile edge joins levels at most one apart, and its shading uses normals of the stitched DEM surface, identical on both sides of a tile edge.
- The example dev servers watch the packages linked from 3d-tiles-core, so that rebuilding core reloads them.
- The implicit grid monitor shows the number of unbalanced tile edges reported by the runtime.
- The examples serve the packages linked from 3d-tiles-core without Vite pre-bundling.
- The implicit grid example is renamed `babylon-implicit-grid-mapzen` and takes its elevation from a `DemPyramid` of `@spacexr/dem`: DEM caching, stitching, overzoom, child ranges, surface heights, gradients and normals moved from the example to the package.

### Fixed

- GPU frame time monitoring with Babylon.js 9.33, which no longer registers time queries when `Engine` is imported.
