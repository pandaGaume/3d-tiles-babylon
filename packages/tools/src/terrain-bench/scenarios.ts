/** A camera path, followed in time so that every engine flies the same one. */
export interface IBenchPath {
    /** Heading change, in radians per second. */
    turn?: number;
    /** Zoom in and out between two radii, in metres; `rate` is the logarithm of the factor per second. */
    zoom?: { nearest: number; farthest: number; rate: number };
}

/** Where a scenario looks, and what it validates. */
export interface IBenchView {
    name: string;
    projection: "mercator" | "cube";
    /** URL parameters of the view. */
    query: string;
    path: IBenchPath;
}

/** A view rendered by one engine. */
export interface IBenchScenario extends IBenchView {
    id: string;
    engine: "mesh" | "gpu";
    url: string;
}

export const BENCH_ENGINES = ["mesh", "gpu"] as const;

/** About 15 notches per second of a fast wheel, each a factor 1.105 on the radius. */
const WHEEL_RATE = 1.5;
const TURN_RATE = 0.7;

const ZOOM = (nearest: number): IBenchPath => ({ zoom: { nearest, farthest: 400000, rate: WHEEL_RATE } });
const TURN: IBenchPath = { turn: TURN_RATE };

export const BENCH_VIEWS: readonly IBenchView[] = [
    { name: "mont-blanc", projection: "mercator", query: "radius=25000&pitch=60", path: TURN },
    { name: "mont-blanc-zoom", projection: "mercator", query: "radius=400000&pitch=60", path: ZOOM(5000) },
    { name: "plain", projection: "cube", query: "lat=35&lon=-15&radius=40000&pitch=70", path: TURN },
    { name: "plain-zoom", projection: "cube", query: "lat=35&lon=-15&radius=400000&pitch=70", path: ZOOM(5000) },
    // An edge between two faces, and one turned between a face and a pole.
    { name: "face-edge", projection: "cube", query: "lat=0&lon=45&radius=40000&pitch=60", path: TURN },
    { name: "turned-edge", projection: "cube", query: "lat=45&lon=90&radius=40000&pitch=60", path: TURN },
    // A vertex of the cube, where 3 tiles meet.
    { name: "cube-vertex", projection: "cube", query: "lat=35.264&lon=45&radius=40000&pitch=60", path: TURN },
    { name: "pole", projection: "cube", query: "lat=-89.67&lon=129.2&radius=8000&pitch=60", path: TURN },
    // Where a dataset gets deeper: data of different resolutions across an edge.
    { name: "cap-border", projection: "cube", query: "lat=-86.6&lon=-90&radius=20000&pitch=60", path: TURN },
];

/**
 * Every view on every engine.
 *
 * @param base - Address of the example.
 * @param dataset - Address of a tile service for the cube; without it, the synthetic Moon.
 * @param grid - Cells per side of the grids on the cube; without it, those of the example.
 */
export function benchScenarios(base: string, dataset?: string, grid?: number): IBenchScenario[] {
    const root = base.replace(/\/+$/, "");
    return BENCH_VIEWS.flatMap((view) =>
        BENCH_ENGINES.map((engine) => {
            const body =
                view.projection === "cube" ? `body=moon&${dataset ? `dataset=${dataset}&` : ""}${grid ? `grid=${grid}&` : ""}` : "";
            return {
                ...view,
                engine,
                id: `${view.name}/${engine}`,
                url: `${root}/?${body}engine=${engine}&solid=1&imagery=none&${view.query}`,
            };
        }),
    );
}
