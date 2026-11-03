import type { IRasterGrid } from "@spacexr/raster";
import type { ITileAddress } from "@spacexr/tiles";

const LEVEL_COLORS = [
    "#2f80ed",
    "#00c2ff",
    "#12b886",
    "#ffd43b",
    "#ff922b",
    "#fa5252",
    "#cc5de8",
    "#845ef7",
] as const;

/**
 * Imagery tile drawn locally, without network: a checkerboard tinted by level, a border and the tile address.
 *
 * Neighbouring tiles continue the checkerboard, so a seam or a shifted page shows immediately, and the label tells
 * which page a quadrant samples.
 */
export function debugImageryTile(
    address: ITileAddress,
    size = 256,
): IRasterGrid<Uint8ClampedArray> {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context)
        throw new Error("OffscreenCanvas 2D context is not available.");
    const color = LEVEL_COLORS[address.lod % LEVEL_COLORS.length]!;
    const cells = 8;
    const cell = size / cells;
    for (let row = 0; row < cells; row++) {
        for (let column = 0; column < cells; column++) {
            context.fillStyle = (row + column) % 2 === 0 ? color : "#f1f3f5";
            context.fillRect(column * cell, row * cell, cell, cell);
        }
    }
    context.strokeStyle = "#212529";
    context.lineWidth = 2;
    context.strokeRect(1, 1, size - 2, size - 2);
    context.fillStyle = "rgba(255, 255, 255, 0.85)";
    context.fillRect(size * 0.15, size * 0.4, size * 0.7, size * 0.2);
    context.fillStyle = "#212529";
    context.font = `bold ${Math.round(size / 11)}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
        `${address.lod}/${address.x}/${address.y}`,
        size / 2,
        size / 2,
    );
    const { data } = context.getImageData(0, 0, size, size);
    return { width: size, height: size, channels: 4, data };
}
