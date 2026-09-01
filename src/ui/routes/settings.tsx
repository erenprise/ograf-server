import {
    Alert,
    Badge,
    Box,
    Button,
    Card,
    CloseButton,
    Code,
    Field,
    Flex,
    Heading,
    HStack,
    Input,
    NativeSelect,
    Stack,
    Switch,
    Text,
} from "@chakra-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isTokenScope, type TokenScope } from "../../shared.ts";
import { adminRenderersQuery, createToken, revokeToken, settingsQuery, tokensQuery, updateSettings } from "../api.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FieldError } from "../components/FieldError.tsx";

export function SettingsPage() {
    const queryClient = useQueryClient();
    const { data: settings, error: settingsError } = useQuery(settingsQuery);
    const { data: tokens, error: tokensError } = useQuery(tokensQuery);
    const { data: renderers, error: renderersError } = useQuery(adminRenderersQuery);

    const [scope, setScope] = useState<TokenScope>("api");
    const [freshToken, setFreshToken] = useState<string>();

    const invalidateTokens = () => void queryClient.invalidateQueries({ queryKey: ["admin", "tokens"] });
    const toggleAuth = useMutation({
        mutationFn: updateSettings,
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
    });
    const create = useMutation({
        mutationFn: createToken,
        onSuccess: (result) => {
            setFreshToken(result.token);
            invalidateTokens();
        },
    });
    const revoke = useMutation({ mutationFn: revokeToken, onSuccess: invalidateTokens });

    const apiTokenCount = tokens?.filter((token) => token.scope === "api").length ?? 0;
    const canEnableAuth = apiTokenCount > 0;
    const lastApiToken = settings?.authEnabled && apiTokenCount <= 1;

    return (
        <Stack gap="6">
            <Card.Root>
                <Card.Body gap="3">
                    <Heading size="sm">Authentication</Heading>
                    <Switch.Root
                        checked={settings?.authEnabled ?? false}
                        disabled={toggleAuth.isPending || (!settings?.authEnabled && !canEnableAuth)}
                        onCheckedChange={(details) => toggleAuth.mutate(details.checked)}
                    >
                        <Switch.HiddenInput />
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                        <Switch.Label>
                            Require authentication for the OGraf API, Admin API and renderer output
                        </Switch.Label>
                    </Switch.Root>
                    {!canEnableAuth && (
                        <Alert.Root status="info" size="sm" alignItems="flex-start">
                            <Alert.Indicator />
                            <Alert.Content>
                                <Alert.Title>Create an API token first</Alert.Title>
                                <Alert.Description>
                                    Generate at least one API token before enabling authentication. Once enabled,
                                    requests to the OGraf API, Admin API and renderer output require a valid token.
                                </Alert.Description>
                            </Alert.Content>
                        </Alert.Root>
                    )}
                    <FieldError error={toggleAuth.error} />
                </Card.Body>
            </Card.Root>

            <Card.Root>
                <Card.Body gap="4">
                    <Box>
                        <Heading size="sm">API tokens</Heading>
                        <Text fontSize="sm" color="fg.muted">
                            Create and manage API tokens for accessing the OGraf API and admin interface.
                        </Text>
                    </Box>

                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            const label = new FormData(event.currentTarget).get("label");
                            if (typeof label === "string") {
                                create.mutate({ label: label, scope: scope });
                            }
                        }}
                    >
                        <Flex gap="3" align="flex-end" wrap="wrap">
                            <Field.Root flex="1" minW="2xs">
                                <Field.Label>Label</Field.Label>
                                <Input name="label" required maxLength={256} placeholder="Automation system" />
                            </Field.Root>
                            <Field.Root w="2xs">
                                <Field.Label>Scope</Field.Label>
                                <NativeSelect.Root>
                                    <NativeSelect.Field
                                        value={scope}
                                        onChange={(event) => {
                                            if (isTokenScope(event.target.value)) {
                                                setScope(event.target.value);
                                            }
                                        }}
                                    >
                                        <option value="api">api (admin + OGraf control)</option>
                                        {renderers?.map((renderer) => (
                                            <option key={renderer.id} value={`renderer:${renderer.id}`}>
                                                renderer:{renderer.id} (output only)
                                            </option>
                                        ))}
                                    </NativeSelect.Field>
                                    <NativeSelect.Indicator />
                                </NativeSelect.Root>
                            </Field.Root>
                            <Button type="submit" size="sm" loading={create.isPending}>
                                Generate token
                            </Button>
                        </Flex>
                    </form>
                    <FieldError error={create.error} />

                    {freshToken && (
                        <Alert.Root status="info" alignItems="flex-start">
                            <Alert.Indicator />
                            <Alert.Content width="full">
                                <Alert.Title>New token generated</Alert.Title>
                                <Alert.Description>Copy this token now — it will not be shown again.</Alert.Description>
                                <HStack width="full" mt="3" gap="2">
                                    <Code flex="1" minW="0" fontSize="sm" p="2" borderRadius="md" wordBreak="break-all">
                                        {freshToken}
                                    </Code>
                                    <CopyButton value={freshToken} label="Copy" size="sm" variant="outline" />
                                </HStack>
                            </Alert.Content>
                            <CloseButton size="sm" onClick={() => setFreshToken(undefined)} />
                        </Alert.Root>
                    )}

                    {!tokens?.length && (
                        <EmptyState title="No API tokens" description="Generate a token using the form above." />
                    )}

                    <Stack gap="2">
                        {tokens?.map((token) => (
                            <HStack
                                key={token.id}
                                justify="space-between"
                                gap="3"
                                px="3"
                                py="2"
                                borderRadius="md"
                                bg="bg.subtle"
                                wrap="wrap"
                            >
                                <Box>
                                    <Text fontWeight="medium" fontSize="sm">
                                        {token.label}
                                    </Text>
                                    <Text fontSize="xs" color="fg.muted">
                                        Created {new Date(token.createdAt).toLocaleString()}
                                    </Text>
                                </Box>
                                <HStack gap="3" flexShrink="0">
                                    <Badge>{token.scope}</Badge>
                                    <Code fontSize="xs" color="fg.muted" bg="transparent">
                                        {token.prefix}
                                    </Code>
                                    <Button
                                        size="xs"
                                        variant="outline"
                                        colorPalette="red"
                                        disabled={lastApiToken && token.scope === "api"}
                                        loading={revoke.isPending && revoke.variables === token.id}
                                        onClick={() => revoke.mutate(token.id)}
                                    >
                                        Revoke
                                    </Button>
                                </HStack>
                            </HStack>
                        ))}
                    </Stack>

                    <FieldError error={revoke.error ?? settingsError ?? tokensError ?? renderersError} />
                </Card.Body>
            </Card.Root>
        </Stack>
    );
}
