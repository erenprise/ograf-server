import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { isSea } from "node:sea";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAppAssets } from "./assets.ts";
import { checkApiAccess, checkRendererAccess, createAuthStore } from "./auth.ts";
import { createServerEvents } from "./events.ts";
import { createGraphicsStore } from "./graphics.ts";
import { createLiveUpdateGateway } from "./live-updates.ts";
import { createLogStore } from "./logs.ts";
import { createRendererService } from "./renderers.ts";
import { createRendererGateway } from "./sockets.ts";
import { createStateStore } from "./state.ts";

const RENDERER_WS = /^\/render\/([^/]+)\/ws$/;
const LIVE_UPDATE_WS = /^\/api\/ograf\/v1\/renderers\/([^/]+)\/target\/graphicInstance\/updateAction$/;

function rejectUpgrade(socket: Duplex, status: 401 | 404): void {
    const text = status === 401 ? "Unauthorized" : "Not Found";
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

// Keep `process` global: a `node:process` import would shadow the build-time
// `process.env.NODE_ENV` replacement and pull Vite into the production bundle.
const isDev = process.env.NODE_ENV !== "production";

function portFromArgs(argv: string[]): number | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }
        if (arg === "--port") {
            const value = argv[index + 1];
            if (value === undefined) {
                throw new Error("--port requires a value");
            }
            return Number(value);
        }
        if (arg.startsWith("--port=")) {
            return Number(arg.slice("--port=".length));
        }
    }
    return undefined;
}

const port = portFromArgs(process.argv) ?? Number(process.env.PORT ?? 8080);
const root = process.cwd();
const dataDir = path.join(isSea() ? path.dirname(process.execPath) : root, "ograf-server");
const uploadTempDir = path.join(dataDir, "uploads");
const graphicsDir = path.join(dataDir, "graphics");
const stateFile = path.join(dataDir, "state.json");
const appAssets = createAppAssets(root);
const SHUTDOWN_DRAIN_MS = 500;

// Waits up to `ms` without holding the process open for it.
const waitUnref = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
    });

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Port must be an integer from 0 to 65535 (set with --port or the PORT environment variable)");
}

async function main() {
    await mkdir(dataDir, { recursive: true });
    await rm(uploadTempDir, { recursive: true, force: true });
    await mkdir(uploadTempDir, { recursive: true });
    const state = await createStateStore(stateFile);
    const logs = createLogStore();
    const auth = createAuthStore(state);
    const gateway = createRendererGateway(logs);

    const events = createServerEvents();
    const unsubscribeLogs = logs.subscribe((entry) => events.emit({ type: "log", entry: entry }));
    const unsubscribeGateway = gateway.onChange((rendererId) =>
        events.emit({ type: "renderers.changed", rendererId: rendererId }),
    );

    const graphics = createGraphicsStore({
        root: graphicsDir,
        state: state,
        logs: logs,
        isGraphicInUse: gateway.isGraphicInUse,
    });
    await graphics.cleanupStaging();
    await graphics.scan();

    const renderers = createRendererService(state, gateway, graphics, logs);
    const liveUpdates = createLiveUpdateGateway(renderers, gateway, logs);

    let vite: import("vite").ViteDevServer | undefined;
    let honoListener: ReturnType<typeof getRequestListener>;
    const server = createHttpServer((req, res) =>
        vite ? vite.middlewares(req, res, () => honoListener(req, res)) : void honoListener(req, res),
    );

    if (isDev) {
        const { createServer: createViteServer } = await import("vite");
        vite = await createViteServer({
            root: root,
            server: { middlewareMode: { server: server }, ws: { server: server } },
            appType: "custom",
        });
    }

    const renderHtml = async (entry: "admin" | "renderer", url: string): Promise<string> => {
        const file = entry === "admin" ? "index.html" : "renderer.html";
        if (vite) {
            const raw = await readFile(path.join(root, file), "utf-8");
            return vite.transformIndexHtml(url, raw);
        }
        return appAssets.readText(file);
    };

    const app = createApp({
        graphics: graphics,
        renderers: renderers,
        gateway: gateway,
        auth: auth,
        logs: logs,
        uploadTempDir: uploadTempDir,
        events: events,
        renderHtml: renderHtml,
        appAssets: appAssets,
    });

    honoListener = getRequestListener(app.fetch);

    server.on("upgrade", (req, socket, head) => {
        let pathname: string;
        try {
            pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
            socket.destroy();
            return;
        }

        const rendererId = pathname.match(RENDERER_WS)?.[1];
        if (rendererId) {
            if (!renderers.getConfig(rendererId)) {
                rejectUpgrade(socket, 404);
                return;
            }
            if (!checkRendererAccess(req.headers, rendererId, auth)) {
                rejectUpgrade(socket, 401);
                return;
            }
            gateway.handleUpgrade(req, socket, head, rendererId);
            return;
        }

        const liveRendererId = pathname.match(LIVE_UPDATE_WS)?.[1];
        if (liveRendererId) {
            if (!renderers.getConfig(liveRendererId)) {
                rejectUpgrade(socket, 404);
                return;
            }
            if (!checkApiAccess(req.headers, auth)) {
                rejectUpgrade(socket, 401);
                return;
            }
            liveUpdates.handleUpgrade(req, socket, head, liveRendererId);
            return;
        }

        if (!vite) {
            socket.destroy();
        }
    });

    let activeSweep: Promise<void> | undefined;
    const startSweep = () => {
        if (activeSweep) {
            return;
        }
        const sweep = graphics.runTombstoneSweep().catch((error) => {
            logs.add({
                level: "error",
                category: "storage",
                message: `Graphic cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        });
        activeSweep = sweep;
        void sweep.then(() => {
            if (activeSweep === sweep) {
                activeSweep = undefined;
            }
            return undefined;
        });
    };
    const sweepInterval = setInterval(startSweep, 60_000).unref();

    server.listen(port, () => {
        const address = server.address();
        logs.add({
            level: "info",
            category: "system",
            message: `OGraf Server listening on http://localhost:${typeof address === "object" && address ? address.port : port} (${isDev ? "development" : "production"})`,
        });
    });

    let shuttingDown = false;
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
        if (shuttingDown) {
            logs.add({
                level: "warn",
                category: "system",
                message: `Received ${signal} while shutting down — forcing exit`,
            });
            process.exit(signal === "SIGINT" ? 130 : 143);
        }
        shuttingDown = true;
        logs.add({ level: "info", category: "system", message: `Shutting down (${signal})` });
        clearInterval(sweepInterval);
        const serverClosed = new Promise<void>((resolve, reject) => {
            if (!server.listening) {
                resolve();
                return;
            }
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections();
        });
        try {
            await activeSweep;
            await graphics.flush();
            await state.flush();
            unsubscribeLogs();
            unsubscribeGateway();
            events.clear();
            await liveUpdates.close();
            await gateway.close();
            await vite?.close();
            await Promise.race([serverClosed, waitUnref(SHUTDOWN_DRAIN_MS)]);
            // Never gate this on `server.listening` (false once close() ran);
            // open SSE connections would keep the process alive forever.
            server.closeAllConnections();
            await serverClosed;
            logs.add({ level: "info", category: "system", message: "Shutdown complete" });
        } catch (error) {
            console.error("Graceful shutdown failed", error);
            server.closeAllConnections();
            process.exit(1);
        }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
