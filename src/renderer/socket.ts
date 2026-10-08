import { isRecord, type RendererMessage, type RendererRuntimeConfig, type RendererStatus } from "../shared.ts";
import type { createGraphicsRuntime } from "./graphics.ts";

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000];

function isRuntimeConfig(value: unknown): value is RendererRuntimeConfig {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        isRecord(value.resolution) &&
        typeof value.resolution.width === "number" &&
        typeof value.resolution.height === "number" &&
        typeof value.frameRate === "number" &&
        typeof value.accessToPublicInternet === "boolean" &&
        Array.isArray(value.layers) &&
        value.layers.every((layer) => isRecord(layer) && typeof layer.id === "string" && typeof layer.name === "string")
    );
}

function isRendererMessage(value: unknown): value is RendererMessage {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }
    if (value.type === "config") {
        return isRuntimeConfig(value.config);
    }
    if (value.type === "ping") {
        return true;
    }
    if (value.type === "command") {
        return (
            typeof value.id === "string" &&
            (value.command === "load" ||
                value.command === "updateAction" ||
                value.command === "playAction" ||
                value.command === "stopAction" ||
                value.command === "clear" ||
                value.command === "graphicCustomAction" ||
                value.command === "rendererCustomAction")
        );
    }
    return false;
}

function sendMessage(message: RendererMessage, target: WebSocket) {
    if (target.readyState === WebSocket.OPEN) {
        try {
            target.send(JSON.stringify(message));
        } catch {
            return;
        }
    }
}

export function connectRendererSocket(rendererId: string, runtime: ReturnType<typeof createGraphicsRuntime>) {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let status: RendererStatus = { status: "OK", message: "Renderer page ready" };
    let configUpdate = Promise.resolve();

    const scheduleReconnect = (closedSocket: WebSocket) => {
        if (stopped || socket !== closedSocket || reconnectTimer !== undefined) {
            return;
        }
        const base = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 5000;
        attempt += 1;
        reconnectTimer = setTimeout(
            () => {
                reconnectTimer = undefined;
                connect();
            },
            base + Math.random() * 200,
        );
    };

    function connect() {
        if (stopped) {
            return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const nextSocket = new WebSocket(`${protocol}//${location.host}/render/${rendererId}/ws`);
        socket = nextSocket;

        nextSocket.addEventListener("open", () => {
            if (socket !== nextSocket) {
                return;
            }
            attempt = 0;
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            sendMessage(
                {
                    type: "hello",
                    rendererId: rendererId,
                    loadedInstanceIds: runtime.getSnapshot().map((instance) => instance.load.graphicInstanceId),
                    onAir: runtime.getRecoverySnapshot(),
                },
                nextSocket,
            );
            sendMessage({ type: "status", status: status }, nextSocket);
        });

        nextSocket.addEventListener("message", (event: MessageEvent<string>) => handleMessage(event, nextSocket));

        nextSocket.addEventListener("close", () => scheduleReconnect(nextSocket));
        nextSocket.addEventListener("error", () => nextSocket.close());
    }

    function handleMessage(event: MessageEvent<string>, source: WebSocket) {
        if (socket !== source) {
            return;
        }
        let message: RendererMessage;
        try {
            const parsed: unknown = JSON.parse(event.data);
            if (!isRendererMessage(parsed)) {
                return;
            }
            message = parsed;
        } catch {
            return;
        }

        if (message.type === "config") {
            configUpdate = configUpdate
                .then(() => runtime.applyConfig(message.config))
                .catch((error: unknown) => {
                    reportStatus({ status: "ERROR", message: error instanceof Error ? error.message : String(error) });
                });
            return;
        }
        if (message.type === "ping") {
            sendMessage({ type: "pong" }, source);
            return;
        }
        if (message.type !== "command") {
            return;
        }

        void executeCommand(message, source);
    }

    async function executeCommand(message: Extract<RendererMessage, { type: "command" }>, source: WebSocket) {
        try {
            await configUpdate;
            const result = await runtime.handleCommand(message.command, message.payload);
            sendMessage(
                { type: "result", id: message.id, ok: true, result: result, instances: runtime.getSnapshot() },
                source,
            );
        } catch (error) {
            sendMessage(
                {
                    type: "result",
                    id: message.id,
                    ok: false,
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                        fromGraphic: error instanceof Error && error.name === "GraphicError",
                    },
                    instances: runtime.getSnapshot(),
                },
                source,
            );
        }
    }

    connect();

    function reportStatus(next: RendererStatus) {
        status = next;
        if (socket) {
            sendMessage({ type: "status", status: status }, socket);
        }
    }

    return {
        reportStatus: reportStatus,
        stop: () => {
            stopped = true;
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            socket?.close();
        },
    };
}
