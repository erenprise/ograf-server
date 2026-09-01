import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppAssets } from "../src/server/assets.ts";

void test("reads generated OGraf assets from the ignored build cache", async () => {
    const root = await mkdtemp(path.join("/tmp", "ograf-server-assets-"));
    try {
        const cache = path.join(root, ".cache", "ograf", "json-schemas");
        await mkdir(cache, { recursive: true });
        await writeFile(path.join(root, ".cache", "ograf", "ograf-openapi.yaml"), "openapi: 3.0.3\n");
        await writeFile(path.join(cache, "graphics.json"), "{}\n");

        const assets = createAppAssets(root);

        assert.equal(await assets.readText("ograf-openapi.yaml"), "openapi: 3.0.3\n");
        assert.equal((await assets.read("json-schemas/graphics.json"))?.byteLength, 3);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
