import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket as Ws, type WebSocket, WebSocketServer } from "ws";
import {
    canonicalJsonKey,
    isRecord,
    MAX_CONTROL_MESSAGE_BYTES,
    type InstanceSnapshot,
    type JsonObject,
    type RendererCommandMap,
    type RendererCommandResult,
    type RendererCommandType,
    type RendererResultMessage,
    type RendererRuntimeConfig,
    type RendererStatus,
} from "../shared.ts";
import { GraphicMethodError, RendererDisconnectedError, RendererOfflineError, RendererTimeoutError } from "./errors.ts";
import type { LogStore } from "./logs.ts";

type LiveTargetState = {
    renderTarget: JsonObject;
    instances: Map<string, { graphicId: string; currentStep?: number }>;
};

type PendingCommand = {
    resolve: (value: RendererCommandResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

type Connection = {
    ws: WebSocket;
    isAlive: boolean;
    pending: Map<string, PendingCommand>;
};

type SendCommand = <T extends RendererCommandType>(
    rendererId: string,
    command: T,
    payload: RendererCommandMap[T]["payload"],
) => Promise<RendererCommandMap[T]["result"]>;

const COMMAND_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;

// Waits up to `ms` without holding the process open for it.
const waitUnref = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
    });

function isSnapshot(value: unknown): value is InstanceSnapshot {
    return (
        isRecord(value) &&
        typeof value.graphicInstanceId === "string" &&
        typeof value.graphicId === "string" &&
        isRecord(value.renderTarget) &&
        (value.currentStep === undefined || typeof value.currentStep === "number")
    );
}

function rawMessageText(raw: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(raw)) {
        return Buffer.concat(raw).toString("utf8");
    }
    const bytes = raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : raw;
    return bytes.toString("utf8");
}

function parseMessage(raw: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
    try {
        const message: unknown = JSON.parse(rawMessageText(raw));
        return isRecord(message) ? message : undefined;
    } catch {
        return undefined;
    }
}

function isSnapshotList(value: unknown): value is InstanceSnapshot[] {
    return Array.isArray(value) && value.every(isSnapshot);
}

function isRendererResultMessage(value: unknown): value is RendererResultMessage {
    if (!isRecord(value) || value.type !== "result" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
        return false;
    }
    return value.instances === undefined || isSnapshotList(value.instances);
}

function rejectPending(connection: Connection, error: Error): void {
    for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    connection.pending.clear();
}

export type RendererGateway = {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, rendererId: string) => void;
    isConnected: (rendererId: string) => boolean;
    getStatus: (rendererId: string) => RendererStatus;
    getLiveTarget: (rendererId: string, renderTarget: JsonObject) => LiveTargetState | undefined;
    isGraphicInUse: (graphicId: string) => boolean;
    sendCommand: SendCommand;
    sendConfig: (rendererId: string, config: RendererRuntimeConfig) => void;
    setConfigProvider: (fn: (rendererId: string) => RendererRuntimeConfig | undefined) => void;
    onChange: (fn: (rendererId: string) => void) => () => void;
    remove: (rendererId: string) => void;
    close: () => Promise<void>;
};

export function createRendererGateway(logs: LogStore): RendererGateway {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_MESSAGE_BYTES });
    const connections = new Map<string, Connection>();
    const liveStates = new Map<string, Map<string, LiveTargetState>>();
    const changeListeners = new Set<(rendererId: string) => void>();
    let configProvider: ((rendererId: string) => RendererRuntimeConfig | undefined) | undefined;

    const isConnected = (rendererId: string) => connections.get(rendererId)?.ws.readyState === Ws.OPEN;

    function sendConfig(rendererId: string, config: RendererRuntimeConfig): void {
        const conn = connections.get(rendererId);
        if (!conn || conn.ws.readyState !== Ws.OPEN) {
            return;
        }
        try {
            conn.ws.send(JSON.stringify({ type: "config", config: config }));
        } catch {
            return;
        }
    }

    const notify = (rendererId: string) => {
        for (const fn of changeListeners) {
            try {
                fn(rendererId);
            } catch (error) {
                console.error("Renderer gateway subscriber failed", error);
            }
        }
    };

    const applySnapshot = (rendererId: string, instances: InstanceSnapshot[]) => {
        const targets = new Map<string, LiveTargetState>();
        for (const instance of instances) {
            const key = canonicalJsonKey(instance.renderTarget);
            let target = targets.get(key);
            if (!target) {
                target = { renderTarget: instance.renderTarget, instances: new Map() };
                targets.set(key, target);
            }
            target.instances.set(instance.graphicInstanceId, {
                graphicId: instance.graphicId,
                currentStep: instance.currentStep,
            });
        }
        liveStates.set(rendererId, targets);
    };

    const handleResultMessage = (conn: Connection, rendererId: string, message: Record<string, unknown>) => {
        if (!isRendererResultMessage(message)) {
            return;
        }
        const pending = conn.pending.get(message.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        conn.pending.delete(message.id);
        if (message.instances) {
            applySnapshot(rendererId, message.instances);
        }
        if (message.ok) {
            pending.resolve(message.result);
        } else {
            const error = isRecord(message.error) ? message.error : undefined;
            const errorMessage = typeof error?.message === "string" ? error.message : "Unknown renderer error";
            pending.reject(error?.fromGraphic ? new GraphicMethodError(errorMessage) : new Error(errorMessage));
        }
        notify(rendererId);
    };

    const handleRendererMessage = (conn: Connection, rendererId: string, raw: Buffer | ArrayBuffer | Buffer[]) => {
        const message = parseMessage(raw);
        if (!message) {
            return;
        }
        if (message.type === "hello" && message.rendererId === rendererId && isSnapshotList(message.instances)) {
            applySnapshot(rendererId, message.instances);
            const config = configProvider?.(rendererId);
            if (config) {
                sendConfig(rendererId, config);
            }
            notify(rendererId);
        }
        if (message.type === "result") {
            handleResultMessage(conn, rendererId, message);
            return;
        }
        if (message.type === "ping" && typeof message.timestamp === "number" && conn.ws.readyState === Ws.OPEN) {
            try {
                conn.ws.send(JSON.stringify({ type: "pong", timestamp: message.timestamp }));
            } catch {
                return;
            }
        }
    };

    const registerConnection = (ws: WebSocket, rendererId: string) => {
        const conn: Connection = { ws: ws, isAlive: true, pending: new Map() };
        const previous = connections.get(rendererId);
        if (previous) {
            rejectPending(previous, new RendererDisconnectedError(rendererId));
            previous.ws.close(1012, "Replaced by a new renderer connection");
        }
        connections.set(rendererId, conn);
        logs.add({
            level: "info",
            category: "renderer",
            message: `Renderer "${rendererId}" connected`,
            rendererId: rendererId,
        });

        ws.on("pong", () => {
            conn.isAlive = true;
        });

        ws.on("message", (raw) => {
            if (connections.get(rendererId) !== conn) {
                return;
            }
            handleRendererMessage(conn, rendererId, raw);
        });

        ws.on("close", () => {
            rejectPending(conn, new RendererDisconnectedError(rendererId));
            if (connections.get(rendererId) !== conn) {
                return;
            }
            connections.delete(rendererId);
            liveStates.delete(rendererId);
            logs.add({
                level: "warn",
                category: "renderer",
                message: `Renderer "${rendererId}" disconnected`,
                rendererId: rendererId,
            });
            notify(rendererId);
        });
    };

    const heartbeat = setInterval(() => {
        for (const [rendererId, conn] of connections) {
            if (!conn.isAlive) {
                rejectPending(conn, new RendererDisconnectedError(rendererId));
                conn.ws.terminate();
                continue;
            }
            conn.isAlive = false;
            if (conn.ws.readyState === Ws.OPEN) {
                try {
                    conn.ws.ping();
                } catch {
                    rejectPending(conn, new RendererDisconnectedError(rendererId));
                    conn.ws.terminate();
                }
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    function sendCommand<T extends RendererCommandType>(
        rendererId: string,
        command: T,
        payload: RendererCommandMap[T]["payload"],
    ): Promise<RendererCommandMap[T]["result"]> {
        const conn = connections.get(rendererId);
        if (!conn || conn.ws.readyState !== Ws.OPEN) {
            return Promise.reject(new RendererOfflineError(rendererId));
        }

        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pending.delete(id);
                reject(new RendererTimeoutError(rendererId, command));
            }, COMMAND_TIMEOUT_MS);
            conn.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            const message = { type: "command" as const, id: id, command: command, payload: payload };
            const rejectSend = () => {
                const pending = conn.pending.get(id);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timer);
                conn.pending.delete(id);
                pending.reject(new RendererDisconnectedError(rendererId));
            };
            try {
                conn.ws.send(JSON.stringify(message), (error) => {
                    if (error) {
                        rejectSend();
                    }
                });
            } catch {
                rejectSend();
            }
        });
    }

    return {
        handleUpgrade: (req, socket, head, rendererId) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                registerConnection(ws, rendererId);
            });
        },

        isConnected: isConnected,

        getStatus: (rendererId) =>
            isConnected(rendererId)
                ? { status: "OK", message: "Renderer connected" }
                : { status: "ERROR", message: "Renderer output is not connected" },

        getLiveTarget: (rendererId, renderTarget) => liveStates.get(rendererId)?.get(canonicalJsonKey(renderTarget)),

        isGraphicInUse: (graphicId) =>
            Array.from(liveStates.values()).some((targets) =>
                Array.from(targets.values()).some((target) =>
                    Array.from(target.instances.values()).some((instance) => instance.graphicId === graphicId),
                ),
            ),

        sendCommand: sendCommand,

        sendConfig: sendConfig,

        setConfigProvider: (fn) => {
            configProvider = fn;
        },

        onChange: (fn) => {
            changeListeners.add(fn);
            return () => changeListeners.delete(fn);
        },

        remove: (rendererId) => {
            const connection = connections.get(rendererId);
            if (connection) {
                rejectPending(connection, new RendererDisconnectedError(rendererId));
                connections.delete(rendererId);
                connection.ws.close(1008, "Renderer deleted");
            }
            liveStates.delete(rendererId);
            notify(rendererId);
        },

        close: async () => {
            clearInterval(heartbeat);
            const connectionsToClose = Array.from(connections.entries());
            for (const [rendererId, connection] of connectionsToClose) {
                rejectPending(connection, new RendererDisconnectedError(rendererId));
                connection.ws.close(1001, "Server shutting down");
            }
            if (connectionsToClose.length) {
                // Let the close frames flush; the cap guards an unresponsive client.
                const closed = connectionsToClose.map(
                    ([, connection]) => new Promise<void>((resolve) => connection.ws.once("close", () => resolve())),
                );
                await Promise.race([Promise.all(closed), waitUnref(CLOSE_GRACE_MS)]);
            }
            for (const ws of wss.clients) {
                if (ws.readyState !== Ws.CLOSED) {
                    ws.terminate();
                }
            }
            connections.clear();
            liveStates.clear();
            changeListeners.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}
