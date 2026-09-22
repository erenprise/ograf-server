type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
    return isRecord(value);
}

export function canonicalJsonKey(value: JsonValue): string {
    return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === "object") {
        const sorted: JsonObject = {};
        for (const key of Object.keys(value).toSorted()) {
            const child = value[key];
            if (child !== undefined) {
                sorted[key] = sortKeysDeep(child);
            }
        }
        return sorted;
    }
    return value;
}

export type RendererStatus = {
    status: "OK" | "WARNING" | "ERROR";
    message: string;
};

export type Resolution = {
    width: number;
    height: number;
};

export type RenderCharacteristics = {
    resolution: Resolution;
    frameRate: number;
    accessToPublicInternet: boolean;
};

export type LayerConfig = {
    id: string;
    name: string;
};

export type RendererConfig = {
    id: string;
    name: string;
    description?: string;
    resolution: Resolution;
    frameRate: number;
    accessToPublicInternet: boolean;
    layers: LayerConfig[];
    createdAt: string;
    updatedAt: string;
};

export type RendererRuntimeConfig = RenderCharacteristics & Pick<RendererConfig, "id" | "layers">;

export function toRendererRuntimeConfig(config: RendererConfig): RendererRuntimeConfig {
    return {
        id: config.id,
        resolution: config.resolution,
        frameRate: config.frameRate,
        accessToPublicInternet: config.accessToPublicInternet,
        layers: config.layers,
    };
}

export type InstanceSnapshot = {
    graphicInstanceId: string;
    graphicId: string;
    renderTarget: JsonObject;
    currentStep?: number;
};

export type GraphicFilter = {
    renderTarget?: JsonObject;
    graphicId?: string;
    graphicInstanceId?: string;
};

export function isGraphicFilter(value: unknown): value is GraphicFilter {
    return (
        isJsonObject(value) &&
        (value.renderTarget === undefined || isJsonObject(value.renderTarget)) &&
        (value.graphicId === undefined || typeof value.graphicId === "string") &&
        (value.graphicInstanceId === undefined || typeof value.graphicInstanceId === "string")
    );
}

type CommandResult =
    | {
          statusCode: number;
          statusMessage?: string;
      }
    | undefined;

type PlayResult =
    | {
          statusCode: number;
          statusMessage?: string;
          currentStep?: number;
      }
    | undefined;

export type RendererCommandMap = {
    load: {
        payload: {
            graphicInstanceId: string;
            renderTarget: JsonObject;
            graphicId: string;
            graphicRevision: string;
            manifest: Record<string, unknown>;
            mainUrl: string;
            data?: unknown;
        };
        result: CommandResult;
    };
    updateAction: {
        payload: { graphicInstanceId: string; data?: unknown; skipAnimation?: boolean };
        result: CommandResult;
    };
    playAction: {
        payload: { graphicInstanceId: string; delta?: number; goto?: number; skipAnimation?: boolean };
        result: PlayResult;
    };
    stopAction: {
        payload: { graphicInstanceId: string; skipAnimation?: boolean };
        result: CommandResult;
    };
    clear: {
        payload: { filters: GraphicFilter[] };
        result: { graphicInstances: Array<{ renderTarget: JsonObject; graphicInstanceId: string }> };
    };
    graphicCustomAction: {
        payload: { graphicInstanceId: string; id: string; payload?: unknown; skipAnimation?: boolean };
        result: CommandResult;
    };
    rendererCustomAction: {
        payload: { customActionId: string; payload?: unknown };
        result: CommandResult;
    };
};

export type RendererCommandType = keyof RendererCommandMap;
type RendererCommandMessage = {
    [K in RendererCommandType]: {
        type: "command";
        id: string;
        command: K;
        payload: RendererCommandMap[K]["payload"];
    };
}[RendererCommandType];

export type RendererCommandResult = RendererCommandMap[RendererCommandType]["result"];

export type RendererCommandExecution = {
    result?: RendererCommandResult;
    instances?: InstanceSnapshot[];
};

type RendererResultError = {
    message: string;
    fromGraphic: boolean;
};

export type RendererResultMessage = {
    type: "result";
    id: string;
    ok: boolean;
    result?: RendererCommandResult;
    error?: RendererResultError;
    instances?: InstanceSnapshot[];
};

type RendererHelloMessage = {
    type: "hello";
    rendererId: string;
    instances: InstanceSnapshot[];
};

type RendererConfigMessage = {
    type: "config";
    config: RendererRuntimeConfig;
};

export type RendererMessage =
    | RendererCommandMessage
    | RendererResultMessage
    | RendererHelloMessage
    | RendererConfigMessage;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_CATEGORIES = ["renderer", "graphic", "storage", "auth", "system"] as const;
type LogCategory = (typeof LOG_CATEGORIES)[number];

export type LogEntry = {
    id: number;
    time: string;
    level: LogLevel;
    category: LogCategory;
    message: string;
    rendererId?: string;
    graphicId?: string;
    graphicInstanceId?: string;
};

export type ServerEvent =
    | { type: "renderers.changed"; rendererId?: string }
    | { type: "graphics.changed" }
    | { type: "log"; entry: LogEntry };

export type TokenScope = "api" | `renderer:${string}`;

export function isTokenScope(value: unknown): value is TokenScope {
    return value === "api" || (typeof value === "string" && /^renderer:[a-z0-9][a-z0-9_-]*$/i.test(value));
}

export type AuthTokenSummary = {
    id: string;
    label: string;
    scope: TokenScope;
    prefix: string;
    createdAt: string;
};

export const MAX_PACKAGE_ID_LENGTH = 128;
export const MAX_CONTROL_MESSAGE_BYTES = 32 * 1024 * 1024;

export const DEFAULT_RESOLUTION: Resolution = { width: 1920, height: 1080 };
export const DEFAULT_FRAME_RATE = 50;

export function matchesGraphicFilter(
    instance: Pick<InstanceSnapshot, "renderTarget" | "graphicId" | "graphicInstanceId">,
    filter: GraphicFilter,
): boolean {
    return (
        (!filter.renderTarget || canonicalJsonKey(filter.renderTarget) === canonicalJsonKey(instance.renderTarget)) &&
        (!filter.graphicId || filter.graphicId === instance.graphicId) &&
        (!filter.graphicInstanceId || filter.graphicInstanceId === instance.graphicInstanceId)
    );
}
