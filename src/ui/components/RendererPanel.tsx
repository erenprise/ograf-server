import {
    Badge,
    Box,
    Button,
    Card,
    chakra,
    Code,
    Collapsible,
    Field,
    Flex,
    Heading,
    HStack,
    Input,
    NativeSelect,
    Stack,
    Text,
} from "@chakra-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { JsonObject } from "../../shared.ts";
import { useAutoSlug } from "../id.ts";
import {
    addLayer,
    adminGraphicDetailQuery,
    adminGraphicsQuery,
    type AdminRendererSummary,
    clearGraphics,
    deleteRenderer,
    type PublicGraphicInstance,
    type PublicRenderTargetInfo,
    playGraphicInstance,
    publicRendererQuery,
    removeLayer,
    runGraphicCustomAction,
    runRendererCustomAction,
    stopGraphicInstance,
    updateGraphicInstance,
} from "../api.ts";
import { FieldError } from "./FieldError.tsx";
import { LoadGraphicDialog } from "./LoadGraphicDialog.tsx";
import { schemaDefaults, SchemaForm } from "./SchemaForm.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { RendererUrls } from "./UrlDisplay.tsx";

type AdminRendererLayer = AdminRendererSummary["layers"][number];
type CommandFn = (...args: never[]) => Promise<unknown>;

export function RendererPanel({ renderer }: { renderer: AdminRendererSummary }) {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(false);
    const { data: detail, error: detailError } = useQuery({
        ...publicRendererQuery(renderer.id),
        enabled: expanded,
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ["admin", "renderers"] });
        void queryClient.invalidateQueries({ queryKey: ["ograf", "renderer", renderer.id] });
    };
    const command = <F extends CommandFn>(run: F) => ({ mutationFn: run, onSuccess: invalidate });

    const reload = useMutation(command(() => runRendererCustomAction(renderer.id, "reload", {})));
    const clear = useMutation(command(() => clearGraphics(renderer.id, [])));
    const remove = useMutation({
        mutationFn: () => deleteRenderer(renderer.id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "renderers"] }),
    });

    const handleClear = () => {
        if (confirm("Clear all loaded graphics on this renderer?")) {
            clear.mutate();
        }
    };
    const handleDelete = () => {
        if (confirm(`Delete renderer "${renderer.id}"? This cannot be undone.`)) {
            remove.mutate();
        }
    };

    return (
        <Collapsible.Root asChild open={expanded} onOpenChange={(details) => setExpanded(details.open)}>
            <Card.Root>
                <Card.Body gap="4">
                    <Flex justify="space-between" align="center" gap="3" wrap="wrap">
                        <HStack gap="2" wrap="wrap">
                            <StatusBadge status={renderer.status} />
                            <Heading size="sm">{renderer.name}</Heading>
                            <IdBadge>{renderer.id}</IdBadge>
                            <Text color="fg.muted" fontSize="sm">
                                {renderer.resolution.width}×{renderer.resolution.height} · {renderer.frameRate} fps
                            </Text>
                        </HStack>
                        <HStack gap="1" flexShrink="0">
                            <Collapsible.Trigger asChild>
                                <Button size="sm" variant="ghost">
                                    Layers
                                    <Chevron open={expanded} />
                                </Button>
                            </Collapsible.Trigger>
                            <Button
                                size="sm"
                                variant="outline"
                                loading={reload.isPending}
                                onClick={() => reload.mutate()}
                            >
                                Reload
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                colorPalette="yellow"
                                loading={clear.isPending}
                                onClick={handleClear}
                            >
                                Clear
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                colorPalette="red"
                                loading={remove.isPending}
                                onClick={handleDelete}
                            >
                                Delete
                            </Button>
                        </HStack>
                    </Flex>

                    <FieldError error={reload.error ?? clear.error ?? remove.error} />

                    <Collapsible.Content>
                        <Stack gap="4">
                            <FieldError error={detailError} />
                            <RendererUrls rendererId={renderer.id} />
                            <AddLayerRow rendererId={renderer.id} onChanged={invalidate} />
                            {!renderer.layers.length ? (
                                <Text fontSize="sm" color="fg.subtle">
                                    No layers yet.
                                </Text>
                            ) : (
                                renderer.layers.map((layer) => (
                                    <LayerSection
                                        key={layer.id}
                                        rendererId={renderer.id}
                                        layer={layer}
                                        target={detail?.renderTargets.find(
                                            (target) => target.renderTarget.layer === layer.id,
                                        )}
                                        onChanged={invalidate}
                                    />
                                ))
                            )}
                        </Stack>
                    </Collapsible.Content>
                </Card.Body>
            </Card.Root>
        </Collapsible.Root>
    );
}

function AddLayerRow({ rendererId, onChanged }: { rendererId: string; onChanged: () => void }) {
    const layer = useAutoSlug();
    const add = useMutation({
        mutationFn: () => addLayer(rendererId, { id: layer.id, name: layer.name }),
        onSuccess: () => {
            layer.reset();
            onChanged();
        },
    });

    return (
        <Stack
            as="form"
            gap="2"
            onSubmit={(event) => {
                event.preventDefault();
                add.mutate();
            }}
        >
            <Flex gap="3" align="flex-end" wrap="wrap">
                <Field.Root flex="1" minW="2xs">
                    <Field.Label>Layer name</Field.Label>
                    <Input
                        size="sm"
                        required
                        maxLength={256}
                        placeholder="Lower Third"
                        value={layer.name}
                        onChange={(event) => layer.setName(event.target.value)}
                    />
                </Field.Root>
                <Field.Root flex="1" minW="2xs">
                    <Field.Label>Layer ID</Field.Label>
                    <Input
                        size="sm"
                        required
                        maxLength={128}
                        pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                        placeholder="lower-third"
                        value={layer.id}
                        onChange={(event) => layer.setId(event.target.value)}
                    />
                </Field.Root>
                <Button type="submit" size="sm" loading={add.isPending}>
                    Add layer
                </Button>
            </Flex>
            <FieldError error={add.error} />
        </Stack>
    );
}

function LayerSection({
    rendererId,
    layer,
    target,
    onChanged,
}: {
    rendererId: string;
    layer: AdminRendererLayer;
    target: PublicRenderTargetInfo | undefined;
    onChanged: () => void;
}) {
    const [showLoad, setShowLoad] = useState(false);
    const instances = target?.graphicInstances ?? [];
    const renderTarget: JsonObject = { layer: layer.id };
    const command = <F extends CommandFn>(run: F) => ({ mutationFn: run, onSuccess: onChanged });

    const clear = useMutation(command(() => clearGraphics(rendererId, [{ renderTarget: renderTarget }])));
    const remove = useMutation(command(() => removeLayer(rendererId, layer.id)));

    const handleRemove = () => {
        if (!layer.graphicCount || confirm(`Remove layer "${layer.id}" and its loaded graphics?`)) {
            remove.mutate();
        }
    };

    return (
        <>
            <Card.Root variant="outline" size="sm">
                <Card.Body gap="3">
                    <Flex justify="space-between" align="flex-start" gap="3" wrap="wrap">
                        <HStack gap="2" wrap="wrap">
                            <Heading size="sm">{layer.name}</Heading>
                            <IdBadge>{layer.id}</IdBadge>
                            {layer.graphicCount > 0 && (
                                <Text fontSize="xs" color="fg.muted">
                                    {layer.graphicCount} graphic(s) loaded
                                </Text>
                            )}
                        </HStack>
                        <HStack gap="2" flexShrink="0">
                            <Button size="xs" onClick={() => setShowLoad(true)}>
                                Load Graphic
                            </Button>
                            <Button
                                size="xs"
                                variant="outline"
                                disabled={!instances.length}
                                loading={clear.isPending}
                                onClick={() => clear.mutate()}
                            >
                                Clear Layer
                            </Button>
                            <Button
                                size="xs"
                                variant="outline"
                                colorPalette="red"
                                loading={remove.isPending}
                                onClick={handleRemove}
                            >
                                Remove
                            </Button>
                        </HStack>
                    </Flex>

                    {!instances.length ? (
                        <Text fontSize="sm" color="fg.subtle">
                            No graphics loaded.
                        </Text>
                    ) : (
                        <Stack gap="1">
                            {instances.map((instance) => (
                                <GraphicInstanceRow
                                    key={instance.graphicInstanceId}
                                    rendererId={rendererId}
                                    renderTarget={renderTarget}
                                    instance={instance}
                                    onChanged={onChanged}
                                />
                            ))}
                        </Stack>
                    )}

                    <FieldError error={clear.error ?? remove.error} />
                </Card.Body>
            </Card.Root>

            {showLoad && (
                <LoadGraphicDialog
                    rendererId={rendererId}
                    renderTarget={renderTarget}
                    onClose={() => setShowLoad(false)}
                    onLoaded={onChanged}
                />
            )}
        </>
    );
}

function GraphicInstanceRow({
    rendererId,
    renderTarget,
    instance,
    onChanged,
}: {
    rendererId: string;
    renderTarget: JsonObject;
    instance: PublicGraphicInstance;
    onChanged: () => void;
}) {
    const { graphicInstanceId } = instance;
    const [expanded, setExpanded] = useState(false);
    const { data: graphics } = useQuery(adminGraphicsQuery);
    const { data: manifest, error: manifestError } = useQuery({
        ...adminGraphicDetailQuery(instance.graphic.id),
        enabled: expanded,
    });
    const [data, setData] = useState<Record<string, unknown>>({});
    const [customActionId, setCustomActionId] = useState("");
    const [customPayload, setCustomPayload] = useState<Record<string, unknown>>({});
    const customActions = manifest?.customActions ?? [];
    const selectedAction = customActions.find((action) => action.id === customActionId);
    const formData = { ...schemaDefaults(manifest?.schema), ...data };
    const customFormData = { ...schemaDefaults(selectedAction?.schema), ...customPayload };
    const command = <F extends CommandFn>(run: F) => ({ mutationFn: run, onSuccess: onChanged });

    const update = useMutation(
        command(() => updateGraphicInstance(rendererId, renderTarget, graphicInstanceId, formData)),
    );
    const play = useMutation(
        command((delta: number) => playGraphicInstance(rendererId, renderTarget, graphicInstanceId, delta)),
    );
    const stop = useMutation(command(() => stopGraphicInstance(rendererId, renderTarget, graphicInstanceId)));
    const clearOne = useMutation(command(() => clearGraphics(rendererId, [{ graphicInstanceId: graphicInstanceId }])));
    const runCustom = useMutation(
        command(() =>
            runGraphicCustomAction(rendererId, renderTarget, graphicInstanceId, customActionId, customFormData),
        ),
    );

    const version = graphics?.find((graphic) => graphic.id === instance.graphic.id)?.version;
    const hasSteps = (manifest?.stepCount ?? 1) !== 1;
    const error = [manifestError, update.error, play.error, stop.error, clearOne.error].find((item) => item);

    return (
        <Collapsible.Root asChild open={expanded} onOpenChange={(details) => setExpanded(details.open)}>
            <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" px="2" py="1.5">
                <Flex align="center" gap="2">
                    <Collapsible.Trigger asChild>
                        <Button size="xs" variant="ghost" aria-label="Graphic controls">
                            <Chevron open={expanded} />
                        </Button>
                    </Collapsible.Trigger>
                    <Text fontSize="sm" fontWeight="medium" flex="1" minW="0" truncate>
                        {instance.graphic.name}
                    </Text>
                    {version && (
                        <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                            v{version}
                        </Text>
                    )}
                </Flex>

                <Collapsible.Content>
                    <Stack gap="3" pt="3">
                        <HStack gap="2" wrap="wrap">
                            <Code fontSize="xs" color="fg.muted">
                                {graphicInstanceId}
                            </Code>
                            {hasSteps && (
                                <Button size="xs" variant="outline" onClick={() => play.mutate(-1)}>
                                    Previous
                                </Button>
                            )}
                            <Button size="xs" variant="outline" onClick={() => play.mutate(1)}>
                                {hasSteps ? "Next" : "Play"}
                            </Button>
                            <Button size="xs" variant="outline" onClick={() => stop.mutate()}>
                                Stop
                            </Button>
                            <Button size="xs" variant="outline" colorPalette="red" onClick={() => clearOne.mutate()}>
                                Clear
                            </Button>
                        </HStack>

                        <Box>
                            <SectionLabel>Update data</SectionLabel>
                            <SchemaForm
                                key={manifest?.id ?? "loading"}
                                schema={manifest?.schema}
                                value={formData}
                                onChange={setData}
                            />
                            <Button size="xs" mt="2" loading={update.isPending} onClick={() => update.mutate()}>
                                Update
                            </Button>
                        </Box>

                        {customActions.length > 0 && (
                            <Box borderTopWidth="1px" pt="3">
                                <SectionLabel>Custom actions</SectionLabel>
                                <HStack align="flex-end" wrap="wrap">
                                    <NativeSelect.Root size="xs" maxW="2xs">
                                        <NativeSelect.Field
                                            value={customActionId}
                                            onChange={(event) => {
                                                setCustomActionId(event.target.value);
                                                setCustomPayload({});
                                            }}
                                        >
                                            <option value="">Select…</option>
                                            {customActions.map((action) => (
                                                <option key={action.id} value={action.id}>
                                                    {action.name}
                                                </option>
                                            ))}
                                        </NativeSelect.Field>
                                        <NativeSelect.Indicator />
                                    </NativeSelect.Root>
                                    <Button
                                        size="xs"
                                        disabled={!customActionId}
                                        loading={runCustom.isPending}
                                        onClick={() => runCustom.mutate()}
                                    >
                                        Run
                                    </Button>
                                </HStack>
                                {selectedAction?.schema && (
                                    <Box mt="2">
                                        <SchemaForm
                                            key={customActionId}
                                            schema={selectedAction.schema}
                                            value={customFormData}
                                            onChange={setCustomPayload}
                                        />
                                    </Box>
                                )}
                                <FieldError error={runCustom.error} />
                            </Box>
                        )}

                        <FieldError error={error} />
                    </Stack>
                </Collapsible.Content>
            </Box>
        </Collapsible.Root>
    );
}

function SectionLabel({ children }: { children: string }) {
    return (
        <Text fontSize="xs" fontWeight="medium" color="fg.muted" mb="1">
            {children}
        </Text>
    );
}

function IdBadge({ children }: { children: string }) {
    return (
        <Badge variant="subtle" colorPalette="gray" fontFamily="mono" fontWeight="normal">
            {children}
        </Badge>
    );
}

const SvgIcon = chakra("svg");

function Chevron({ open }: { open: boolean }) {
    return (
        <SvgIcon
            boxSize="4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            transition="transform 0.2s"
            transform={open ? "rotate(90deg)" : undefined}
        >
            <path d="m9 6 6 6-6 6" />
        </SvgIcon>
    );
}
