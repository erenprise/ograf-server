import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OGRAF_OPENAPI_ASSET } from "../src/server/assets.ts";

const root = path.resolve(import.meta.dirname, "..");
const distDir = path.join(root, "dist");
const bundleDir = path.join(root, ".cache", "exe");
const bundle = path.join(bundleDir, "server.mjs");
const seaConfig = path.join(root, ".cache", "sea", "sea-config.json");
const runtimeCache = path.join(root, ".cache", "node");
const buildDir = path.join(root, "build");
const output = path.join(buildDir, "ograf-server.exe");

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

const nodeVersion = process.versions.node;
const nodeVariables: Record<string, unknown> = process.config.variables;

if (Number.parseInt(nodeVersion, 10) < 26) {
    throw new Error(`yarn build:exe requires Node 26+, current version: ${nodeVersion}`);
}

if (nodeVariables.single_executable_application !== true) {
    throw new Error(
        `This Node ${nodeVersion} build has single-executable support disabled and cannot run --build-sea. ` +
            "Use an official build from https://nodejs.org (Homebrew and distro packages are a common cause).",
    );
}

async function ensureExists(target: string, hint: string): Promise<void> {
    try {
        await stat(target);
    } catch {
        throw new Error(`Missing ${path.relative(root, target)}. ${hint}`);
    }
}

async function sha256(file: string): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await readFile(file));
    return hash.digest("hex");
}

async function fetchOk(url: string): Promise<Response> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response;
}

async function downloadTo(url: string, destination: string): Promise<void> {
    const { body } = await fetchOk(url);
    if (!body) {
        throw new Error(`Empty response body: ${url}`);
    }

    const temporary = `${destination}.${process.pid}.tmp`;
    try {
        await pipeline(Readable.from(body), createWriteStream(temporary));
        await rename(temporary, destination);
    } finally {
        await rm(temporary, { force: true });
    }
}

/** The Windows x64 runtime to build from; its version must match the Node generating the executable. */
async function windowsRuntime(): Promise<string> {
    if (process.platform === "win32" && process.arch === "x64") {
        return process.execPath;
    }

    const cacheDir = path.join(runtimeCache, `v${nodeVersion}`, "win-x64");
    const runtime = path.join(cacheDir, "node.exe");
    const checksumFile = `${runtime}.sha256`;
    await mkdir(cacheDir, { recursive: true });

    const cached = await Promise.all([readFile(checksumFile, "utf-8"), sha256(runtime)]).catch(() => undefined);
    if (cached && cached[0].trim() === cached[1]) {
        return runtime;
    }

    console.log(`Downloading Node ${nodeVersion} win-x64 runtime`);
    const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
    const sums = await (await fetchOk(`${baseUrl}/SHASUMS256.txt`)).text();
    const expected = sums.match(/^([a-f0-9]{64})\s+win-x64\/node\.exe$/m)?.[1];
    if (!expected) {
        throw new Error(`Missing win-x64/node.exe checksum for Node ${nodeVersion}`);
    }

    await downloadTo(`${baseUrl}/win-x64/node.exe`, runtime);
    if ((await sha256(runtime)) !== expected) {
        await rm(runtime, { force: true });
        throw new Error(`SHA-256 mismatch for Node ${nodeVersion} win-x64/node.exe`);
    }

    await writeFile(checksumFile, `${expected}\n`);
    return runtime;
}

async function embeddedAssets(): Promise<Record<string, string>> {
    const entries = await readdir(distDir, { withFileTypes: true, recursive: true });
    const files = entries
        .filter((entry) => entry.isFile() && !IGNORED_FILES.has(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .toSorted((a, b) => a.localeCompare(b));

    return Object.fromEntries(files.map((file) => [path.relative(distDir, file).split(path.sep).join("/"), file]));
}

async function buildSea(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        spawn(process.execPath, ["--build-sea", seaConfig], { cwd: root, stdio: "inherit" })
            .on("error", reject)
            .on("close", (code) =>
                code === 0 ? resolve() : reject(new Error(`node --build-sea exited with code ${code}`)),
            );
    });
}

async function main(): Promise<void> {
    await ensureExists(distDir, "Run `yarn build` first.");
    await ensureExists(bundle, "Run `yarn build:server` first.");
    await ensureExists(path.join(distDir, OGRAF_OPENAPI_ASSET), "Run `yarn build` first.");

    const stray = (await readdir(bundleDir)).filter(
        (file) => file !== path.basename(bundle) && !IGNORED_FILES.has(file),
    );
    if (stray.length) {
        throw new Error(`The server build must emit a single bundle, also found: ${stray.join(", ")}`);
    }

    const runtime = await windowsRuntime();
    const assets = await embeddedAssets();

    await rm(buildDir, { recursive: true, force: true });
    await mkdir(buildDir, { recursive: true });
    await mkdir(path.dirname(seaConfig), { recursive: true });
    await writeFile(
        seaConfig,
        JSON.stringify(
            {
                main: bundle,
                mainFormat: "module",
                executable: runtime,
                output: output,
                disableExperimentalSEAWarning: true,
                // Cross-platform builds require both off; execArgvExtension keeps NODE_OPTIONS out.
                useSnapshot: false,
                useCodeCache: false,
                execArgvExtension: "none",
                assets: assets,
            },
            undefined,
            4,
        ),
    );

    await buildSea();

    const { size } = await stat(output);
    const megabytes = (size / 1024 / 1024).toFixed(1);
    console.log(`Built ${path.relative(root, output)} (${megabytes} MiB, ${Object.keys(assets).length} assets)`);
}

await main();
