import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    getMultipartBoundary,
    MaxFileSizeExceededError,
    MultipartParseError,
    parseMultipartStream,
    type MultipartPart,
} from "@mjackson/multipart-parser";
import { sValidator } from "@hono/standard-validator";
import { type Context, Hono } from "hono";
import * as v from "valibot";
import {
    isTokenScope,
    LOG_CATEGORIES,
    LOG_LEVELS,
    MAX_PACKAGE_ID_LENGTH,
    type RendererConfig,
    type TokenScope,
} from "../shared.ts";
import type { AuthStore } from "./auth.ts";
import { InvalidRequestError, problem, problemResponse } from "./errors.ts";
import type { ServerEvents } from "./events.ts";
import { getGraphicManifestInfo, type GraphicRecord, type GraphicsStore } from "./graphics.ts";
import type { LogStore } from "./logs.ts";
import {
    CreateRendererSchema,
    LayerSchema,
    ReorderLayersSchema,
    UpdateLayerSchema,
    UpdateRendererSchema,
    type RendererService,
} from "./renderers.ts";
import type { RendererGateway } from "./sockets.ts";
import { streamServerEvents } from "./sse.ts";
import { NameSchema } from "./state.ts";

type AdminApiDeps = {
    renderers: RendererService;
    graphics: GraphicsStore;
    gateway: RendererGateway;
    auth: AuthStore;
    logs: LogStore;
    uploadTempDir: string;
    events: ServerEvents;
};

export type AdminApi = ReturnType<typeof createAdminApi>;

const SettingsSchema = v.object({ enabled: v.boolean() });
const CreateTokenSchema = v.object({
    label: NameSchema,
    scope: v.custom<TokenScope>(isTokenScope, 'scope must be "api" or "renderer:<id>"'),
});
const LogQuerySchema = v.object({
    level: v.optional(v.picklist(LOG_LEVELS)),
    category: v.optional(v.picklist(LOG_CATEGORIES)),
    search: v.optional(v.pipe(v.string(), v.maxLength(200))),
});

const MAX_UPLOAD_BODY_BYTES = 210 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;

class UploadInputError extends Error {}

class UploadTooLargeError extends UploadInputError {}

function uploadErrorStatus(error: unknown): 400 | 413 | undefined {
    if (error instanceof MaxFileSizeExceededError || error instanceof UploadTooLargeError) {
        return 413;
    }
    return error instanceof MultipartParseError || error instanceof UploadInputError ? 400 : undefined;
}

type UploadParts = { packageId?: string; zipPath?: string };

async function storeUploadPart(part: MultipartPart, parts: UploadParts, uploadTempDir: string): Promise<void> {
    if (part.name === "packageId" && part.isText) {
        if (parts.packageId !== undefined) {
            throw new UploadInputError('The "packageId" field must appear once');
        }
        if (part.size > MAX_PACKAGE_ID_LENGTH) {
            throw new UploadInputError(
                `packageId must be at most ${MAX_PACKAGE_ID_LENGTH} letters, digits, "-" or "_"`,
            );
        }
        parts.packageId = part.text;
        return;
    }
    if (part.name === "file" && part.isFile) {
        if (parts.zipPath !== undefined) {
            throw new UploadInputError('The "file" field must appear once');
        }
        if (part.filename && !part.filename.toLowerCase().endsWith(".zip")) {
            throw new UploadInputError('The "file" field must be a ZIP file');
        }
        const zipPath = join(uploadTempDir, `${randomUUID()}.zip`);
        parts.zipPath = zipPath;
        await pipeline(Readable.from(part.content), createWriteStream(zipPath, { flags: "wx" }));
        return;
    }
    throw new UploadInputError('Expected exactly one "packageId" field and one "file" field');
}

async function parseUploadParts(
    body: ReadableStream<Uint8Array>,
    boundary: string,
    uploadTempDir: string,
): Promise<{ packageId: string; zipPath: string }> {
    const parts: UploadParts = {};
    try {
        await mkdir(uploadTempDir, { recursive: true });
        for await (const part of parseMultipartStream(body, {
            boundary: boundary,
            maxFileSize: MAX_UPLOAD_FILE_BYTES,
        })) {
            await storeUploadPart(part, parts, uploadTempDir);
        }
        if (parts.packageId === undefined || parts.zipPath === undefined) {
            throw new UploadInputError('Expected exactly one "packageId" field and one "file" field');
        }
        return { packageId: parts.packageId, zipPath: parts.zipPath };
    } catch (error) {
        if (parts.zipPath) {
            await rm(parts.zipPath, { force: true });
        }
        throw error;
    }
}

function invalidRequestResponse(error: unknown): Response {
    if (error instanceof InvalidRequestError) {
        return problemResponse(problem(400, "Bad Request", error.message), 400);
    }
    throw error;
}

async function receiveUpload(
    c: Context,
    uploadTempDir: string,
): Promise<{ packageId: string; zipPath: string } | Response> {
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BODY_BYTES) {
        return problemResponse(problem(413, "Payload Too Large", "Upload exceeds the size limit"), 413);
    }

    const body = c.req.raw.body;
    const boundary = body && getMultipartBoundary(c.req.header("content-type") ?? "");
    if (!body || !boundary) {
        return problemResponse(problem(400, "Bad Request", "Expected multipart form data"), 400);
    }

    let totalBytes = 0;
    const limitedBody = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
                totalBytes += chunk.byteLength;
                if (totalBytes > MAX_UPLOAD_BODY_BYTES) {
                    controller.error(new UploadTooLargeError("Upload exceeds the size limit"));
                    return;
                }
                controller.enqueue(chunk);
            },
        }),
    );

    try {
        return await parseUploadParts(limitedBody, boundary, uploadTempDir);
    } catch (error) {
        const status = uploadErrorStatus(error);
        if (status === undefined) {
            throw error;
        }
        return problemResponse(
            problem(
                status,
                status === 413 ? "Payload Too Large" : "Bad Request",
                error instanceof Error ? error.message : String(error),
            ),
            status,
        );
    }
}

export function createAdminApi(deps: AdminApiDeps) {
    const { renderers, graphics, gateway, auth, logs, uploadTempDir, events } = deps;

    const rendererSummary = (config: RendererConfig) => ({
        ...config,
        status: gateway.getStatus(config.id),
        layers: config.layers.map((layer) => ({
            id: layer.id,
            name: layer.name,
            graphicCount: renderers.getRenderTargetInfo(config.id, { layer: layer.id })?.graphicInstances.length ?? 0,
        })),
    });

    const graphicSummary = (record: GraphicRecord) => {
        const tombstone = graphics.getTombstone(record.id);
        return {
            id: record.id,
            packageId: record.packageId,
            manifestPath: record.manifestPath,
            ...getGraphicManifestInfo(record.manifest),
            valid: record.validation.valid,
            issues: record.validation.issues,
            updatedAt: record.updatedAt,
            pendingDelete: tombstone !== undefined,
            deleteAfter: tombstone?.deleteAfter,
        };
    };

    const app = new Hono()
        .get("/renderers", (c) => c.json({ renderers: renderers.listConfigs().map(rendererSummary) }))
        .post("/renderers", sValidator("json", CreateRendererSchema), async (c) => {
            try {
                const renderer = await renderers.createRenderer(c.req.valid("json"));
                events.emit({ type: "renderers.changed", rendererId: renderer.id });
                return c.json({ renderer: rendererSummary(renderer) }, 201);
            } catch (error) {
                return invalidRequestResponse(error);
            }
        })
        .patch("/renderers/:rendererId", sValidator("json", UpdateRendererSchema), async (c) => {
            const renderer = await renderers.updateRenderer(c.req.param("rendererId"), c.req.valid("json"));
            if (!renderer) {
                return c.json(problem(404, "Not Found", "No renderer with that id"), 404);
            }
            events.emit({ type: "renderers.changed", rendererId: renderer.id });
            return c.json({ renderer: rendererSummary(renderer) });
        })
        .delete("/renderers/:rendererId", async (c) => {
            const ok = await renderers.deleteRenderer(c.req.param("rendererId"));
            if (!ok) {
                return c.json(problem(404, "Not Found", "No renderer with that id"), 404);
            }
            events.emit({ type: "renderers.changed" });
            return c.json({});
        })
        .post("/renderers/:rendererId/layers", sValidator("json", LayerSchema), async (c) => {
            try {
                const renderer = await renderers.addLayer(c.req.param("rendererId"), c.req.valid("json"));
                if (!renderer) {
                    return c.json(problem(404, "Not Found", "No renderer with that id"), 404);
                }
                events.emit({ type: "renderers.changed", rendererId: renderer.id });
                return c.json({ renderer: rendererSummary(renderer) }, 201);
            } catch (error) {
                return invalidRequestResponse(error);
            }
        })
        .put("/renderers/:rendererId/layers", sValidator("json", ReorderLayersSchema), async (c) => {
            try {
                const renderer = await renderers.reorderLayers(c.req.param("rendererId"), c.req.valid("json").ids);
                if (!renderer) {
                    return c.json(problem(404, "Not Found", "No renderer with that id"), 404);
                }
                events.emit({ type: "renderers.changed", rendererId: renderer.id });
                return c.json({ renderer: rendererSummary(renderer) });
            } catch (error) {
                return invalidRequestResponse(error);
            }
        })
        .patch("/renderers/:rendererId/layers/:layerId", sValidator("json", UpdateLayerSchema), async (c) => {
            const renderer = await renderers.updateLayer(
                c.req.param("rendererId"),
                c.req.param("layerId"),
                c.req.valid("json"),
            );
            if (!renderer) {
                return c.json(problem(404, "Not Found", "No renderer or layer with that id"), 404);
            }
            events.emit({ type: "renderers.changed", rendererId: renderer.id });
            return c.json({ renderer: rendererSummary(renderer) });
        })
        .delete("/renderers/:rendererId/layers/:layerId", async (c) => {
            const renderer = await renderers.removeLayer(c.req.param("rendererId"), c.req.param("layerId"));
            if (!renderer) {
                return c.json(problem(404, "Not Found", "No renderer with that id"), 404);
            }
            events.emit({ type: "renderers.changed", rendererId: renderer.id });
            return c.json({ renderer: rendererSummary(renderer) });
        })
        .get("/graphics/packages", (c) => c.json({ graphics: graphics.listAll().map(graphicSummary) }))
        .get("/graphics/:graphicId", (c) => {
            const record = graphics.getAny(c.req.param("graphicId"));
            if (!record) {
                return problemResponse(problem(404, "Not Found", "No Graphic found"), 404);
            }
            const tombstone = graphics.getTombstone(record.id);
            return c.json({
                graphic: record.manifest,
                metadata: { createdAt: record.updatedAt },
                pendingDelete: tombstone !== undefined,
                deleteAfter: tombstone?.deleteAfter,
            });
        })
        .post("/graphics/upload", async (c) => {
            const input = await receiveUpload(c, uploadTempDir);
            if (input instanceof Response) {
                return input;
            }

            try {
                const result = await graphics.upload(input.packageId, input.zipPath);
                if (!result.ok) {
                    return problemResponse(problem(result.status, "Upload failed", result.error), result.status);
                }
                events.emit({ type: "graphics.changed" });
                return c.json({ graphicIds: result.graphicIds });
            } catch (error) {
                return problemResponse(
                    problem(500, "Internal Server Error", error instanceof Error ? error.message : String(error)),
                    500,
                );
            } finally {
                await rm(input.zipPath, { force: true });
            }
        })
        .post("/graphics/rescan", async (c) => {
            await graphics.scan();
            events.emit({ type: "graphics.changed" });
            return c.json({});
        })
        .get("/settings", (c) => c.json({ authEnabled: auth.isEnabled() }))
        .patch("/settings", sValidator("json", SettingsSchema), async (c) => {
            try {
                await auth.setEnabled(c.req.valid("json").enabled);
                return c.json({ authEnabled: auth.isEnabled() });
            } catch (error) {
                return invalidRequestResponse(error);
            }
        })
        .get("/tokens", (c) => c.json({ tokens: auth.listTokens() }))
        .post("/tokens", sValidator("json", CreateTokenSchema), async (c) => {
            const { label, scope } = c.req.valid("json");
            try {
                const { token, record } = await auth.createToken(label, scope);
                return c.json({ token: token, record: record }, 201);
            } catch (error) {
                return invalidRequestResponse(error);
            }
        })
        .delete("/tokens/:tokenId", async (c) => {
            try {
                const revoked = await auth.revokeToken(c.req.param("tokenId"));
                if (!revoked) {
                    return problemResponse(problem(404, "Not Found", "No token with that id"), 404);
                }
            } catch (error) {
                return invalidRequestResponse(error);
            }
            return c.json({});
        })
        .get("/logs", sValidator("query", LogQuerySchema), (c) => c.json({ logs: logs.list(c.req.valid("query")) }))
        .get("/events", (c) => streamServerEvents(c, events.subscribe));

    return app;
}
