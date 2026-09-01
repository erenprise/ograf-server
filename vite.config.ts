import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The SSR build bundles the server into one ESM file for `node --build-sea`. */
export default defineConfig(({ isSsrBuild }) =>
    isSsrBuild
        ? {
              publicDir: false,
              define: {
                  // Lets Rolldown drop the development-only `import("vite")` branch.
                  "process.env.NODE_ENV": JSON.stringify("production"),
                  "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
              },
              ssr: {
                  target: "node",
                  noExternal: true,
              },
              build: {
                  outDir: ".cache/exe",
                  emptyOutDir: true,
                  target: "node26",
                  minify: false,
                  sourcemap: false,
                  rolldownOptions: {
                      output: {
                          format: "es",
                          entryFileNames: "server.mjs",
                          codeSplitting: false,
                      },
                  },
              },
          }
        : {
              plugins: [react()],
              publicDir: resolve(import.meta.dirname, ".cache/ograf"),
              build: {
                  outDir: "dist",
                  rolldownOptions: {
                      input: {
                          admin: resolve(import.meta.dirname, "index.html"),
                          renderer: resolve(import.meta.dirname, "renderer.html"),
                      },
                  },
              },
          },
);
