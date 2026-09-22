import { watch, type FSWatcher } from "node:fs";

const DEBOUNCE_MS = 250;

type GraphicsWatcherOptions = {
    root: string;
    onChange: () => void;
    onError: (error: unknown) => void;
};

// Debounced recursive watcher; hidden paths (".staging", ".DS_Store") are ignored.
export function watchGraphicsFolder({ root, onChange, onError }: GraphicsWatcherOptions): { close: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher | undefined;

    const schedule = (filename: string | Buffer | null) => {
        if (filename === null || isHidden(filename)) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(onChange, DEBOUNCE_MS).unref();
    };

    try {
        watcher = watch(root, { recursive: true }, (_event, filename) => schedule(filename));
        watcher.on("error", onError);
    } catch (error) {
        onError(error);
    }

    return {
        close: () => {
            clearTimeout(timer);
            watcher?.close();
        },
    };
}

const isHidden = (filename: string | Buffer) =>
    filename
        .toString()
        .split(/[\\/]/)
        .some((segment) => segment.startsWith("."));
