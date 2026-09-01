import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
    validatePackage,
    type ValidationIssue,
    type ValidationResult,
    type VirtualFS,
} from "@streamshapers/ograf-validator-core";
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";
import { isRecord, MAX_PACKAGE_ID_LENGTH } from "../shared.ts";
import { hasErrorCode } from "./errors.ts";
import type { LogStore } from "./logs.ts";
import { ID_PATTERN, type StateStore } from "./state.ts";

export type GraphicRecord = {
    id: string;
    packageId: string;
    manifestPath: string;
    packageDir: string;
    manifestDir: string;
    manifest: Record<string, unknown>;
    validation: ValidationResult;
    revision: string;
    updatedAt: string;
};

type GraphicManifestInfo = {
    name?: string;
    version?: string;
    description?: string;
    supportsRealTime: boolean;
    supportsNonRealTime: boolean;
    stepCount?: number;
    customActionCount: number;
    thumbnails?: unknown[];
};

export function getGraphicManifestInfo(manifest: Record<string, unknown>): GraphicManifestInfo {
    return {
        name: typeof manifest.name === "string" ? manifest.name : undefined,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
        description: typeof manifest.description === "string" ? manifest.description : undefined,
        supportsRealTime: Boolean(manifest.supportsRealTime),
        supportsNonRealTime: Boolean(manifest.supportsNonRealTime),
        stepCount: typeof manifest.stepCount === "number" ? manifest.stepCount : undefined,
        customActionCount: Array.isArray(manifest.customActions) ? manifest.customActions.length : 0,
        thumbnails: Array.isArray(manifest.thumbnails) ? manifest.thumbnails : undefined,
    };
}

export function getGraphicListInfo(record: Pick<GraphicRecord, "id" | "manifest">) {
    const info = getGraphicManifestInfo(record.manifest);
    return {
        id: record.id,
        name: info.name ?? record.id,
        description: info.description,
        thumbnails: info.thumbnails,
    };
}

type UploadResult =
    | {
          ok: true;
          status: number;
          graphicIds: string[];
      }
    | {
          ok: false;
          status: number;
          error: string;
      };

type PackageFileMetadata = {
    path: string;
    size: number;
    mtimeMs: number;
};

const MAX_ZIP_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_FILE_COUNT = 5000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const TOMBSTONE_GRACE_MS = 5 * 60 * 1000;
const STAGING_DIR_NAME = ".staging";

function safeJoinPath(base: string, relPath: string): string | undefined {
    if (
        relPath.includes("\0") ||
        relPath.startsWith("/") ||
        relPath.startsWith("\\") ||
        /^[a-z]:[\\/]/i.test(relPath)
    ) {
        return undefined;
    }
    const segments = relPath.split(/[\\/]/).filter((segment) => segment && segment !== ".");
    if (segments.includes("..")) {
        return undefined;
    }
    const target = join(base, ...segments);
    return target === base || target.startsWith(base + sep) ? target : undefined;
}

async function resolveFilePath(root: string, base: string, relPath: string): Promise<string | undefined> {
    const target = safeJoinPath(base, relPath);
    if (!target) {
        return undefined;
    }
    try {
        const [realRoot, realBase, realTarget] = await Promise.all([realpath(root), realpath(base), realpath(target)]);
        return realBase !== realRoot &&
            realBase.startsWith(realRoot + sep) &&
            realTarget !== realBase &&
            realTarget.startsWith(realBase + sep) &&
            (await stat(realTarget)).isFile()
            ? realTarget
            : undefined;
    } catch {
        return undefined;
    }
}

async function listFilesRelative(rootDir: string, startDir = rootDir): Promise<string[]> {
    const entries = await readdir(startDir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
            relative(rootDir, join(entry.parentPath ?? startDir, entry.name))
                .split(sep)
                .join("/"),
        )
        .toSorted();
}

function createNodeVirtualFS(rootDir: string): VirtualFS {
    const resolveSafe = (relPath: string): string => {
        if (relPath.includes("\0")) {
            throw new Error(`Path contains NUL: "${relPath}"`);
        }
        const target = safeJoinPath(rootDir, relPath);
        if (!target) {
            throw new Error(`Path escapes package root: "${relPath}"`);
        }
        return target;
    };
    return {
        readFile: (path) => readFile(resolveSafe(path), "utf-8"),
        fileExists: async (path) => {
            try {
                return (await stat(resolveSafe(path))).isFile();
            } catch (error) {
                if (hasErrorCode(error, "ENOENT")) {
                    return false;
                }
                throw error;
            }
        },
        listFiles: (path) => listFilesRelative(rootDir, path ? resolveSafe(path) : rootDir),
        getFileSize: async (path) => (await stat(resolveSafe(path))).size,
    };
}

async function packageFiles(dir: string): Promise<PackageFileMetadata[]> {
    const paths = await listFilesRelative(dir);
    return Promise.all(
        paths.map(async (path) => {
            const metadata = await stat(join(dir, ...path.split("/")));
            return { path: path, size: metadata.size, mtimeMs: metadata.mtimeMs };
        }),
    );
}

function packageRevision(files: PackageFileMetadata[]): string {
    return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function packageUpdatedAt(files: PackageFileMetadata[]): string {
    const mtimeMs = files.length ? Math.max(...files.map((file) => file.mtimeMs)) : 0;
    return new Date(mtimeMs).toISOString();
}

function validationError(code: string, message: string): ValidationResult {
    const issue: ValidationIssue = { severity: "error", code: code, message: message };
    return { valid: false, issues: [issue], errors: [issue], warnings: [], infos: [] };
}

async function scanPackageDir(packageId: string, packageDir: string): Promise<GraphicRecord[]> {
    const files = await packageFiles(packageDir);
    const revision = packageRevision(files);
    const updatedAt = packageUpdatedAt(files);
    return Promise.all(
        files
            .filter((file) => file.path.endsWith(".ograf.json"))
            .map(async ({ path: manifestRelPath, size: manifestSize }) => {
                const absManifestPath = join(packageDir, ...manifestRelPath.split("/"));
                const manifestDir = dirname(absManifestPath);
                let manifestRaw: unknown;
                let validation: ValidationResult;
                try {
                    if (manifestSize > MAX_MANIFEST_BYTES) {
                        manifestRaw = {};
                        validation = validationError(
                            "MANIFEST_TOO_LARGE",
                            `Manifest exceeds the ${MAX_MANIFEST_BYTES} byte limit`,
                        );
                    } else {
                        manifestRaw = JSON.parse(await readFile(absManifestPath, "utf-8"));
                        validation = await validatePackage(
                            manifestRaw,
                            createNodeVirtualFS(manifestDir),
                            basename(manifestRelPath),
                        );
                    }
                } catch (error) {
                    manifestRaw = {};
                    validation = validationError(
                        "INVALID_MANIFEST",
                        `Could not read or validate manifest: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }

                const id =
                    isRecord(manifestRaw) && typeof manifestRaw.id === "string" && manifestRaw.id.trim()
                        ? manifestRaw.id
                        : `${packageId}/${basename(manifestRelPath, ".ograf.json")}`;

                return {
                    id: id,
                    packageId: packageId,
                    manifestPath: `${packageId}/${manifestRelPath}`,
                    packageDir: packageDir,
                    manifestDir: manifestDir,
                    manifest: isRecord(manifestRaw) ? manifestRaw : {},
                    validation: validation,
                    revision: revision,
                    updatedAt: updatedAt,
                };
            }),
    );
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
}

function validateZipEntryName(name: string): { path: string; directory: boolean } {
    if (!name || name.includes("\0")) {
        throw new Error("ZIP file contains an invalid entry name");
    }
    if (name.startsWith("/") || name.startsWith("\\") || /^[a-z]:[\\/]/i.test(name)) {
        throw new Error(`Refusing absolute path entry: "${name}"`);
    }
    const directory = /[\\/]$/.test(name);
    const segments = name.split(/[\\/]/).filter((segment) => segment && segment !== ".");
    if (segments.includes("..") || !segments.length) {
        throw new Error(`Refusing path traversal entry: "${name}"`);
    }
    return { path: segments.join("/"), directory: directory };
}

async function writeStreamChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
    if (!stream.write(chunk)) {
        await once(stream, "drain");
    }
}

async function finishWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        stream.once("error", reject);
        stream.end(() => resolvePromise());
    });
}

async function extractZip(zipPath: string, stagingDir: string): Promise<void> {
    if ((await stat(zipPath)).size > MAX_ZIP_TOTAL_BYTES) {
        throw new Error("ZIP file exceeds the size limit");
    }

    let fileCount = 0;
    let totalBytes = 0;
    let extractionError: Error | undefined;
    const names = new Set<string>();
    const pendingWrites = new Set<Promise<void>>();
    const streams = new Set<ReturnType<typeof createWriteStream>>();
    const files = new Set<UnzipFile>();
    const unzipper = new Unzip((file) => {
        fileCount += 1;
        if (fileCount > MAX_ZIP_FILE_COUNT) {
            throw new Error("ZIP file contains too many entries");
        }
        if (file.originalSize !== undefined && (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0)) {
            throw new Error("ZIP file contains an invalid entry size");
        }
        const entry = validateZipEntryName(file.name);
        if (names.has(entry.path)) {
            throw new Error(`ZIP file contains duplicate entry "${entry.path}"`);
        }
        names.add(entry.path);
        const destination = safeJoinPath(stagingDir, entry.path);
        if (!destination) {
            throw new Error(`Path escapes staging directory: "${entry.path}"`);
        }
        if (entry.directory) {
            mkdirSync(destination, { recursive: true });
            return;
        }
        mkdirSync(dirname(destination), { recursive: true });
        const stream = createWriteStream(destination, { flags: "wx" });
        streams.add(stream);
        files.add(file);
        let fileBytes = 0;
        let writeChain = Promise.resolve();
        stream.on("error", (error: Error) => {
            extractionError ??= error;
        });
        const queueWrite = (write: () => Promise<void>) => {
            writeChain = writeChain.then(write).catch((error: unknown) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                extractionError ??= failure;
                throw failure;
            });
            const current = writeChain;
            pendingWrites.add(current);
            void current.then(() => pendingWrites.delete(current)).catch(() => pendingWrites.delete(current));
        };
        file.ondata = (error, chunk, final) => {
            if (error) {
                extractionError ??= error;
                return;
            }
            if (extractionError) {
                return;
            }
            fileBytes += chunk.length;
            totalBytes += chunk.length;
            if (fileBytes > MAX_ZIP_FILE_BYTES) {
                extractionError = new Error(`Entry "${file.name}" exceeds the per-file size limit`);
                file.terminate();
                return;
            }
            if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
                extractionError = new Error("ZIP file exceeds the total decompressed size limit");
                file.terminate();
                return;
            }
            if (chunk.length) {
                queueWrite(() => writeStreamChunk(stream, chunk));
            }
            if (final) {
                queueWrite(() => finishWriteStream(stream));
            }
        };
        file.start();
    });
    unzipper.register(UnzipPassThrough);
    unzipper.register(UnzipInflate);

    const input = createReadStream(zipPath);
    try {
        for await (const chunk of input) {
            if (extractionError) {
                throw extractionError;
            }
            unzipper.push(chunk, false);
            await Promise.all(pendingWrites);
        }
        unzipper.push(new Uint8Array(), true);
        await Promise.all(pendingWrites);
        if (extractionError) {
            throw extractionError;
        }
        if (!fileCount) {
            throw new Error("ZIP file is empty");
        }
    } finally {
        input.destroy();
        for (const file of files) {
            file.terminate();
        }
        for (const stream of streams) {
            stream.destroy();
        }
    }
}

function validateStagedPackage(staged: GraphicRecord[], existingIds: Set<string>): UploadResult | undefined {
    if (!staged.length) {
        return { ok: false, status: 400, error: "No *.ograf.json manifest found in the uploaded package" };
    }
    const invalid = staged.filter((record) => !record.validation.valid);
    if (invalid.length) {
        const detail = invalid
            .map((record) => `${record.manifestPath}: ${record.validation.errors.map((e) => e.message).join("; ")}`)
            .join(" | ");
        return { ok: false, status: 400, error: `Package failed validation: ${detail}` };
    }
    const conflicting = staged.find((record) => existingIds.has(record.id));
    return conflicting
        ? { ok: false, status: 409, error: `Graphic id "${conflicting.id}" already exists on this server` }
        : undefined;
}

async function moveStagedPackage(
    stagingDir: string,
    finalDir: string,
    packageId: string,
): Promise<UploadResult | undefined> {
    await mkdir(dirname(finalDir), { recursive: true });
    try {
        await rename(stagingDir, finalDir);
        return undefined;
    } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
            return { ok: false, status: 409, error: `A package named "${packageId}" already exists` };
        }
        throw error;
    }
}

function resolveDuplicateIds(records: GraphicRecord[]): GraphicRecord[] {
    const claimed = new Set<string>();
    return records.map((record) => {
        if (!record.validation.valid) {
            return record;
        }
        if (!claimed.has(record.id)) {
            claimed.add(record.id);
            return record;
        }
        const issue: ValidationIssue = {
            severity: "error",
            code: "DUPLICATE_GRAPHIC_ID",
            message: `Another Graphic package already uses id "${record.id}". Ids must be unique across the whole server.`,
            path: "id",
        };
        return {
            ...record,
            validation: {
                valid: false,
                issues: [...record.validation.issues, issue],
                errors: [...record.validation.errors, issue],
                warnings: record.validation.warnings,
                infos: record.validation.infos,
            },
        };
    });
}

type GraphicsStoreOptions = {
    root: string;
    state: StateStore;
    logs: LogStore;
    isGraphicInUse?: (graphicId: string) => boolean;
};

export type GraphicsStore = {
    scan: () => Promise<void>;
    cleanupStaging: () => Promise<void>;
    flush: () => Promise<void>;
    listPublic: () => GraphicRecord[];
    listAll: () => GraphicRecord[];
    get: (id: string) => GraphicRecord | undefined;
    getAny: (id: string) => GraphicRecord | undefined;
    getTombstone: (id: string) => { deleteAfter: string } | undefined;
    resolveAssetPath: (packageId: string, revision: string, relPath: string) => Promise<string | undefined>;
    resolveThumbnailPath: (graphicId: string, file: string) => Promise<string | undefined>;
    remove: (id: string, opts: { force: boolean }) => Promise<"deleted" | "tombstoned" | "not-found">;
    upload: (packageId: string, zipPath: string) => Promise<UploadResult>;
    runTombstoneSweep: () => Promise<void>;
};

export function createGraphicsStore(options: GraphicsStoreOptions): GraphicsStore {
    const { root, state, logs } = options;
    let records: GraphicRecord[] = [];
    let scanQueue: Promise<void> = Promise.resolve();
    let uploadQueue: Promise<void> = Promise.resolve();

    const log = (message: string, graphicId?: string) =>
        logs.add({ level: "info", category: "storage", message: message, graphicId: graphicId });

    const isTombstoned = (id: string) => Boolean(state.getState().graphics.tombstones[id]);

    const scan = () => {
        const run = scanQueue.then(async () => {
            await mkdir(root, { recursive: true });
            const entries = await readdir(root, { withFileTypes: true });
            const packageDirs = entries
                .filter(
                    (entry) => entry.isDirectory() && entry.name !== STAGING_DIR_NAME && !entry.name.startsWith("."),
                )
                .toSorted((a, b) => a.name.localeCompare(b.name));

            const packages = await Promise.all(
                packageDirs.map(async (dir) => {
                    try {
                        return await scanPackageDir(dir.name, join(root, dir.name));
                    } catch (error) {
                        logs.add({
                            level: "error",
                            category: "storage",
                            message: `Could not scan package "${dir.name}": ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        });
                        return [];
                    }
                }),
            );
            records = resolveDuplicateIds(packages.flat());

            const invalidCount = records.filter((record) => !record.validation.valid).length;
            log(
                `Scanned ${records.length} graphic manifest(s) in ${packageDirs.length} package(s), ${invalidCount} invalid`,
            );
            return undefined;
        });
        scanQueue = run.catch(() => undefined);
        return run;
    };

    const cleanupStaging = () => rm(join(root, STAGING_DIR_NAME), { recursive: true, force: true });

    const listPublic = () => records.filter((record) => record.validation.valid && !isTombstoned(record.id));
    const listAll = () => records;
    const get = (id: string) => {
        const record = records.find((item) => item.id === id);
        return record?.validation.valid && !isTombstoned(id) ? record : undefined;
    };
    const getAny = (id: string) => records.find((record) => record.id === id);
    const getTombstone = (id: string) => state.getState().graphics.tombstones[id];

    const resolveAssetPath = async (packageId: string, revision: string, relPath: string) => {
        const record = records.find((item) => item.packageId === packageId);
        if (!record || record.revision !== revision) {
            return undefined;
        }
        return resolveFilePath(root, record.packageDir, relPath);
    };

    const resolveThumbnailPath = async (graphicId: string, file: string) => {
        const record = getAny(graphicId);
        const thumbnails = record?.manifest.thumbnails;
        const match =
            Array.isArray(thumbnails) && thumbnails.some((thumbnail) => isRecord(thumbnail) && thumbnail.file === file);
        return record && match ? resolveFilePath(root, record.manifestDir, file) : undefined;
    };

    const deleteManifestAndMaybePackage = async (record: GraphicRecord) => {
        const absManifestPath = join(root, ...record.manifestPath.split("/"));
        await rm(absManifestPath, { force: true });
        const remaining = await packageFiles(record.packageDir).catch((error) => {
            if (hasErrorCode(error, "ENOENT")) {
                return [];
            }
            throw error;
        });
        if (!remaining.some((file) => file.path.endsWith(".ograf.json"))) {
            await rm(record.packageDir, { recursive: true, force: true });
        }
    };

    const remove = async (id: string, { force }: { force: boolean }) => {
        const record = getAny(id);
        if (!record) {
            return "not-found" as const;
        }

        if (!force) {
            let created = false;
            await state.updateState((draft) => {
                if (!draft.graphics.tombstones[id]) {
                    draft.graphics.tombstones[id] = {
                        deleteAfter: new Date(Date.now() + TOMBSTONE_GRACE_MS).toISOString(),
                    };
                    created = true;
                }
            });
            if (created) {
                log(`Tombstoned graphic "${id}" (soft delete)`, id);
            }
            return "tombstoned" as const;
        }

        await deleteManifestAndMaybePackage(record);
        await state.updateState((draft) => {
            delete draft.graphics.tombstones[id];
        });
        await scan();
        log(`Force-deleted graphic "${id}"`, id);
        return "deleted" as const;
    };

    const runTombstoneSweep = async () => {
        const { tombstones } = state.getState().graphics;
        const now = Date.now();
        const expired = Object.entries(tombstones).filter(
            ([id, tombstone]) =>
                Number.isFinite(Date.parse(tombstone.deleteAfter)) &&
                new Date(tombstone.deleteAfter).getTime() <= now &&
                !options.isGraphicInUse?.(id),
        );
        if (!expired.length) {
            return;
        }

        const removedRecords = await Promise.all(
            expired.map(async ([id]) => {
                const record = getAny(id);
                if (record) {
                    await deleteManifestAndMaybePackage(record);
                }
                return Boolean(record);
            }),
        );
        await state.updateState((draft) => {
            for (const [id, tombstone] of expired) {
                if (draft.graphics.tombstones[id]?.deleteAfter === tombstone.deleteAfter) {
                    delete draft.graphics.tombstones[id];
                }
            }
        });
        for (const [id] of expired) {
            log(`Garbage-collected tombstoned graphic "${id}"`, id);
        }
        if (removedRecords.some(Boolean)) {
            await scan();
        }
    };

    const uploadPackage = async (packageId: string, zipPath: string): Promise<UploadResult> => {
        if (!ID_PATTERN.test(packageId) || packageId.length > MAX_PACKAGE_ID_LENGTH) {
            return {
                ok: false,
                status: 400,
                error: `packageId must be at most ${MAX_PACKAGE_ID_LENGTH} letters, digits, "-" or "_"`,
            };
        }
        const finalDir = join(root, packageId);
        if (await pathExists(finalDir)) {
            return { ok: false, status: 409, error: `A package named "${packageId}" already exists` };
        }

        const stagingDir = join(root, STAGING_DIR_NAME, randomUUID());
        await mkdir(stagingDir, { recursive: true });
        try {
            try {
                await extractZip(zipPath, stagingDir);
            } catch (error) {
                return {
                    ok: false,
                    status: 400,
                    error: `Could not read ZIP file: ${error instanceof Error ? error.message : String(error)}`,
                };
            }

            const staged = await scanPackageDir(packageId, stagingDir);
            const stagedError = validateStagedPackage(staged, new Set(listAll().map((record) => record.id)));
            if (stagedError) {
                return stagedError;
            }

            const commitError = await moveStagedPackage(stagingDir, finalDir, packageId);
            if (commitError) {
                return commitError;
            }
            await scan();
            log(`Uploaded package "${packageId}" (${staged.length} graphic(s))`);
            return { ok: true, status: 200, graphicIds: staged.map((record) => record.id) };
        } finally {
            await rm(stagingDir, { recursive: true, force: true });
        }
    };

    const upload = (packageId: string, zipPath: string) => {
        const run = uploadQueue.then(() => uploadPackage(packageId, zipPath));
        uploadQueue = run.then(() => undefined).catch(() => undefined);
        return run;
    };

    return {
        scan: scan,
        cleanupStaging: cleanupStaging,
        flush: async () => {
            await uploadQueue;
            await scanQueue;
        },
        listPublic: listPublic,
        listAll: listAll,
        get: get,
        getAny: getAny,
        getTombstone: getTombstone,
        resolveAssetPath: resolveAssetPath,
        resolveThumbnailPath: resolveThumbnailPath,
        remove: remove,
        upload: upload,
        runTombstoneSweep: runTombstoneSweep,
    };
}
