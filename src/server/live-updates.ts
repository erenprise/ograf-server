import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket as Ws, type WebSocket, WebSocketServer } from "ws";
import { isRecord, MAX_CONTROL_MESSAGE_BYTES } from "../shared.ts";
import { errorToProblem } from "./errors.ts";
import type { LogStore } from "./logs.ts";
import {
    executeInstanceAction,
    parseInstanceActionInput,
    type InstanceActionDeps,
    type InstanceActionInput,
} from "./ograf-actions.ts";

// Live updates must run one at a time per instance; coalescing is the point.
// oxlint-disable no-await-in-loop

export type LiveUpdateGateway = {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, rendererId: string) => void;
    close: () => Promise<void>;
};

type PendingLiveUpdate = {
    ws: WebSocket;
    id: string;
    input: InstanceActionInput;
};

type LiveSlot = {
    running: boolean;
    pending?: PendingLiveUpdate;
};

const MAX_ID_LENGTH = 128;
const CLOSE_GRACE_MS = 1_000;

// Waits up to `ms` without holding the process open for it.
const waitUnref = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
    });

function rawText(raw: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(raw)) {
        return Buffer.concat(raw).toString("utf8");
    }
    return (raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : raw).toString("utf8");
}

function send(ws: WebSocket, message: unknown): void {
    if (ws.readyState !== Ws.OPEN) {
        return;
    }
    try {
        ws.send(JSON.stringify(message));
    } catch {
        // The close handler cleans up.
    }
}

const slotKey = (rendererId: string, graphicInstanceId: string) => `${rendererId}\0${graphicInstanceId}`;

export function createLiveUpdateGateway(
    renderers: InstanceActionDeps["renderers"],
    gateway: InstanceActionDeps["gateway"],
    logs: LogStore,
): LiveUpdateGateway {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_MESSAGE_BYTES });
    const slots = new Map<string, LiveSlot>();
    const actionDeps = { renderers: renderers, gateway: gateway };

    async function drain(rendererId: string, key: string, slot: LiveSlot): Promise<void> {
        slot.running = true;
        try {
            while (slot.pending) {
                const request = slot.pending;
                slot.pending = undefined;

                if (request.ws.readyState !== Ws.OPEN) {
                    continue;
                }

                try {
                    const result = await executeInstanceAction(actionDeps, rendererId, "updateAction", request.input);
                    send(request.ws, { id: request.id, ok: true, result: result });
                } catch (error) {
                    send(request.ws, { id: request.id, ok: false, error: errorToProblem(error).body });
                }
            }
        } finally {
            slot.running = false;
            if (!slot.pending) {
                slots.delete(key);
            }
        }
    }

    function enqueue(rendererId: string, request: PendingLiveUpdate): void {
        const key = slotKey(rendererId, request.input.graphicInstanceId);
        const slot = slots.get(key) ?? { running: false };
        slots.set(key, slot);

        if (slot.pending) {
            send(slot.pending.ws, { id: slot.pending.id, ok: true, superseded: true });
        }
        slot.pending = request;
        if (!slot.running) {
            void drain(rendererId, key, slot);
        }
    }

    function handleMessage(rendererId: string, ws: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText(raw));
        } catch {
            ws.close(1008, "Malformed message");
            return;
        }
        if (
            !isRecord(parsed) ||
            typeof parsed.id !== "string" ||
            parsed.id.length === 0 ||
            parsed.id.length > MAX_ID_LENGTH
        ) {
            ws.close(1008, "Message id must be a non-empty string");
            return;
        }

        const input = parseInstanceActionInput(parsed.body);
        if (!input) {
            send(ws, {
                id: parsed.id,
                ok: false,
                error: {
                    status: 400,
                    title: "Bad Request",
                    detail: "Message body must contain renderTarget, graphicInstanceId and params",
                },
            });
            return;
        }

        enqueue(rendererId, { ws: ws, id: parsed.id, input: input });
    }

    return {
        handleUpgrade: (req, socket, head, rendererId) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                logs.add({
                    level: "info",
                    category: "renderer",
                    message: `Live update client connected for renderer "${rendererId}"`,
                    rendererId: rendererId,
                });
                ws.on("message", (raw) => handleMessage(rendererId, ws, raw));
                ws.on("close", () => {
                    logs.add({
                        level: "debug",
                        category: "renderer",
                        message: `Live update client disconnected from renderer "${rendererId}"`,
                        rendererId: rendererId,
                    });
                });
            });
        },

        close: async () => {
            const clients = [...wss.clients];
            for (const client of clients) {
                if (client.readyState !== Ws.CLOSED) {
                    client.close(1001, "Server shutting down");
                }
            }
            if (clients.length) {
                const closed = clients.map(
                    (client) => new Promise<void>((resolve) => client.once("close", () => resolve())),
                );
                await Promise.race([Promise.all(closed), waitUnref(CLOSE_GRACE_MS)]);
            }
            for (const client of wss.clients) {
                if (client.readyState !== Ws.CLOSED) {
                    client.terminate();
                }
            }
            slots.clear();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}
