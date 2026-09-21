import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { type Context, Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import packageJson from "../../package.json" with { type: "json" };
import { isGraphicFilter, isJsonObject, type AdminEvent, type JsonObject } from "../shared.ts";
import {
    GraphicMethodError,
    problem,
    problemResponse,
    RendererDisconnectedError,
    RendererOfflineError,
    RendererTimeoutError,
} from "./errors.ts";
import { getGraphicListInfo, type GraphicsStore } from "./graphics.ts";
import { RENDERER_CUSTOM_ACTIONS, type RendererService } from "./renderers.ts";
import type { RendererGateway } from "./sockets.ts";

type OgrafApiDeps = {
    graphics: GraphicsStore;
    renderers: RendererService;
    gateway: RendererGateway;
    emitEvent: (event: AdminEvent) => void;
};

function transportErrorToProblem(error: unknown, instance: string) {
    if (error instanceof GraphicMethodError) {
        return { status: 550, body: problem(550, "Graphic method error", error.message, instance) };
    }
    if (error instanceof RendererOfflineError || error instanceof RendererDisconnectedError) {
        return { status: 503, body: problem(503, "Renderer Offline", error.message, instance) };
    }
    if (error instanceof RendererTimeoutError) {
        return { status: 500, body: problem(500, "Renderer error", error.message, instance) };
    }
    return {
        status: 500,
        body: problem(500, "Internal Server Error", error instanceof Error ? error.message : String(error), instance),
    };
}

function parseRenderTarget(raw: string | undefined): JsonObject | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        return isJsonObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

async function readJsonObject(c: Context): Promise<JsonObject | undefined> {
    try {
        const body: unknown = await c.req.json();
        return isJsonObject(body) ? body : undefined;
    } catch {
        return undefined;
    }
}

function invalidBody(c: Context) {
    return c.json(problem(400, "Bad Request", "Request body must be a JSON object", c.req.path), 400);
}

function notFound(c: Context, detail: string) {
    return c.json(problem(404, "Not Found", detail, c.req.path), 404);
}

function rendererOffline(c: Context, rendererId: string) {
    return problemResponse(
        problem(503, "Renderer Offline", `Renderer "${rendererId}" is not connected`, c.req.path),
        503,
    );
}

async function withTransport(c: Context, run: () => Promise<unknown>): Promise<Response> {
    try {
        return c.json(await run());
    } catch (error) {
        const { status, body } = transportErrorToProblem(error, c.req.path);
        return problemResponse(body, status);
    }
}

export function createOgrafApi({ graphics, renderers, gateway, emitEvent }: OgrafApiDeps): Hono {
    const app = new Hono();

    app.get("/", (c) =>
        c.json({
            name: "OGraf Server",
            description: "Manages and renders OGraf broadcast graphics",
            version: packageJson.version,
        }),
    );

    app.get("/graphics", (c) => c.json({ graphics: graphics.listPublic().map(getGraphicListInfo) }));

    app.get("/graphics/:graphicId", (c) => {
        const record = graphics.get(c.req.param("graphicId"));
        if (!record) {
            return notFound(c, "No Graphic found with the given ID");
        }
        return c.json({ graphic: record.manifest, metadata: { createdAt: record.updatedAt } });
    });

    app.delete("/graphics/:graphicId", async (c) => {
        const force = c.req.query("force") === "true";
        const result = await graphics.remove(c.req.param("graphicId"), { force: force });
        if (result === "not-found") {
            return notFound(c, "No Graphic found with the given ID");
        }
        emitEvent({ type: "graphics.changed" });
        return c.json({});
    });

    app.get("/graphics/:graphicId/thumbnail", async (c) => {
        const file = c.req.query("file");
        if (!file) {
            return c.json(problem(400, "Bad Request", 'Missing "file" query parameter', c.req.path), 400);
        }
        const path = await graphics.resolveThumbnailPath(c.req.param("graphicId"), file);
        if (!path) {
            return notFound(c, "No Graphic or thumbnail found with the given ID and file reference");
        }
        const mime = getMimeType(path) ?? "application/octet-stream";
        try {
            const bytes = await readFile(path);
            return c.body(bytes, 200, { "Content-Type": mime });
        } catch {
            return c.notFound();
        }
    });

    app.get("/renderers", (c) => {
        const list = renderers.listConfigs().map((r) => ({ id: r.id, name: r.name, description: r.description }));
        return c.json({ renderers: list });
    });

    app.get("/renderers/:rendererId", (c) => {
        const info = renderers.getPublicRendererInfo(c.req.param("rendererId"));
        if (!info) {
            return notFound(c, "No Renderer found");
        }
        return c.json({ renderer: info });
    });

    app.get("/renderers/:rendererId/target", (c) => {
        const target = parseRenderTarget(c.req.query("renderTarget"));
        const info = target && renderers.getRenderTargetInfo(c.req.param("rendererId"), target);
        if (!info) {
            return notFound(c, "No RenderTarget found");
        }
        return c.json(info);
    });

    app.post("/renderers/:rendererId/customActions/:customActionId", async (c) => {
        const rendererId = c.req.param("rendererId");
        const customActionId = c.req.param("customActionId");
        if (!renderers.getConfig(rendererId) || !RENDERER_CUSTOM_ACTIONS.some((a) => a.id === customActionId)) {
            return notFound(c, "No Renderer found");
        }
        const body = await readJsonObject(c);
        if (!body) {
            return invalidBody(c);
        }
        if (!gateway.isConnected(rendererId)) {
            return rendererOffline(c, rendererId);
        }
        return withTransport(c, async () => ({
            result: await gateway.sendCommand(rendererId, "rendererCustomAction", {
                ...body,
                customActionId: customActionId,
            }),
        }));
    });

    app.put("/renderers/:rendererId/target/graphicInstance/clear", async (c) => {
        const rendererId = c.req.param("rendererId");
        if (!renderers.getConfig(rendererId)) {
            return notFound(c, "No Renderer found");
        }
        const body = await readJsonObject(c);
        if (!body) {
            return invalidBody(c);
        }
        const filters = body.filters === undefined ? [] : body.filters;
        if (!Array.isArray(filters) || !filters.every(isGraphicFilter)) {
            return invalidBody(c);
        }
        if (!gateway.isConnected(rendererId)) {
            return rendererOffline(c, rendererId);
        }
        return withTransport(c, () => gateway.sendCommand(rendererId, "clear", { filters: filters }));
    });

    app.post("/renderers/:rendererId/target/graphicInstance/load", async (c) => {
        const rendererId = c.req.param("rendererId");
        const renderer = renderers.getConfig(rendererId);
        if (!renderer) {
            return notFound(c, "No Graphic or RenderTarget found");
        }

        const body = await readJsonObject(c);
        if (!body) {
            return invalidBody(c);
        }
        const { renderTarget, graphicId, params } = body;
        if (
            !isJsonObject(renderTarget) ||
            typeof graphicId !== "string" ||
            (params !== undefined && !isJsonObject(params))
        ) {
            return invalidBody(c);
        }
        const layerId = renderers.findLayerIdForTarget(rendererId, renderTarget);
        const record = graphics.get(graphicId);
        if (!layerId || !record?.validation.valid) {
            return notFound(c, "No Graphic or RenderTarget found");
        }

        if (!gateway.isConnected(rendererId)) {
            return rendererOffline(c, rendererId);
        }

        const graphicInstanceId = randomUUID();
        const mainUrl = `/render/${rendererId}/assets/${record.packageId}/${record.revision}/${relativeMain(record)}`;
        return withTransport(c, async () => {
            const result = await gateway.sendCommand(rendererId, "load", {
                graphicInstanceId: graphicInstanceId,
                renderTarget: { layer: layerId },
                graphicId: graphicId,
                graphicRevision: record.revision,
                manifest: record.manifest,
                mainUrl: mainUrl,
                data: isJsonObject(params) ? params.data : undefined,
            });
            return {
                graphicInstanceId: graphicInstanceId,
                statusCode: result?.statusCode ?? 200,
                statusMessage: result?.statusMessage,
            };
        });
    });

    app.post("/renderers/:rendererId/target/graphicInstance/updateAction", (c) => runInstanceAction(c, "updateAction"));
    app.post("/renderers/:rendererId/target/graphicInstance/playAction", (c) => runInstanceAction(c, "playAction"));
    app.post("/renderers/:rendererId/target/graphicInstance/stopAction", (c) => runInstanceAction(c, "stopAction"));
    app.post("/renderers/:rendererId/target/graphicInstance/customActions/:customActionId", (c) =>
        runInstanceAction(c, "graphicCustomAction"),
    );

    async function runInstanceAction(
        c: Context,
        command: "updateAction" | "playAction" | "stopAction" | "graphicCustomAction",
    ) {
        const rendererId = c.req.param("rendererId");
        if (!rendererId || !renderers.getConfig(rendererId)) {
            return notFound(c, "No GraphicInstance or RenderTarget found");
        }

        const body = await readJsonObject(c);
        if (!body) {
            return invalidBody(c);
        }
        const { renderTarget, graphicInstanceId, params } = body;
        if (!isJsonObject(renderTarget) || typeof graphicInstanceId !== "string" || !isJsonObject(params)) {
            return invalidBody(c);
        }
        if (!gateway.isConnected(rendererId)) {
            return rendererOffline(c, rendererId);
        }
        const targetInfo = renderers.getRenderTargetInfo(rendererId, renderTarget);
        if (!targetInfo?.graphicInstances.some((i) => i.graphicInstanceId === graphicInstanceId)) {
            return notFound(c, "No GraphicInstance or RenderTarget found");
        }

        return withTransport(c, async () => {
            const response = await sendInstanceCommand(
                rendererId,
                command,
                graphicInstanceId,
                params,
                c.req.param("customActionId"),
            );
            return {
                graphicInstanceId: graphicInstanceId,
                statusCode: response?.statusCode ?? 200,
                statusMessage: response?.statusMessage,
                ...(command === "playAction" && response && "currentStep" in response
                    ? { currentStep: response.currentStep }
                    : {}),
            };
        });
    }

    function sendInstanceCommand(
        rendererId: string,
        command: "updateAction" | "playAction" | "stopAction" | "graphicCustomAction",
        graphicInstanceId: string,
        params: JsonObject,
        customActionId?: string,
    ) {
        const skipAnimation = typeof params.skipAnimation === "boolean" ? params.skipAnimation : undefined;
        const common = { graphicInstanceId: graphicInstanceId, skipAnimation: skipAnimation };
        switch (command) {
            case "updateAction":
                return gateway.sendCommand(rendererId, command, {
                    ...common,
                    data: params.data,
                });
            case "playAction":
                return gateway.sendCommand(rendererId, command, {
                    ...common,
                    delta: typeof params.delta === "number" ? params.delta : undefined,
                    goto: typeof params.goto === "number" ? params.goto : undefined,
                });
            case "stopAction":
                return gateway.sendCommand(rendererId, command, common);
            case "graphicCustomAction":
                return gateway.sendCommand(rendererId, command, {
                    ...common,
                    id: customActionId ?? "",
                    payload: params.payload,
                });
        }
        throw new Error("Unsupported renderer command");
    }

    return app;
}

function relativeMain(record: { manifest: Record<string, unknown>; manifestDir: string; packageDir: string }): string {
    const main = typeof record.manifest.main === "string" ? record.manifest.main : "";
    const manifestSubPath = relative(record.packageDir, record.manifestDir).split(sep).filter(Boolean).join("/");
    return manifestSubPath ? `${manifestSubPath}/${main}` : main;
}
