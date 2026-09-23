import type { ApiReferenceConfiguration } from "@scalar/hono-api-reference";
import packageJson from "../../package.json" with { type: "json" };

export const adminOpenApiDocument = {
    openapi: "3.0.3",
    info: {
        title: "OGraf Server Admin API",
        description:
            "Server administration for renderer, graphic, settings and token management. Authentication accepts an API bearer token or the HttpOnly admin session cookie. Authentication can only be enabled when an API-scoped token exists.",
        version: packageJson.version,
    },
    servers: [{ url: "/api/admin" }],
    security: [{ bearerAuth: [] }, { adminSession: [] }],
    components: {
        securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", description: "An API-scoped token" },
            adminSession: {
                type: "apiKey",
                in: "cookie",
                name: "ograf_admin_token",
                description: "HttpOnly SameSite=Strict cookie created by POST /session",
            },
        },
    },
    paths: {
        "/session": {
            post: {
                summary: "Start an admin session with an API-scoped token",
                security: [],
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { type: "object", required: ["token"] } } },
                },
                responses: { 200: { description: "Session cookie set" }, 401: { description: "Invalid token" } },
            },
            delete: {
                summary: "End the admin session",
                security: [],
                responses: { 200: { description: "Session cookie cleared" } },
            },
        },
        "/renderers": {
            get: { summary: "List renderers (with live status and layers)", responses: { 200: { description: "OK" } } },
            post: { summary: "Create a renderer", responses: { 201: { description: "Created" } } },
        },
        "/renderers/{rendererId}": {
            patch: { summary: "Update a renderer", responses: { 200: { description: "OK" } } },
            delete: { summary: "Delete a renderer", responses: { 200: { description: "OK" } } },
        },
        "/renderers/{rendererId}/layers": {
            post: { summary: "Add a layer to a renderer", responses: { 201: { description: "Created" } } },
            put: {
                summary: "Reorder a renderer's layers (array position defines layer order)",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["ids"],
                                properties: { ids: { type: "array", items: { type: "string" } } },
                            },
                        },
                    },
                },
                responses: { 200: { description: "OK" }, 400: { description: "Invalid layer order" } },
            },
        },
        "/renderers/{rendererId}/layers/{layerId}": {
            patch: { summary: "Rename a layer", responses: { 200: { description: "OK" } } },
            delete: { summary: "Remove a layer", responses: { 200: { description: "OK" } } },
        },
        "/graphics/packages": {
            get: {
                summary: "List all graphic packages, including invalid ones with validation diagnostics",
                responses: { 200: { description: "OK" } },
            },
        },
        "/graphics/{graphicId}": {
            get: {
                summary: "Get raw manifest and metadata for a graphic (including tombstoned ones)",
                responses: { 200: { description: "OK" }, 404: { description: "Not found" } },
            },
        },
        "/graphics/upload": {
            post: {
                summary: "Upload a ZIP package of one or more Graphics (multipart/form-data: packageId, file)",
                requestBody: {
                    required: true,
                    content: { "multipart/form-data": { schema: { type: "object", required: ["packageId", "file"] } } },
                },
                responses: { 200: { description: "OK" } },
            },
        },
        "/graphics/rescan": {
            post: {
                summary: "Rescan the ./ograf-server/graphics folder from disk",
                responses: { 200: { description: "OK" } },
            },
        },
        "/settings": {
            get: { summary: "Get server settings and local access URLs", responses: { 200: { description: "OK" } } },
            patch: {
                summary: "Update server settings (e.g. enable/disable auth)",
                responses: { 200: { description: "OK" } },
            },
        },
        "/tokens": {
            get: { summary: "List API tokens (metadata only, no secrets)", responses: { 200: { description: "OK" } } },
            post: {
                summary: "Create a token (plaintext token is only ever returned once)",
                responses: { 201: { description: "Created" } },
            },
        },
        "/tokens/{tokenId}": {
            delete: { summary: "Revoke a token", responses: { 200: { description: "OK" } } },
        },
        "/logs": {
            get: {
                summary: "Fetch recent log entries (level/category/search query filters)",
                responses: { 200: { description: "OK" } },
            },
        },
        "/events": {
            get: {
                summary: "Server-sent events stream of live log and renderer/graphic change events",
                responses: { 200: { description: "OK" } },
            },
        },
    },
} as const satisfies NonNullable<ApiReferenceConfiguration["content"]>;

export const adminApiReferenceConfig = {
    theme: "fastify",
    layout: "classic",
    defaultOpenAllTags: true,
    expandAllModelSections: true,
    expandAllResponses: true,
    expandAllSchemaProperties: true,
    hideClientButton: true,
    hideDarkModeToggle: true,
    hideModels: true,
    showOperationId: true,
    showDeveloperTools: "never",
    telemetry: false,
} as const satisfies Partial<ApiReferenceConfiguration>;
