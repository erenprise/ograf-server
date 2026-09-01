import {
    DEFAULT_FRAME_RATE,
    DEFAULT_RESOLUTION,
    type JsonObject,
    type RenderCharacteristics,
    type RendererConfig,
    type RendererStatus,
} from "../shared.ts";
import type { ServerApi } from "ograf";
import * as v from "valibot";
import { getGraphicListInfo, type GraphicsStore } from "./graphics.ts";
import type { LogStore } from "./logs.ts";
import { InvalidRequestError } from "./errors.ts";
import type { RendererGateway } from "./sockets.ts";
import {
    DescriptionSchema,
    IdSchema,
    NameSchema,
    PositiveNumberSchema,
    ResolutionSchema,
    type StateStore,
} from "./state.ts";

export const RENDERER_CUSTOM_ACTIONS: JsonObject[] = [
    { id: "reload", name: "Reload Output", description: "Reloads the renderer output page in the browser" },
];

function buildRenderTargetSchema(layers: RendererConfig["layers"]): JsonObject {
    const labels: JsonObject = {};
    for (const layer of layers) {
        labels[layer.id] = layer.name;
    }
    return {
        type: "object",
        properties: {
            layer: {
                type: "string",
                gddType: "select",
                enum: layers.map((layer) => layer.id),
                gddOptions: { labels: labels },
            },
        },
        required: ["layer"],
    };
}

type GraphicListInfo = Pick<ServerApi.components["schemas"]["GraphicListInfo"], "id" | "name" | "description"> & {
    thumbnails?: unknown[];
};
type GraphicInstanceInfo = {
    graphicInstanceId: string;
    graphic: GraphicListInfo;
};
type RenderTargetInfo = {
    renderTarget: JsonObject;
    name: string;
    description?: string;
    graphicInstances: GraphicInstanceInfo[];
};
export type PublicRendererInfo = {
    id: string;
    name: string;
    description?: string;
    customActions: JsonObject[];
    renderCharacteristics: RenderCharacteristics;
    renderTargetSchema: JsonObject;
    status: RendererStatus;
    renderTargets: RenderTargetInfo[];
};

export const CreateRendererSchema = v.object({
    id: IdSchema,
    name: NameSchema,
    description: v.optional(DescriptionSchema),
    resolution: v.optional(ResolutionSchema),
    frameRate: v.optional(PositiveNumberSchema),
    accessToPublicInternet: v.optional(v.boolean()),
});

export const UpdateRendererSchema = v.partial(v.omit(CreateRendererSchema, ["id"]));

export const LayerSchema = v.object({ id: IdSchema, name: NameSchema });

export const UpdateLayerSchema = v.omit(LayerSchema, ["id"]);

export type CreateRendererInput = v.InferOutput<typeof CreateRendererSchema>;
type UpdateRendererInput = v.InferOutput<typeof UpdateRendererSchema>;
type LayerInput = v.InferOutput<typeof LayerSchema>;
type UpdateLayerInput = v.InferOutput<typeof UpdateLayerSchema>;

export type RendererService = {
    listConfigs: () => RendererConfig[];
    getConfig: (id: string) => RendererConfig | undefined;
    createRenderer: (input: CreateRendererInput) => Promise<RendererConfig>;
    updateRenderer: (id: string, patch: UpdateRendererInput) => Promise<RendererConfig | undefined>;
    deleteRenderer: (id: string) => Promise<boolean>;
    addLayer: (rendererId: string, layer: LayerInput) => Promise<RendererConfig | undefined>;
    updateLayer: (rendererId: string, layerId: string, patch: UpdateLayerInput) => Promise<RendererConfig | undefined>;
    removeLayer: (rendererId: string, layerId: string) => Promise<RendererConfig | undefined>;
    getPublicRendererInfo: (id: string) => PublicRendererInfo | undefined;
    getRenderTargetInfo: (id: string, renderTarget: JsonObject) => RenderTargetInfo | undefined;
    findLayerIdForTarget: (id: string, renderTarget: JsonObject) => string | undefined;
};

export function createRendererService(
    state: StateStore,
    gateway: RendererGateway,
    graphics: GraphicsStore,
    logs: LogStore,
): RendererService {
    const listConfigs = () => state.getState().renderers;
    const getConfig = (id: string) => listConfigs().find((r) => r.id === id);

    const graphicToListInfo = (graphicId: string): GraphicListInfo => {
        const record = graphics.getAny(graphicId);
        return record ? getGraphicListInfo(record) : { id: graphicId, name: graphicId };
    };

    const getRenderTargetInfo = (id: string, renderTarget: JsonObject): RenderTargetInfo | undefined => {
        const config = getConfig(id);
        if (!config) {
            return undefined;
        }
        const layerId = typeof renderTarget.layer === "string" ? renderTarget.layer : undefined;
        const layer = config.layers.find((l) => l.id === layerId);
        if (!layer) {
            return undefined;
        }

        const live = gateway.getLiveTarget(id, renderTarget);
        const graphicInstances = Array.from(live?.instances.entries() ?? []).map(([graphicInstanceId, inst]) => ({
            graphicInstanceId: graphicInstanceId,
            graphic: graphicToListInfo(inst.graphicId),
        }));

        return { renderTarget: renderTarget, name: layer.name, graphicInstances: graphicInstances };
    };

    const findLayerIdForTarget = (id: string, renderTarget: JsonObject) => {
        const layerId = typeof renderTarget.layer === "string" ? renderTarget.layer : undefined;
        return getConfig(id)?.layers.find((l) => l.id === layerId)?.id;
    };

    const getPublicRendererInfo = (id: string): PublicRendererInfo | undefined => {
        const config = getConfig(id);
        if (!config) {
            return undefined;
        }
        return {
            id: config.id,
            name: config.name,
            description: config.description,
            customActions: RENDERER_CUSTOM_ACTIONS,
            renderCharacteristics: {
                resolution: config.resolution,
                frameRate: config.frameRate,
                accessToPublicInternet: config.accessToPublicInternet,
            },
            renderTargetSchema: buildRenderTargetSchema(config.layers),
            status: gateway.getStatus(id),
            renderTargets: config.layers
                .map((layer) => getRenderTargetInfo(id, { layer: layer.id }))
                .filter((t): t is RenderTargetInfo => t !== undefined),
        };
    };

    const createRenderer = async (input: CreateRendererInput): Promise<RendererConfig> => {
        const now = new Date().toISOString();
        const renderer: RendererConfig = {
            id: input.id,
            name: input.name,
            description: input.description,
            resolution: input.resolution ?? DEFAULT_RESOLUTION,
            frameRate: input.frameRate ?? DEFAULT_FRAME_RATE,
            accessToPublicInternet: input.accessToPublicInternet ?? false,
            layers: [],
            createdAt: now,
            updatedAt: now,
        };
        await state.updateState((draft) => {
            if (draft.renderers.some((r) => r.id === input.id)) {
                throw new InvalidRequestError(`Renderer "${input.id}" already exists`);
            }
            draft.renderers.push(renderer);
        });
        logs.add({
            level: "info",
            category: "system",
            message: `Created renderer "${renderer.id}"`,
            rendererId: renderer.id,
        });
        return renderer;
    };

    const mutateRenderer = async (
        rendererId: string,
        mutate: (renderer: RendererConfig) => void,
    ): Promise<RendererConfig | undefined> => {
        const next = await state.updateState((draft) => {
            const renderer = draft.renderers.find((r) => r.id === rendererId);
            if (!renderer) {
                return;
            }
            mutate(renderer);
            renderer.updatedAt = new Date().toISOString();
        });
        return next.renderers.find((r) => r.id === rendererId);
    };

    const updateRenderer = async (id: string, patch: UpdateRendererInput) => {
        const updated = await mutateRenderer(id, (renderer) => {
            if (patch.name !== undefined) {
                renderer.name = patch.name;
            }
            if (patch.description !== undefined) {
                renderer.description = patch.description;
            }
            if (patch.resolution !== undefined) {
                renderer.resolution = patch.resolution;
            }
            if (patch.frameRate !== undefined) {
                renderer.frameRate = patch.frameRate;
            }
            if (patch.accessToPublicInternet !== undefined) {
                renderer.accessToPublicInternet = patch.accessToPublicInternet;
            }
        });
        if (!updated) {
            return undefined;
        }
        logs.add({ level: "info", category: "system", message: `Updated renderer "${id}"`, rendererId: id });
        return updated;
    };

    const deleteRenderer = async (id: string) => {
        let deleted = false;
        await state.updateState((draft) => {
            deleted = draft.renderers.some((renderer) => renderer.id === id);
            draft.renderers = draft.renderers.filter((r) => r.id !== id);
            draft.auth.tokens = draft.auth.tokens.filter((token) => token.scope !== `renderer:${id}`);
        });
        if (!deleted) {
            return false;
        }
        gateway.remove(id);
        logs.add({ level: "info", category: "system", message: `Deleted renderer "${id}"`, rendererId: id });
        return true;
    };

    const addLayer = async (rendererId: string, layer: LayerInput) => {
        const updated = await mutateRenderer(rendererId, (renderer) => {
            if (renderer.layers.some((l) => l.id === layer.id)) {
                throw new InvalidRequestError(`Layer "${layer.id}" already exists`);
            }
            renderer.layers.push(layer);
        });
        if (!updated) {
            return undefined;
        }
        logs.add({
            level: "info",
            category: "system",
            message: `Added layer "${layer.id}" to renderer "${rendererId}"`,
            rendererId: rendererId,
        });
        return updated;
    };

    const updateLayer = async (rendererId: string, layerId: string, patch: UpdateLayerInput) => {
        const config = getConfig(rendererId);
        if (!config?.layers.some((layer) => layer.id === layerId)) {
            return undefined;
        }
        return mutateRenderer(rendererId, (renderer) => {
            const layer = renderer.layers.find((l) => l.id === layerId);
            if (layer) {
                layer.name = patch.name;
            }
        });
    };

    const removeLayer = async (rendererId: string, layerId: string) => {
        const config = getConfig(rendererId);
        if (!config?.layers.some((layer) => layer.id === layerId)) {
            return undefined;
        }

        if (gateway.isConnected(rendererId)) {
            const live = gateway.getLiveTarget(rendererId, { layer: layerId });
            if (live?.instances.size) {
                await gateway.sendCommand(rendererId, "clear", { filters: [{ renderTarget: { layer: layerId } }] });
            }
        }

        const updated = await mutateRenderer(rendererId, (renderer) => {
            renderer.layers = renderer.layers.filter((l) => l.id !== layerId);
        });
        if (!updated) {
            return undefined;
        }
        logs.add({
            level: "info",
            category: "system",
            message: `Removed layer "${layerId}" from renderer "${rendererId}"`,
            rendererId: rendererId,
        });
        return updated;
    };

    return {
        listConfigs: listConfigs,
        getConfig: getConfig,
        createRenderer: createRenderer,
        updateRenderer: updateRenderer,
        deleteRenderer: deleteRenderer,
        addLayer: addLayer,
        updateLayer: updateLayer,
        removeLayer: removeLayer,
        getPublicRendererInfo: getPublicRendererInfo,
        getRenderTargetInfo: getRenderTargetInfo,
        findLayerIdForTarget: findLayerIdForTarget,
    };
}
