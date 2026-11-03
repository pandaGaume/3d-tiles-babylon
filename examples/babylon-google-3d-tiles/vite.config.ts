import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const GOOGLE_TILES_PROXY_PREFIX = "/google-3d-tiles";
const GOOGLE_TILES_TARGET = "https://tile.googleapis.com";

function googleTilesProxy(apiKey: string): Record<string, ProxyOptions> {
    return {
        [GOOGLE_TILES_PROXY_PREFIX]: {
            target: GOOGLE_TILES_TARGET,
            changeOrigin: true,
            secure: true,
            rewrite: (path) => {
                const url = new URL(path, "http://localhost");
                url.pathname = url.pathname.slice(GOOGLE_TILES_PROXY_PREFIX.length);
                url.searchParams.set("key", apiKey);
                return `${url.pathname}${url.search}`;
            },
        },
    };
}

export default defineConfig(({ command, mode }) => {
    const environment = loadEnv(mode, process.cwd(), "");
    const apiKey = environment.GOOGLE_MAP_TILES_API_KEY?.trim() ?? "";
    if (command === "serve" && !apiKey) {
        throw new Error("GOOGLE_MAP_TILES_API_KEY is missing. Copy .env.example to .env and add the server-side API key.");
    }
    const proxy = apiKey ? googleTilesProxy(apiKey) : {};

    return {
        resolve: {
            alias: {
                "@spacexr/3d-tiles-babylon": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
            },
            // The 3D Tiles packages are linked from 3d-tiles-core; keep their imports resolved from this workspace.
            preserveSymlinks: true,
        },
        server: {
            port: 5173,
            // Reload the packages linked from 3d-tiles-core when they are rebuilt.
            watch: { ignored: ["!**/node_modules/@spacexr/**"] },
            open: true,
            proxy,
        },
        preview: {
            proxy,
        },
        esbuild: { target: "es2022" },
        optimizeDeps: {
            // Linked from 3d-tiles-core: served from their build so that rebuilding core needs no Vite cache reset.
            exclude: ["@spacexr/3d-tiles-core", "@spacexr/3d-tiles-runtime", "@spacexr/tiles"],
            esbuildOptions: { target: "es2022" },
        },
        build: {
            target: "es2022",
            sourcemap: true,
        },
    };
});
