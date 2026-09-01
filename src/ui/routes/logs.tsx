import { Badge, Button, Card, HStack, Input, NativeSelect, ScrollArea, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { LOG_CATEGORIES, LOG_LEVELS, type LogEntry } from "../../shared.ts";
import { logsQuery } from "../api.ts";
import { FieldError } from "../components/FieldError.tsx";

const LEVEL_COLOR: Record<LogEntry["level"], string> = { debug: "gray", info: "blue", warn: "orange", error: "red" };

function LogOptions({ label, items }: { label: string; items: readonly string[] }) {
    return ["", ...items].map((item) => (
        <option key={item} value={item}>
            {item || label}
        </option>
    ));
}

export function LogsPage() {
    const queryClient = useQueryClient();
    const { data: logs = [], error } = useQuery(logsQuery);
    const [level, setLevel] = useState("");
    const [category, setCategory] = useState("");
    const [search, setSearch] = useState("");
    const [autoScroll, setAutoScroll] = useState(true);
    const bottomRef = useRef<HTMLDivElement>(null);
    const normalizedSearch = search.toLowerCase();

    useEffect(() => {
        if (autoScroll && logs.length) {
            bottomRef.current?.scrollIntoView({ block: "end" });
        }
    }, [autoScroll, logs.length]);

    const filtered = logs.filter(
        (entry) =>
            (!level || entry.level === level) &&
            (!category || entry.category === category) &&
            (!normalizedSearch || entry.message.toLowerCase().includes(normalizedSearch)),
    );

    return (
        <Stack gap="4">
            <HStack wrap="wrap" gap="3">
                <NativeSelect.Root w="36">
                    <NativeSelect.Field value={level} onChange={(event) => setLevel(event.target.value)}>
                        <LogOptions label="All levels" items={LOG_LEVELS} />
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                </NativeSelect.Root>
                <NativeSelect.Root w="40">
                    <NativeSelect.Field value={category} onChange={(event) => setCategory(event.target.value)}>
                        <LogOptions label="All categories" items={LOG_CATEGORIES} />
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                </NativeSelect.Root>
                <Input
                    placeholder="Search…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    maxW="xs"
                />
                <Button
                    size="sm"
                    variant={autoScroll ? "solid" : "outline"}
                    onClick={() => setAutoScroll((value) => !value)}
                >
                    Auto-scroll {autoScroll ? "on" : "off"}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => queryClient.setQueryData<LogEntry[]>(logsQuery.queryKey, [])}
                >
                    Clear view
                </Button>
            </HStack>

            {error && <FieldError error={error} />}
            <Card.Root>
                <Card.Body>
                    <ScrollArea.Root maxH="70vh">
                        <ScrollArea.Viewport>
                            {filtered.map((entry) => (
                                <HStack
                                    key={entry.id}
                                    gap="2"
                                    py="0.5"
                                    borderBottomWidth="1px"
                                    borderColor="border.subtle"
                                    align="flex-start"
                                >
                                    <Text color="fg.subtle" flexShrink="0">
                                        {new Date(entry.time).toLocaleTimeString()}
                                    </Text>
                                    <Badge colorPalette={LEVEL_COLOR[entry.level]} flexShrink="0">
                                        {entry.level}
                                    </Badge>
                                    <Text color="fg.muted" flexShrink="0">
                                        {entry.category}
                                    </Text>
                                    <Text>{entry.message}</Text>
                                </HStack>
                            ))}
                            <div ref={bottomRef} />
                        </ScrollArea.Viewport>
                        <ScrollArea.Scrollbar>
                            <ScrollArea.Thumb />
                        </ScrollArea.Scrollbar>
                    </ScrollArea.Root>
                </Card.Body>
            </Card.Root>
        </Stack>
    );
}
