import { createGraphicsRuntime, type RendererRuntimeConfig } from "./graphics.ts";
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

connectRendererSocket(config.id, runtime.getSnapshot, runtime.handleCommand);
