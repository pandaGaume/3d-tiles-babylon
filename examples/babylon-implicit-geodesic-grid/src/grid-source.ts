import type {
    IMetadataEntity,
    IMetadataSchema,
    ITile,
    ITileset,
    NonEmptyArray,
} from "@spacexr/3d-tiles-core";
import {
    createWebMapImplicitSource,
    type ImplicitTilesetDecorator,
    type IImplicitTileResolveContext,
    type IImplicitTileResolver,
    type IImplicitTileOverride,
    type ITileAddress,
    type WebMapTileDataSource,
    WebMercatorTileMetrics,
} from "@spacexr/3d-tiles-runtime";

import type { ChildHeightRanges } from "./child-height-ranges";

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
        private readonly decoratorsByRoot: ReadonlyMap<
            ITile,
            ImplicitTilesetDecorator
        >,
        private readonly prepared: IPreparedHeights | undefined,
    ) {}

    public resolve(
        context: IImplicitTileResolveContext,
    ): IImplicitTileOverride | undefined {
        const decorator = this.decoratorsByRoot.get(context.rootTile);
        if (!decorator)
            throw new Error("No data source owns this implicit root tile.");
        const override = decorator.resolve(context);
        const region = override?.boundingVolume?.region;
        const properties = override?.metadata?.properties;
        if (!this.prepared || !region || !properties) return override;

        const range = this.prepared.ranges.rangeFor({
            lod: Number(properties.lod),
            x: Number(properties.x),
            y: Number(properties.y),
        });
        if (!range) return override;
        const scale = this.prepared.verticalScale();
        return {
            ...override,
            boundingVolume: {
                region: [
                    region[0],
                    region[1],
                    region[2],
                    region[3],
                    range[0] * scale,
                    range[1] * scale,
                ],
            },
        };
    }
}

/** Creates a global Web Map forest whose LOD 3 roots are decorated as implicit 3D Tiles. */
export function createGeodesicGridSource(
    prepared?: IPreparedHeights,
): IGeodesicGridSource {
    const rootsPerAxis = 2 ** TILE_METRICS.minLOD;
    const children: ITile[] = [];
    const dataSources: WebMapTileDataSource[] = [];
    const decoratorsByRoot = new Map<ITile, ImplicitTilesetDecorator>();

    for (let y = 0; y < rootsPerAxis; y++) {
        for (let x = 0; x < rootsPerAxis; x++) {
            const source = createWebMapImplicitSource({
                id: `geodesic-grid-${x}-${y}`,
                urlTemplates: "grid://tile/{z}/{x}/{y}",
                metrics: TILE_METRICS,
                rootAddress: { lod: TILE_METRICS.minLOD, x, y },
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

    const maximumLatitudeRadians = (TILE_METRICS.maxLatitude * Math.PI) / 180;
    const rootGeometricError = TILE_METRICS.groundResolution(
        0,
        TILE_METRICS.minLOD,
    );
    const firstChild = children[0];
    if (!firstChild)
        throw new Error(
            "The global Web Map source requires at least one root.",
        );
    const rootChildren: NonEmptyArray<ITile> = [
        firstChild,
        ...children.slice(1),
    ];
    return {
        tileset: {
            asset: { version: "1.1" },
            geometricError: rootGeometricError,
            schema,
            root: {
                boundingVolume: {
                    region: [
                        -Math.PI,
                        -maximumLatitudeRadians,
                        Math.PI,
                        maximumLatitudeRadians,
                        0,
                        0,
                    ],
                },
                geometricError: rootGeometricError,
                refine: "REPLACE",
                children: rootChildren,
            },
        },
        resolver: new GeodesicGridImplicitResolver(decoratorsByRoot, prepared),
        dataSources,
        metrics: TILE_METRICS,
    };
}
