import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket as Ws, type WebSocket, WebSocketServer } from "ws";
import { validateGddValue } from "@streamshapers/ograf-validator-core";
import {
    canonicalJsonKey,
    commandSucceeded,
    isRecord,
    isInstanceSnapshot,
    isLoadPayload,
    isRendererStatus,
    matchesGraphicFilter,
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
import {
    GraphicMethodError,
    InvalidRequestError,
    RendererDisconnectedError,
    RendererOfflineError,
    RendererTimeoutError,
} from "./errors.ts";
import type { LogStore } from "./logs.ts";

type PendingCommand = {
    resolve: (value: RendererCommandResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

type Connection = {
    ws: WebSocket;
    isAlive: boolean;
    pending: Map<string, PendingCommand>;
    instances: Map<string, InstanceSnapshot>;
    loadingInstances: Map<string, Promise<RendererCommandResult>>;
    ready: boolean;
    status: RendererStatus;
    failure?: string;
    recovery?: Promise<void>;
    restoringInstanceId?: string;
};

const INSTANCE_COMMANDS = new Set<RendererCommandType>([
    "updateAction",
    "playAction",
    "stopAction",
    "graphicCustomAction",
]);

const COMMAND_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const CLOSE_GRACE_MS = 1_000;

// Waits up to `ms` without holding the process open for it.
const waitUnref = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
    });

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
    return Array.isArray(value) && value.every(isInstanceSnapshot);
}

function instanceGraphicId(value: unknown): string | undefined {
    return isRecord(value) && typeof value.graphicInstanceId === "string" ? value.graphicInstanceId : undefined;
}

function isRendererResultMessage(value: unknown): value is RendererResultMessage {
    if (!isRecord(value) || value.type !== "result" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
        return false;
    }
    const result = value.result;
    if (result !== undefined && !isCommandResult(result)) {
        return false;
    }
    return value.instances === undefined || isSnapshotList(value.instances);
}

function isCommandResult(value: unknown): value is Exclude<RendererCommandResult, undefined> {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.statusCode === "number") {
        return (
            Number.isFinite(value.statusCode) &&
            (value.statusMessage === undefined || typeof value.statusMessage === "string") &&
            (value.currentStep === undefined ||
                (typeof value.currentStep === "number" && Number.isSafeInteger(value.currentStep)))
        );
    }
    return (
        Array.isArray(value.graphicInstances) &&
        value.graphicInstances.every(
            (instance) =>
                isRecord(instance) && typeof instance.graphicInstanceId === "string" && isRecord(instance.renderTarget),
        )
    );
}

function rejectPending(connection: Connection, error: Error): void {
    for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    connection.pending.clear();
    connection.loadingInstances.clear();
}

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

function commandTimeout(connection: Connection, command: RendererCommandType, payload: unknown): number {
    if (!["updateAction", "playAction", "stopAction"].includes(command) || !isRecord(payload)) {
        return COMMAND_TIMEOUT_MS;
    }
    const base = 2_000;
    if (payload.skipAnimation === true) {
        return base;
    }
    const id = instanceGraphicId(payload);
    const instance = id ? connection.instances.get(id) : undefined;
    const durations = instance?.load.manifest.actionDurations;
    const action = Array.isArray(durations)
        ? durations.find((value) => isRecord(value) && value.type === command)
        : undefined;
    if (!isRecord(action)) {
        return COMMAND_TIMEOUT_MS;
    }
    let duration = action.duration;
    if (command === "playAction" && Array.isArray(action.steps)) {
        const step =
            typeof payload.goto === "number"
                ? payload.goto
                : (instance?.currentStep ?? -1) + (typeof payload.delta === "number" ? payload.delta : 1);
        const specific =
            action.steps.find((value) => isRecord(value) && value.step === step) ??
            action.steps.find((value) => isRecord(value) && value.step === undefined);
        if (isRecord(specific)) {
            duration = specific.duration;
        }
    }
    return typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0
        ? Math.min(2_147_483_647, base + duration)
        : COMMAND_TIMEOUT_MS;
}

function sendNow<T extends RendererCommandType>(
    connection: Connection,
    rendererId: string,
    command: T,
    payload: RendererCommandMap[T]["payload"],
): Promise<RendererCommandMap[T]["result"]> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => {
                connection.pending.delete(id);
                reject(new RendererTimeoutError(rendererId, command));
            },
            commandTimeout(connection, command, payload),
        );
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

function checkRecoveryResult(result: RendererCommandResult): void {
    if (result && "statusCode" in result && !commandSucceeded(result)) {
        throw new GraphicMethodError(result.statusMessage || "Graphic recovery failed");
    }
}

async function restoreInstance(connection: Connection, rendererId: string, instance: InstanceSnapshot): Promise<void> {
    const { graphicInstanceId } = instance.load;
    const current = connection.instances.get(graphicInstanceId);
    const reload = !current || JSON.stringify(current.load) !== JSON.stringify(instance.load);
    if (reload) {
        checkRecoveryResult(await sendToConnection(connection, rendererId, "load", instance.load));
    }
    if (
        instance.latestUpdate &&
        (reload || JSON.stringify(current?.latestUpdate?.data) !== JSON.stringify(instance.latestUpdate.data))
    ) {
        checkRecoveryResult(
            await sendToConnection(connection, rendererId, "updateAction", {
                graphicInstanceId: graphicInstanceId,
                data: instance.latestUpdate.data,
                skipAnimation: true,
            }),
        );
    }
    if (instance.playing && (reload || !current?.playing || current.currentStep !== instance.currentStep)) {
        if (instance.currentStep === undefined) {
            throw new Error("Playing graphic has no saved step");
        }
        checkRecoveryResult(
            await sendToConnection(connection, rendererId, "playAction", {
                graphicInstanceId: graphicInstanceId,
                goto: instance.currentStep,
                skipAnimation: true,
            }),
        );
    } else if (!instance.playing && !reload && current?.playing) {
        checkRecoveryResult(
            await sendToConnection(connection, rendererId, "stopAction", {
                graphicInstanceId: graphicInstanceId,
                skipAnimation: true,
            }),
        );
    }
}

export type RendererGateway = {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, rendererId: string) => void;
    isConnected: (rendererId: string) => boolean;
    getStatus: (rendererId: string) => RendererStatus;
    getLiveTarget: (
        rendererId: string,
        renderTarget: JsonObject,
    ) => Map<string, { graphicId: string; currentStep?: number }> | undefined;
    isGraphicInUse: (graphicId: string) => boolean;
    sendCommand: <T extends RendererCommandType>(
        rendererId: string,
        command: T,
        payload: RendererCommandMap[T]["payload"],
    ) => Promise<RendererCommandMap[T]["result"]>;
    sendConfig: (rendererId: string, config: RendererRuntimeConfig) => void;
    setConfigProvider: (fn: (rendererId: string) => RendererRuntimeConfig | undefined) => void;
    onChange: (fn: (rendererId: string) => void) => () => void;
    remove: (rendererId: string) => void;
    close: () => Promise<void>;
};

export function createRendererGateway(logs: LogStore): RendererGateway {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_MESSAGE_BYTES });
    const rendererConnections = new Map<string, Set<Connection>>();
    const rendererState = new Map<string, Map<string, InstanceSnapshot>>();
    const recoveryFailures = new Map<string, Map<string, string>>();
    const unsupportedSchemas = new Set<string>();
    const changeListeners = new Set<(rendererId: string) => void>();
    let configProvider: ((rendererId: string) => RendererRuntimeConfig | undefined) | undefined;

    const openConnections = (rendererId: string): Connection[] =>
        [...(rendererConnections.get(rendererId) ?? [])].filter((connection) => connection.ws.readyState === Ws.OPEN);

    const getPrimary = (rendererId: string) => openConnections(rendererId).find((connection) => connection.ready);

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
        const layers = new Set(config.layers.map((layer) => layer.id));
        for (const [id, instance] of rendererState.get(rendererId) ?? []) {
            if (typeof instance.load.renderTarget.layer !== "string" || !layers.has(instance.load.renderTarget.layer)) {
                rendererState.get(rendererId)?.delete(id);
                recoveryFailures.get(rendererId)?.delete(id);
            }
        }
        for (const connection of openConnections(rendererId)) {
            sendConfigToConnection(connection, config);
        }
    };

    const recordRecoveryFailure = (rendererId: string, id: string, message: string) => {
        const failures = recoveryFailures.get(rendererId) ?? new Map<string, string>();
        if (failures.has(id)) {
            return;
        }
        failures.set(id, message);
        recoveryFailures.set(rendererId, failures);
        logs.add({
            level: "error",
            category: "renderer",
            message: `Skipped graphic instance "${id}" after recovery failed: ${message}`,
            rendererId: rendererId,
            graphicInstanceId: id,
        });
    };

    const replayState = async (connection: Connection, rendererId: string): Promise<void> => {
        const state = rendererState.get(rendererId) ?? new Map<string, InstanceSnapshot>();
        const stale = [...connection.instances.keys()].filter((id) => !state.has(id));
        if (stale.length) {
            await sendToConnection(connection, rendererId, "clear", {
                filters: stale.map((id) => ({ graphicInstanceId: id })),
            });
        }
        for (const [id, instance] of state) {
            if (connection.ws.readyState !== Ws.OPEN) {
                break;
            }
            if (recoveryFailures.get(rendererId)?.has(id)) {
                continue;
            }
            connection.restoringInstanceId = id;
            try {
                // Recovery must finish one graphic before the next starts.
                // oxlint-disable-next-line no-await-in-loop
                await restoreInstance(connection, rendererId, instance);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                connection.failure = message;
                if (getPrimary(rendererId) === connection) {
                    recordRecoveryFailure(rendererId, id, message);
                }
            } finally {
                connection.restoringInstanceId = undefined;
            }
        }
    };

    const handleResultMessage = (connection: Connection, message: Record<string, unknown>) => {
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
            connection.instances = new Map(
                message.instances.map((instance) => [instance.load.graphicInstanceId, instance]),
            );
        }
        if (message.ok) {
            const result = message.result;
            connection.failure = undefined;
            if (result && "statusCode" in result && !commandSucceeded(result)) {
                connection.failure = result.statusMessage || "Graphic command failed";
            }
            pending.resolve(message.result);
        } else {
            const error = isRecord(message.error) ? message.error : undefined;
            const errorMessage = typeof error?.message === "string" ? error.message : "Unknown renderer error";
            connection.failure = errorMessage;
            pending.reject(error?.fromGraphic ? new GraphicMethodError(errorMessage) : new Error(errorMessage));
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
        if (message.type === "pong") {
            connection.isAlive = true;
            return;
        }
        if (message.type === "status" && isRendererStatus(message.status)) {
            if (
                connection.status.status === message.status.status &&
                connection.status.message === message.status.message
            ) {
                return;
            }
            connection.status = message.status;
            notify(rendererId);
            return;
        }
        if (
            message.type === "hello" &&
            !connection.ready &&
            message.rendererId === rendererId &&
            Array.isArray(message.loadedInstanceIds) &&
            message.loadedInstanceIds.every((id) => typeof id === "string") &&
            isSnapshotList(message.onAir)
        ) {
            const onAir = new Map(message.onAir.map((instance) => [instance.load.graphicInstanceId, instance]));
            const loadedIds = new Set(message.loadedInstanceIds);
            connection.instances = new Map([...onAir].filter(([id]) => loadedIds.has(id)));
            connection.ready = true;
            if (!rendererState.has(rendererId) && getPrimary(rendererId) === connection) {
                rendererState.set(rendererId, onAir);
            }
            const config = configProvider?.(rendererId);
            if (config) {
                sendConfigToConnection(connection, config);
            }
            connection.recovery = replayState(connection, rendererId)
                .catch((error: unknown) => {
                    connection.failure = error instanceof Error ? error.message : String(error);
                    logs.add({
                        level: "error",
                        category: "renderer",
                        message: `Renderer recovery failed: ${connection.failure}`,
                        rendererId: rendererId,
                    });
                })
                .finally(() => {
                    connection.recovery = undefined;
                    notify(rendererId);
                });
            notify(rendererId);
        }
        if (message.type === "result") {
            handleResultMessage(connection, message);
            return;
        }
    };

    const registerConnection = (ws: WebSocket, rendererId: string) => {
        const connection: Connection = {
            ws: ws,
            isAlive: true,
            pending: new Map(),
            instances: new Map(),
            loadingInstances: new Map(),
            ready: false,
            status: { status: "OK", message: "Renderer page ready" },
        };

        const current = rendererConnections.get(rendererId);
        if (current) {
            current.add(connection);
        } else {
            rendererConnections.set(rendererId, new Set([connection]));
        }

        logs.add({
            level: "info",
            category: "renderer",
            message: `Renderer "${rendererId}" output connected (${openConnections(rendererId).length} active)`,
            rendererId: rendererId,
        });

        ws.on("message", (raw) => {
            try {
                handleRendererMessage(connection, rendererId, raw);
            } catch {
                ws.close(1008, "Invalid renderer message");
            }
        });

        ws.on("close", () => {
            const group = rendererConnections.get(rendererId);
            const firstReady = [...(group ?? [])].find((item) => item.ready);
            if (connection.restoringInstanceId && firstReady === connection) {
                recordRecoveryFailure(
                    rendererId,
                    connection.restoringInstanceId,
                    "Output disconnected during recovery",
                );
            }
            rejectPending(connection, new RendererDisconnectedError(rendererId));

            if (!group?.delete(connection)) {
                return;
            }
            if (group.size === 0) {
                rendererConnections.delete(rendererId);
            }

            logs.add({
                level: "warn",
                category: "renderer",
                message: `Renderer "${rendererId}" output disconnected (${openConnections(rendererId).length} active)`,
                rendererId: rendererId,
            });
            notify(rendererId);
        });
        ws.on("error", (error) => {
            connection.failure = error.message;
            notify(rendererId);
        });
    };

    const heartbeat = setInterval(() => {
        for (const [rendererId, group] of rendererConnections) {
            for (const connection of group) {
                if (!connection.isAlive) {
                    rejectPending(connection, new RendererDisconnectedError(rendererId));
                    connection.ws.terminate();
                    continue;
                }
                connection.isAlive = false;
                if (connection.ws.readyState === Ws.OPEN) {
                    try {
                        connection.ws.send(JSON.stringify({ type: "ping" }));
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
        const connections = openConnections(rendererId).filter((connection) => connection.ready);
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

    function validateCommandData(rendererId: string, command: RendererCommandType, payload: unknown): void {
        if (!isRecord(payload) || !["load", "updateAction", "graphicCustomAction"].includes(command)) {
            return;
        }
        const id = instanceGraphicId(payload);
        const load =
            command === "load" && isLoadPayload(payload)
                ? payload
                : id
                  ? rendererState.get(rendererId)?.get(id)?.load
                  : undefined;
        if (!load) {
            return;
        }
        const customAction = command === "graphicCustomAction";
        const actions = Array.isArray(load.manifest.customActions) ? load.manifest.customActions : [];
        const action = actions.find((item) => isRecord(item) && item.id === payload.id);
        const schema = customAction ? (isRecord(action) ? action.schema : undefined) : load.manifest.schema;
        const data = customAction ? payload.payload : payload.data;
        if (schema == null || (data === undefined && command !== "updateAction")) {
            return;
        }
        const validation = validateGddValue(schema, data);
        const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        if (validation.status === "invalid") {
            throw new InvalidRequestError(detail);
        }
        const key = `${load.graphicId}:${command}`;
        if (validation.status === "unsupported" && !unsupportedSchemas.has(key)) {
            unsupportedSchemas.add(key);
            logs.add({
                level: "warn",
                category: "graphic",
                message: `Graphic data validation is incomplete: ${detail}`,
                graphicId: load.graphicId,
                rendererId: rendererId,
            });
        }
    }

    function recordCommand(
        rendererId: string,
        connection: Connection,
        command: RendererCommandType,
        payload: RendererCommandMap[RendererCommandType]["payload"],
    ): void {
        const state = rendererState.get(rendererId) ?? new Map<string, InstanceSnapshot>();
        if (command === "clear" && "filters" in payload) {
            for (const [id, instance] of state) {
                if (
                    !payload.filters.length ||
                    payload.filters.some((filter) => matchesGraphicFilter(instance.load, filter))
                ) {
                    state.delete(id);
                    recoveryFailures.get(rendererId)?.delete(id);
                }
            }
        } else {
            const id = instanceGraphicId(payload);
            const snapshot = id && connection.instances.get(id);
            if (snapshot) {
                state.set(snapshot.load.graphicInstanceId, snapshot);
                recoveryFailures.get(rendererId)?.delete(snapshot.load.graphicInstanceId);
            }
        }
        rendererState.set(rendererId, state);
    }

    async function sendCommand<T extends RendererCommandType>(
        rendererId: string,
        command: T,
        payload: RendererCommandMap[T]["payload"],
    ): Promise<RendererCommandMap[T]["result"]> {
        const primary = getPrimary(rendererId);
        if (!primary) {
            throw new RendererOfflineError(rendererId);
        }
        await primary.recovery;
        const targets = commandTargets(rendererId, command, payload);
        if (!targets.includes(primary)) {
            throw new RendererOfflineError(rendererId);
        }

        validateCommandData(rendererId, command, payload);

        for (const connection of targets) {
            if (connection === primary) {
                continue;
            }
            void Promise.resolve(connection.recovery)
                .then(() => sendToConnection(connection, rendererId, command, payload))
                .then(() => notify(rendererId))
                .catch((error) => {
                    connection.failure = error instanceof Error ? error.message : String(error);
                    logs.add({
                        level: "warn",
                        category: "renderer",
                        message: `Renderer "${rendererId}" replica failed "${command}": ${connection.failure}`,
                        rendererId: rendererId,
                    });
                    notify(rendererId);
                });
        }

        let result: RendererCommandMap[T]["result"];
        try {
            result = await sendToConnection(primary, rendererId, command, payload);
        } catch (error) {
            primary.failure = error instanceof Error ? error.message : String(error);
            notify(rendererId);
            throw error;
        }
        if (commandSucceeded(result)) {
            recordCommand(rendererId, primary, command, payload);
        }
        notify(rendererId);
        return result;
    }

    return {
        handleUpgrade: (req, socket, head, rendererId) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                registerConnection(ws, rendererId);
            });
        },

        isConnected: (rendererId) => getPrimary(rendererId) !== undefined,

        getStatus: (rendererId) => {
            const connections = openConnections(rendererId);
            const primary = connections.find((connection) => connection.ready);
            if (!primary) {
                return { status: "ERROR", message: "Renderer output is not ready" };
            }
            if (primary.failure || primary.status.status === "ERROR") {
                return { status: "ERROR", message: primary.failure ?? primary.status.message };
            }
            const failures = recoveryFailures.get(rendererId);
            if (failures?.size) {
                return {
                    status: "WARNING",
                    message: `Skipped ${failures.size} graphic(s) after recovery failed: ${[...failures].map(([id, message]) => `${id}: ${message}`).join("; ")}`,
                };
            }
            if (primary.recovery) {
                return { status: "WARNING", message: "Restoring renderer state" };
            }
            const unhealthy = connections.find(
                (connection) => !connection.ready || connection.failure || connection.status.status !== "OK",
            );
            return unhealthy
                ? { status: "WARNING", message: unhealthy.failure ?? unhealthy.status.message }
                : { status: "OK", message: `${connections.length} renderer output(s) ready` };
        },

        getLiveTarget: (rendererId, renderTarget) => {
            const primary = getPrimary(rendererId);
            if (!primary) {
                return undefined;
            }

            const key = canonicalJsonKey(renderTarget);
            const instances = new Map<string, { graphicId: string; currentStep?: number }>();
            for (const instance of primary.instances.values()) {
                if (canonicalJsonKey(instance.load.renderTarget) === key) {
                    instances.set(instance.load.graphicInstanceId, {
                        graphicId: instance.load.graphicId,
                        currentStep: instance.currentStep,
                    });
                }
            }

            return instances;
        },

        isGraphicInUse: (graphicId) =>
            [...rendererState.values()].some((instances) =>
                [...instances.values()].some((instance) => instance.load.graphicId === graphicId),
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
            rendererState.delete(rendererId);
            recoveryFailures.delete(rendererId);
            const group = rendererConnections.get(rendererId);
            if (group) {
                rendererConnections.delete(rendererId);
                for (const connection of group) {
                    rejectPending(connection, new RendererDisconnectedError(rendererId));
                    connection.ws.close(1008, "Renderer deleted");
                }
            }
        },

        close: async () => {
            clearInterval(heartbeat);
            const closed: Array<Promise<void>> = [];
            for (const [rendererId, group] of rendererConnections) {
                for (const connection of group) {
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
            rendererState.clear();
            recoveryFailures.clear();
            unsupportedSchemas.clear();
            changeListeners.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}
