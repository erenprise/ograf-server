import { serveStatic } from "@hono/node-server/serve-static";
import { Scalar } from "@scalar/hono-api-reference";
import { deleteCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getMimeType } from "hono/utils/mime";
import { sValidator } from "@hono/standard-validator";
import * as v from "valibot";
import { MAX_CONTROL_MESSAGE_BYTES, toRendererRuntimeConfig } from "../shared.ts";
import { createAdminApi } from "./admin.ts";
import { type AppAssets, OGRAF_OPENAPI_ASSET } from "./assets.ts";
import { adminApiReferenceConfig, adminOpenApiDocument } from "./admin-openapi-doc.ts";
import {
    ADMIN_SESSION_COOKIE,
    checkApiAccess,
    checkRendererAccess,
    scopeAllowsRenderer,
    type AccessHeaders,
    type AuthStore,
} from "./auth.ts";
import { problem, problemResponse } from "./errors.ts";
import type { ServerEvents } from "./events.ts";
import type { GraphicsStore } from "./graphics.ts";
import type { LogStore } from "./logs.ts";
import { createOgrafApi } from "./ograf.ts";
import type { RendererService } from "./renderers.ts";
import type { RendererGateway } from "./sockets.ts";

type AppDeps = {
    graphics: GraphicsStore;
    renderers: RendererService;
    gateway: RendererGateway;
    auth: AuthStore;
    logs: LogStore;
    uploadTempDir: string;
    events: ServerEvents;
    getLocalOrigins: () => string[];
    renderHtml: (entry: "admin" | "renderer", url: string) => Promise<string>;
    appAssets: AppAssets;
};

const SessionSchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) });

const requestAccessHeaders = (c: Context): AccessHeaders => ({
    authorization: c.req.header("authorization"),
    cookie: c.req.header("cookie"),
});

const sessionCookieOptions = (c: Context) => ({
    httpOnly: true,
    sameSite: "Strict" as const,
    path: "/api",
    secure: isHttpsRequest(c),
});

export function createApp(deps: AppDeps): Hono {
    const { graphics, renderers, gateway, auth, logs, uploadTempDir, events, getLocalOrigins, renderHtml, appAssets } =
        deps;
    const app = new Hono();
    const serveAppAsset = async (c: Context, key: string): Promise<Response> => {
        const asset = await appAssets.read(key);
        if (!asset) {
            return c.notFound();
        }
        c.header("Content-Type", getMimeType(key) ?? "application/octet-stream");
        c.header("Content-Length", String(asset.byteLength));
        c.header("Cache-Control", "public, max-age=31536000, immutable");
        return c.req.method === "HEAD" ? c.body(null) : c.body(asset);
    };

    const requireApiAuth = () =>
        createMiddleware(async (c, next) => {
            if (!checkApiAccess(requestAccessHeaders(c), auth)) {
                return problemResponse(
                    problem(401, "Unauthorized", 'A valid API bearer token or admin session (scope "api") is required'),
                    401,
                );
            }
            return next();
        });

    app.get("/healthz", (c) => c.json({ ok: true }));

    app.use("/api/ograf/v1/*", bodyLimit({ maxSize: MAX_CONTROL_MESSAGE_BYTES }));
    app.use("/api/ograf/v1/*", requireApiAuth());
    app.route(
        "/api/ograf/v1",
        createOgrafApi({ graphics: graphics, renderers: renderers, gateway: gateway, events: events }),
    );

    const adminJsonBodyLimit = bodyLimit({ maxSize: MAX_CONTROL_MESSAGE_BYTES });
    app.use("/api/admin/*", (c, next) =>
        c.req.path === "/api/admin/graphics/upload" ? next() : adminJsonBodyLimit(c, next),
    );
    const adminApiAuth = requireApiAuth();
    app.use("/api/admin/*", (c, next) =>
        c.req.path === "/api/admin/session" && (c.req.method === "POST" || c.req.method === "DELETE")
            ? next()
            : adminApiAuth(c, next),
    );
    app.post("/api/admin/session", sValidator("json", SessionSchema), (c) => {
        const result = auth.verify(c.req.valid("json").token);
        if (!result.ok || result.record.scope !== "api") {
            return problemResponse(problem(401, "Unauthorized", "A valid API-scoped token is required"), 401);
        }
        setCookie(c, ADMIN_SESSION_COOKIE, c.req.valid("json").token, sessionCookieOptions(c));
        return c.json({});
    });
    app.delete("/api/admin/session", (c) => {
        deleteCookie(c, ADMIN_SESSION_COOKIE, sessionCookieOptions(c));
        return c.json({});
    });
    app.route(
        "/api/admin",
        createAdminApi({
            renderers: renderers,
            graphics: graphics,
            gateway: gateway,
            auth: auth,
            logs: logs,
            uploadTempDir: uploadTempDir,
            events: events,
            getLocalOrigins: getLocalOrigins,
        }),
    );

    app.get("/docs/ograf/openapi.yaml", async (c) =>
        c.body(await appAssets.readText(OGRAF_OPENAPI_ASSET), 200, { "Content-Type": "application/yaml" }),
    );
    app.get(
        "/docs/ograf",
        Scalar((c) => ({
            url: "/docs/ograf/openapi.yaml",
            pageTitle: "OGraf API Reference",
            servers: [{ url: new URL("/api/ograf/v1", c.req.url).href }],
        })),
    );
    app.on(["GET", "HEAD"], "/docs/json-schemas/*", (c) => serveAppAsset(c, c.req.path.slice("/docs/".length)));
    app.get(
        "/docs/admin",
        Scalar({ content: adminOpenApiDocument, pageTitle: "OGraf Server Admin API", ...adminApiReferenceConfig }),
    );

    app.get("/render/:rendererId", async (c) => {
        const rendererId = c.req.param("rendererId");
        const config = renderers.getConfig(rendererId);
        if (!config) {
            return c.text("Renderer not found", 404);
        }

        const tokenQuery = c.req.query("token");
        if (auth.isEnabled() && tokenQuery) {
            const result = auth.verify(tokenQuery);
            if (!result.ok || !scopeAllowsRenderer(result.record.scope, rendererId)) {
                return c.text("Invalid token", 401);
            }
            setCookie(c, `ograf_renderer_${rendererId}`, tokenQuery, {
                httpOnly: true,
                sameSite: "Lax",
                path: `/render/${rendererId}`,
                secure: isHttpsRequest(c),
            });
            c.header("Cache-Control", "no-store");
            c.header("Referrer-Policy", "no-referrer");
            return c.redirect(`/render/${rendererId}`, 303);
        }

        if (!checkRendererAccess(requestAccessHeaders(c), rendererId, auth)) {
            return c.text("Unauthorized", 401);
        }

        const html = await renderHtml("renderer", c.req.path);
        const configScript = `<script>window.__OGRAF_RENDERER__=${safeJsonForScript(toRendererRuntimeConfig(config))}</script>`;
        const finalHtml = html.includes("</head>")
            ? html.replace("</head>", `${configScript}</head>`)
            : `${configScript}${html}`;
        c.header("Cache-Control", "no-store");
        c.header("Referrer-Policy", "no-referrer");
        return c.html(finalHtml);
    });

    app.get("/render/:rendererId/assets/:packageId/:revision/*", async (c) => {
        const rendererId = c.req.param("rendererId");
        if (!renderers.getConfig(rendererId)) {
            return c.notFound();
        }
        if (!checkRendererAccess(requestAccessHeaders(c), rendererId, auth)) {
            return c.text("Unauthorized", 401);
        }
        const packageId = c.req.param("packageId");
        const revision = c.req.param("revision");
        const relPath = c.req.path.split(`/render/${rendererId}/assets/${packageId}/${revision}/`)[1] ?? "";
        const filePath = await graphics.resolveAssetPath(packageId, revision, relPath);
        if (!filePath) {
            return c.notFound();
        }
        return serveStatic({ path: filePath })(c, async () => {});
    });

    app.on(["GET", "HEAD"], "/assets/*", (c) => serveAppAsset(c, c.req.path.slice(1)));
    app.get("*", async (c) => {
        const html = await renderHtml("admin", c.req.path);
        return c.html(html);
    });

    return app;
}

function isHttpsRequest(c: Context): boolean {
    return new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

function safeJsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(
        /[<>&\u2028\u2029]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}
