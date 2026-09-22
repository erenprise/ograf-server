import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { type Context, Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import packageJson from "../../package.json" with { type: "json" };
import { isGraphicFilter, isJsonObject, type JsonObject, type ServerEvent } from "../shared.ts";
import { errorToProblem, problem, problemResponse } from "./errors.ts";
import type { ServerEvents } from "./events.ts";
import { getGraphicListInfo, type GraphicsStore } from "./graphics.ts";
import { executeInstanceAction, parseInstanceActionInput, type InstanceActionCommand } from "./ograf-actions.ts";
import { RENDERER_CUSTOM_ACTIONS, type RendererService } from "./renderers.ts";
import type { RendererGateway } from "./sockets.ts";
import { streamLatestState, wantsSse } from "./sse.ts";

type OgrafApiDeps = {
    graphics: GraphicsStore;
    renderers: RendererService;
    gateway: RendererGateway;
    events: ServerEvents;
};

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

async function readJson(c: Context): Promise<unknown> {
    try {
        return await c.req.json();
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
        const { status, body } = errorToProblem(error, c.req.path);
        return problemResponse(body, status);
    }
}

const isGraphicsEvent = (event: ServerEvent) => event.type === "graphics.changed";

const matchesRenderer = (event: ServerEvent, rendererId: string) =>
    event.type === "graphics.changed" ||
    (event.type === "renderers.changed" && (!event.rendererId || event.rendererId === rendererId));

export function createOgrafApi({ graphics, renderers, gateway, events }: OgrafApiDeps): Hono {
    const app = new Hono();
    const actionDeps = { renderers: renderers, gateway: gateway };

    const respond = <T>(
        c: Context,
        initial: T,
        getSnapshot: () => T | undefined,
        matches: (event: ServerEvent) => boolean,
    ): Response =>
        wantsSse(c) ? streamLatestState(c, initial, getSnapshot, events.subscribe, matches) : c.json(initial);

    app.get("/", (c) =>
        c.json({
            name: "OGraf Server",
            description: "Manages and renders OGraf broadcast graphics",
            version: packageJson.version,
        }),
    );

    const getGraphics = () => ({ graphics: graphics.listPublic().map(getGraphicListInfo) });
    app.get("/graphics", (c) => respond(c, getGraphics(), getGraphics, isGraphicsEvent));

    app.get("/graphics/:graphicId", (c) => {
        const graphicId = c.req.param("graphicId");
        const getSnapshot = () => {
            const record = graphics.get(graphicId);
            return record ? { graphic: record.manifest, metadata: { createdAt: record.updatedAt } } : undefined;
        };
        const initial = getSnapshot();
        if (!initial) {
            return notFound(c, "No Graphic found with the given ID");
        }
        return respond(c, initial, getSnapshot, isGraphicsEvent);
    });

    app.delete("/graphics/:graphicId", async (c) => {
        const force = c.req.query("force") === "true";
        const result = await graphics.remove(c.req.param("graphicId"), { force: force });
        if (result === "not-found") {
            return notFound(c, "No Graphic found with the given ID");
        }
        events.emit({ type: "graphics.changed" });
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

    const getRenderers = () => ({
        renderers: renderers.listConfigs().map((renderer) => ({
            id: renderer.id,
            name: renderer.name,
            description: renderer.description,
        })),
    });
    app.get("/renderers", (c) =>
        respond(c, getRenderers(), getRenderers, (event) => event.type === "renderers.changed"),
    );

    app.get("/renderers/:rendererId", (c) => {
        const rendererId = c.req.param("rendererId");
        const getSnapshot = () => {
            const info = renderers.getPublicRendererInfo(rendererId);
            return info ? { renderer: info } : undefined;
        };
        const initial = getSnapshot();
        if (!initial) {
            return notFound(c, "No Renderer found");
        }
        return respond(c, initial, getSnapshot, (event) => matchesRenderer(event, rendererId));
    });

    app.get("/renderers/:rendererId/target", (c) => {
        const rendererId = c.req.param("rendererId");
        const target = parseRenderTarget(c.req.query("renderTarget"));
        const getSnapshot = () => (target ? renderers.getRenderTargetInfo(rendererId, target) : undefined);
        const initial = getSnapshot();
        if (!initial) {
            return notFound(c, "No RenderTarget found");
        }
        return respond(c, initial, getSnapshot, (event) => matchesRenderer(event, rendererId));
    });

    app.post("/renderers/:rendererId/customActions/:customActionId", async (c) => {
        const rendererId = c.req.param("rendererId");
        const customActionId = c.req.param("customActionId");
        if (!renderers.getConfig(rendererId) || !RENDERER_CUSTOM_ACTIONS.some((a) => a.id === customActionId)) {
            return notFound(c, "No Renderer found");
        }
        const body = await readJson(c);
        if (!isJsonObject(body)) {
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
        const body = await readJson(c);
        if (!isJsonObject(body)) {
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

        const body = await readJson(c);
        if (!isJsonObject(body)) {
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

    async function runInstanceAction(c: Context, command: InstanceActionCommand) {
        const rendererId = c.req.param("rendererId");
        if (!rendererId) {
            return notFound(c, "No GraphicInstance or RenderTarget found");
        }
        const input = parseInstanceActionInput(await readJson(c));
        if (!input) {
            return invalidBody(c);
        }
        return withTransport(c, () =>
            executeInstanceAction(actionDeps, rendererId, command, input, c.req.param("customActionId")),
        );
    }

    return app;
}

function relativeMain(record: { manifest: Record<string, unknown>; manifestDir: string; packageDir: string }): string {
    const main = typeof record.manifest.main === "string" ? record.manifest.main : "";
    const manifestSubPath = relative(record.packageDir, record.manifestDir).split(sep).filter(Boolean).join("/");
    return manifestSubPath ? `${manifestSubPath}/${main}` : main;
}
