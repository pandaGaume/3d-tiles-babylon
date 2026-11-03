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
        open: true,
    },
    esbuild: {
        target: "es2022",
        supported: {
            destructuring: true,
        },
    },
    optimizeDeps: { esbuildOptions: { target: "es2022" } },
    build: {
        target: "es2022",
        sourcemap: true,
    },
});
