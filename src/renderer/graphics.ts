import type { GraphicsAPI } from "ograf";
import {
    isGraphicFilter,
    isJsonObject,
    isRecord,
    matchesGraphicFilter,
    type InstanceSnapshot,
    type JsonObject,
    type RenderCharacteristics,
    type RendererCommandExecution,
    type RendererCommandMap,
    type RendererCommandType,
    type RendererRuntimeConfig,
} from "../shared.ts";

class GraphicError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "GraphicError";
    }
}

type RealtimeGraphic = HTMLElement &
    Pick<GraphicsAPI.Graphic, "load" | "dispose" | "playAction" | "stopAction" | "updateAction" | "customAction">;

type LoadedInstance = {
    graphicInstanceId: string;
    graphicId: string;
    renderTarget: JsonObject;
    el: RealtimeGraphic;
    currentStep?: number;
};

type LoadPayload = RendererCommandMap["load"]["payload"];
type UpdatePayload = RendererCommandMap["updateAction"]["payload"];
type PlayPayload = RendererCommandMap["playAction"]["payload"];
type StopPayload = RendererCommandMap["stopAction"]["payload"];
type GraphicActionPayload = RendererCommandMap["graphicCustomAction"]["payload"];
type ClearPayload = RendererCommandMap["clear"]["payload"];
type RendererActionPayload = RendererCommandMap["rendererCustomAction"]["payload"];

type PendingLoad = {
    graphicInstanceId: string;
    graphicId: string;
    renderTarget: JsonObject;
    element?: RealtimeGraphic;
};

function tagNameForGraphic(graphicId: string, graphicRevision: string): string {
    const sanitized = graphicId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^[^a-z]+/, "");
    const revision = graphicRevision.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = hashCode(`${graphicId}:${graphicRevision}`).toString(36);
    return `ograf-g-${sanitized || "graphic"}-${revision || "revision"}-${hash}`;
}

function hashCode(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
}

function isGraphicModule(value: unknown): value is { default: CustomElementConstructor } {
    return isRecord(value) && typeof value.default === "function";
}

const REALTIME_GRAPHIC_METHODS = ["load", "dispose", "playAction", "stopAction", "updateAction", "customAction"];

function isRealtimeGraphic(value: Element): value is RealtimeGraphic {
    return (
        value instanceof HTMLElement &&
        REALTIME_GRAPHIC_METHODS.every((method) => typeof Reflect.get(value, method) === "function")
    );
}

async function importGraphicElement(payload: LoadPayload): Promise<RealtimeGraphic> {
    const module: unknown = await import(/* @vite-ignore */ payload.mainUrl);
    if (!isGraphicModule(module)) {
        throw new GraphicError("Graphic module has no default custom element");
    }
    const tagName = tagNameForGraphic(payload.graphicId, payload.graphicRevision);
    if (!customElements.get(tagName)) {
        customElements.define(tagName, module.default);
    }
    const element = document.createElement(tagName);
    if (!isRealtimeGraphic(element)) {
        throw new GraphicError("Graphic does not implement the complete realtime Graphic API");
    }
    return element;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
    return value[key] === undefined || typeof value[key] === "boolean";
}

function isLoadPayload(value: unknown): value is LoadPayload {
    return (
        isRecord(value) &&
        typeof value.graphicInstanceId === "string" &&
        isJsonObject(value.renderTarget) &&
        typeof value.graphicId === "string" &&
        typeof value.graphicRevision === "string" &&
        isRecord(value.manifest) &&
        typeof value.mainUrl === "string"
    );
}

function isUpdatePayload(value: unknown): value is UpdatePayload {
    return isRecord(value) && typeof value.graphicInstanceId === "string" && optionalBoolean(value, "skipAnimation");
}

function isPlayPayload(value: unknown): value is PlayPayload {
    return (
        isRecord(value) &&
        typeof value.graphicInstanceId === "string" &&
        (value.delta === undefined || typeof value.delta === "number") &&
        (value.goto === undefined || typeof value.goto === "number") &&
        optionalBoolean(value, "skipAnimation")
    );
}

function isStopPayload(value: unknown): value is StopPayload {
    return isRecord(value) && typeof value.graphicInstanceId === "string" && optionalBoolean(value, "skipAnimation");
}

function isGraphicActionPayload(value: unknown): value is GraphicActionPayload {
    return (
        isRecord(value) &&
        typeof value.graphicInstanceId === "string" &&
        typeof value.id === "string" &&
        optionalBoolean(value, "skipAnimation")
    );
}

function isClearPayload(value: unknown): value is ClearPayload {
    return isRecord(value) && Array.isArray(value.filters) && value.filters.every(isGraphicFilter);
}

function isRendererActionPayload(value: unknown): value is RendererActionPayload {
    return isRecord(value) && typeof value.customActionId === "string";
}

async function rendererCustomAction(payload: RendererActionPayload) {
    if (payload.customActionId === "reload") {
        setTimeout(() => location.reload(), 50);
        return { result: { statusCode: 200, statusMessage: "Reloading" } };
    }
    throw new Error(`Unknown renderer custom action "${payload.customActionId}"`);
}

async function callGraphicMethod<T>(fn: () => Promise<T>, methodName: string): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        throw new GraphicError(
            `Graphic "${methodName}" threw: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function disposeGraphic(element: RealtimeGraphic): Promise<void> {
    try {
        await element.dispose({});
    } catch {
        return;
    } finally {
        element.remove();
    }
}

export function createGraphicsRuntime(config: RendererRuntimeConfig) {
    const instances = new Map<string, LoadedInstance>();
    const pendingLoads = new Map<string, PendingLoad>();
    const root = document.getElementById("ograf-renderer");
    if (!root) {
        throw new GraphicError('Renderer root element "ograf-renderer" was not found');
    }

    const layerElements = new Map<string, HTMLElement>();
    for (const layer of config.layers) {
        if (layerElements.has(layer.id)) {
            throw new GraphicError(`Renderer has duplicate layer "${layer.id}"`);
        }
        const element = document.createElement("div");
        element.dataset.layer = layer.id;
        root.appendChild(element);
        layerElements.set(layer.id, element);
    }

    const renderCharacteristics: RenderCharacteristics = {
        resolution: config.resolution,
        frameRate: config.frameRate,
        accessToPublicInternet: config.accessToPublicInternet,
    };

    const applyConfig = async (next: RendererRuntimeConfig): Promise<void> => {
        renderCharacteristics.resolution = next.resolution;
        renderCharacteristics.frameRate = next.frameRate;
        renderCharacteristics.accessToPublicInternet = next.accessToPublicInternet;

        const nextLayerIds = new Set(next.layers.map((layer) => layer.id));
        const removedLayerIds = new Set<string>();
        for (const [layerId, element] of layerElements) {
            if (nextLayerIds.has(layerId)) {
                continue;
            }
            removedLayerIds.add(layerId);
            element.remove();
            layerElements.delete(layerId);
        }
        const isRemovedLayer = (renderTarget: JsonObject) =>
            typeof renderTarget.layer === "string" && removedLayerIds.has(renderTarget.layer);
        for (const [id, pending] of pendingLoads) {
            if (isRemovedLayer(pending.renderTarget)) {
                pendingLoads.delete(id);
            }
        }
        const removals = [...instances].filter(([, instance]) => isRemovedLayer(instance.renderTarget));
        await Promise.allSettled(
            removals.map(async ([id, instance]) => {
                await disposeGraphic(instance.el);
                instances.delete(id);
            }),
        );

        for (const layer of next.layers) {
            let element = layerElements.get(layer.id);
            if (!element) {
                element = document.createElement("div");
                element.dataset.layer = layer.id;
                layerElements.set(layer.id, element);
            }
            root.appendChild(element);
        }
    };

    const getSnapshot = (): InstanceSnapshot[] =>
        Array.from(instances.values()).map((instance) => ({
            graphicInstanceId: instance.graphicInstanceId,
            graphicId: instance.graphicId,
            renderTarget: instance.renderTarget,
            currentStep: instance.currentStep,
        }));

    // A load is current while it is still the latest entry for its instance id.
    const isCurrentLoad = (pending: PendingLoad): boolean => pendingLoads.get(pending.graphicInstanceId) === pending;

    const load = async (payload: LoadPayload) => {
        const layerId = typeof payload.renderTarget.layer === "string" ? payload.renderTarget.layer : undefined;
        const layer = layerId && layerElements.get(layerId);
        if (!layer) {
            throw new GraphicError(`Renderer has no configured layer "${layerId ?? "unknown"}"`);
        }

        const pending: PendingLoad = {
            graphicInstanceId: payload.graphicInstanceId,
            graphicId: payload.graphicId,
            renderTarget: payload.renderTarget,
        };
        pendingLoads.set(payload.graphicInstanceId, pending);

        const previous = instances.get(payload.graphicInstanceId);
        if (previous) {
            instances.delete(payload.graphicInstanceId);
            await disposeGraphic(previous.el);
        }

        let committed = false;
        try {
            const element = await importGraphicElement(payload);
            pending.element = element;
            if (!isCurrentLoad(pending)) {
                throw new GraphicError(`Graphic load "${payload.graphicInstanceId}" was superseded`);
            }
            layer.appendChild(element);

            const result = await callGraphicMethod(
                () =>
                    element.load({
                        data: payload.data,
                        renderType: "realtime",
                        renderCharacteristics: renderCharacteristics,
                    }),
                "load",
            );

            if (!isCurrentLoad(pending)) {
                throw new GraphicError(`Graphic load "${payload.graphicInstanceId}" was superseded`);
            }

            instances.set(payload.graphicInstanceId, {
                graphicInstanceId: payload.graphicInstanceId,
                graphicId: payload.graphicId,
                renderTarget: payload.renderTarget,
                el: element,
            });
            committed = true;
            pendingLoads.delete(payload.graphicInstanceId);
            return { result: result, instances: getSnapshot() };
        } catch (error) {
            if (!committed && pending.element) {
                await disposeGraphic(pending.element);
            }
            if (isCurrentLoad(pending)) {
                pendingLoads.delete(payload.graphicInstanceId);
            }
            throw error;
        }
    };

    const withInstance = async <T>(
        graphicInstanceId: string,
        fn: (instance: LoadedInstance) => Promise<T>,
    ): Promise<T> => {
        const instance = instances.get(graphicInstanceId);
        if (!instance) {
            throw new Error(`No loaded GraphicInstance "${graphicInstanceId}"`);
        }
        return fn(instance);
    };

    const runInstanceMethod = <T>(
        graphicInstanceId: string,
        methodName: string,
        fn: (instance: LoadedInstance) => Promise<T>,
    ) =>
        withInstance(graphicInstanceId, async (instance) => {
            const result = await callGraphicMethod(() => fn(instance), methodName);
            return { result: result, instances: getSnapshot() };
        });

    const updateAction = (payload: UpdatePayload) =>
        runInstanceMethod(payload.graphicInstanceId, "updateAction", (instance) =>
            instance.el.updateAction({ data: payload.data, skipAnimation: payload.skipAnimation }),
        );

    const playAction = (payload: PlayPayload) =>
        withInstance(payload.graphicInstanceId, async (instance) => {
            const params =
                payload.goto !== undefined
                    ? { goto: payload.goto, skipAnimation: payload.skipAnimation }
                    : { delta: payload.delta ?? 1, skipAnimation: payload.skipAnimation };
            const result = await callGraphicMethod(() => instance.el.playAction(params), "playAction");
            instance.currentStep = result?.currentStep;
            return { result: result, instances: getSnapshot() };
        });

    const stopAction = (payload: StopPayload) =>
        runInstanceMethod(payload.graphicInstanceId, "stopAction", (instance) =>
            instance.el.stopAction({ skipAnimation: payload.skipAnimation }),
        );

    const graphicCustomAction = (payload: GraphicActionPayload) =>
        runInstanceMethod(payload.graphicInstanceId, "customAction", (instance) =>
            instance.el.customAction({
                id: payload.id,
                payload: payload.payload,
                skipAnimation: payload.skipAnimation,
            }),
        );

    const clear = async (payload: ClearPayload) => {
        for (const [id, pending] of pendingLoads) {
            if (!payload.filters.length || payload.filters.some((filter) => matchesGraphicFilter(pending, filter))) {
                pendingLoads.delete(id);
            }
        }

        const matches = [...instances].filter(
            ([, instance]) =>
                !payload.filters.length || payload.filters.some((filter) => matchesGraphicFilter(instance, filter)),
        );
        await Promise.allSettled(
            matches.map(async ([id, instance]) => {
                await disposeGraphic(instance.el);
                instances.delete(id);
            }),
        );
        return {
            result: {
                graphicInstances: matches.map(([, instance]) => ({
                    renderTarget: instance.renderTarget,
                    graphicInstanceId: instance.graphicInstanceId,
                })),
            },
            instances: getSnapshot(),
        };
    };

    const handleCommand = (command: RendererCommandType, payload: unknown): Promise<RendererCommandExecution> => {
        if (command === "load" && isLoadPayload(payload)) {
            return load(payload);
        }
        if (command === "updateAction" && isUpdatePayload(payload)) {
            return updateAction(payload);
        }
        if (command === "playAction" && isPlayPayload(payload)) {
            return playAction(payload);
        }
        if (command === "stopAction" && isStopPayload(payload)) {
            return stopAction(payload);
        }
        if (command === "graphicCustomAction" && isGraphicActionPayload(payload)) {
            return graphicCustomAction(payload);
        }
        if (command === "clear" && isClearPayload(payload)) {
            return clear(payload);
        }
        if (command === "rendererCustomAction" && isRendererActionPayload(payload)) {
            return rendererCustomAction(payload);
        }
        return Promise.reject(new Error("Invalid renderer command payload"));
    };

    return {
        handleCommand: handleCommand,
        getSnapshot: getSnapshot,
        applyConfig: applyConfig,
    };
}
