import type { RendererRuntimeConfig } from "../shared.ts";
import { createGraphicsRuntime } from "./graphics.ts";
import { connectRendererSocket } from "./socket.ts";

declare global {
    // biome-ignore lint/style/useConsistentTypeDefinitions: required for global augmentation
    interface Window {
        __OGRAF_RENDERER__?: RendererRuntimeConfig;
    }
}

const config = window.__OGRAF_RENDERER__;
if (!config) {
    throw new Error("window.__OGRAF_RENDERER__ was not injected by the server");
}

const runtime = createGraphicsRuntime(config);

const socket = connectRendererSocket(config.id, runtime);
window.addEventListener("error", (event) =>
    socket.reportStatus({ status: "ERROR", message: event.message || "Renderer resource failed to load" }),
);
window.addEventListener("unhandledrejection", (event) =>
    socket.reportStatus({
        status: "ERROR",
        message: event.reason instanceof Error ? event.reason.message : String(event.reason),
    }),
);
document.addEventListener("securitypolicyviolation", (event) =>
    socket.reportStatus({
        status: "WARNING",
        message: `Renderer blocked ${event.blockedURI} (${event.violatedDirective})`,
    }),
);
