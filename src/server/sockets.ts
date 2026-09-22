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
    order: number;
    ws: WebSocket;
    isAlive: boolean;
    pending: Map<string, PendingCommand>;
    instances: Map<string, InstanceSnapshot>;
    loadingInstances: Map<string, Promise<RendererCommandResult>>;
};

type LoadPayload = RendererCommandMap["load"]["payload"];

type RendererConnections = {
    primary: Connection;
    connections: Set<Connection>;
};

type SendCommand = <T extends RendererCommandType>(
    rendererId: string,
    command: T,
    payload: RendererCommandMap[T]["payload"],
) => Promise<RendererCommandMap[T]["result"]>;

const INSTANCE_COMMANDS = new Set<RendererCommandType>([
    "updateAction",
    "playAction",
    "stopAction",
    "graphicCustomAction",
]);

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

function instanceGraphicId(value: unknown): string | undefined {
    return isRecord(value) && typeof value.graphicInstanceId === "string" ? value.graphicInstanceId : undefined;
}

function isLoadPayload(value: unknown): value is LoadPayload {
    return (
        isRecord(value) &&
        typeof value.graphicInstanceId === "string" &&
        typeof value.graphicId === "string" &&
        typeof value.graphicRevision === "string" &&
        typeof value.mainUrl === "string" &&
        isRecord(value.renderTarget)
    );
}

function clearedInstanceIds(value: unknown): string[] {
    if (!isRecord(value) || !Array.isArray(value.graphicInstances)) {
        return [];
    }
    return value.graphicInstances.flatMap((instance) =>
        isRecord(instance) && typeof instance.graphicInstanceId === "string" ? [instance.graphicInstanceId] : [],
    );
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
    connection.loadingInstances.clear();
}

function applySnapshot(connection: Connection, instances: InstanceSnapshot[]): void {
    connection.instances = new Map(instances.map((instance) => [instance.graphicInstanceId, instance]));
}

const choosePrimary = (connections: Set<Connection>): Connection | undefined =>
    [...connections]
        .filter((connection) => connection.ws.readyState === Ws.OPEN)
        .toSorted((a, b) => b.instances.size - a.instances.size || a.order - b.order)[0];

function sendConfigToConnection(connection: Connection, config: RendererRuntimeConfig): void {
    if (connection.ws.readyState !== Ws.OPEN) {
        return;
    }
    try {
        connection.ws.send(JSON.stringify({ type: "config", config: config }));
    } catch {
        // The close handler cleans up.
    }
}

function sendNow<T extends RendererCommandType>(
    connection: Connection,
    rendererId: string,
    command: T,
    payload: RendererCommandMap[T]["payload"],
): Promise<RendererCommandMap[T]["result"]> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            connection.pending.delete(id);
            reject(new RendererTimeoutError(rendererId, command));
        }, COMMAND_TIMEOUT_MS);
        connection.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        const message = { type: "command" as const, id: id, command: command, payload: payload };
        const rejectSend = () => {
            const pending = connection.pending.get(id);
            if (!pending) {
                return;
            }
            clearTimeout(pending.timer);
            connection.pending.delete(id);
            pending.reject(new RendererDisconnectedError(rendererId));
        };
        try {
            connection.ws.send(JSON.stringify(message), (error) => {
                if (error) {
                    rejectSend();
                }
            });
        } catch {
            rejectSend();
        }
    });
}

/** Defers instance actions until this connection's in-flight load resolves. */
function sendToConnection<T extends RendererCommandType>(
    connection: Connection,
    rendererId: string,
    command: T,
    payload: RendererCommandMap[T]["payload"],
): Promise<RendererCommandMap[T]["result"]> {
    const graphicInstanceId = instanceGraphicId(payload);

    if (command !== "load" && INSTANCE_COMMANDS.has(command) && graphicInstanceId) {
        const loading = connection.loadingInstances.get(graphicInstanceId);
        if (loading) {
            return loading.then(() => sendNow(connection, rendererId, command, payload));
        }
    }

    const request = sendNow(connection, rendererId, command, payload);

    if (command === "load" && graphicInstanceId) {
        connection.loadingInstances.set(graphicInstanceId, request);

        const cleanup = () => {
            if (connection.loadingInstances.get(graphicInstanceId) === request) {
                connection.loadingInstances.delete(graphicInstanceId);
            }
        };
        void request.then(cleanup, cleanup);
    }

    return request;
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
    const rendererConnections = new Map<string, RendererConnections>();
    const rendererLoads = new Map<string, Map<string, LoadPayload>>();
    const changeListeners = new Set<(rendererId: string) => void>();
    let configProvider: ((rendererId: string) => RendererRuntimeConfig | undefined) | undefined;
    let connectionOrder = 0;

    const openConnections = (rendererId: string): Connection[] =>
        [...(rendererConnections.get(rendererId)?.connections ?? [])].filter(
            (connection) => connection.ws.readyState === Ws.OPEN,
        );

    const getPrimary = (rendererId: string): Connection | undefined => {
        const group = rendererConnections.get(rendererId);
        return group?.primary.ws.readyState === Ws.OPEN ? group.primary : undefined;
    };

    const notify = (rendererId: string) => {
        for (const fn of changeListeners) {
            try {
                fn(rendererId);
            } catch (error) {
                console.error("Renderer gateway subscriber failed", error);
            }
        }
    };

    const sendConfig = (rendererId: string, config: RendererRuntimeConfig): void => {
        for (const connection of openConnections(rendererId)) {
            sendConfigToConnection(connection, config);
        }
    };

    // Re-issues the original load so reloaded or newly opened outputs show current graphics.
    const replayLoads = (connection: Connection, rendererId: string): void => {
        const loads = rendererLoads.get(rendererId);
        if (!loads) {
            return;
        }
        for (const [graphicInstanceId, payload] of loads) {
            if (connection.instances.has(graphicInstanceId) || connection.loadingInstances.has(graphicInstanceId)) {
                continue;
            }
            void sendToConnection(connection, rendererId, "load", payload).catch((error) => {
                logs.add({
                    level: "warn",
                    category: "renderer",
                    message: `Renderer "${rendererId}" failed to restore graphic instance "${graphicInstanceId}": ${error instanceof Error ? error.message : String(error)}`,
                    rendererId: rendererId,
                });
            });
        }
    };

    const handleResultMessage = (connection: Connection, rendererId: string, message: Record<string, unknown>) => {
        if (!isRendererResultMessage(message)) {
            return;
        }
        const pending = connection.pending.get(message.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        connection.pending.delete(message.id);
        if (message.instances) {
            applySnapshot(connection, message.instances);
        }
        if (message.ok) {
            pending.resolve(message.result);
        } else {
            const error = isRecord(message.error) ? message.error : undefined;
            const errorMessage = typeof error?.message === "string" ? error.message : "Unknown renderer error";
            pending.reject(error?.fromGraphic ? new GraphicMethodError(errorMessage) : new Error(errorMessage));
        }
        if (getPrimary(rendererId) === connection) {
            notify(rendererId);
        }
    };

    const handleRendererMessage = (
        connection: Connection,
        rendererId: string,
        raw: Buffer | ArrayBuffer | Buffer[],
    ) => {
        const message = parseMessage(raw);
        if (!message) {
            return;
        }
        if (message.type === "hello" && message.rendererId === rendererId && isSnapshotList(message.instances)) {
            applySnapshot(connection, message.instances);
            const config = configProvider?.(rendererId);
            if (config) {
                sendConfigToConnection(connection, config);
            }
            replayLoads(connection, rendererId);
            if (getPrimary(rendererId) === connection) {
                notify(rendererId);
            }
        }
        if (message.type === "result") {
            handleResultMessage(connection, rendererId, message);
            return;
        }
    };

    const registerConnection = (ws: WebSocket, rendererId: string) => {
        const connection: Connection = {
            order: ++connectionOrder,
            ws: ws,
            isAlive: true,
            pending: new Map(),
            instances: new Map(),
            loadingInstances: new Map(),
        };

        const current = rendererConnections.get(rendererId);
        if (current) {
            current.connections.add(connection);
        } else {
            rendererConnections.set(rendererId, { primary: connection, connections: new Set([connection]) });
        }

        logs.add({
            level: "info",
            category: "renderer",
            message: `Renderer "${rendererId}" output connected (${openConnections(rendererId).length} active)`,
            rendererId: rendererId,
        });

        notify(rendererId);

        ws.on("pong", () => {
            connection.isAlive = true;
        });

        ws.on("message", (raw) => {
            handleRendererMessage(connection, rendererId, raw);
        });

        ws.on("close", () => {
            rejectPending(connection, new RendererDisconnectedError(rendererId));

            const group = rendererConnections.get(rendererId);
            if (!group?.connections.delete(connection)) {
                return;
            }
            if (group.connections.size === 0) {
                rendererConnections.delete(rendererId);
            } else if (group.primary === connection) {
                const next = choosePrimary(group.connections);
                if (next) {
                    group.primary = next;
                }
            }

            logs.add({
                level: "warn",
                category: "renderer",
                message: `Renderer "${rendererId}" output disconnected (${openConnections(rendererId).length} active)`,
                rendererId: rendererId,
            });
            notify(rendererId);
        });
    };

    const heartbeat = setInterval(() => {
        for (const [rendererId, group] of rendererConnections) {
            for (const connection of group.connections) {
                if (!connection.isAlive) {
                    rejectPending(connection, new RendererDisconnectedError(rendererId));
                    connection.ws.terminate();
                    continue;
                }
                connection.isAlive = false;
                if (connection.ws.readyState === Ws.OPEN) {
                    try {
                        connection.ws.ping();
                    } catch {
                        rejectPending(connection, new RendererDisconnectedError(rendererId));
                        connection.ws.terminate();
                    }
                }
            }
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    function commandTargets<T extends RendererCommandType>(
        rendererId: string,
        command: T,
        payload: RendererCommandMap[T]["payload"],
    ): Connection[] {
        const connections = openConnections(rendererId);
        if (!INSTANCE_COMMANDS.has(command)) {
            return connections;
        }
        const graphicInstanceId = instanceGraphicId(payload);
        return typeof graphicInstanceId === "string"
            ? connections.filter(
                  (connection) =>
                      connection.instances.has(graphicInstanceId) || connection.loadingInstances.has(graphicInstanceId),
              )
            : connections;
    }

    function sendCommand<T extends RendererCommandType>(
        rendererId: string,
        command: T,
        payload: RendererCommandMap[T]["payload"],
    ): Promise<RendererCommandMap[T]["result"]> {
        const targets = commandTargets(rendererId, command, payload);
        const canonical = getPrimary(rendererId);
        const primary = canonical && targets.includes(canonical) ? canonical : targets[0];
        if (!primary) {
            return Promise.reject(new RendererOfflineError(rendererId));
        }

        if (command === "load" && isLoadPayload(payload)) {
            const loads = rendererLoads.get(rendererId) ?? new Map<string, LoadPayload>();
            loads.set(payload.graphicInstanceId, payload);
            rendererLoads.set(rendererId, loads);
        }

        for (const connection of targets) {
            if (connection === primary) {
                continue;
            }
            void sendToConnection(connection, rendererId, command, payload).catch((error) => {
                logs.add({
                    level: "warn",
                    category: "renderer",
                    message: `Renderer "${rendererId}" replica failed "${command}": ${error instanceof Error ? error.message : String(error)}`,
                    rendererId: rendererId,
                });
            });
        }

        const result = sendToConnection(primary, rendererId, command, payload);

        if (command === "clear") {
            const loads = rendererLoads.get(rendererId);
            void result
                .then((clearResult) => {
                    for (const graphicInstanceId of clearedInstanceIds(clearResult)) {
                        loads?.delete(graphicInstanceId);
                    }
                    return undefined;
                })
                .catch(() => {});
        }

        return result;
    }

    return {
        handleUpgrade: (req, socket, head, rendererId) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                registerConnection(ws, rendererId);
            });
        },

        isConnected: (rendererId) => openConnections(rendererId).length > 0,

        getStatus: (rendererId) => {
            const count = openConnections(rendererId).length;
            return count
                ? {
                      status: "OK",
                      message: count === 1 ? "Renderer connected" : `${count} renderer outputs connected`,
                  }
                : { status: "ERROR", message: "Renderer output is not connected" };
        },

        getLiveTarget: (rendererId, renderTarget) => {
            const primary = getPrimary(rendererId);
            if (!primary) {
                return undefined;
            }

            const key = canonicalJsonKey(renderTarget);
            const instances = new Map<string, { graphicId: string; currentStep?: number }>();
            for (const instance of primary.instances.values()) {
                if (canonicalJsonKey(instance.renderTarget) === key) {
                    instances.set(instance.graphicInstanceId, {
                        graphicId: instance.graphicId,
                        currentStep: instance.currentStep,
                    });
                }
            }

            return instances.size ? { renderTarget: renderTarget, instances: instances } : undefined;
        },

        isGraphicInUse: (graphicId) =>
            [...rendererConnections.values()].some((group) =>
                [...group.connections].some((connection) =>
                    [...connection.instances.values()].some((instance) => instance.graphicId === graphicId),
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
            rendererLoads.delete(rendererId);
            const group = rendererConnections.get(rendererId);
            if (group) {
                rendererConnections.delete(rendererId);
                for (const connection of group.connections) {
                    rejectPending(connection, new RendererDisconnectedError(rendererId));
                    connection.ws.close(1008, "Renderer deleted");
                }
            }
            notify(rendererId);
        },

        close: async () => {
            clearInterval(heartbeat);
            const closed: Array<Promise<void>> = [];
            for (const [rendererId, group] of rendererConnections) {
                for (const connection of group.connections) {
                    rejectPending(connection, new RendererDisconnectedError(rendererId));
                    connection.ws.close(1001, "Server shutting down");
                    closed.push(new Promise((resolve) => connection.ws.once("close", () => resolve())));
                }
            }
            if (closed.length) {
                // Let the close frames flush; the cap guards an unresponsive client.
                await Promise.race([Promise.all(closed), waitUnref(CLOSE_GRACE_MS)]);
            }
            for (const ws of wss.clients) {
                if (ws.readyState !== Ws.CLOSED) {
                    ws.terminate();
                }
            }
            rendererConnections.clear();
            rendererLoads.clear();
            changeListeners.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}
