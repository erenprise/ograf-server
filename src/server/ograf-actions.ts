import { isJsonObject, type JsonObject } from "../shared.ts";
import { OgrafNotFoundError, RendererOfflineError } from "./errors.ts";
import type { RendererService } from "./renderers.ts";
import type { RendererGateway } from "./sockets.ts";

export type InstanceActionDeps = {
    renderers: Pick<RendererService, "getConfig" | "getRenderTargetInfo">;
    gateway: Pick<RendererGateway, "isConnected" | "sendCommand">;
};

export type InstanceActionCommand = "updateAction" | "playAction" | "stopAction" | "graphicCustomAction";

export type InstanceActionInput = {
    renderTarget: JsonObject;
    graphicInstanceId: string;
    params: JsonObject;
};

export type InstanceActionResponse = {
    graphicInstanceId: string;
    statusCode: number;
    statusMessage?: string;
    currentStep?: number;
};

export function parseInstanceActionInput(value: unknown): InstanceActionInput | undefined {
    if (!isJsonObject(value)) {
        return undefined;
    }
    const { renderTarget, graphicInstanceId, params } = value;
    return isJsonObject(renderTarget) && typeof graphicInstanceId === "string" && isJsonObject(params)
        ? { renderTarget: renderTarget, graphicInstanceId: graphicInstanceId, params: params }
        : undefined;
}

export async function executeInstanceAction(
    deps: InstanceActionDeps,
    rendererId: string,
    command: InstanceActionCommand,
    input: InstanceActionInput,
    customActionId?: string,
): Promise<InstanceActionResponse> {
    const { renderers, gateway } = deps;
    if (!renderers.getConfig(rendererId)) {
        throw new OgrafNotFoundError("No GraphicInstance or RenderTarget found");
    }
    if (!gateway.isConnected(rendererId)) {
        throw new RendererOfflineError(rendererId);
    }
    const targetInfo = renderers.getRenderTargetInfo(rendererId, input.renderTarget);
    if (!targetInfo?.graphicInstances.some((instance) => instance.graphicInstanceId === input.graphicInstanceId)) {
        throw new OgrafNotFoundError("No GraphicInstance or RenderTarget found");
    }

    const response = await sendInstanceCommand(gateway, rendererId, command, input, customActionId);
    return {
        graphicInstanceId: input.graphicInstanceId,
        statusCode: response?.statusCode ?? 200,
        statusMessage: response?.statusMessage,
        currentStep:
            command === "playAction" &&
            response &&
            "currentStep" in response &&
            typeof response.currentStep === "number"
                ? response.currentStep
                : undefined,
    };
}

function sendInstanceCommand(
    gateway: InstanceActionDeps["gateway"],
    rendererId: string,
    command: InstanceActionCommand,
    input: InstanceActionInput,
    customActionId?: string,
) {
    const { graphicInstanceId, params } = input;
    const skipAnimation = typeof params.skipAnimation === "boolean" ? params.skipAnimation : undefined;
    const common = { graphicInstanceId: graphicInstanceId, skipAnimation: skipAnimation };
    switch (command) {
        case "updateAction":
            return gateway.sendCommand(rendererId, command, { ...common, data: params.data });
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
