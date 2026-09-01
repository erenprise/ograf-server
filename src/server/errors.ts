import { isRecord } from "../shared.ts";

export type ProblemDetails = {
    title: string;
    status: number;
    detail?: string;
    instance?: string;
    type?: string;
};

export function problem(status: number, title: string, detail?: string, instance?: string): ProblemDetails {
    return { status: status, title: title, detail: detail, instance: instance };
}

export function problemResponse(body: ProblemDetails, status: number): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "content-type": "application/problem+json" },
    });
}

export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
    return isRecord(error) && typeof error.code === "string" && codes.includes(error.code);
}

export class RendererOfflineError extends Error {
    public constructor(rendererId: string) {
        super(`Renderer "${rendererId}" is not connected`);
    }
}

export class RendererTimeoutError extends Error {
    public constructor(rendererId: string, command: string) {
        super(`Renderer "${rendererId}" did not respond to "${command}" in time`);
    }
}

export class RendererDisconnectedError extends Error {
    public constructor(rendererId: string) {
        super(`Renderer "${rendererId}" disconnected before replying`);
    }
}

export class GraphicMethodError extends Error {}

export class InvalidRequestError extends Error {}
