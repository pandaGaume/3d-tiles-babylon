<img src="https://raw.githubusercontent.com/pandaGaume/3d-tiles-core/main/assets/brand/spacexr-component.png" alt="SpaceXR Component" height="56">

# Babylon implicit grid, Mapzen

This example is the integration proof for the renderer-neutral runtime pipeline.

The 3D Tiles runtime owns camera traversal, implicit tiling, LOD selection, readiness, metadata handles and cache policy. The terrain engine only implements `ITileActivationAdapter` and `ITilePresentationAdapter`. It never imports `TileRuntime` internals.

The terrain engines, the grid pipeline and the geodesic grid source come from `@spacexr/3d-tiles-babylon`. The example only assembles them: it creates the terrain and imagery runtimes, the DEM pyramid and the imagery pages, and hands presented tiles to an engine behind `ITerrainEngine`, selected with `engine`. `mesh`, the default, shares one normalized grid topology and creates one geometry per tile on the CPU: every ready tile receives unique ECEF vertices projected from its geographic region onto the WGS84 ellipsoid, so curvature and east-west pinching follow both LOD and latitude. `gpu` instances one predefined grid instead, refined on its edges as in SpaceXR, once per tile of the finer of the terrain and imagery cuts, displaced in the vertex shader from elevation pages; it renders the terrain in one draw call, without cracks and without skirts. Debug labels are shown by the mesh engine only.

Every presented tile is colored by absolute LOD and receives a screen-space `X/Y/LOD` label. Those identifiers are also published through the example's 3D Tiles metadata, making parent-child overlap and incorrect replacement cuts directly visible while debugging traversal.

The scene root covers the complete WebMercator domain and contains 64 independent sources, one for every `X/Y` address at LOD 3. Each `WebMapTileDataSource` owns the shared `WebMercatorTileMetrics` configuration with `minLOD = 3` and `maxLOD = 18`, its root address and its `grid://` URL template. Its `ImplicitTilesetDecorator` derives sixteen available levels and cannot request an address beyond LOD 18.

The explicit scene root has no renderable content. It lets the standard runtime select only the visible LOD 3 source roots. A routing resolver then delegates every implicit tile to the decorator that owns its root. The coverage is global within the WebMercator latitude limits of approximately 85.051 degrees north and south.

Run it from the repository root, after building 3d-tiles-core as described in the [repository README](../../README.md):

```bash
npm run example:implicit-grid
```

No API key or `.env` file is required.

## Elevation

Grid vertices are displaced with Mapzen Terrarium heights from a `DemPyramid` of `@spacexr/dem`, one DEM tile per grid tile. Below level 15, the deepest Terrarium level, DEM tiles are generated level by level down to 18, the deepest grid level, by interpolating the level above: `interpolation=cubic` (default), `bilinear`, `linear` or `nearest`.

DEM tiles are stitched with the first column, row and sample of their east, south and south-east neighbours, as in SpaceXR, and sampled in point registration: neighbouring grids of the same level read identical heights on their shared edge. Where tiles of several levels meet, every edge vertex takes the height chosen by the `heights` parameter, computed identically by every tile touching it. The runtime keeps neighbouring tiles within one level of detail (2:1 quadtree balance), and shaded rendering uses normals of the stitched DEM surface, so tile edges show neither cracks nor shading seams.

When many tiles arrive at once, the grids whose neighbours changed are rebuilt within `junctionBudget` milliseconds per frame, cracks first and nearest first, so that a wave of loaded tiles spreads over several frames instead of stalling one.

Tiles start with a 0/0 m height range. When a DEM is loaded, the tile reports its measured range to the runtime through `tileBoundingVolume`, and the four quadrant ranges are recorded for its children. The resolver applies them when the children are created, and the runtime applies them again to children created before the parent DEM arrived.

The camera starts above the Mont Blanc summit. URL parameters:

| Parameter                  | Effect                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elevation=0`              | Flat grids, no DEM requests                                                                                                                           |
| `scale=2`                  | Initial altitude scale; the panel slider changes it live                                                                                              |
| `solid=1`                  | Shaded rendering with a sun light instead of the wireframe                                                                                            |
| `radius=250`               | Initial camera distance to the summit in metres                                                                                                       |
| `pitch=50`                 | Initial camera pitch in degrees                                                                                                                       |
| `junctions=coarse`         | Junction policy between levels of detail: `fine` (default), `coarse` or `none`                                                                        |
| `heights=finest`           | Height of edge vertices shared by several levels: DEM of the `coarsest` (default), `finest` or `average` level                                        |
| `balance=0`                | Disables the 2:1 quadtree balance, which keeps neighbouring tiles within one level of detail                                                          |
| `interpolation=bilinear`   | DEM levels generated below level 15: `cubic` (default), `bilinear`, `linear` or `nearest`                                                             |
| `engine=gpu`               | Terrain engine: `mesh` (default), one CPU mesh per tile, or `gpu`, predefined grids instanced on the GPU                                              |
| `junctionBudget=4`         | Main-thread milliseconds per frame for rebuilding the grids whose neighbours changed, 4 by default                                                    |
| `hysteresis=0.2`           | Refined tiles coarsen only once their error drops below `1 - hysteresis` times the threshold                                                          |
| `coarsenDelay=20`          | Frames a refined tile waits before coarsening                                                                                                         |
| `imagery=none`             | Imagery draped on shaded grids: `debug` (default), `none`, or the name of a local module (see [Imagery](#imagery))                                    |
| `kmax=4`                   | Deepest drape, in levels below the terrain tile                                                                                                       |
| `subtrees=13/4252/2920/13` | Terrain subtrees with their own levels, `lod/x/y/maxLOD` separated by commas: from each root tile down, the grid stops at `maxLOD`, or refines deeper |
| `renderer=webgpu`          | Renders with WebGPU where the browser supports it, WebGL otherwise                                                                                    |
| `monitor=0`                | Disables the monitoring overlay and its counters                                                                                                      |

The Mapzen attribution is displayed in the bottom-right corner.

## Runtime monitoring

The overlay joins the renderer-neutral runtime cache statistics with Babylon counters. It reports selected and cached tiles, tracked CPU/GPU/subtree memory, JavaScript heap usage when the browser exposes it, cumulative content and subtree evictions, implicit branch pruning, FPS, draw calls and the number of Babylon meshes created, shown and released.

The `Frame` line uses Babylon's standard `SceneInstrumentation` and `EngineInstrumentation` counters, averaged over the last second: frame time, time between frames (JavaScript outside rendering, such as runtime traversal and tile reception), render time, active mesh selection time and GPU frame time when the browser exposes GPU timer queries. DEM tiles are decoded in a pool of web workers, so their decoding does not appear in these timings.

Monitoring is throttled to four publications per second. Open the example with `?monitor=0` to disable both runtime metric collection and Babylon `SceneInstrumentation` observers when measuring the viewer without diagnostic overhead.

## Imagery

Shaded grids (`solid=1`) are draped with imagery from a second implicit quadtree, levels 3 to 20, traversed by its own runtime on texel size rather than geometric error. Each terrain tile is divided into as many cells as the imagery cut needs above it, one page per cell, up to 4 levels below the terrain: distant tiles show one page, near tiles up to 256, and a cell falls back to a coarser page while its own loads; pages are stitched with their neighbours, so the imagery shows no seam between pages. `kmax` sets the deepest drape, 4 levels below the terrain by default.

`imagery=debug`, the default, draws the pages locally: a checkerboard tinted by level and labelled with the page address, which makes the binding visible. `imagery=none` keeps the level colours.

`imagery=<name>` drapes the imagery of `src/local/<name>.imagery.ts`, a module exporting `createImagery()` with a tile loader, a maximum level and an attribution (see `src/local-imagery.ts`). The `src/local/` folder is ignored by git, for sources that must stay on the developer machine.
