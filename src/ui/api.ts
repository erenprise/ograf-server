import { queryOptions } from "@tanstack/react-query";
import type { ValidationIssue } from "@streamshapers/ograf-validator-core";
import { hc } from "hono/client";
import createClient from "openapi-fetch";
import type { GraphicsManifest, ServerApi } from "ograf";
import type { AdminApi } from "../server/admin.ts";
import type { CreateRendererInput, PublicRendererInfo } from "../server/renderers.ts";
import {
    isRecord,
    type AuthTokenSummary,
    type GraphicFilter,
    type JsonObject,
    type LayerConfig,
    type LogEntry,
    type RendererConfig,
    type RendererStatus,
    type TokenScope,
} from "../shared.ts";

const admin = hc<AdminApi>("/api/admin", { init: { credentials: "include" } });
const ograf = createClient<ServerApi.paths>({ baseUrl: "/api/ograf/v1", credentials: "same-origin" });

export class AdminApiError extends Error {
    public readonly status: number;

    public constructor(message: string, status: number) {
        super(message);
        this.status = status;
        this.name = "AdminApiError";
    }
}

function errorDetail(error: unknown, fallback: string): string {
    return isRecord(error) && typeof error.detail === "string" ? error.detail : fallback;
}

async function readJsonResponse<T = unknown>(response: JsonResponse | PromiseLike<JsonResponse>): Promise<T> {
    const resolved = await response;
    const body: unknown = await resolved.json().catch(() => undefined);
    if (!resolved.ok) {
        throw new AdminApiError(errorDetail(body, `Request failed (HTTP ${resolved.status})`), resolved.status);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic response type must be asserted since fetch APIs don't carry runtime type info
    return body as T;
}

type JsonResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

async function unwrap<T>(request: PromiseLike<{ data?: unknown; error?: unknown }>, fallback: string): Promise<T> {
    const result = await request;
    if (result.error) {
        throw new Error(errorDetail(result.error, fallback));
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- openapi-fetch types data loosely; the server contract fixes the shape
    return result.data as T;
}

type AdminRendererLayer = LayerConfig & { graphicCount: number };
type GraphicThumbnail = NonNullable<GraphicsManifest["thumbnails"]>[number];

export type AdminRendererSummary = Omit<RendererConfig, "layers"> & {
    status: RendererStatus;
    layers: AdminRendererLayer[];
};

export type AdminGraphicSummary = {
    id: string;
    packageId: string;
    manifestPath: string;
    name?: string;
    version?: string;
    description?: string;
    supportsRealTime: boolean;
    supportsNonRealTime: boolean;
    stepCount?: number;
    customActionCount: number;
    thumbnails?: GraphicThumbnail[];
    valid: boolean;
    issues: ValidationIssue[];
    updatedAt: string;
    pendingDelete: boolean;
    deleteAfter?: string;
};

export type { CreateRendererInput, PublicRendererInfo };
export type PublicRenderTargetInfo = PublicRendererInfo["renderTargets"][number];
export type PublicGraphicInstance = PublicRenderTargetInfo["graphicInstances"][number];

export const adminRenderersQuery = queryOptions({
    queryKey: ["admin", "renderers"],
    queryFn: async ({ signal }) => {
        const response = await admin.renderers.$get(undefined, { init: { signal: signal } });
        return (await readJsonResponse<{ renderers: AdminRendererSummary[] }>(response)).renderers;
    },
});

export const publicRendererQuery = (rendererId: string) =>
    queryOptions({
        queryKey: ["ograf", "renderer", rendererId],
        queryFn: async ({ signal }): Promise<PublicRendererInfo> => {
            const data = await unwrap<{ renderer?: PublicRendererInfo }>(
                ograf.GET("/renderers/{rendererId}", {
                    params: { path: { rendererId: rendererId } },
                    signal: signal,
                }),
                "Renderer not found",
            );
            if (!data.renderer) {
                throw new Error("Renderer not found");
            }
            return data.renderer;
        },
    });

export const adminGraphicsQuery = queryOptions({
    queryKey: ["admin", "graphics"],
    queryFn: async ({ signal }) => {
        const response = await admin.graphics.packages.$get(undefined, { init: { signal: signal } });
        return (await readJsonResponse<{ graphics: AdminGraphicSummary[] }>(response)).graphics;
    },
});

export const adminGraphicDetailQuery = (graphicId: string) =>
    queryOptions({
        queryKey: ["admin", "graphic", graphicId],
        queryFn: async ({ signal }) => {
            const body = await readJsonResponse<{ graphic: Record<string, unknown> }>(
                admin.graphics[":graphicId"].$get({ param: { graphicId: graphicId } }, { init: { signal: signal } }),
            );
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Hono returns the raw manifest; it was validated server-side before being stored
            return body.graphic as unknown as GraphicsManifest;
        },
        enabled: Boolean(graphicId),
    });

export const settingsQuery = queryOptions({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) =>
        readJsonResponse<{ authEnabled: boolean; localOrigins: string[] }>(
            admin.settings.$get(undefined, { init: { signal: signal } }),
        ),
});

export const tokensQuery = queryOptions({
    queryKey: ["admin", "tokens"],
    queryFn: async ({ signal }) => {
        const response = await admin.tokens.$get(undefined, { init: { signal: signal } });
        return (await readJsonResponse<{ tokens: AuthTokenSummary[] }>(response)).tokens;
    },
});

export const logsQuery = queryOptions({
    queryKey: ["admin", "logs"],
    queryFn: async ({ signal }) => {
        const response = await admin.logs.$get({ query: {} }, { init: { signal: signal } });
        return (await readJsonResponse<{ logs: LogEntry[] }>(response)).logs;
    },
});

export const loginAdmin = async (token: string) => {
    const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token }),
    });
    await readJsonResponse(response);
};

export const logoutAdmin = async () => {
    await readJsonResponse(fetch("/api/session", { method: "DELETE" }));
};

export const createRenderer = (input: CreateRendererInput) => readJsonResponse(admin.renderers.$post({ json: input }));

export const deleteRenderer = (id: string) =>
    readJsonResponse(admin.renderers[":rendererId"].$delete({ param: { rendererId: id } }));

export const addLayer = (rendererId: string, layer: LayerConfig) =>
    readJsonResponse(admin.renderers[":rendererId"].layers.$post({ param: { rendererId: rendererId }, json: layer }));

export const reorderLayers = (rendererId: string, ids: string[]) =>
    readJsonResponse(
        admin.renderers[":rendererId"].layers.$put({ param: { rendererId: rendererId }, json: { ids: ids } }),
    );

export const removeLayer = (rendererId: string, layerId: string) =>
    readJsonResponse(
        admin.renderers[":rendererId"].layers[":layerId"].$delete({
            param: { rendererId: rendererId, layerId: layerId },
        }),
    );

export const uploadGraphicPackage = async (packageId: string, file: File) => {
    const form = new FormData();
    form.append("packageId", packageId);
    form.append("file", file);
    const body = await readJsonResponse(fetch("/api/admin/graphics/upload", { method: "POST", body: form }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- upload returns graphic IDs as a simple array
    return body as { graphicIds: string[] };
};

export const deleteGraphic = (graphicId: string) =>
    unwrap(
        ograf.DELETE("/graphics/{graphicId}", { params: { path: { graphicId: graphicId }, query: { force: false } } }),
        "Could not delete graphic",
    );

export const updateSettings = (authEnabled: boolean) =>
    readJsonResponse(admin.settings.$patch({ json: { enabled: authEnabled } }));

export const createToken = (input: { label: string; scope: TokenScope }) =>
    readJsonResponse<{ token: string; record: AuthTokenSummary }>(admin.tokens.$post({ json: input }));

export const revokeToken = (id: string) =>
    readJsonResponse(admin.tokens[":tokenId"].$delete({ param: { tokenId: id } }));

export const loadGraphic = (rendererId: string, renderTarget: JsonObject, graphicId: string, data: unknown) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/target/graphicInstance/load", {
            params: { path: { rendererId: rendererId } },
            body: { renderTarget: renderTarget, graphicId: graphicId, params: { data: data } },
        }),
        "Failed to load graphic",
    );

export const updateGraphicInstance = (
    rendererId: string,
    renderTarget: JsonObject,
    graphicInstanceId: string,
    data: unknown,
) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/target/graphicInstance/updateAction", {
            params: { path: { rendererId: rendererId } },
            body: { renderTarget: renderTarget, graphicInstanceId: graphicInstanceId, params: { data: data } },
        }),
        "Failed to update graphic",
    );

export const playGraphicInstance = (
    rendererId: string,
    renderTarget: JsonObject,
    graphicInstanceId: string,
    delta: number,
) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/target/graphicInstance/playAction", {
            params: { path: { rendererId: rendererId } },
            body: { renderTarget: renderTarget, graphicInstanceId: graphicInstanceId, params: { delta: delta } },
        }),
        "Failed to play graphic",
    );

export const stopGraphicInstance = (rendererId: string, renderTarget: JsonObject, graphicInstanceId: string) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/target/graphicInstance/stopAction", {
            params: { path: { rendererId: rendererId } },
            body: { renderTarget: renderTarget, graphicInstanceId: graphicInstanceId, params: {} },
        }),
        "Failed to stop graphic",
    );

export const runGraphicCustomAction = (
    rendererId: string,
    renderTarget: JsonObject,
    graphicInstanceId: string,
    customActionId: string,
    payload: unknown,
) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/target/graphicInstance/customActions/{customActionId}", {
            params: { path: { rendererId: rendererId, customActionId: customActionId } },
            body: { renderTarget: renderTarget, graphicInstanceId: graphicInstanceId, params: { payload: payload } },
        }),
        "Failed to run custom action",
    );

export const runRendererCustomAction = (rendererId: string, customActionId: string, payload: unknown) =>
    unwrap(
        ograf.POST("/renderers/{rendererId}/customActions/{customActionId}", {
            params: { path: { rendererId: rendererId, customActionId: customActionId } },
            body: { payload: payload },
        }),
        "Failed to run renderer action",
    );

export const clearGraphics = (rendererId: string, filters: GraphicFilter[]) =>
    unwrap(
        ograf.PUT("/renderers/{rendererId}/target/graphicInstance/clear", {
            params: { path: { rendererId: rendererId } },
            body: { filters: filters },
        }),
        "Failed to clear",
    );
