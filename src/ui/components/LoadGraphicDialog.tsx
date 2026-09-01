import { Button, Combobox, createListCollection, Dialog, Field, HStack, Stack, Text } from "@chakra-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { JsonObject } from "../../shared.ts";
import { adminGraphicDetailQuery, adminGraphicsQuery, loadGraphic } from "../api.ts";
import { FieldError } from "./FieldError.tsx";
import { Overlay } from "./Overlay.tsx";
import { schemaDefaults, SchemaForm } from "./SchemaForm.tsx";

export function LoadGraphicDialog({
    rendererId,
    renderTarget,
    onClose,
    onLoaded,
}: {
    rendererId: string;
    renderTarget: JsonObject;
    onClose: () => void;
    onLoaded: () => void;
}) {
    const { data: graphics, error: graphicsError } = useQuery(adminGraphicsQuery);
    const [graphicId, setGraphicId] = useState("");
    const [search, setSearch] = useState("");
    const [data, setData] = useState<Record<string, unknown>>();

    const collection = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const items = (graphics ?? [])
            .filter(
                (graphic) =>
                    graphic.valid &&
                    graphic.supportsRealTime &&
                    !graphic.pendingDelete &&
                    [graphic.name, graphic.id, graphic.description, graphic.packageId].some((value) =>
                        value?.toLowerCase().includes(needle),
                    ),
            )
            .map((graphic) => ({
                label: graphic.name ?? graphic.id,
                value: graphic.id,
                version: graphic.version,
                description: graphic.description,
            }));
        return createListCollection({ items: items });
    }, [graphics, search]);

    const { data: manifest, error: manifestError } = useQuery(adminGraphicDetailQuery(graphicId));
    const formData = data ?? schemaDefaults(manifest?.schema);

    const load = useMutation({
        mutationFn: () => loadGraphic(rendererId, renderTarget, graphicId, formData),
        onSuccess: () => {
            onLoaded();
            onClose();
        },
    });

    return (
        <Overlay onClose={onClose} size="md">
            <Dialog.Header>
                <Dialog.Title>Load Graphic</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
                <Stack gap="4">
                    <Field.Root>
                        <Field.Label>Graphic</Field.Label>
                        <Combobox.Root
                            collection={collection}
                            size="sm"
                            openOnClick
                            onInputValueChange={(details) => setSearch(details.inputValue)}
                            onValueChange={(details) => {
                                setGraphicId(details.value[0] ?? "");
                                setData(undefined);
                                load.reset();
                            }}
                        >
                            <Combobox.Control>
                                <Combobox.Input placeholder="Search graphics…" />
                                <Combobox.IndicatorGroup>
                                    <Combobox.ClearTrigger />
                                    <Combobox.Trigger />
                                </Combobox.IndicatorGroup>
                            </Combobox.Control>
                            <Combobox.Positioner>
                                <Combobox.Content>
                                    <Combobox.Empty>No matching graphics</Combobox.Empty>
                                    {collection.items.map((item) => (
                                        <Combobox.Item item={item} key={item.value}>
                                            <Stack gap="0" flex="1" minW="0">
                                                <Text fontWeight="medium">{item.label}</Text>
                                                <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                                                    {item.version ? `${item.value} · v${item.version}` : item.value}
                                                </Text>
                                                {item.description && (
                                                    <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                                                        {item.description}
                                                    </Text>
                                                )}
                                            </Stack>
                                            <Combobox.ItemIndicator />
                                        </Combobox.Item>
                                    ))}
                                </Combobox.Content>
                            </Combobox.Positioner>
                        </Combobox.Root>
                    </Field.Root>

                    {manifest && (
                        <SchemaForm key={manifest.id} schema={manifest.schema} value={formData} onChange={setData} />
                    )}

                    <FieldError error={graphicsError ?? manifestError ?? load.error} />
                </Stack>
            </Dialog.Body>
            <Dialog.Footer>
                <HStack justify="flex-end" gap="2">
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button disabled={!graphicId} loading={load.isPending} onClick={() => load.mutate()}>
                        Load
                    </Button>
                </HStack>
            </Dialog.Footer>
        </Overlay>
    );
}
