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

### Fixed

- GPU frame time monitoring with Babylon.js 9.33, which no longer registers time queries when `Engine` is imported.
