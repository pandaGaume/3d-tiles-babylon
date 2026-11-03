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
- Google Photorealistic 3D Tiles and implicit geodesic grid examples, moved from 3d-tiles-core.

### Changed

- The Google example uses the split activation and presentation ports instead of the legacy content adapter, and detects external tilesets from the payload instead of the media type or `.json` extension.
- The implicit geodesic grid example builds its grids with `@spacexr/grid`: alternating diagonals, and edges reconnected to the levels of detail displayed next to each tile whenever the presentation changes. The `junctions` URL parameter selects which tile adapts: `fine` (default), `coarse` or `none`.
- The implicit geodesic grid example samples stitched DEM tiles in `point` registration, which removes the height cracks between grids of the same level.
- Edge vertices touched by tiles of several levels take one height computed identically by every tile touching them, from the stitched DEM of the `coarsest` (default), `finest` or `average` displayed level, chosen with the `heights` URL parameter. Junctions between consecutive levels then meet exactly.
- The implicit geodesic grid example enables the 2:1 quadtree balance of the runtime (`balance=0` disables it), so that every tile edge joins levels at most one apart, and its shading uses normals of the stitched DEM surface, identical on both sides of a tile edge.
- The example dev servers watch the packages linked from 3d-tiles-core, so that rebuilding core reloads them.
- The examples serve the packages linked from 3d-tiles-core without Vite pre-bundling.

### Fixed

- GPU frame time monitoring with Babylon.js 9.33, which no longer registers time queries when `Engine` is imported.
