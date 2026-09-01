import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAsset, getAssetKeys, isSea } from "node:sea";
import { hasErrorCode } from "./errors.ts";

export const OGRAF_OPENAPI_ASSET = "ograf-openapi.yaml";

async function readFileIfPresent(file: string | undefined): Promise<ArrayBuffer | undefined> {
    if (!file) {
        return undefined;
    }
    try {
        return new Uint8Array(await readFile(file)).buffer;
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT", "EISDIR", "ENOTDIR")) {
            throw error;
        }
        return undefined;
    }
}

/** Immutable application assets: embedded in the single-executable build, read from disk otherwise. */
export function createAppAssets(root: string) {
    const embeddedKeys = isSea() ? new Set(getAssetKeys()) : undefined;
    const distRoot = path.join(root, "dist");
    const ografCacheRoot = path.join(root, ".cache", "ograf");
    const cache = new Map<string, ArrayBuffer>();

    const readFromDisk = async (key: string): Promise<ArrayBuffer | undefined> => {
        if (key.includes("\0") || key.split(/[\\/]/).includes("..")) {
            return undefined;
        }
        const [distFile, cacheFile] = [distRoot, ografCacheRoot].flatMap((base) => {
            const file = path.resolve(base, key);
            return file.startsWith(`${base}${path.sep}`) ? [file] : [];
        });
        return (await readFileIfPresent(distFile)) ?? readFileIfPresent(cacheFile);
    };

    const read = async (key: string): Promise<ArrayBuffer | undefined> => {
        const cached = cache.get(key);
        if (cached) {
            return cached;
        }

        const value = embeddedKeys ? (embeddedKeys.has(key) ? getAsset(key) : undefined) : await readFromDisk(key);
        if (value) {
            cache.set(key, value);
        }
        return value;
    };

    const readText = async (key: string): Promise<string> => {
        const value = await read(key);
        if (!value) {
            throw new Error(`Missing application asset "${key}"`);
        }
        return new TextDecoder().decode(value);
    };

    return { read: read, readText: readText };
}

export type AppAssets = ReturnType<typeof createAppAssets>;
