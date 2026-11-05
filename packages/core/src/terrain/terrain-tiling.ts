import { cubeTileBoundingBox, type ITileAddress } from "@spacexr/3d-tiles-runtime";
import { GeodeticSystem, type ICartesian3 } from "@spacexr/geodesy";
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
 * Web Mercator is the official engine and the cube an alternative under test: everything the cube needs lives in
 * {@link cubeTiling}, so that it cannot change how Web Mercator tiles are computed.
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
    /** Area of a tile in a DEM tile, the DEM of a neighbour included. */
    demArea(address: ITileAddress, demTile: ITileAddress): ITerrainDemArea;
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
        demArea: (address, demTile) => CUBE_TILE_TOPOLOGY.areaIn(address, demTile),
    };
}
