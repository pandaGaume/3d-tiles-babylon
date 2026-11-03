import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
    resolve: {
        alias: {
            "@spacexr/3d-tiles-babylon": fileURLToPath(
                new URL("../../packages/core/src/index.ts", import.meta.url),
            ),
        },
        // The 3D Tiles packages are linked from 3d-tiles-core; keep their imports resolved from this workspace.
        preserveSymlinks: true,
    },
    server: {
        port: 5174,
        // Reload the packages linked from 3d-tiles-core when they are rebuilt.
        watch: { ignored: ["!**/node_modules/@spacexr/**"] },
        open: true,
    },
    esbuild: {
        target: "es2022",
        supported: {
            destructuring: true,
        },
    },
    optimizeDeps: {
        // Linked from 3d-tiles-core: served from their build so that rebuilding core needs no Vite cache reset.
        exclude: [
            "@spacexr/3d-tiles-core",
            "@spacexr/3d-tiles-runtime",
            "@spacexr/tiles",
            "@spacexr/raster",
            "@spacexr/dem",
            "@spacexr/grid",
        ],
        esbuildOptions: { target: "es2022" },
    },
    build: {
        target: "es2022",
        sourcemap: true,
    },
});
