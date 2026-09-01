import { HStack, Link, Text } from "@chakra-ui/react";
import { CopyButton } from "./CopyButton.tsx";

export function UrlDisplay({ path, label }: { path: string; label: string }) {
    const fullUrl = new URL(path, location.origin).href;

    return (
        <HStack gap="1" wrap="wrap" align="center">
            <Text fontSize="sm" color="fg.muted">
                {label}
            </Text>
            <Link
                href={fullUrl}
                target="_blank"
                rel="noopener noreferrer"
                fontFamily="mono"
                fontSize="sm"
                color="colorPalette.solid"
                wordBreak="break-all"
            >
                {fullUrl}
            </Link>
            <CopyButton value={fullUrl} />
        </HStack>
    );
}

export function RendererUrls({ rendererId }: { rendererId: string }) {
    return (
        <>
            <UrlDisplay path={`/render/${rendererId}`} label="Output:" />
            <UrlDisplay path={`/api/ograf/v1/renderers/${rendererId}`} label="OGraf Status:" />
        </>
    );
}
