import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerEvent } from "../shared.ts";

// Sequential writes are intentional: each event is flushed in order. `stopped`
// is only mutated from the abort callback, which the linter cannot see.
// oxlint-disable no-await-in-loop no-unmodified-loop-condition

const HEARTBEAT_MS = 15_000;
const MAX_EVENT_QUEUE = 1000;

export function wantsSse(c: Context): boolean {
    const accepts = c.req.header("accept") ?? "";
    const contentType = c.req.header("content-type") ?? "";
    return accepts.includes("text/event-stream") || contentType.includes("text/event-stream");
}

const createSignal = () => {
    let wake: (() => void) | undefined;
    return {
        notify: () => {
            const resolve = wake;
            wake = undefined;
            resolve?.();
        },
        wait: (ready: () => boolean) =>
            new Promise<void>((resolve) => {
                wake = resolve;
                if (ready()) {
                    resolve();
                }
            }),
    };
};

const withSseHeaders = (response: Response): Response => {
    response.headers.set("Cache-Control", "no-cache, no-transform");
    response.headers.set("X-Accel-Buffering", "no");
    return response;
};

/** Streams the latest snapshot of one resource, coalescing matching events. */
export function streamLatestState<T>(
    c: Context,
    initial: T,
    getSnapshot: () => T | undefined,
    subscribe: (fn: (event: ServerEvent) => void) => () => void,
    matches: (event: ServerEvent) => boolean,
): Response {
    return withSseHeaders(
        streamSSE(c, async (stream) => {
            const { notify, wait } = createSignal();
            let stopped = false;
            let dirty = false;
            let heartbeatDue = false;
            let lastData = JSON.stringify(initial);

            const unsubscribe = subscribe((event) => {
                if (matches(event)) {
                    dirty = true;
                    notify();
                }
            });
            const heartbeat = setInterval(() => {
                heartbeatDue = true;
                notify();
            }, HEARTBEAT_MS);
            heartbeat.unref();
            stream.onAbort(() => {
                stopped = true;
                notify();
            });

            try {
                await stream.writeSSE({ event: "snapshot", data: lastData, retry: 2000 });

                while (!stopped && !stream.aborted) {
                    if (dirty) {
                        dirty = false;
                        const snapshot = getSnapshot();
                        if (snapshot === undefined) {
                            await stream.writeSSE({ event: "deleted", data: "{}" });
                            break;
                        }
                        const data = JSON.stringify(snapshot);
                        if (data !== lastData) {
                            lastData = data;
                            await stream.writeSSE({ event: "snapshot", data: data });
                        }
                        continue;
                    }

                    if (heartbeatDue) {
                        heartbeatDue = false;
                        await stream.writeSSE({ event: "heartbeat", data: "" });
                        continue;
                    }

                    await wait(() => dirty || heartbeatDue || stopped);
                }
            } finally {
                clearInterval(heartbeat);
                unsubscribe();
            }
        }),
    );
}

/** Streams every server event over a bounded queue, closing if the client lags. */
export function streamServerEvents(c: Context, subscribe: (fn: (event: ServerEvent) => void) => () => void): Response {
    return withSseHeaders(
        streamSSE(c, async (stream) => {
            const { notify, wait } = createSignal();
            const queue: Array<{ data: string; event: string }> = [];
            let stopped = false;

            const stop = () => {
                stopped = true;
                queue.length = 0;
                notify();
            };
            const enqueue = (event: string, data: string) => {
                if (stopped) {
                    return;
                }
                if (queue.length >= MAX_EVENT_QUEUE) {
                    stop();
                    void stream.close();
                    return;
                }
                queue.push({ event: event, data: data });
                notify();
            };

            stream.onAbort(stop);
            const unsubscribe = subscribe((event) => enqueue("message", JSON.stringify(event)));
            const heartbeat = setInterval(() => enqueue("heartbeat", ""), HEARTBEAT_MS);
            heartbeat.unref();

            try {
                while (!stopped && !stream.aborted) {
                    const message = queue.shift();
                    if (!message) {
                        await wait(() => stopped || queue.length > 0);
                        continue;
                    }
                    try {
                        await stream.writeSSE(message);
                    } catch {
                        stop();
                    }
                }
            } finally {
                clearInterval(heartbeat);
                unsubscribe();
            }
        }),
    );
}
