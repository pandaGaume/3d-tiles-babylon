import { cubeTileBoundingBox, type ITileAddress } from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem, type ICartesian3 } from "@spacexr/geodesy";
import { webMercatorSurfaceNormal } from "@spacexr/dem";
import { buildGridTileGeometry, buildGridTileShape, type IGridTopology } from "@spacexr/grid";
import {
    CUBE_TILE_TOPOLOGY,
    WebMercatorTileSurface,
    flatTileTopology,
    type CubeTileSurface,
    type ITileSurface,
    type ITileTopology,
} from "@spacexr/tiles";

import { gridShape, tileCenterEcef, tileCenterLongitude, webMercatorLatitude } from "./gpu/grid-shapes";

/** Area of a tile in a DEM tile, and the quarter turns of the DEM tile. */
export interface ITerrainDemArea {
    west: number;
    north: number;
    size: number;
    turns: number;
}

/** Height of the terrain at a position of a pyramid, and on a root of the pyramid. */
export type TerrainPickHeight = (x: number, y: number, face: number) => number;

/**
 * How terrain tiles lie on a body. The engines stay the same whatever the tiling: they ask it where a tile is and how
 * tiles connect.
 *
 * Only what really differs between projections belongs here: addressing, positions and the direction of heights.
 */
export interface ITerrainTiling {
    /** Places the tiles on the body. */
    surface: ITileSurface;
    /** Connects the tiles, across cube faces when needed. */
    topology: ITileTopology;
    /** Heights move vertices along the ray from the centre of the body instead of the normal of its ellipsoid. */
    radialHeights: boolean;
    /** Radii `a`, `b`, `c` of the reference surface, for the normals of radial heights. */
    referenceRadii?: readonly [number, number, number];
    /** Bounding box of a tile with a measured height range; without it, tiles keep a `region`. */
    boundingBox?: (address: ITileAddress, minimumHeight: number, maximumHeight: number) => number[];
    /** Centre of a tile on the body. */
    center(address: ITileAddress): ICartesian3;
    /** Longitude by which the shape of a tile turns about the polar axis, without radial heights. */
    rotation(address: ITileAddress): number;
    /** Tiles with the same key share a shape. */
    shapeKey(address: ITileAddress): string;
    /** Texels of the shape of a tile, `(cells + 1)^2` of four floats: position from the tile centre, then latitude. */
    shapeTexels(address: ITileAddress, cells: number): Float32Array;
    /** Centre and positions, relative to it, of the coarse grid the camera picks. */
    pickGeometry(
        topology: IGridTopology,
        address: ITileAddress,
        height: TerrainPickHeight,
    ): { center: ICartesian3; positions: Float32Array };
    /**
     * Normal of the displaced surface at a point of a tile, from the gradient of the heights over the pyramid, in metres
     * per normalized unit.
     */
    surfaceNormal(
        address: ITileAddress,
        u: number,
        v: number,
        up: ICartesian3,
        gradient: readonly [number, number],
        verticalScale: number,
    ): ICartesian3;
    /** Area of a tile in a DEM tile, the DEM of a neighbour included. */
    demArea(address: ITileAddress, demTile: ITileAddress): ITerrainDemArea;
    /** Roots of a tiling covering a whole body: the engine then draws coarse terrain where the selection left no tile. */
    readonly coverRoots?: readonly ITileAddress[];
}

/** Web Mercator tiling on an ellipsoid, without the poles. */
export function webMercatorTiling(system: GeodeticSystem = GeodeticSystem.WGS84): ITerrainTiling {
    return {
        surface: new WebMercatorTileSurface(system),
        topology: flatTileTopology({ wrapX: true }),
        radialHeights: false,
        center: (address) => tileCenterEcef(address, system),
        rotation: (address) => tileCenterLongitude(address),
        shapeKey: (address) => `${address.lod}/${address.y}`,
        shapeTexels: (address, cells) => gridShape(address.lod, address.y, cells, system),
        pickGeometry: (topology, address, height) => {
            const center = tileCenterEcef(address, system);
            const count = 2 ** address.lod;
            const positions = new Float32Array((topology.coordinates.length / 2) * 3);
            const point = { x: 0, y: 0, z: 0 };
            for (let vertex = 0; vertex < topology.coordinates.length / 2; vertex++) {
                const x = (address.x + topology.coordinates[vertex * 2]!) / count;
                const y = (address.y + topology.coordinates[vertex * 2 + 1]!) / count;
                system.geodeticRadiansToEcef(webMercatorLatitude(y), x * 2 * Math.PI - Math.PI, height(x, y, 0), point);
                positions[vertex * 3] = point.x - center.x;
                positions[vertex * 3 + 1] = point.y - center.y;
                positions[vertex * 3 + 2] = point.z - center.z;
            }
            return { center, positions };
        },
        surfaceNormal: (_address, _u, _v, up, gradient, verticalScale) => webMercatorSurfaceNormal(gradient, up, verticalScale),
        // The tile is never coarser than the DEM tile; it may lie outside it, on its edge, for a neighbour's DEM.
        demArea: (address, demTile) => {
            const scale = 2 ** (address.lod - demTile.lod);
            return { west: address.x / scale - demTile.x, north: address.y / scale - demTile.y, size: 1 / scale, turns: 0 };
        },
    };
}

/** Cube tiling on a reference surface, which covers a whole body. */
export function cubeTiling(surface: CubeTileSurface): ITerrainTiling {
    return {
        surface,
        topology: CUBE_TILE_TOPOLOGY,
        radialHeights: true,
        referenceRadii: surface.reference.radii,
        boundingBox: (address, minimumHeight, maximumHeight) => cubeTileBoundingBox(address, surface, minimumHeight, maximumHeight),
        center: (address) => surface.point(address, 0.5, 0.5),
        rotation: (address) => surface.shape(address).rotation,
        shapeKey: (address) => surface.shape(address).key,
        shapeTexels: (address, cells) => {
            const { positions, ups } = buildGridTileShape(address, surface, cells);
            const data = new Float32Array((positions.length / 3) * 4);
            for (let vertex = 0; vertex < positions.length / 3; vertex++) {
                data[vertex * 4] = positions[vertex * 3]!;
                data[vertex * 4 + 1] = positions[vertex * 3 + 1]!;
                data[vertex * 4 + 2] = positions[vertex * 3 + 2]!;
                data[vertex * 4 + 3] = Math.asin(ups[vertex * 3 + 2]!);
            }
            return data;
        },
        pickGeometry: (topology, address, height) => {
            const count = 2 ** address.lod;
            return buildGridTileGeometry(topology, address, surface, {
                heightInitializer: ({ u, v }) => height((address.x + u) / count, (address.y + v) / count, address.face ?? 0),
            });
        },
        surfaceNormal: (address, u, v, up, gradient, verticalScale) => {
            // Tangents of the reference surface per unit of tile coordinate, from points half a cell of 1/16 around.
            const step = 1 / 32;
            const west = surface.point(address, u - step, v);
            const east = surface.point(address, u + step, v);
            const north = surface.point(address, u, v - step);
            const south = surface.point(address, u, v + step);
            const count = 2 ** address.lod;
            const slopeU = (gradient[0] * verticalScale) / count;
            const slopeV = (gradient[1] * verticalScale) / count;
            const tangentU = {
                x: (east.x - west.x) / (2 * step) + up.x * slopeU,
                y: (east.y - west.y) / (2 * step) + up.y * slopeU,
                z: (east.z - west.z) / (2 * step) + up.z * slopeU,
            };
            const tangentV = {
                x: (south.x - north.x) / (2 * step) + up.x * slopeV,
                y: (south.y - north.y) / (2 * step) + up.y * slopeV,
                z: (south.z - north.z) / (2 * step) + up.z * slopeV,
            };
            // East cross north, which points away from the body.
            const x = tangentV.y * tangentU.z - tangentV.z * tangentU.y;
            const y = tangentV.z * tangentU.x - tangentV.x * tangentU.z;
            const z = tangentV.x * tangentU.y - tangentV.y * tangentU.x;
            const length = Math.hypot(x, y, z);
            return length > 0 ? { x: x / length, y: y / length, z: z / length } : { x: up.x, y: up.y, z: up.z };
        },
        demArea: (address, demTile) => CUBE_TILE_TOPOLOGY.areaIn(address, demTile),
        coverRoots: [0, 1, 2, 3, 4, 5].map((face) => ({ face, lod: 0, x: 0, y: 0 })),
    };
}
