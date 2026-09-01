import { Box, EmptyState as ChakraEmptyState } from "@chakra-ui/react";
import type { ReactNode } from "react";

export function EmptyState({
    title,
    description,
    children,
}: {
    title: string;
    description: string;
    children?: ReactNode;
}) {
    return (
        <Box borderWidth="1px" borderStyle="dashed" borderColor="border.muted" borderRadius="md">
            <ChakraEmptyState.Root size="sm">
                <ChakraEmptyState.Content>
                    <ChakraEmptyState.Title>{title}</ChakraEmptyState.Title>
                    <ChakraEmptyState.Description>{description}</ChakraEmptyState.Description>
                    {children}
                </ChakraEmptyState.Content>
            </ChakraEmptyState.Root>
        </Box>
    );
}
