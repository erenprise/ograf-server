import {
    Alert,
    Badge,
    Box,
    Button,
    Card,
    Code,
    Dialog,
    Field,
    Flex,
    Heading,
    HStack,
    Image,
    Input,
    Link,
    Stack,
    Text,
} from "@chakra-ui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MAX_PACKAGE_ID_LENGTH } from "../../shared.ts";
import { type AdminGraphicSummary, adminGraphicsQuery, deleteGraphic, uploadGraphicPackage } from "../api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { FieldError } from "../components/FieldError.tsx";
import { Loading } from "../components/Loading.tsx";
import { Overlay } from "../components/Overlay.tsx";

const SAMPLE_GRAPHICS = [
    { title: "github.com/ebu/ograf", url: "https://github.com/ebu/ograf/tree/main/v1/examples" },
    { title: "github.com/nytamin/ograf-graphics", url: "https://github.com/nytamin/ograf-graphics/tree/main/graphics" },
];

export function GraphicsPage() {
    const { data: graphics, isLoading, error } = useQuery(adminGraphicsQuery);
    const queryClient = useQueryClient();
    const [showUpload, setShowUpload] = useState(false);
    const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["admin", "graphics"] });

    return (
        <Stack gap="6">
            <Flex justify="space-between" align="flex-start" gap="3" wrap="wrap">
                <Box>
                    <Heading size="md">Graphics</Heading>
                    <Text fontSize="sm" color="fg.muted">
                        Manage installed OGraf graphics and packages.
                    </Text>
                </Box>
                <HStack gap="2" flexShrink="0">
                    <Button size="sm" onClick={() => setShowUpload(true)}>
                        Upload Graphic
                    </Button>
                </HStack>
            </Flex>

            {isLoading && <Loading />}
            <FieldError error={error} />
            {!isLoading && !graphics?.length && (
                <EmptyState
                    title="No graphics found"
                    description="Upload a package or add one to ./ograf-server/graphics folder."
                >
                    <HStack gap="2" wrap="wrap" justify="center">
                        <Text fontSize="sm" color="fg.muted">
                            Download a sample graphic pack from:
                        </Text>
                        {SAMPLE_GRAPHICS.map(({ title, url }) => (
                            <Link key={url} href={url} target="_blank" rel="noopener noreferrer">
                                {title} ↗
                            </Link>
                        ))}
                    </HStack>
                </EmptyState>
            )}

            <Stack gap="3">
                {graphics?.map((graphic) => (
                    <GraphicCard key={graphic.manifestPath} graphic={graphic} onChanged={invalidate} />
                ))}
            </Stack>

            {showUpload && (
                <UploadGraphicDialog
                    onClose={() => setShowUpload(false)}
                    onUploaded={() => {
                        invalidate();
                        setShowUpload(false);
                    }}
                />
            )}
        </Stack>
    );
}

function UploadGraphicDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
    const upload = useMutation({
        mutationFn: ({ packageId, file }: { packageId: string; file: File }) => uploadGraphicPackage(packageId, file),
        onSuccess: onUploaded,
    });

    return (
        <Overlay onClose={onClose} size="sm">
            <Dialog.Header>
                <Dialog.Title>Upload Graphic</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
                <form
                    id="upload-graphic-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        const packageId = data.get("packageId");
                        const file = data.get("file");
                        if (typeof packageId === "string" && file instanceof File) {
                            upload.mutate({ packageId: packageId, file: file });
                        }
                    }}
                >
                    <Stack gap="4">
                        <Field.Root>
                            <Field.Label>Package folder name</Field.Label>
                            <Input
                                name="packageId"
                                required
                                maxLength={MAX_PACKAGE_ID_LENGTH}
                                pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                                placeholder="news"
                            />
                        </Field.Root>
                        <Field.Root>
                            <Field.Label>ZIP file</Field.Label>
                            <Input name="file" type="file" accept=".zip" p="1" required />
                        </Field.Root>
                        <FieldError error={upload.error} />
                    </Stack>
                </form>
            </Dialog.Body>
            <Dialog.Footer>
                <HStack justify="flex-end" gap="2">
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" form="upload-graphic-form" loading={upload.isPending}>
                        Upload
                    </Button>
                </HStack>
            </Dialog.Footer>
        </Overlay>
    );
}

function GraphicCard({ graphic, onChanged }: { graphic: AdminGraphicSummary; onChanged: () => void }) {
    const thumbnail = graphic.thumbnails?.[0];
    const thumbnailSrc = `/api/ograf/v1/graphics/${encodeURIComponent(graphic.id)}/thumbnail?file=${encodeURIComponent(thumbnail?.file ?? "")}`;
    const remove = useMutation({ mutationFn: () => deleteGraphic(graphic.id), onSuccess: onChanged });
    const errors = graphic.issues.filter((issue) => issue.severity === "error");
    const identity = [
        `ID: ${graphic.id}`,
        graphic.version ? `Version: v${graphic.version}` : "",
        `Package: ${graphic.packageId}`,
    ].filter((part) => part);
    const capabilities = [
        graphic.supportsRealTime ? "Real-time" : "Non-real-time",
        graphic.stepCount === undefined ? "Default steps" : `${graphic.stepCount} step(s)`,
        `${graphic.customActionCount} custom action(s)`,
    ];

    const handleDelete = () => {
        if (confirm(`Delete graphic "${graphic.id}"?`)) {
            remove.mutate();
        }
    };

    return (
        <Card.Root>
            <Card.Body>
                <Flex gap="4" align="flex-start">
                    {graphic.valid && thumbnail && (
                        <Image
                            src={thumbnailSrc}
                            alt=""
                            w="32"
                            h="18"
                            flexShrink="0"
                            objectFit="cover"
                            borderRadius="md"
                        />
                    )}
                    <Stack flex="1" minW="0" gap="2">
                        <HStack gap="2" wrap="wrap">
                            <Heading size="sm">{graphic.name ?? graphic.id}</Heading>
                            <Badge colorPalette={graphic.valid ? "green" : "red"}>
                                {graphic.valid ? "Valid" : "Invalid"}
                            </Badge>
                            {graphic.pendingDelete && <Badge colorPalette="orange">Pending delete</Badge>}
                        </HStack>

                        <Text fontSize="sm" color="fg.muted">
                            {identity.join(" · ")}
                        </Text>
                        <Text fontSize="xs" color="fg.muted" wordBreak="break-all">
                            Manifest: {graphic.manifestPath}
                        </Text>
                        {graphic.description && <Text fontSize="sm">{graphic.description}</Text>}
                        <Text fontSize="xs" color="fg.muted">
                            {capabilities.join(" · ")}
                        </Text>

                        {graphic.pendingDelete && graphic.deleteAfter && (
                            <Text fontSize="xs" color="fg.warning">
                                Deletes after {new Date(graphic.deleteAfter).toLocaleString()}.
                            </Text>
                        )}

                        {errors.length > 0 && (
                            <Alert.Root status="error" size="sm" alignItems="flex-start">
                                <Alert.Indicator />
                                <Alert.Content>
                                    <Alert.Title>Validation failed</Alert.Title>
                                    {errors.map((issue) => (
                                        <Alert.Description key={`${issue.code}:${issue.path ?? ""}`} display="block">
                                            <Code fontSize="xs">{issue.code}</Code>: {issue.message}{" "}
                                            {issue.path && `(${issue.path})`}
                                        </Alert.Description>
                                    ))}
                                </Alert.Content>
                            </Alert.Root>
                        )}

                        <FieldError error={remove.error} />
                    </Stack>
                    {!graphic.pendingDelete && (
                        <Button
                            flexShrink="0"
                            size="xs"
                            variant="outline"
                            colorPalette="red"
                            loading={remove.isPending}
                            onClick={handleDelete}
                        >
                            Delete
                        </Button>
                    )}
                </Flex>
            </Card.Body>
        </Card.Root>
    );
}
