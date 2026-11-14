import "./view-hud.css";

import type { IViewMetrics } from "@spacexr/3d-tiles-runtime";

/** Options of {@link ViewHud}. */
export interface IViewHudOptions {
    /** Longest the scale bar may be, in CSS pixels. Defaults to 120. */
    scaleBarMaxWidth?: number;
}

/**
 * Default scale and altitude display of a view: a scale bar, a compass, the altitude over the ground and the reference
 * surface, the position and the pitch. It reads {@link IViewMetrics} only, so it does not depend on the renderer.
 */
export class ViewHud {
    public readonly element: HTMLElement;
    private readonly scaleBarMaxWidth: number;
    private readonly bar: HTMLElement;
    private readonly barLabel: HTMLElement;
    private readonly needle: HTMLElement;
    private readonly fields: Record<
        "heading" | "pitch" | "altitude" | "height" | "position",
        HTMLElement
    >;
    private readonly shown = new Map<HTMLElement, string>();

    public constructor(container: HTMLElement, options: IViewHudOptions = {}) {
        this.scaleBarMaxWidth = options.scaleBarMaxWidth ?? 120;
        this.element = element("aside", "sxr-view-hud");
        this.element.setAttribute("aria-label", "View");

        const compass = element("div", "sxr-view-hud__compass");
        compass.setAttribute("aria-hidden", "true");
        this.needle = element("div", "sxr-view-hud__needle");
        this.needle.append(element("span", "sxr-view-hud__north", "N"));
        compass.append(this.needle);

        const readouts = element("dl", "sxr-view-hud__readouts");
        const field = (label: string, title: string): HTMLElement => {
            const term = element("dt", "", label);
            term.title = title;
            const value = element("dd");
            readouts.append(term, value);
            return value;
        };
        this.fields = {
            altitude: field(
                "Alt",
                "Altitude of the camera over the terrain below it",
            ),
            height: field(
                "Ref",
                "Height of the camera over the reference surface of the body",
            ),
            heading: field("Hdg", "Heading of the view, clockwise from north"),
            pitch: field("Pitch", "Angle of the view over the horizon"),
            position: field("Pos", "Latitude and east longitude of the camera"),
        };

        const scale = element("div", "sxr-view-hud__scale");
        this.bar = element("div", "sxr-view-hud__bar");
        this.barLabel = element("span", "sxr-view-hud__bar-label");
        scale.append(this.bar, this.barLabel);

        const top = element("div", "sxr-view-hud__top");
        top.append(compass, readouts);
        this.element.append(top, scale);
        container.append(this.element);
    }

    /**
     * Shows a view.
     *
     * @param view - Metrics of the view, from `describeView`.
     * @param viewportPixelsPerCssPixel - Viewport pixels, those of `view.metresPerPixel`, in one CSS pixel.
     */
    public update(
        view: Readonly<IViewMetrics>,
        viewportPixelsPerCssPixel = 1,
    ): void {
        this.show(
            this.fields.altitude,
            view.altitude === undefined ? "n/a" : formatLength(view.altitude),
        );
        this.show(this.fields.height, formatLength(view.height));
        this.show(
            this.fields.heading,
            view.heading === undefined
                ? "n/a"
                : `${String(Math.round(view.heading) % 360).padStart(3, "0")}°`,
        );
        this.show(
            this.fields.pitch,
            view.pitch === undefined ? "n/a" : `${view.pitch.toFixed(0)}°`,
        );
        this.show(
            this.fields.position,
            `${formatAngle(view.latitude, "N", "S")} ${formatAngle(view.longitude, "E", "W")}`,
        );
        this.needle.style.transform = `rotate(${-(view.heading ?? 0)}deg)`;

        const perCssPixel =
            view.metresPerPixel === undefined
                ? undefined
                : view.metresPerPixel * viewportPixelsPerCssPixel;
        const length =
            perCssPixel === undefined
                ? undefined
                : roundLength(this.scaleBarMaxWidth * perCssPixel);
        if (length === undefined || perCssPixel === undefined) {
            this.bar.style.width = "0";
            this.show(this.barLabel, "");
            return;
        }
        this.bar.style.width = `${(length / perCssPixel).toFixed(1)}px`;
        this.show(this.barLabel, formatRoundLength(length));
    }

    public dispose(): void {
        this.element.remove();
    }

    private show(target: HTMLElement, text: string): void {
        if (this.shown.get(target) === text) return;
        this.shown.set(target, text);
        target.textContent = text;
    }
}

function element(tag: string, className = "", text = ""): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** Largest length of 1, 2 or 5 times a power of ten not longer than `maximum`. */
export function roundLength(maximum: number): number | undefined {
    if (!(maximum > 0) || !Number.isFinite(maximum)) return undefined;
    const power = 10 ** Math.floor(Math.log10(maximum));
    return (
        [5, 2, 1]
            .map((step) => step * power)
            .find((length) => length <= maximum) ?? power
    );
}

/** A length in centimetres, metres or kilometres, with three significant digits at most. */
export function formatLength(metres: number): string {
    const size = Math.abs(metres);
    if (size < 1) return `${(metres * 100).toFixed(0)} cm`;
    if (size < 1000) return `${metres.toFixed(size < 10 ? 1 : 0)} m`;
    const kilometres = metres / 1000;
    return `${kilometres.toFixed(size < 10_000 ? 2 : size < 100_000 ? 1 : 0)} km`;
}

/** A length of {@link roundLength}, in its unit without decimals: 5 km, 200 m, 10 cm. */
export function formatRoundLength(metres: number): string {
    const digit = (value: number): number => Number(value.toPrecision(1));
    if (metres >= 1000) return `${digit(metres / 1000)} km`;
    if (metres >= 1) return `${digit(metres)} m`;
    return `${digit(metres * 100)} cm`;
}

function formatAngle(
    degrees: number,
    positive: string,
    negative: string,
): string {
    return `${Math.abs(degrees).toFixed(4)}°${degrees < 0 ? negative : positive}`;
}
