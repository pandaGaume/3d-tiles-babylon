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

/** Whether `outer` contains `inner`, itself included. */
function contains(outer: ITileAddress, inner: ITileAddress): boolean {
    if (inner.lod < outer.lod) return false;
    const scale = 2 ** (inner.lod - outer.lod);
    return (
        Math.floor(inner.x / scale) === outer.x &&
        Math.floor(inner.y / scale) === outer.y
    );
}

/**
 * Tracks the last known cut of a quadtree to find the level displayed across each tile edge.
 *
 * A tile hidden while no displayed tile overlaps it, typically because it left the view, stays known as a ghost: its
 * neighbours keep connecting to its level, so that turning the camera does not change their edges back and forth.
 * A ghost leaves when a tile overlapping it is presented, or when its resource is released.
 */
export interface IDisplayedTilesOptions {
    /** Called when a tile joins the known cut, to keep the data its edges are computed from. */
    onTrack?: (address: ITileAddress) => void;
    /** Called when a tile leaves the known cut, displayed or ghost. */
    onForget?: (address: ITileAddress) => void;
}

export class DisplayedTiles {
    public constructor(private readonly options: IDisplayedTilesOptions = {}) {}

    private readonly counts = new Map<string, number>();
    private readonly addresses = new Map<string, ITileAddress>();
    private readonly ghosts = new Set<string>();
    private readonly levelCounts = new Map<number, number>();
    private sortedLevels: number[] = [];

    /** Records a presented tile; ghosts it overlaps leave. */
    public add(address: ITileAddress): void {
        const tileKey = key(address);
        if (this.ghosts.delete(tileKey))
            return this.removeOverlappingGhosts(address);
        const tracked = this.counts.has(tileKey);
        this.counts.set(tileKey, (this.counts.get(tileKey) ?? 0) + 1);
        this.addresses.set(tileKey, { ...address });
        this.countLevel(address.lod, 1);
        if (!tracked) this.options.onTrack?.(address);
        this.removeOverlappingGhosts(address);
    }

    /** Records a hidden tile: it leaves when a displayed tile overlaps it, and stays as a ghost otherwise. */
    public hide(address: ITileAddress): void {
        const tileKey = key(address);
        if (!this.counts.has(tileKey) || this.ghosts.has(tileKey)) return;
        if (this.counts.get(tileKey)! > 1 || this.overlapsDisplayed(address))
            this.delete(address);
        else this.ghosts.add(tileKey);
    }

    /** Whether a tile is known only as a ghost, hidden while nothing displayed overlaps it. */
    public isGhost(address: ITileAddress): boolean {
        return this.ghosts.has(key(address));
    }

    /** Forgets a tile, displayed or ghost. */
    public delete(address: ITileAddress): void {
        const tileKey = key(address);
        if (!this.counts.has(tileKey)) return;
        const count = this.counts.get(tileKey)! - 1;
        if (count > 0) this.counts.set(tileKey, count);
        else {
            this.counts.delete(tileKey);
            this.addresses.delete(tileKey);
            this.ghosts.delete(tileKey);
        }
        this.countLevel(address.lod, -1);
        if (count <= 0) this.options.onForget?.(address);
    }

    /** Whether a displayed tile, not a ghost, is an ancestor or a descendant of a tile. */
    private overlapsDisplayed(address: ITileAddress): boolean {
        for (const [tileKey, other] of this.addresses) {
            if (this.ghosts.has(tileKey) || tileKey === key(address)) continue;
            if (contains(other, address) || contains(address, other))
                return true;
        }
        return false;
    }

    private removeOverlappingGhosts(address: ITileAddress): void {
        for (const ghost of [...this.ghosts]) {
            const other = this.addresses.get(ghost)!;
            if (contains(other, address) || contains(address, other))
                this.delete(other);
        }
    }

    public has(address: ITileAddress): boolean {
        return this.counts.has(key(address));
    }

    /**
     * Displayed tiles whose closed extent contains a point, one per level, from
     * the coarsest. The point is normalized over the pyramid: `x` eastward and
     * `y` southward in `[0, 1]`. Columns wrap around the antimeridian.
     */
    public touching(x: number, y: number): ITileAddress[] {
        const result: ITileAddress[] = [];
        for (const lod of this.sortedLevels) {
            const count = 2 ** lod;
            const column = x * count;
            const row = y * count;
            // A point on a tile boundary touches the tiles on both sides.
            const columns = Number.isInteger(column)
                ? [column - 1, column]
                : [Math.floor(column)];
            const rows = Number.isInteger(row)
                ? [row - 1, row]
                : [Math.floor(row)];
            const found = rows
                .filter((candidate) => candidate >= 0 && candidate < count)
                .flatMap((candidateRow) =>
                    columns.map((candidate) => ({
                        lod,
                        x: ((candidate % count) + count) % count,
                        y: candidateRow,
                    })),
                )
                .find((address) => this.has(address));
            if (found) result.push(found);
        }
        return result;
    }

    private countLevel(lod: number, delta: number): void {
        const count = (this.levelCounts.get(lod) ?? 0) + delta;
        if (count > 0) this.levelCounts.set(lod, count);
        else this.levelCounts.delete(lod);
        this.sortedLevels = [...this.levelCounts.keys()].sort(
            (left, right) => left - right,
        );
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
