import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    formatComparison,
    formatReport,
    integrityFailures,
    type IBenchIntegrity,
    type IBenchPerformance,
    type IBenchReport,
    type IBenchResult,
} from "./report";
import { benchScenarios, type IBenchPath } from "./scenarios";

const USAGE = `Usage: terrain-bench [options]

Flies fixed camera paths in headless Chrome over the implicit grid example, which must be running.

  --url <address>      Address of the example. Defaults to http://localhost:5174
  --browser <path>     Chrome or Chromium. Defaults to the usual locations
  --only <pattern>     Scenarios whose id matches this regular expression
  --seconds <n>        Length of each path. Defaults to 8
  --label <text>       Name of what is measured. Defaults to the current commit
  --out <file>         Writes the report as JSON
  --compare <file>     Compares with a report written earlier
  --query <text>       More URL parameters of the example, such as demCache=2048
  --shots <folder>     Writes an image of each scenario, once at rest after its path
  --max-requests <n>   Requests a page may send to tile servers before they are blocked and the
                       path fails, which protects public servers. Defaults to 5000
`;

function option(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function findBrowser(): string {
    const candidates = [
        option("browser"),
        process.env.CHROME_PATH,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ];
    const found = candidates.find((candidate) => candidate && existsSync(candidate));
    if (!found) throw new Error("No browser found: pass --browser.");
    return found;
}

/** A minimal Chrome DevTools connection. */
class Devtools {
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (reason: Error) => void }>();
    public onEvent: ((message: { method: string; params: never; sessionId?: string }) => void) | undefined;

    private constructor(private readonly socket: WebSocket) {
        socket.onmessage = (event: MessageEvent) => {
            const message = JSON.parse(String(event.data));
            const waiting = this.pending.get(message.id);
            if (waiting) {
                this.pending.delete(message.id);
                if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
                else waiting.resolve(message.result as never);
            } else this.onEvent?.(message);
        };
    }

    public static async connect(url: string): Promise<Devtools> {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = reject;
        });
        return new Devtools(socket);
    }

    public send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
            this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startBrowser(path: string, port: number, profile: string): Promise<{ devtools: Devtools; stop: () => void }> {
    const browser = spawn(
        path,
        [
            "--headless=new",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profile}`,
            "--window-size=1200,860",
            "--force-device-scale-factor=1",
            "--use-angle=d3d11",
            "--ignore-gpu-blocklist",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--no-first-run",
            "about:blank",
        ],
        { stdio: "ignore" },
    );
    const stop = (): void => {
        try {
            if (process.platform === "win32") execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
            else browser.kill();
        } catch {
            // Already gone.
        }
    };
    for (let attempt = 0; attempt < 50; attempt++) {
        await sleep(200);
        const version = await fetch(`http://127.0.0.1:${port}/json/version`)
            .then((response) => response.json() as Promise<{ webSocketDebuggerUrl: string }>)
            .catch(() => undefined);
        if (version) return { devtools: await Devtools.connect(version.webSocketDebuggerUrl), stop };
    }
    stop();
    throw new Error("The browser did not start.");
}

/** Opens a page and waits until its terrain has settled. */
async function openPage(
    devtools: Devtools,
    url: string,
    probe: string,
    errors: string[],
    maxRequests: number,
): Promise<{
    evaluate: <T>(expression: string) => Promise<T>;
    tileRequests: () => number;
    tileUrls: () => string[];
    screenshot: (file: string) => Promise<void>;
    loadSeconds: number;
    close: () => Promise<void>;
}> {
    const { targetId } = await devtools.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await devtools.send("Page.enable", {}, sessionId);
    await devtools.send("Runtime.enable", {}, sessionId);
    await devtools.send("Network.enable", {}, sessionId);
    // What leaves the page for its tile servers: everything but the application itself.
    const origin = new URL(url).origin;
    let tileRequests = 0;
    const tileUrls = new Set<string>();
    devtools.onEvent = (message) => {
        if (message.sessionId !== sessionId) return;
        const params = message.params as {
            exceptionDetails?: { text: string; exception?: { description?: string } };
            type?: string;
            args?: { value?: string; description?: string }[];
            request?: { url: string };
        };
        if (
            message.method === "Network.requestWillBeSent" &&
            params.request?.url.startsWith("http") &&
            !params.request.url.startsWith(origin)
        ) {
            tileRequests++;
            tileUrls.add(params.request.url);
            if (tileRequests === maxRequests) {
                errors.push(`Tile servers blocked after ${maxRequests} requests`);
                const hosts = new Set([...tileUrls].map((address) => new URL(address).host));
                void devtools.send("Network.setBlockedURLs", { urls: [...hosts].map((host) => `*://${host}/*`) }, sessionId);
            }
        }
        if (message.method === "Runtime.exceptionThrown")
            errors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text).slice(0, 300));
        if (message.method === "Runtime.consoleAPICalled" && params.type === "error")
            errors.push(
                (params.args ?? [])
                    .map((a) => a.value ?? a.description)
                    .join(" ")
                    .slice(0, 300),
            );
    };
    const opening = Date.now();
    await devtools.send("Page.navigate", { url }, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await devtools.send<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            sessionId,
        );
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
        return result.result.value;
    };
    // A page that has not started loading also reads 0 pending: wait for selected tiles, and for it to last.
    let quietChecks = 0;
    for (let attempt = 0; attempt < 120 && quietChecks < 3; attempt++) {
        await sleep(500);
        const quiet = await evaluate<boolean>(
            `(() => {
                const text = document.getElementById('runtime-statistics')?.textContent ?? '';
                return !!window.__SPACEXR_EXAMPLE__ && Number((text.match(/Tiles (\\d+)\\//) ?? [])[1] ?? 0) > 0 && (text.match(/(\\d+) pending/) ?? [])[1] === '0';
            })()`,
        );
        quietChecks = quiet ? quietChecks + 1 : 0;
    }
    const loadSeconds = Math.round((Date.now() - opening) / 100) / 10;
    await sleep(1500);
    await evaluate(probe);
    return {
        evaluate,
        tileRequests: () => tileRequests,
        tileUrls: () => [...tileUrls],
        screenshot: async (file: string) => {
            const { data } = await devtools.send<{ data: string }>(
                "Page.captureScreenshot",
                { format: "png", clip: { x: 0, y: 230, width: 1180, height: 500, scale: 1 } },
                sessionId,
            );
            writeFileSync(file, Buffer.from(data, "base64"));
        },
        loadSeconds,
        close: () => devtools.send("Target.closeTarget", { targetId }),
    };
}

async function main(): Promise<void> {
    if (process.argv.includes("--help")) {
        console.log(USAGE);
        return;
    }
    if (typeof WebSocket === "undefined") throw new Error("The bench needs Node.js 22 or later, for its WebSocket client.");
    const seconds = Number(option("seconds") ?? 8);
    const only = option("only");
    const probe = readFileSync(fileURLToPath(new URL("./page-probe.js", import.meta.url)), "utf8");
    const query = option("query");
    const shots = option("shots");
    const maxRequests = Number(option("max-requests") ?? 5000);
    const scenarios = benchScenarios(option("url") ?? "http://localhost:5174").filter(
        (scenario) => !only || new RegExp(only).test(scenario.id),
    );
    const label = option("label") ?? execSync("git rev-parse --short HEAD").toString().trim();
    const profile = mkdtempSync(join(tmpdir(), "terrain-bench-"));
    const { devtools, stop } = await startBrowser(findBrowser(), 9400 + Math.floor(Math.random() * 400), profile);
    const results: IBenchResult[] = [];
    try {
        for (const scenario of scenarios) {
            const errors: string[] = [];
            const result: IBenchResult = { id: scenario.id, url: scenario.url, errors };
            const run = async <T>(pass: "performancePass" | "integrityPass"): Promise<T | undefined> => {
                const page = await openPage(devtools, `${scenario.url}${query ? `&${query}` : ""}`, probe, errors, maxRequests);
                try {
                    const engine = await page.evaluate<string | undefined>("window.__TERRAIN_BENCH__.engine()");
                    if (engine !== scenario.engine) {
                        result.skipped = `runs ${engine ?? "nothing"}`;
                        return undefined;
                    }
                    const path: IBenchPath = scenario.path;
                    const value = await page.evaluate<T>(`window.__TERRAIN_BENCH__.${pass}(${JSON.stringify(path)}, ${seconds})`);
                    if (pass === "integrityPass" && shots) {
                        mkdirSync(shots, { recursive: true });
                        await page.screenshot(join(shots, `${scenario.id.replace("/", "-")}.png`));
                    }
                    const urls = page.tileUrls();
                    return {
                        ...value,
                        tileRequests: page.tileRequests(),
                        distinctTileRequests: urls.length,
                        tileHosts: [...new Set(urls.map((address) => new URL(address).host))],
                        loadSeconds: page.loadSeconds,
                    };
                } finally {
                    await page.close();
                }
            };
            const performance = await run<IBenchPerformance>("performancePass");
            if (performance) result.performance = performance;
            if (!result.skipped) {
                const integrity = await run<IBenchIntegrity>("integrityPass");
                if (integrity) result.integrity = integrity;
            }
            results.push(result);
            console.error(
                `${scenario.id}: ${result.skipped ?? `${performance?.framesPerSecond} fps, ${result.integrity?.worstHoles} holes, ${result.integrity?.worstSharedEdgeMetres} m`}${errors.length ? `, ${errors.length} errors` : ""}`,
            );
        }
    } finally {
        stop();
        await sleep(300);
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    const report: IBenchReport = { label, date: new Date().toISOString(), seconds, results };
    const out = option("out");
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    const compare = option("compare");
    console.log(compare ? formatComparison(JSON.parse(readFileSync(compare, "utf8")) as IBenchReport, report) : formatReport(report));
    const failures = integrityFailures(report);
    if (failures.length) console.log(`\nIntegrity:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    for (const result of results) for (const error of result.errors.slice(0, 2)) console.log(`\n${result.id}: ${error}`);
}

main().then(
    () => process.exit(0),
    (error: unknown) => {
        console.error(error);
        process.exit(1);
    },
);
