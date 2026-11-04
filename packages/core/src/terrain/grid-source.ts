import type { IMetadataEntity, IMetadataSchema, ITile, ITileset, NonEmptyArray } from "@spacexr/3d-tiles-core";
import {
    createWebMapImplicitSource,
    type ImplicitTilesetDecorator,
    type IImplicitTileAddressContext,
    type IImplicitTileResolveContext,
    type IImplicitTileResolver,
    type IImplicitTileOverride,
    type ITileAddress,
    type WebMapTileDataSource,
    WebMercatorTileMetrics,
} from "@spacexr/3d-tiles-runtime";

import type { ChildHeightRanges } from "@spacexr/dem";
import { parentTileAddress } from "@spacexr/tiles";

export const TILE_METRICS = new WebMercatorTileMetrics({
    minLOD: 3,
    // Mapzen Terrarium stops at level 15; deeper grids sample their level 15 ancestor.
    maxLOD: 18,
    tileSize: 256,
});

const schema: IMetadataSchema = {
    id: "SpaceXRGeodesicGrid",
    name: "SpaceXR geodesic grid pipeline proof",
    classes: {
        GeodesicGridTile: {
            properties: {
                lod: {
                    type: "SCALAR",
                    componentType: "UINT32",
                    required: true,
                },
                x: { type: "SCALAR", componentType: "UINT32", required: true },
                y: { type: "SCALAR", componentType: "UINT32", required: true },
            },
        },
    },
};

function tileMetadata(address: ITileAddress): IMetadataEntity {
    return {
        class: "GeodesicGridTile",
        properties: {
            lod: address.lod,
            x: address.x,
            y: address.y,
        },
    };
}

export interface IGeodesicGridSource {
    tileset: ITileset;
    resolver: IImplicitTileResolver;
    dataSources: readonly WebMapTileDataSource[];
    metrics: WebMercatorTileMetrics;
}

/** Height ranges prepared by parent DEMs, applied when child tiles are created. */
export interface IPreparedHeights {
    ranges: ChildHeightRanges;
    /** Current vertical scale applied to heights. */
    verticalScale: () => number;
}

class GeodesicGridImplicitResolver implements IImplicitTileResolver {
    public constructor(
        private readonly decoratorsByRoot: ReadonlyMap<ITile, ImplicitTilesetDecorator>,
        private readonly prepared: IPreparedHeights | undefined,
    ) {}

    /** Address in the global Web Mercator pyramid, so that the runtime balances the quadtree across roots. */
    public addressOf(context: IImplicitTileAddressContext): ITileAddress {
        const decorator = this.decoratorsByRoot.get(context.rootTile);
        if (!decorator) throw new Error("No data source owns this implicit root tile.");
        return decorator.addressOf(context);
    }

    public resolve(context: IImplicitTileResolveContext): IImplicitTileOverride | undefined {
        const decorator = this.decoratorsByRoot.get(context.rootTile);
        if (!decorator) throw new Error("No data source owns this implicit root tile.");
        const override = decorator.resolve(context);
        const region = override?.boundingVolume?.region;
        const properties = override?.metadata?.properties;
        if (!this.prepared || !region || !properties) return override;

        // Ranges are prepared one level ahead; deeper tiles, such as imagery tiles, use their deepest prepared ancestor.
        let address: ITileAddress | undefined = {
            lod: Number(properties.lod),
            x: Number(properties.x),
            y: Number(properties.y),
        };
        let range = undefined as readonly [number, number] | undefined;
        while (address && !range) {
            range = this.prepared.ranges.rangeFor(address);
            address = parentTileAddress(address);
        }
        if (!range) return override;
        const scale = this.prepared.verticalScale();
        return {
            ...override,
            boundingVolume: {
                region: [region[0], region[1], region[2], region[3], range[0] * scale, range[1] * scale],
            },
        };
    }
}

export interface IGridSourceOptions {
    /** Pyramid levels and tile size. Defaults to the terrain grid metrics. */
    metrics?: WebMercatorTileMetrics;
    /** Prefix of the data source identifiers. Defaults to `geodesic-grid`. */
    id?: string;
}

/** Creates a global Web Map forest whose `minLOD` roots are decorated as implicit 3D Tiles. */
export function createGeodesicGridSource(prepared?: IPreparedHeights, options: IGridSourceOptions = {}): IGeodesicGridSource {
    const metrics = options.metrics ?? TILE_METRICS;
    const id = options.id ?? "geodesic-grid";
    const rootsPerAxis = 2 ** metrics.minLOD;
    const children: ITile[] = [];
    const dataSources: WebMapTileDataSource[] = [];
    const decoratorsByRoot = new Map<ITile, ImplicitTilesetDecorator>();

    for (let y = 0; y < rootsPerAxis; y++) {
        for (let x = 0; x < rootsPerAxis; x++) {
            const source = createWebMapImplicitSource({
                id: `${id}-${x}-${y}`,
                urlTemplates: `${id}://tile/{z}/{x}/{y}`,
                metrics,
                rootAddress: { lod: metrics.minLOD, x, y },
                subtreeLevels: 4,
                // Tiles start flat; the DEM loaded with each tile reports its measured height range.
                minimumHeight: 0,
                maximumHeight: 0,
                refine: "REPLACE",
                tileMetadata,
                contentMetadata: tileMetadata,
            });
            children.push(source.tileset.root);
            dataSources.push(source.dataSource);
            decoratorsByRoot.set(source.tileset.root, source.decorator);
        }
    }

    const maximumLatitudeRadians = (metrics.maxLatitude * Math.PI) / 180;
    const rootGeometricError = metrics.groundResolution(0, metrics.minLOD);
    const firstChild = children[0];
    if (!firstChild) throw new Error("The global Web Map source requires at least one root.");
    const rootChildren: NonEmptyArray<ITile> = [firstChild, ...children.slice(1)];
    return {
        tileset: {
            asset: { version: "1.1" },
            geometricError: rootGeometricError,
            schema,
            root: {
                boundingVolume: {
                    region: [-Math.PI, -maximumLatitudeRadians, Math.PI, maximumLatitudeRadians, 0, 0],
                },
                geometricError: rootGeometricError,
                refine: "REPLACE",
                children: rootChildren,
            },
        },
        resolver: new GeodesicGridImplicitResolver(decoratorsByRoot, prepared),
        dataSources,
        metrics,
    };
}

/** Address of an implicit grid tile, read from the `lod`, `x` and `y` metadata of the tile. */
export function metadataTileAddress(tile: { id: string; source: ITile }): ITileAddress {
    const properties = tile.source.metadata?.properties;
    const coordinate = (name: "lod" | "x" | "y"): number => {
        const value = properties?.[name];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Tile ${tile.id} has no valid ${name} metadata.`);
        return value;
    };
    return { lod: coordinate("lod"), x: coordinate("x"), y: coordinate("y") };
}
