import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { OGRAF_OPENAPI_ASSET } from "../src/server/assets.ts";

const root = path.resolve(import.meta.dirname, "..");
const distDir = path.join(root, "dist");
const bundleDir = path.join(root, ".cache", "exe");
const bundle = path.join(bundleDir, "server.mjs");
const seaConfig = path.join(root, ".cache", "sea", "sea-config.json");
const buildDir = path.join(root, "build");

const output = path.join(buildDir, process.platform === "win32" ? "ograf-server.exe" : "ografServer");

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const nodeVariables: Record<string, unknown> = process.config.variables;

if (Number.parseInt(process.versions.node, 10) < 26) {
    throw new Error(`Building requires Node 26+, current: ${process.versions.node}`);
}

if (nodeVariables.single_executable_application !== true) {
    throw new Error(
        `This Node ${process.versions.node} build has single-executable support disabled and cannot run --build-sea. ` +
            "Use an official build from https://nodejs.org (Homebrew and distro packages are a common cause).",
    );
}

if (
    !(
        (process.platform === "win32" && process.arch === "x64") ||
        (process.platform === "darwin" && process.arch === "arm64")
    )
) {
    throw new Error(
        `Unsupported target: ${process.platform}-${process.arch}. Supported targets: win32-x64, darwin-arm64`,
    );
}

async function ensureExists(target: string, hint: string): Promise<void> {
    try {
        await stat(target);
    } catch {
        throw new Error(`Missing ${path.relative(root, target)}. ${hint}`);
    }
}

async function run(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        spawn(command, args, { cwd: root, stdio: "inherit" })
            .on("error", reject)
            .on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
    });
}

async function embeddedAssets(): Promise<Record<string, string>> {
    const entries = await readdir(distDir, {
        withFileTypes: true,
        recursive: true,
    });

    const files = entries
        .filter((entry) => entry.isFile() && !IGNORED_FILES.has(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .toSorted((a, b) => a.localeCompare(b));

    return Object.fromEntries(files.map((file) => [path.relative(distDir, file).split(path.sep).join("/"), file]));
}

async function main(): Promise<void> {
    await ensureExists(distDir, "Run `yarn build` first.");
    await ensureExists(bundle, "Run `yarn build:server` first.");
    await ensureExists(path.join(distDir, OGRAF_OPENAPI_ASSET), "Run `yarn build` first.");

    const stray = (await readdir(bundleDir)).filter(
        (file) => file !== path.basename(bundle) && !IGNORED_FILES.has(file),
    );

    if (stray.length) {
        throw new Error(`Server build must emit one bundle, also found: ${stray.join(", ")}`);
    }

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
                executable: process.execPath,
                output: output,
                disableExperimentalSEAWarning: true,
                useSnapshot: false,
                useCodeCache: false,
                execArgvExtension: "none",
                assets: assets,
            },
            undefined,
            4,
        ),
    );

    await run(process.execPath, ["--build-sea", seaConfig]);

    if (process.platform === "darwin") {
        await chmod(output, 0o755);
        await run("codesign", ["--force", "--sign", "-", output]);
        await run("codesign", ["--verify", "--verbose=2", output]);
    }

    const { size } = await stat(output);

    console.log(
        `Built ${path.relative(root, output)} (${(size / 1024 / 1024).toFixed(1)} MiB, ${Object.keys(assets).length} assets)`,
    );
}

await main();
