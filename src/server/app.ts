import { serveStatic } from "@hono/node-server/serve-static";
import { Scalar } from "@scalar/hono-api-reference";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { parse as parseCookieHeader } from "hono/utils/cookie";
import { getMimeType } from "hono/utils/mime";
import { sValidator } from "@hono/standard-validator";
import * as v from "valibot";
import { MAX_CONTROL_MESSAGE_BYTES, type AdminEvent } from "../shared.ts";
import { createAdminApi } from "./admin.ts";
import { type AppAssets, OGRAF_OPENAPI_ASSET } from "./assets.ts";
import { adminOpenApiDocument } from "./admin-openapi-doc.ts";
import { scopeAllowsRenderer, type AuthStore } from "./auth.ts";
import { problem, problemResponse } from "./errors.ts";
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
    emitEvent: (event: AdminEvent) => void;
    subscribeEvents: (fn: (event: AdminEvent) => void) => () => void;
    renderHtml: (entry: "admin" | "renderer", url: string) => Promise<string>;
    appAssets: AppAssets;
};

const ADMIN_SESSION_COOKIE = "ograf_admin_token";
const SessionSchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) });

function verifyToken(auth: AuthStore, token: string | undefined) {
    if (!token) {
        return undefined;
    }
    const result = auth.verify(token);
    return result.ok ? result.record : undefined;
}

export function checkRendererAccess(
    headers: { authorization?: string; cookie?: string },
    rendererId: string,
    auth: AuthStore,
): boolean {
    if (!auth.isEnabled()) {
        return true;
    }

    const checkToken = (token: string | undefined): boolean => {
        const scope = verifyToken(auth, token)?.scope;
        return scope !== undefined && scopeAllowsRenderer(scope, rendererId);
    };

    const bearer = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : undefined;
    const cookieToken = parseCookieHeader(headers.cookie ?? "")[`ograf_renderer_${rendererId}`];
    return checkToken(bearer) || checkToken(cookieToken);
}

const rendererAccessHeaders = (c: Context) => ({
    authorization: c.req.header("authorization"),
    cookie: c.req.header("cookie"),
});

export function createApp(deps: AppDeps): Hono {
    const {
        graphics,
        renderers,
        gateway,
        auth,
        logs,
        uploadTempDir,
        emitEvent,
        subscribeEvents,
        renderHtml,
        appAssets,
    } = deps;
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

    const requireApiAuth = (allowAdminSession: boolean) =>
        createMiddleware(async (c, next) => {
            if (!auth.isEnabled()) {
                return next();
            }

            const header = c.req.header("authorization");
            const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
            const sessionToken = allowAdminSession ? getCookie(c, ADMIN_SESSION_COOKIE) : undefined;
            if (verifyToken(auth, bearer)?.scope === "api" || verifyToken(auth, sessionToken)?.scope === "api") {
                await next();
                return;
            }

            return problemResponse(
                problem(401, "Unauthorized", 'A valid API bearer token or admin session (scope "api") is required'),
                401,
            );
        });

    const sessionCookieOptions = (c: Context) => ({
        httpOnly: true,
        sameSite: "Strict" as const,
        path: "/api",
        secure: isHttpsRequest(c),
    });

    app.get("/healthz", (c) => c.json({ ok: true }));

    app.post(
        "/api/session",
        bodyLimit({ maxSize: MAX_CONTROL_MESSAGE_BYTES }),
        sValidator("json", SessionSchema),
        (c) => {
            const result = auth.verify(c.req.valid("json").token);
            if (!result.ok || result.record.scope !== "api") {
                return problemResponse(problem(401, "Unauthorized", "A valid API-scoped token is required"), 401);
            }
            setCookie(c, ADMIN_SESSION_COOKIE, c.req.valid("json").token, sessionCookieOptions(c));
            return c.json({});
        },
    );
    app.delete("/api/session", (c) => {
        deleteCookie(c, ADMIN_SESSION_COOKIE, sessionCookieOptions(c));
        return c.json({});
    });

    app.use("/api/ograf/v1/*", bodyLimit({ maxSize: MAX_CONTROL_MESSAGE_BYTES }));
    app.use("/api/ograf/v1/*", requireApiAuth(true));
    app.route(
        "/api/ograf/v1",
        createOgrafApi({ graphics: graphics, renderers: renderers, gateway: gateway, emitEvent: emitEvent }),
    );

    const adminJsonBodyLimit = bodyLimit({ maxSize: MAX_CONTROL_MESSAGE_BYTES });
    app.use("/api/admin/*", (c, next) =>
        c.req.path === "/api/admin/graphics/upload" ? next() : adminJsonBodyLimit(c, next),
    );
    app.use("/api/admin/*", requireApiAuth(true));
    app.route(
        "/api/admin",
        createAdminApi({
            renderers: renderers,
            graphics: graphics,
            gateway: gateway,
            auth: auth,
            logs: logs,
            uploadTempDir: uploadTempDir,
            emitEvent: emitEvent,
            subscribeEvents: subscribeEvents,
        }),
    );

    app.get("/docs/ograf/openapi.yaml", async (c) =>
        c.body(await appAssets.readText(OGRAF_OPENAPI_ASSET), 200, { "Content-Type": "application/yaml" }),
    );
    app.get("/docs/ograf", Scalar({ url: "/docs/ograf/openapi.yaml", pageTitle: "OGraf API Reference" }));
    app.on(["GET", "HEAD"], "/docs/json-schemas/*", (c) => serveAppAsset(c, c.req.path.slice("/docs/".length)));
    app.get("/docs/admin", Scalar({ content: adminOpenApiDocument, pageTitle: "OGraf Server Admin API" }));

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

        if (!checkRendererAccess(rendererAccessHeaders(c), rendererId, auth)) {
            return c.text("Unauthorized", 401);
        }

        const html = await renderHtml("renderer", c.req.path);
        const configScript = `<script>window.__OGRAF_RENDERER__=${safeJsonForScript({
            id: config.id,
            resolution: config.resolution,
            frameRate: config.frameRate,
            accessToPublicInternet: config.accessToPublicInternet,
            layers: config.layers,
        })}</script>`;
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
        if (!checkRendererAccess(rendererAccessHeaders(c), rendererId, auth)) {
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
