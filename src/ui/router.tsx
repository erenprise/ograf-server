import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.tsx";
import { GraphicsPage } from "./routes/graphics.tsx";
import { HomePage } from "./routes/index.tsx";
import { LogsPage } from "./routes/logs.tsx";
import { SettingsPage } from "./routes/settings.tsx";

const rootRoute = createRootRoute({
    component: () => (
        <AppShell>
            <Outlet />
        </AppShell>
    ),
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const graphicsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/graphics", component: GraphicsPage });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", component: LogsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([homeRoute, graphicsRoute, logsRoute, settingsRoute]);

export const router = createRouter({ routeTree: routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
    // biome-ignore lint/style/useConsistentTypeDefinitions: only interface can override existing module
    interface Register {
        router: typeof router;
    }
}
