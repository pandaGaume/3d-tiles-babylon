import { GeodeticSystem } from "@spacexr/geodesy";

/**
 * Renderer-neutral parametric topology shared by every geodesic tile.
 *
 * Coordinates are normalized over a tile region: u runs west to east and v
 * runs north to south. They deliberately contain no Cartesian position. This
 * keeps topology independent from the ellipsoid projection and prepares a
 * future instanced implementation where a vertex shader performs projection.
 */
export interface IGridTopology {
    readonly subdivisions: number;
    readonly coordinates: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
}

/** Unique Cartesian geometry produced for one geographic tile. */
export interface IEllipsoidTileGeometry {
    readonly positions: number[];
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
}

/** Options of {@link projectGridTopologyToEllipsoid}. */
export interface IProjectGridOptions {
    /**
     * Ellipsoidal height in metres at normalized tile coordinates. `NaN` falls
     * back to the region minimum height. Defaults to the region minimum height.
     */
    heightAt?: (u: number, v: number) => number;
    /**
     * Distribution of rows between the north and south edges. `geodetic`
     * interpolates latitude linearly; `mercator` interpolates the Web Mercator
     * ordinate, so rows line up with the pixel rows of a Web Mercator tile.
     * Defaults to `geodetic`.
     */
    latitudeInterpolation?: "geodetic" | "mercator";
}

/** Web Mercator ordinate of a latitude in radians. */
function mercatorOrdinate(latitude: number): number {
    return Math.log(Math.tan(Math.PI / 4 + latitude / 2));
}

/** Creates one reusable normalized grid topology. */
export function createGridTopology(subdivisions: number): IGridTopology {
    if (!Number.isInteger(subdivisions) || subdivisions < 1)
        throw new RangeError("Grid subdivisions must be a positive integer.");

    const vertexCount = (subdivisions + 1) ** 2;
    const coordinates = new Float32Array(vertexCount * 2);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(subdivisions * subdivisions * 6);
    let vertexOffset = 0;

    for (let row = 0; row <= subdivisions; row++) {
        const v = row / subdivisions;
        for (let column = 0; column <= subdivisions; column++) {
            const u = column / subdivisions;
            coordinates[vertexOffset] = u;
            coordinates[vertexOffset + 1] = v;
            uvs[vertexOffset] = u;
            uvs[vertexOffset + 1] = 1 - v;
            vertexOffset += 2;
        }
    }

    const rowLength = subdivisions + 1;
    let indexOffset = 0;
    for (let row = 0; row < subdivisions; row++) {
        for (let column = 0; column < subdivisions; column++) {
            const northWest = row * rowLength + column;
            const northEast = northWest + 1;
            const southWest = northWest + rowLength;
            const southEast = southWest + 1;
            indices[indexOffset++] = northWest;
            indices[indexOffset++] = southWest;
            indices[indexOffset++] = northEast;
            indices[indexOffset++] = northEast;
            indices[indexOffset++] = southWest;
            indices[indexOffset++] = southEast;
        }
    }

    return { subdivisions, coordinates, uvs, indices };
}

/**
 * Projects a shared topology onto one geographic region of an ellipsoid.
 *
 * The region follows the 3D Tiles order
 * `[west, south, east, north, minimumHeight, maximumHeight]`, in radians and
 * metres. Each call returns unique positions because curvature and east-west
 * pinching depend on the region's latitude and longitude.
 */
export function projectGridTopologyToEllipsoid(
    topology: IGridTopology,
    region: readonly number[],
    system: GeodeticSystem = GeodeticSystem.WGS84,
    options: IProjectGridOptions = {},
): IEllipsoidTileGeometry {
    if (region.length < 6)
        throw new RangeError("A 3D Tiles region must contain six values.");

    const [west, south, east, north, minimumHeight] = region;
    if (
        west === undefined ||
        south === undefined ||
        east === undefined ||
        north === undefined ||
        minimumHeight === undefined
    )
        throw new RangeError("The 3D Tiles region is incomplete.");

    const mercator = options.latitudeInterpolation === "mercator";
    const northOrdinate = mercator ? mercatorOrdinate(north) : 0;
    const southOrdinate = mercator ? mercatorOrdinate(south) : 0;
    const positions = new Array<number>((topology.coordinates.length / 2) * 3);
    const scratch = { x: 0, y: 0, z: 0 };
    let positionOffset = 0;

    for (
        let coordinateOffset = 0;
        coordinateOffset < topology.coordinates.length;
        coordinateOffset += 2
    ) {
        const u = topology.coordinates[coordinateOffset]!;
        const v = topology.coordinates[coordinateOffset + 1]!;
        const longitude = west + (east - west) * u;
        const latitude = mercator
            ? 2 *
                  Math.atan(
                      Math.exp(
                          northOrdinate + (southOrdinate - northOrdinate) * v,
                      ),
                  ) -
              Math.PI / 2
            : north + (south - north) * v;
        const sampledHeight = options.heightAt?.(u, v);
        const height =
            sampledHeight === undefined || Number.isNaN(sampledHeight)
                ? minimumHeight
                : sampledHeight;
        system.geodeticRadiansToEcef(latitude, longitude, height, scratch);
        positions[positionOffset++] = scratch.x;
        positions[positionOffset++] = scratch.y;
        positions[positionOffset++] = scratch.z;
    }

    return {
        positions,
        uvs: topology.uvs,
        indices: topology.indices,
    };
}

/**
 * Grid whose vertical scale can change without resampling the DEM.
 *
 * For an ellipsoidal height `h`, the ECEF position is exactly
 * `base + h * up`, where `base` lies on the ellipsoid and `up` is the
 * ellipsoid surface normal.
 */
export interface IElevatedGridGeometry {
    /** ECEF positions on the ellipsoid, three components per vertex. */
    readonly base: Float64Array;
    /** Unit ellipsoid normals, three components per vertex. */
    readonly up: Float64Array;
    /** Unscaled heights in metres; `NaN` when the DEM has no value. */
    readonly heights: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
}

/**
 * Projects a topology onto a Web Mercator region and records unscaled heights.
 * Rows follow the Web Mercator ordinate so that vertices line up with DEM pixels.
 */
export function projectElevatedGrid(
    topology: IGridTopology,
    region: readonly number[],
    heightAt: (u: number, v: number) => number,
    system: GeodeticSystem = GeodeticSystem.WGS84,
): IElevatedGridGeometry {
    const [west, south, east, north] = region;
    if (
        west === undefined ||
        south === undefined ||
        east === undefined ||
        north === undefined
    )
        throw new RangeError("The 3D Tiles region is incomplete.");

    const vertexCount = topology.coordinates.length / 2;
    const base = new Float64Array(vertexCount * 3);
    const up = new Float64Array(vertexCount * 3);
    const heights = new Float32Array(vertexCount);
    const northOrdinate = mercatorOrdinate(north);
    const southOrdinate = mercatorOrdinate(south);
    const point = { x: 0, y: 0, z: 0 };
    const normal = { x: 0, y: 0, z: 0 };

    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const u = topology.coordinates[vertex * 2]!;
        const v = topology.coordinates[vertex * 2 + 1]!;
        const longitude = west + (east - west) * u;
        const latitude =
            2 *
                Math.atan(
                    Math.exp(
                        northOrdinate + (southOrdinate - northOrdinate) * v,
                    ),
                ) -
            Math.PI / 2;
        system.geodeticRadiansToEcef(latitude, longitude, 0, point);
        system.geodeticSurfaceNormalRadians(latitude, longitude, normal);
        base.set([point.x, point.y, point.z], vertex * 3);
        up.set([normal.x, normal.y, normal.z], vertex * 3);
        heights[vertex] = heightAt(u, v);
    }
    return { base, up, heights, uvs: topology.uvs, indices: topology.indices };
}

/**
 * Composes ECEF positions for a vertical scale. Missing heights use
 * `fallbackHeight`, which is not scaled.
 */
export function composeElevatedPositions(
    geometry: IElevatedGridGeometry,
    scale: number,
    fallbackHeight = 0,
    target: number[] = new Array<number>(geometry.base.length),
): number[] {
    for (let vertex = 0; vertex < geometry.heights.length; vertex++) {
        const height = geometry.heights[vertex]!;
        const offset = Number.isNaN(height) ? fallbackHeight : height * scale;
        for (let axis = 0; axis < 3; axis++) {
            const index = vertex * 3 + axis;
            target[index] =
                geometry.base[index]! + geometry.up[index]! * offset;
        }
    }
    return target;
}
