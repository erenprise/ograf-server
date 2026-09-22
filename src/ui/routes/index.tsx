import {
    Button,
    Card,
    Code,
    Dialog,
    Field,
    Flex,
    Grid,
    Heading,
    HStack,
    Input,
    Stack,
    Switch,
    Text,
} from "@chakra-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { homepage } from "../../../package.json" with { type: "json" };
import { DEFAULT_FRAME_RATE, DEFAULT_RESOLUTION } from "../../shared.ts";
import { adminRenderersQuery, createRenderer } from "../api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { FieldError } from "../components/FieldError.tsx";
import { Loading } from "../components/Loading.tsx";
import { Overlay } from "../components/Overlay.tsx";
import { RendererPanel } from "../components/RendererPanel.tsx";
import { UrlDisplay } from "../components/UrlDisplay.tsx";
import { useAutoSlug } from "../id.ts";

export function HomePage() {
    const { data: renderers, isLoading, error } = useQuery(adminRenderersQuery);
    const [showAdd, setShowAdd] = useState(false);

    return (
        <Stack gap="4">
            <Card.Root>
                <Card.Body gap="2">
                    <Heading size="sm">Server</Heading>
                    <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap="6" alignItems="start">
                        <UrlDisplay path="/api/ograf/v1" label="OGraf API:" allOrigins />
                        <Stack gap="1">
                            <UrlDisplay path="/docs/ograf" label="OGraf API Docs:" />
                            <UrlDisplay path="/docs/admin" label="Admin API Docs:" />
                            <HStack gap="2">
                                <Text fontSize="sm" color="fg.muted">
                                    Graphics Folder:
                                </Text>
                                <Code>./ograf-server/graphics</Code>
                            </HStack>
                            <UrlDisplay path={homepage} label="GitHub:" />
                        </Stack>
                    </Grid>
                </Card.Body>
            </Card.Root>

            <Flex justify="space-between" align="center" gap="3" wrap="wrap">
                <Heading size="md">Renderers</Heading>
                <Button size="sm" onClick={() => setShowAdd(true)}>
                    Add Renderer
                </Button>
            </Flex>

            {isLoading && <Loading />}
            <FieldError error={error} />
            {!isLoading && !renderers?.length && (
                <EmptyState title="No renderers" description="Add a renderer to start loading graphics." />
            )}

            <Stack gap="4">
                {renderers?.map((renderer) => (
                    <RendererPanel key={renderer.id} renderer={renderer} />
                ))}
            </Stack>

            {showAdd && <AddRendererDialog onClose={() => setShowAdd(false)} />}
        </Stack>
    );
}

function AddRendererDialog({ onClose }: { onClose: () => void }) {
    const queryClient = useQueryClient();
    const renderer = useAutoSlug();

    const create = useMutation({
        mutationFn: createRenderer,
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["admin", "renderers"] });
            onClose();
        },
    });

    return (
        <Overlay onClose={onClose} size="sm">
            <Dialog.Header>
                <Dialog.Title>Add Renderer</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
                <form
                    id="add-renderer-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        create.mutate({
                            id: renderer.id,
                            name: renderer.name,
                            resolution: {
                                width: Number(data.get("width")),
                                height: Number(data.get("height")),
                            },
                            frameRate: Number(data.get("frameRate")),
                            accessToPublicInternet: data.get("accessToPublicInternet") === "on",
                        });
                    }}
                >
                    <Stack gap="4">
                        <Field.Root>
                            <Field.Label>Name</Field.Label>
                            <Input
                                required
                                maxLength={256}
                                placeholder="Main Output"
                                value={renderer.name}
                                onChange={(event) => renderer.setName(event.target.value)}
                            />
                        </Field.Root>
                        <Field.Root>
                            <Field.Label>ID</Field.Label>
                            <Input
                                required
                                maxLength={128}
                                pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                                placeholder="main-output"
                                value={renderer.id}
                                onChange={(event) => renderer.setId(event.target.value)}
                            />
                        </Field.Root>
                        <HStack gap="3" align="flex-start">
                            <NumberField name="width" label="Width" value={DEFAULT_RESOLUTION.width} />
                            <NumberField name="height" label="Height" value={DEFAULT_RESOLUTION.height} />
                            <NumberField name="frameRate" label="Frame rate" value={DEFAULT_FRAME_RATE} step="any" />
                        </HStack>
                        <Switch.Root>
                            <Switch.HiddenInput name="accessToPublicInternet" />
                            <Switch.Control>
                                <Switch.Thumb />
                            </Switch.Control>
                            <Switch.Label>Renderer has public internet access</Switch.Label>
                        </Switch.Root>
                        <FieldError error={create.error} />
                    </Stack>
                </form>
            </Dialog.Body>
            <Dialog.Footer>
                <HStack justify="flex-end" gap="2">
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" form="add-renderer-form" loading={create.isPending}>
                        Create
                    </Button>
                </HStack>
            </Dialog.Footer>
        </Overlay>
    );
}

function NumberField({ name, label, value, step }: { name: string; label: string; value: number; step?: string }) {
    return (
        <Field.Root>
            <Field.Label>{label}</Field.Label>
            <Input name={name} type="number" defaultValue={value} min={1} step={step ?? 1} required />
        </Field.Root>
    );
}
