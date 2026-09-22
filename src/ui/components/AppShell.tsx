import { Badge, Box, Button, Card, Container, Flex, Heading, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { version } from "../../../package.json" with { type: "json" };
import { LOG_CATEGORIES, LOG_LEVELS, isRecord, type LogEntry, type ServerEvent } from "../../shared.ts";
import { AdminApiError, loginAdmin, logoutAdmin, logsQuery, adminRenderersQuery, settingsQuery } from "../api.ts";
import { FieldError } from "./FieldError.tsx";
import { Loading } from "./Loading.tsx";

const NAV = [
    { to: "/", label: "Home" },
    { to: "/graphics", label: "Graphics" },
    { to: "/logs", label: "Logs" },
    { to: "/settings", label: "Settings" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const { data: settings, isLoading, error } = useQuery(settingsQuery);
    const [reauthenticate, setReauthenticate] = useState(false);
    const lock = useMutation({
        mutationFn: logoutAdmin,
        onSuccess: () => {
            queryClient.removeQueries({ queryKey: ["admin"] });
            setReauthenticate(true);
        },
    });

    useEffect(() => {
        return queryClient.getQueryCache().subscribe(({ query }) => {
            const key = query.queryKey[0];
            if (typeof key !== "string" || !key.startsWith("admin")) {
                return;
            }
            const queryError = query.state.error;
            if (queryError instanceof AdminApiError && queryError.status === 401) {
                setReauthenticate(true);
            }
        });
    }, [queryClient]);

    const needsLogin = reauthenticate || (error instanceof AdminApiError && error.status === 401);

    return (
        <Box minH="100dvh">
            <Box
                as="header"
                borderBottomWidth="1px"
                borderColor="border"
                bg="bg.panel"
                position="sticky"
                top="0"
                zIndex="10"
            >
                <Container maxW="6xl" py="3">
                    <Flex align="center" gap="8" justify="space-between">
                        <HStack gap="8">
                            <HStack gap="2" align="baseline">
                                <Heading size="md">OGraf Server</Heading>
                                <Badge size="md" variant="subtle" colorPalette="gray">
                                    v{version}
                                </Badge>
                            </HStack>
                            <HStack gap="1">
                                {NAV.map((item) => (
                                    <Link
                                        key={item.to}
                                        to={item.to}
                                        activeOptions={{ exact: item.to === "/" }}
                                        style={{ textDecoration: "none" }}
                                    >
                                        {({ isActive }) => (
                                            <Box
                                                as="span"
                                                display="inline-block"
                                                px="3"
                                                py="1.5"
                                                borderRadius="md"
                                                fontWeight="medium"
                                                transition="background 120ms ease, color 120ms ease"
                                                bg={isActive ? "colorPalette.solid" : undefined}
                                                color={isActive ? "colorPalette.contrast" : "fg"}
                                                _hover={{ bg: isActive ? "colorPalette.solid" : "bg.subtle" }}
                                            >
                                                {item.label}
                                            </Box>
                                        )}
                                    </Link>
                                ))}
                            </HStack>
                        </HStack>
                        {settings?.authEnabled && !needsLogin && (
                            <Button size="xs" variant="outline" loading={lock.isPending} onClick={() => lock.mutate()}>
                                Lock UI
                            </Button>
                        )}
                    </Flex>
                </Container>
            </Box>
            <Container maxW="6xl" py="6">
                {isLoading && <Loading />}
                {needsLogin && <AdminLogin onSuccess={() => setReauthenticate(false)} />}
                {!isLoading && !needsLogin && error && (
                    <Text color="fg.error">Could not load admin settings: {error.message}</Text>
                )}
                {!isLoading && !needsLogin && !error && settings && (
                    <>
                        <AdminEvents />
                        {children}
                    </>
                )}
            </Container>
        </Box>
    );
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
    const queryClient = useQueryClient();
    const [token, setToken] = useState("");
    const login = useMutation({
        mutationFn: () => loginAdmin(token),
        onSuccess: () => {
            setToken("");
            onSuccess();
            void queryClient.invalidateQueries({ queryKey: ["admin"] });
        },
    });

    return (
        <Card.Root maxW="md" mx="auto">
            <Card.Body>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        login.mutate();
                    }}
                >
                    <Stack gap="4">
                        <Heading size="sm">Admin access</Heading>
                        <Text color="fg.muted" fontSize="sm">
                            Enter an API-scoped token. It is sent once and kept in an HttpOnly cookie.
                        </Text>
                        <Input
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder="ogr_…"
                            autoComplete="off"
                        />
                        {login.error && <FieldError error={login.error} />}
                        <Button type="submit" loading={login.isPending} disabled={!token} alignSelf="flex-start">
                            Sign in
                        </Button>
                    </Stack>
                </form>
            </Card.Body>
        </Card.Root>
    );
}

function AdminEvents() {
    const queryClient = useQueryClient();

    useEffect(() => {
        const source = new EventSource("/api/admin/events");
        const sync = () => {
            void queryClient.invalidateQueries({ queryKey: ["admin"] });
            void queryClient.invalidateQueries({ queryKey: ["ograf", "renderer"] });
            void queryClient.invalidateQueries({ queryKey: ["ograf", "graphics"] });
        };
        source.addEventListener("open", sync);
        source.addEventListener("message", (event: MessageEvent<string>) => {
            try {
                const data: unknown = JSON.parse(event.data);
                if (!isServerEvent(data)) {
                    return;
                }
                if (data.type === "log") {
                    queryClient.setQueryData<LogEntry[]>(logsQuery.queryKey, (previous = []) => [
                        ...previous.slice(-999),
                        data.entry,
                    ]);
                } else if (data.type === "renderers.changed") {
                    void queryClient.invalidateQueries({ queryKey: adminRenderersQuery.queryKey });
                    void queryClient.invalidateQueries({ queryKey: ["ograf", "renderer"] });
                } else {
                    void queryClient.invalidateQueries({ queryKey: ["admin", "graphics"] });
                    void queryClient.invalidateQueries({ queryKey: ["ograf", "graphics"] });
                }
            } catch {
                return;
            }
        });
        return () => source.close();
    }, [queryClient]);

    return null;
}

function isServerEvent(value: unknown): value is ServerEvent {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }
    if (value.type === "renderers.changed") {
        return value.rendererId === undefined || typeof value.rendererId === "string";
    }
    if (value.type === "graphics.changed") {
        return true;
    }
    if (value.type !== "log" || !isRecord(value.entry)) {
        return false;
    }
    const entry = value.entry;
    return (
        typeof entry.id === "number" &&
        typeof entry.time === "string" &&
        typeof entry.message === "string" &&
        LOG_LEVELS.some((level) => level === entry.level) &&
        LOG_CATEGORIES.some((category) => category === entry.category)
    );
}
