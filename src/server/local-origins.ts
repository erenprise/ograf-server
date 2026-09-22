import { networkInterfaces } from "node:os";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];

export function localOrigins(port: number): string[] {
    const hosts = new Set<string>(LOOPBACK_HOSTS);
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (!address.internal && address.family === "IPv4") {
                hosts.add(address.address);
            }
        }
    }
    return [...hosts].map((host) => `http://${host}:${port}`);
}
