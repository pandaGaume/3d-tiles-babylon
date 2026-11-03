/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_GOOGLE_3D_TILES_LATITUDE?: string;
    readonly VITE_GOOGLE_3D_TILES_LONGITUDE?: string;
    readonly VITE_GOOGLE_3D_TILES_HEIGHT_METERS?: string;
    readonly VITE_GOOGLE_3D_TILES_CAMERA_DISTANCE_METERS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
