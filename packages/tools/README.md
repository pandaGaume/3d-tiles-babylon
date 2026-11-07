# @spacexr/3d-tiles-babylon-tools

Build tools of this repository. Private: it is not published.

## Shaders

Shaders are written in their own files, so that editors and linters can read them. `build-shaders` compiles each one into a TypeScript module beside it, following the approach of `packages/dev/buildTools` in SpaceXR.

```bash
npm run shaders
```

```bash
npm run shaders:watch
```

| File                 | Kind    | Generated                                                | Registered in          |
| -------------------- | ------- | -------------------------------------------------------- | ---------------------- |
| `name.vertex.glsl`   | stage   | `name.vertex.ts`, exports `nameVertexShader`             | `ShadersStore`         |
| `name.fragment.glsl` | stage   | `name.fragment.ts`, exports `namePixelShader`            | `ShadersStore`         |
| `name.compute.glsl`  | stage   | `name.compute.ts`, exports `nameComputeShader`           | `ShadersStore`         |
| `includes/name.glsl` | include | `includes/name.ts`, exports `name`, for `#include<name>` | `IncludesShadersStore` |
| `snippets/name.glsl` | snippet | `snippets/name.ts`, exports `name`                       | nothing                |

A `.wgsl` file generates the same module and registers in `ShadersStoreWGSL` or `IncludesShadersStoreWGSL`. The tool handles the extension; this repository holds no WGSL shader today.

Each export is `{ name, shader }`. Reference it from the code that uses the shader: the package declares `"sideEffects": false`, so a bundler may drop a module imported only for its registration.

- **What a build changes.** Comments, indentation and blank lines are removed. Lines are never joined, so preprocessor directives keep their own line and tokens are not touched. A comment changed in a shader file leaves its module unchanged.
- **Snippets.** Code a material plugin injects into a Babylon.js material, such as `CUSTOM_FRAGMENT_DEFINITIONS`. To use `#include` in one, the plugin sets `resolveIncludes`. A snippet is not a whole shader, and an editor may report what it expects from the material around it.
- **Generated modules.** They are committed, so that a checkout builds without a generation step, and hidden in VS Code. Do not edit them. The tests of this package fail when one differs from its shader file, or has no shader file: `npm run check` reports a forgotten generation. The build of the core package generates them first.

## Commands

From the core package, `npm run shaders:check` reports the modules out of date without writing them.

Called directly, the tool takes a folder:

```bash
npx tsx packages/tools/src/cli.ts packages/core/src --check
```

## Terrain bench

Flies fixed camera paths in headless Chrome over the implicit grid example, on both terrain engines, and reports what each costs and breaks. It needs Node.js 22 and the example running, and the tile service for the Moon. Read the [terrain test log](https://github.com/pandaGaume/3d-tiles-core/blob/main/docs/terrain-test-log.md) of 3d-tiles-core before a new measurement, and add an entry after it.

```bash
npm run bench:terrain -- --dataset http://127.0.0.1:8793 --only "/gpu$" --label name --out file.json --compare reference.json
```

Each path runs twice, on a fresh page: once for performance, once for integrity.

- **Performance:** frames per second, CPU of the terrain and of the render, GPU time, instances, draw calls, triangles, uploads, memory, requests to tile servers and time to load.
- **Integrity:** holes, and the largest distance between vertices tiles share, in the view and anywhere, in motion and at rest once nothing is pending.

`mont-blanc` paths reach public tile servers. A page is cut off from them after `--max-requests`, 5000 by default, and its path then fails: try a change that adds tiles on the Moon first. Mobile hardware and other GPUs are not covered. Run to run, compare large differences only.
