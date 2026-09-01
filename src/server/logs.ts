import type { LogEntry, LogLevel } from "../shared.ts";

type LogFilter = {
    level?: LogEntry["level"];
    category?: LogEntry["category"];
    search?: string;
};

export type LogStore = {
    add: (entry: Omit<LogEntry, "id" | "time">) => LogEntry;
    list: (filter?: LogFilter) => LogEntry[];
    subscribe: (fn: (entry: LogEntry) => void) => () => void;
};

const LEVEL_CONSOLE: Record<LogLevel, (...args: unknown[]) => void> = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
};

export function createLogStore(capacity = 1000): LogStore {
    const buffer: LogEntry[] = [];
    const subscribers = new Set<(entry: LogEntry) => void>();
    let nextId = 0;

    return {
        add: (partial) => {
            const entry: LogEntry = { id: ++nextId, time: new Date().toISOString(), ...partial };
            buffer.push(entry);
            if (buffer.length > capacity) {
                buffer.shift();
            }

            const line = `[${entry.time}] ${entry.level.toUpperCase()} ${entry.category} ${entry.message}`;
            LEVEL_CONSOLE[entry.level](line);

            for (const fn of subscribers) {
                try {
                    fn(entry);
                } catch (error) {
                    console.error("Log subscriber failed", error);
                }
            }
            return entry;
        },
        list: (filter) => {
            if (!filter) {
                return [...buffer];
            }
            const search = filter.search?.toLowerCase();
            return buffer.filter(
                (entry) =>
                    (!filter.level || entry.level === filter.level) &&
                    (!filter.category || entry.category === filter.category) &&
                    (!search || entry.message.toLowerCase().includes(search)),
            );
        },
        subscribe: (fn) => {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
    };
}
