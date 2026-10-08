import type { IncomingHttpHeaders } from "node:http";
import { hostname, networkInterfaces } from "node:os";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", hostname()];

export function localOrigins(port: number): string[] {
    const hosts = new Set(LOCAL_HOSTS);
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (!address.internal && address.family === "IPv4") {
                hosts.add(address.address);
            }
        }
    }
    return [...hosts].map((host) => new URL(`http://${host}:${port}`).origin);
}

export function isTrustedRequest(url: URL, headers: IncomingHttpHeaders, allowed: string[], method?: string): boolean {
    const target = url.origin;
    const origin = headers.origin;
    const site = headers["sec-fetch-site"];
    const navigation =
        method === "GET" && headers["sec-fetch-mode"] === "navigate" && headers["sec-fetch-dest"] === "document";
    return (
        allowed.includes(target) &&
        (!origin || origin === target) &&
        (!site || site === "same-origin" || site === "none" || navigation)
    );
}
