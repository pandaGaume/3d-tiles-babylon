# Babylon implicit geodesic grid

This example is the integration proof for the renderer-neutral runtime pipeline.

The 3D Tiles runtime owns camera traversal, implicit tiling, LOD selection, readiness, metadata handles and cache policy. The Babylon bundle only implements `ITileActivationAdapter` and `ITilePresentationAdapter`. It never imports `TileRuntime` internals.

The Babylon adapter shares one normalized grid topology, not a Cartesian mesh. Every ready 3D Tile receives unique ECEF vertices projected from its geographic region onto the WGS84 ellipsoid. Curvature and east-west pinching therefore follow both LOD and latitude.

This CPU implementation intentionally creates one geometry per tile. The topology and runtime contracts already support a later GPU path: normalized coordinates remain shared, while the tile region and ellipsoid parameters can become per-instance shader inputs.

Every presented tile is colored by absolute LOD and receives a screen-space `X/Y/LOD` label. Those identifiers are also published through the example's 3D Tiles metadata, making parent-child overlap and incorrect replacement cuts directly visible while debugging traversal.

The scene root covers the complete WebMercator domain and contains 64 independent sources, one for every `X/Y` address at LOD 3. Each `WebMapTileDataSource` owns the shared `WebMercatorTileMetrics` configuration with `minLOD = 3` and `maxLOD = 18`, its root address and its `grid://` URL template. Its `ImplicitTilesetDecorator` derives sixteen available levels and cannot request an address beyond LOD 18.

The explicit scene root has no renderable content. It lets the standard runtime select only the visible LOD 3 source roots. A routing resolver then delegates every implicit tile to the decorator that owns its root. The coverage is global within the WebMercator latitude limits of approximately 85.051 degrees north and south.

Run it from the repository root, after building 3d-tiles-core as described in the [repository README](../../README.md):

```bash
npm run example:implicit-grid
```

No API key or `.env` file is required.

## Elevation

Grid vertices are displaced with Mapzen Terrarium heights from `@spacexr/tiles`, one DEM tile per grid tile. Beyond level 15, the deepest Terrarium level, a grid samples the matching sub-area of its level 15 ancestor, kept in a shared cache.

Tiles start with a 0/0 m height range. When a DEM is loaded, the tile reports its measured range to the runtime through `tileBoundingVolume`, and the four quadrant ranges are recorded for its children. The resolver applies them when the children are created, and the runtime applies them again to children created before the parent DEM arrived.

The camera starts above the Mont Blanc summit. URL parameters:

| Parameter     | Effect                                                     |
| ------------- | ---------------------------------------------------------- |
| `elevation=0` | Flat grids, no DEM requests                                |
| `scale=2`     | Initial altitude scale; the panel slider changes it live   |
| `solid=1`     | Shaded rendering with a sun light instead of the wireframe |
| `radius=250`  | Initial camera distance to the summit in metres            |
| `pitch=50`    | Initial camera pitch in degrees                            |

The Mapzen attribution is displayed in the bottom-right corner.

## Runtime monitoring

The overlay joins the renderer-neutral runtime cache statistics with Babylon counters. It reports selected and cached tiles, tracked CPU/GPU/subtree memory, JavaScript heap usage when the browser exposes it, cumulative content and subtree evictions, implicit branch pruning, FPS, draw calls and the number of Babylon meshes created, shown and released.

The `Frame` line uses Babylon's standard `SceneInstrumentation` and `EngineInstrumentation` counters, averaged over the last second: frame time, time between frames (JavaScript outside rendering, such as runtime traversal and tile reception), render time, active mesh selection time and GPU frame time when the browser exposes GPU timer queries. DEM tiles are decoded in a pool of web workers, so their decoding does not appear in these timings.

Monitoring is throttled to four publications per second. Open the example with `?monitor=0` to disable both runtime metric collection and Babylon `SceneInstrumentation` observers when measuring the viewer without diagnostic overhead.
