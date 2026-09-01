import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cacheRoot = path.join(root, ".cache", "ograf");
const openApiUrl = "https://ograf.ebu.io/v1/specification/open-api/server-api.yaml";
const ografSchemaPrefix = "https://ograf.ebu.io/v1/specification/json-schemas/";
const jsonSchemaPrefix = "https://json-schema.org/draft/2020-12/";
const openApiReferencePattern = /^([ \t]*(?:-[ \t]*)?)(\$ref|x-\$ref):[ \t]*["']?([^"'\s]+)["']?[ \t]*$/gm;

type SpecReference = {
    file: string;
    fragment: string;
    url: string;
};

function localAssetPath(url: URL): string | undefined {
    const prefix = [ografSchemaPrefix, jsonSchemaPrefix].find((candidate) => url.href.startsWith(candidate));
    if (!prefix) {
        return undefined;
    }
    const directory = prefix === ografSchemaPrefix ? "json-schemas" : "json-schemas/json-schema/draft/2020-12";

    const encodedRelative = url.href.slice(prefix.length).split(/[?#]/, 1)[0];
    if (!encodedRelative) {
        return undefined;
    }
    const relative = decodeURIComponent(encodedRelative);
    if (relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        return undefined;
    }

    const file = relative.endsWith(".json") ? relative : `${relative}.json`;
    return path.posix.join(directory, file);
}

function resolveReference(value: string, baseUrl: string): SpecReference | undefined {
    let url: URL;
    try {
        url = new URL(value, baseUrl);
    } catch {
        return undefined;
    }

    const fragment = url.hash;
    url.hash = "";
    const file = localAssetPath(url);
    return file ? { file: file, fragment: fragment, url: url.href } : undefined;
}

function relativeReference(sourceFile: string, targetFile: string, fragment: string): string {
    const relative = path.posix.relative(path.posix.dirname(sourceFile), targetFile);
    return `${relative || path.posix.basename(targetFile)}${fragment}`;
}

function openApiReferences(document: string): SpecReference[] {
    const references = new Map<string, SpecReference>();
    for (const match of document.matchAll(openApiReferencePattern)) {
        const value = match[3];
        const reference = value && resolveReference(value, openApiUrl);
        if (reference) {
            references.set(reference.url, reference);
        }
    }
    return [...references.values()];
}

function jsonReferences(value: unknown, sourceUrl: string): SpecReference[] {
    const references = new Map<string, SpecReference>();

    const visit = (current: unknown): void => {
        if (Array.isArray(current)) {
            for (const item of current) {
                visit(item);
            }
            return;
        }
        if (current === null || typeof current !== "object") {
            return;
        }
        for (const [key, child] of Object.entries(current)) {
            if (isReferenceKey(key) && typeof child === "string") {
                const reference = resolveReference(child, sourceUrl);
                if (reference) {
                    references.set(reference.url, reference);
                }
            }
            visit(child);
        }
    };

    visit(value);
    return [...references.values()];
}

function rewriteOpenApiReferences(document: string): string {
    return document.replace(openApiReferencePattern, (line, indent: string, key: string, value: string) => {
        const reference = resolveReference(value, openApiUrl);
        if (!reference) {
            return line;
        }
        const localFile = path.posix.join("docs", reference.file);
        const localReference = relativeReference("docs/ograf/openapi.yaml", localFile, reference.fragment);
        return `${indent}${key}: "${localReference}"`;
    });
}

function isReferenceKey(key: string): boolean {
    return key === "$ref" || key === "x-$ref";
}

function rewriteJsonReferences(value: unknown, source: SpecReference): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => rewriteJsonReferences(item, source));
    }
    if (value === null || typeof value !== "object") {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (isReferenceKey(key) && typeof child === "string") {
            const reference = resolveReference(child, source.url);
            result[key] = reference ? relativeReference(source.file, reference.file, reference.fragment) : child;
            continue;
        }
        result[key] = rewriteJsonReferences(child, source);
    }
    return result;
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    }
    return response.text();
}

async function downloadSchemas(initial: SpecReference[], stage: string): Promise<number> {
    const downloaded = new Set<string>();
    let pending = initial;
    let count = 0;

    while (pending.length) {
        const batch = pending.filter((reference) => !downloaded.has(reference.url));
        if (!batch.length) {
            break;
        }

        // Each batch discovers the next graph level, so the batches must stay ordered.
        // oxlint-disable-next-line no-await-in-loop
        const files = await Promise.all(
            batch.map(async (reference) => {
                const parsed: unknown = JSON.parse(await fetchText(reference.url));
                return { reference: reference, parsed: parsed, children: jsonReferences(parsed, reference.url) };
            }),
        );

        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(
            files.map(async ({ reference, parsed }) => {
                const file = path.join(stage, reference.file);
                await mkdir(path.dirname(file), { recursive: true });
                await writeFile(file, `${JSON.stringify(rewriteJsonReferences(parsed, reference), undefined, 4)}\n`);
            }),
        );

        const next = new Map<string, SpecReference>();
        for (const { reference, children } of files) {
            downloaded.add(reference.url);
            for (const child of children) {
                if (!downloaded.has(child.url)) {
                    next.set(child.url, child);
                }
            }
        }
        pending = [...next.values()];
        count += files.length;
    }

    return count;
}

async function refreshCache(): Promise<void> {
    const cacheParent = path.dirname(cacheRoot);
    await mkdir(cacheParent, { recursive: true });
    const stage = await mkdtemp(path.join(cacheParent, "ograf-"));

    try {
        const openApi = await fetchText(openApiUrl);
        await writeFile(path.join(stage, "ograf-openapi.yaml"), rewriteOpenApiReferences(openApi));

        const downloadedCount = await downloadSchemas(openApiReferences(openApi), stage);

        await rm(cacheRoot, { recursive: true, force: true });
        await rename(stage, cacheRoot);
        console.log(
            `Downloaded OGraf documentation to ${path.relative(root, cacheRoot)} (${downloadedCount + 1} files)`,
        );
    } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
    }
}

await refreshCache();
