import type { ServerEvent } from "../shared.ts";

export type ServerEvents = {
    emit: (event: ServerEvent) => void;
    subscribe: (fn: (event: ServerEvent) => void) => () => void;
    clear: () => void;
};

export function createServerEvents(): ServerEvents {
    const listeners = new Set<(event: ServerEvent) => void>();

    return {
        emit: (event) => {
            for (const listener of listeners) {
                try {
                    listener(event);
                } catch (error) {
                    console.error("Server event subscriber failed", error);
                }
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        clear: () => listeners.clear(),
    };
}
