import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, isTokenScope, type TokenScope } from "../shared.ts";
import * as v from "valibot";
import { hasErrorCode } from "./errors.ts";

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const TimestampSchema = v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value)), "Expected a valid timestamp"),
);

export const IdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.check((value) => ID_PATTERN.test(value), 'Id must contain only letters, digits, "-" or "_"'),
);
export const NameSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
export const DescriptionSchema = v.pipe(v.string(), v.maxLength(2000));
const FiniteNumberSchema = v.pipe(
    v.number(),
    v.check((value) => Number.isFinite(value), "Expected a finite number"),
);
const PositiveIntegerSchema = v.pipe(FiniteNumberSchema, v.integer(), v.minValue(1));
export const PositiveNumberSchema = v.pipe(FiniteNumberSchema, v.minValue(1));
const TokenScopeSchema = v.custom<TokenScope>(isTokenScope, "Expected an API or renderer token scope");
const LayerConfigSchema = v.object({ id: IdSchema, name: NameSchema });
export const ResolutionSchema = v.object({ width: PositiveIntegerSchema, height: PositiveIntegerSchema });
const RendererConfigSchema = v.object({
    id: IdSchema,
    name: NameSchema,
    description: v.optional(DescriptionSchema),
    resolution: ResolutionSchema,
    frameRate: PositiveNumberSchema,
    accessToPublicInternet: v.boolean(),
    layers: v.array(LayerConfigSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});
const PersistedAuthTokenSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    label: NameSchema,
    scope: TokenScopeSchema,
    prefix: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
    hash: v.pipe(
        v.string(),
        v.length(64),
        v.check((value) => /^[a-f0-9]+$/i.test(value), "Expected a SHA-256 token hash"),
    ),
    createdAt: TimestampSchema,
});
const TombstoneSchema = v.object({ deleteAfter: TimestampSchema });
const StateSchema = v.object({
    version: v.literal(1),
    renderers: v.array(RendererConfigSchema),
    auth: v.object({ enabled: v.boolean(), tokens: v.array(PersistedAuthTokenSchema) }),
    graphics: v.object({ tombstones: v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), TombstoneSchema) }),
});

export type PersistedAuthToken = v.InferOutput<typeof PersistedAuthTokenSchema>;

type PersistedState = v.InferOutput<typeof StateSchema>;

function createDefaultState(): PersistedState {
    return {
        version: 1,
        renderers: [],
        auth: { enabled: false, tokens: [] },
        graphics: { tombstones: {} },
    };
}

export type StateStore = {
    getState: () => PersistedState;
    updateState: (mutator: (draft: PersistedState) => void) => Promise<PersistedState>;
    flush: () => Promise<void>;
};

export async function createStateStore(filePath: string): Promise<StateStore> {
    let state = await loadState(filePath);
    let writeQueue: Promise<void> = Promise.resolve();

    const persist = async (next: PersistedState) => {
        await mkdir(dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
            await rename(tmpPath, filePath);
        } finally {
            await rm(tmpPath, { force: true });
        }
    };

    const updateState = (mutator: (draft: PersistedState) => void): Promise<PersistedState> => {
        const update = writeQueue.then(async () => {
            const draft = structuredClone(state);
            mutator(draft);
            await persist(draft);
            state = draft;
            return state;
        });
        writeQueue = update.then(
            () => undefined,
            () => undefined,
        );
        return update;
    };

    return {
        getState: () => state,
        updateState: updateState,
        flush: () => writeQueue,
    };
}

function parseArray<T>(value: unknown, schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>): T[] {
    return Array.isArray(value)
        ? value.flatMap((item) => {
              const result = v.safeParse(schema, item);
              return result.success ? [result.output] : [];
          })
        : [];
}

function parseRecord<T>(value: unknown, schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>): Record<string, T> {
    const parsed: Record<string, T> = {};
    if (!isRecord(value)) {
        return parsed;
    }
    for (const [key, item] of Object.entries(value)) {
        const result = v.safeParse(schema, item);
        if (result.success) {
            parsed[key] = result.output;
        }
    }
    return parsed;
}

async function loadState(filePath: string): Promise<PersistedState> {
    try {
        const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
        if (!isRecord(parsed)) {
            return createDefaultState();
        }

        const version = v.safeParse(v.literal(1), parsed.version);
        if (!version.success) {
            throw new Error("Unsupported persisted state version");
        }

        const auth = isRecord(parsed.auth) ? parsed.auth : {};
        const graphics = isRecord(parsed.graphics) ? parsed.graphics : {};

        return {
            version: 1,
            renderers: parseArray(parsed.renderers, RendererConfigSchema),
            auth: {
                enabled: Boolean(auth.enabled),
                tokens: parseArray(auth.tokens, PersistedAuthTokenSchema),
            },
            graphics: { tombstones: parseRecord(graphics.tombstones, TombstoneSchema) },
        };
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
            return createDefaultState();
        }
        throw error;
    }
}
