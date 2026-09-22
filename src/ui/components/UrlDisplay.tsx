import { Grid, HStack, Link, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "../api.ts";
import { CopyButton } from "./CopyButton.tsx";

function useLocalOrigins(): string[] {
    const { data } = useQuery(settingsQuery);
    return data?.localOrigins ?? [location.origin];
}

function UrlLink({ url, display }: { url: string; display: string }) {
    return (
        <HStack gap="1" align="center">
            <Link
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                fontFamily="mono"
                fontSize="sm"
                lineHeight="1.25"
                color="colorPalette.solid"
                wordBreak="break-all"
            >
                {display}
            </Link>
            <CopyButton value={url} size="2xs" />
        </HStack>
    );
}

export function UrlDisplay({ path, label, allOrigins = false }: { path: string; label: string; allOrigins?: boolean }) {
    const origins = useLocalOrigins();

    if (!allOrigins) {
        return (
            <HStack gap="1" wrap="wrap" align="center">
                <Text fontSize="sm" lineHeight="1.25" color="fg.muted">
                    {label}
                </Text>
                <UrlLink url={new URL(path, location.origin).href} display={path} />
            </HStack>
        );
    }

    return (
        <Stack gap="0">
            <Text fontSize="sm" lineHeight="1.25" color="fg.muted">
                {label}
            </Text>
            {origins.map((origin) => {
                const url = new URL(path, origin).href;
                return <UrlLink key={origin} url={url} display={url} />;
            })}
        </Stack>
    );
}

export function RendererUrls({ rendererId }: { rendererId: string }) {
    return (
        <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="6" alignItems="start">
            <UrlDisplay path={`/render/${rendererId}`} label="Renderer URLs:" allOrigins />
            <UrlDisplay path={`/api/ograf/v1/renderers/${rendererId}`} label="Renderer Ograf API:" />
        </Grid>
    );
}
