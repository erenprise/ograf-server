import { Text } from "@chakra-ui/react";

export function FieldError({ error }: { error: { message: string } | null | undefined }) {
    return error ? (
        <Text color="fg.error" fontSize="sm">
            {error.message}
        </Text>
    ) : null;
}
