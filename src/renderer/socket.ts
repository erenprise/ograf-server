import {
    isRecord,
    type InstanceSnapshot,
    type RendererCommandExecution,
    type RendererCommandType,
    type RendererMessage,
} from "../shared.ts";

type CommandHandler = (command: RendererCommandType, payload: unknown) => Promise<RendererCommandExecution>;

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000];

function isRendererMessage(value: unknown): value is RendererMessage {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }
    if (value.type === "ping" || value.type === "pong") {
        return typeof value.timestamp === "number";
    }
    if (value.type === "hello") {
        return typeof value.rendererId === "string" && Array.isArray(value.instances);
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
    return value.type === "result" && typeof value.id === "string" && typeof value.ok === "boolean";
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

export function connectRendererSocket(
    rendererId: string,
    getSnapshot: () => InstanceSnapshot[],
    onCommand: CommandHandler,
) {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

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
            sendMessage({ type: "hello", rendererId: rendererId, instances: getSnapshot() }, nextSocket);
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

        if (message.type === "ping") {
            sendMessage({ type: "pong", timestamp: message.timestamp }, source);
            return;
        }
        if (message.type !== "command") {
            return;
        }

        void executeCommand(message, source);
    }

    async function executeCommand(message: Extract<RendererMessage, { type: "command" }>, source: WebSocket) {
        try {
            const { result, instances } = await onCommand(message.command, message.payload);
            sendMessage(
                { type: "result", id: message.id, ok: true, result: result, instances: instances ?? getSnapshot() },
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
                    instances: getSnapshot(),
                },
                source,
            );
        }
    }

    connect();

    return {
        stop: () => {
            stopped = true;
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            socket?.close();
        },
    };
}
