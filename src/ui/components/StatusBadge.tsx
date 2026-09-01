import { Badge } from "@chakra-ui/react";
import type { RendererStatus } from "../../shared.ts";

const STATUS_COLOR: Record<RendererStatus["status"], string> = {
    OK: "green",
    WARNING: "yellow",
    ERROR: "red",
};

export function StatusBadge({ status }: { status: RendererStatus }) {
    return <Badge colorPalette={STATUS_COLOR[status.status]}>{status.status}</Badge>;
}
