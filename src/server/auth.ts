import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parse as parseCookieHeader } from "hono/utils/cookie";
import { isTokenScope, type AuthTokenSummary, type TokenScope } from "../shared.ts";
import { InvalidRequestError } from "./errors.ts";
import type { PersistedAuthToken, StateStore } from "./state.ts";

export type AuthStore = {
    isEnabled: () => boolean;
    setEnabled: (enabled: boolean) => Promise<void>;
    listTokens: () => AuthTokenSummary[];
    createToken: (label: string, scope: TokenScope) => Promise<{ token: string; record: AuthTokenSummary }>;
    revokeToken: (id: string) => Promise<boolean>;
    verify: (plaintext: string) => { ok: true; record: AuthTokenSummary } | { ok: false };
};

const TOKEN_PREFIX = "ogr_";

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function toSummary(record: PersistedAuthToken): AuthTokenSummary {
    return {
        id: record.id,
        label: record.label,
        scope: record.scope,
        prefix: record.prefix,
        createdAt: record.createdAt,
    };
}

export function createAuthStore(state: StateStore): AuthStore {
    return {
        isEnabled: () => state.getState().auth.enabled,

        setEnabled: async (enabled) => {
            await state.updateState((draft) => {
                if (enabled && !draft.auth.tokens.some((token) => token.scope === "api")) {
                    throw new InvalidRequestError(
                        "At least one API-scoped token is required before enabling authentication",
                    );
                }
                draft.auth.enabled = enabled;
            });
        },

        listTokens: () => state.getState().auth.tokens.map(toSummary),

        createToken: async (label, scope) => {
            const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
            const record: PersistedAuthToken = {
                id: randomUUID(),
                label: label,
                scope: scope,
                prefix: `${token.slice(0, 12)}…`,
                hash: hashToken(token),
                createdAt: new Date().toISOString(),
            };
            await state.updateState((draft) => {
                if (!isTokenScope(scope)) {
                    throw new InvalidRequestError("Invalid token scope");
                }
                if (scope !== "api" && !draft.renderers.some((renderer) => `renderer:${renderer.id}` === scope)) {
                    throw new InvalidRequestError(`Renderer token scope requires an existing renderer: "${scope}"`);
                }
                draft.auth.tokens.push(record);
            });
            return { token: token, record: toSummary(record) };
        },

        revokeToken: async (id) => {
            let revoked = false;
            await state.updateState((draft) => {
                const token = draft.auth.tokens.find((item) => item.id === id);
                if (!token) {
                    return;
                }
                if (
                    draft.auth.enabled &&
                    token.scope === "api" &&
                    !draft.auth.tokens.some((item) => item.id !== id && item.scope === "api")
                ) {
                    throw new InvalidRequestError(
                        "The final API-scoped token cannot be revoked while authentication is enabled",
                    );
                }
                revoked = true;
                draft.auth.tokens = draft.auth.tokens.filter((item) => item.id !== id);
            });
            return revoked;
        },

        verify: (plaintext) => {
            const hash = plaintext.startsWith(TOKEN_PREFIX) ? hashToken(plaintext) : undefined;
            const record = state.getState().auth.tokens.find((t) => t.hash === hash);
            return record ? { ok: true, record: toSummary(record) } : { ok: false };
        },
    };
}

export function scopeAllowsRenderer(scope: TokenScope, rendererId: string): boolean {
    return scope === "api" || scope === `renderer:${rendererId}`;
}

export const ADMIN_SESSION_COOKIE = "ograf_admin_token";

export type AccessHeaders = {
    authorization?: string | string[];
    cookie?: string | string[];
};

function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function verifyToken(auth: AuthStore, token: string | undefined) {
    if (!token) {
        return undefined;
    }
    const result = auth.verify(token);
    return result.ok ? result.record : undefined;
}

export function checkApiAccess(headers: AccessHeaders, auth: AuthStore): boolean {
    if (!auth.isEnabled()) {
        return true;
    }

    const bearer = firstHeader(headers.authorization);
    const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined;
    const session = parseCookieHeader(firstHeader(headers.cookie) ?? "")[ADMIN_SESSION_COOKIE];

    return verifyToken(auth, token)?.scope === "api" || verifyToken(auth, session)?.scope === "api";
}

export function checkRendererAccess(headers: AccessHeaders, rendererId: string, auth: AuthStore): boolean {
    if (!auth.isEnabled()) {
        return true;
    }

    const checkToken = (token: string | undefined): boolean => {
        const scope = verifyToken(auth, token)?.scope;
        return scope !== undefined && scopeAllowsRenderer(scope, rendererId);
    };

    const bearer = firstHeader(headers.authorization);
    const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined;
    const cookieToken = parseCookieHeader(firstHeader(headers.cookie) ?? "")[`ograf_renderer_${rendererId}`];
    return checkToken(token) || checkToken(cookieToken);
}
