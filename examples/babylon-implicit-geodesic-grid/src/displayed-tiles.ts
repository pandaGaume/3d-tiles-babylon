import {
    NeighborLod,
    SAME_EDGE_LODS,
    gridEdgeLods,
    type GridEdgeLods,
} from "@spacexr/grid";
import {
    TileNeighbor,
    childTileAddresses,
    parentTileAddress,
    tileNeighborAddress,
    type ITileAddress,
    type TileEdgeNeighbor,
} from "@spacexr/tiles";

/**
 * Which tile of a junction between two levels adapts its edge.
 *
 * - `fine`: the finer tile removes every other edge vertex (`Coarser`).
 * - `coarse`: the coarser tile adds the edge midpoints (`Finer`).
 * - `none`: no junction, tiles keep their regular edges.
 */
export type JunctionPolicy = "fine" | "coarse" | "none";

/** Children of a neighbour that touch the tile, in `childTileAddresses` order NW, NE, SW, SE. */
const CHILDREN_FACING: Readonly<
    Record<TileEdgeNeighbor, readonly [number, number]>
> = {
    // The northern neighbour touches the tile with its southern children, and so on.
    [TileNeighbor.N]: [2, 3],
    [TileNeighbor.E]: [0, 2],
    [TileNeighbor.S]: [0, 1],
    [TileNeighbor.W]: [1, 3],
};

function key(address: ITileAddress): string {
    return `${address.lod}/${address.x}/${address.y}`;
}

/** Tracks the presented tiles of a quadtree to find the level displayed across each tile edge. */
export class DisplayedTiles {
    private readonly counts = new Map<string, number>();

    public add(address: ITileAddress): void {
        this.counts.set(key(address), (this.counts.get(key(address)) ?? 0) + 1);
    }

    public delete(address: ITileAddress): void {
        const count = (this.counts.get(key(address)) ?? 0) - 1;
        if (count > 0) this.counts.set(key(address), count);
        else this.counts.delete(key(address));
    }

    public has(address: ITileAddress): boolean {
        return this.counts.has(key(address));
    }

    /**
     * Level of detail displayed across an edge: the neighbour itself, one of its
     * ancestors, or its children facing the tile. Columns wrap around the
     * antimeridian; `undefined` when nothing is displayed there.
     */
    public lodAcross(
        address: ITileAddress,
        edge: TileEdgeNeighbor,
    ): number | undefined {
        const neighbor = tileNeighborAddress(address, edge, { wrapX: true });
        if (!neighbor) return undefined;
        if (this.has(neighbor)) return neighbor.lod;
        for (
            let ancestor = parentTileAddress(neighbor);
            ancestor;
            ancestor = parentTileAddress(ancestor)
        ) {
            if (this.has(ancestor)) return ancestor.lod;
        }
        const children = childTileAddresses(neighbor);
        return CHILDREN_FACING[edge].some((index) => this.has(children[index]!))
            ? neighbor.lod + 1
            : undefined;
    }

    /**
     * Edge levels of a tile under a junction policy. Levels further than one
     * apart are clamped: the runtime does not balance its quadtree, so such a
     * junction keeps a small crack.
     */
    public edgeLods(
        address: ITileAddress,
        policy: JunctionPolicy,
    ): GridEdgeLods {
        if (policy === "none") return SAME_EDGE_LODS;
        return gridEdgeLods(address, (edge) => {
            const lod = this.lodAcross(address, edge);
            if (lod === undefined) return undefined;
            const clamped = Math.min(
                Math.max(lod, address.lod - NeighborLod.Finer),
                address.lod + NeighborLod.Finer,
            );
            if (policy === "fine" && clamped > address.lod) return address.lod;
            if (policy === "coarse" && clamped < address.lod)
                return address.lod;
            return clamped;
        });
    }
}
