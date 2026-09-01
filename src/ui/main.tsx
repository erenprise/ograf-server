import { ChakraProvider, createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router.tsx";

const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 2000, refetchOnWindowFocus: false } },
});

const system = createSystem(
    defaultConfig,
    defineConfig({
        globalCss: {
            "html, body": {
                colorPalette: "teal",
                bg: "bg",
                color: "fg",
                minHeight: "100vh",
            },
        },
        cssVarsPrefix: "ck",
        // Dark mode is driven by the `class="dark"` on <html> in index.html — keep one source of truth
        conditions: {
            dark: '.dark &, [data-theme="dark"] &, &:where([data-theme=dark])',
        },
    }),
);

const rootEl = document.getElementById("root");
if (!rootEl) {
    throw new Error("#root element not found");
}

createRoot(rootEl).render(
    <StrictMode>
        <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </ChakraProvider>
    </StrictMode>,
);
