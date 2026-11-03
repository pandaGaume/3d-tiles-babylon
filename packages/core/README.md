# @spacexr/3d-tiles-babylon

Babylon.js 9 adaptation of [`@spacexr/3d-tiles-runtime`](https://github.com/pandaGaume/3d-tiles-core). The scene works in WGS84 ECEF metres with large world rendering, so tiles keep their exact 3D Tiles transforms.

## Install

```bash
npm install @spacexr/3d-tiles-babylon @spacexr/3d-tiles-runtime @babylonjs/core @babylonjs/loaders
```

`@babylonjs/loaders` is needed only for glTF content. Register its glTF loader once in the application:

```ts
import "@babylonjs/loaders/glTF/2.0/index.js";
```

## Modules

| Export                                                    | Role                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `createGeospatialEngine`, `createGeospatialScene`         | WebGL engine with large world rendering; right-handed scene without pointer-move picking                  |
| `createGeospatialCamera`, `useEllipsoidUpVector`          | `GeospatialCamera` orbiting a geodetic target, navigating along the ellipsoid surface normal              |
| `createEcefCameraFrame`, `BabylonCameraChangeTracker`     | Runtime camera frames and `CameraChangeFlags` from a Babylon camera                                       |
| `BabylonRuntimeDriver`                                    | Starts the runtime and runs a frame after rendering, only when the camera moved or loads settled          |
| `BabylonGltfTileAdapter`                                  | Activation and presentation ports for `.glb`, `.gltf` and external tilesets                               |
| `detectTileContentFormat`                                 | Recognizes `glb`, `gltf`, `tileset`, `b3dm`, `i3dm`, `pnts` and `cmpt` payloads from their bytes          |
| `createBabylonTileMatrix`                                 | glTF Y-up to 3D Tiles Z-up, then the tile local-to-ECEF transform                                         |
| `CopyrightAttributions`, `extractGltfCopyrights`          | Ordered `asset.copyright` sources of presented content, as data providers require                         |
| `BabylonRuntimeMonitor`, `formatBytes`                    | Throttled snapshots joining runtime statistics with Babylon frame, draw call, GPU time and heap counters |

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

## Render loop

`BabylonRuntimeDriver.start()` starts the runtime, submits the camera and processes the first frame. It then observes `scene.onAfterRenderObservable`: camera changes are submitted with their `CameraChangeFlags`, and at most one runtime frame runs at a time. The application keeps its own `engine.runRenderLoop`.

## Monitoring

```ts
const monitor = new BabylonRuntimeMonitor(engine, scene, runtime.instrumentation, { resources: adapter });
monitor.subscribe((snapshot) => console.log(snapshot.frame.framesPerSecond, snapshot.runtime.nodes.selected));
engine.runRenderLoop(() => {
    scene.render();
    monitor.update();
});
```

GPU frame time requires GPU timer queries. The monitor registers the WebGL time query extension; a WebGPU application imports `@babylonjs/core/Engines/WebGPU/Extensions/engine.query.js`.

## License

Apache-2.0.
