import { Button, Stack, Text, Textarea } from "@chakra-ui/react";
import type { GraphicsManifest } from "ograf";
import { getDefaultDataFromSchema, type GDDSchema } from "ograf-form";
import { useEffect, useRef, useState } from "react";
import { isRecord } from "../../shared.ts";

type SchemaFormProps = {
    schema: ManifestSchema | null | undefined;
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
};

type ManifestSchema = NonNullable<GraphicsManifest["schema"]>;

export function schemaDefaults(schema: ManifestSchema | null | undefined): Record<string, unknown> {
    const formSchema = toFormSchema(schema);
    const defaults = formSchema && getDefaultDataFromSchema(formSchema);
    return isRecord(defaults) ? defaults : {};
}

export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
    const formSchema = toFormSchema(schema);
    const [useJson, setUseJson] = useState(!formSchema);
    const effectiveValue = { ...schemaDefaults(schema), ...value };

    if (!formSchema || useJson) {
        return (
            <JsonEditor
                key={JSON.stringify(effectiveValue)}
                value={effectiveValue}
                onChange={onChange}
                onUseForm={formSchema ? () => setUseJson(false) : undefined}
            />
        );
    }

    return (
        <Stack gap="2">
            <OgrafForm schema={formSchema} value={effectiveValue} onChange={onChange} />
            <Button size="xs" variant="outline" alignSelf="flex-start" onClick={() => setUseJson(true)}>
                Advanced (JSON)
            </Button>
        </Stack>
    );
}

function toFormSchema(schema: ManifestSchema | null | undefined): GDDSchema | undefined {
    if (schema?.type !== "object" || !schema.properties) {
        return undefined;
    }
    // The validator exposes a deliberately loose JSON-schema type. `ograf-form` uses the equivalent stricter form type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return schema as unknown as GDDSchema;
}

function OgrafForm({
    schema,
    value,
    onChange,
}: {
    schema: GDDSchema;
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
}) {
    const ref = useRef<FormElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) {
            return undefined;
        }

        element.schema = schema;
        const handle = () => {
            const next = element.value;
            if (isRecord(next)) {
                onChange(next);
            }
        };
        element.addEventListener("change", handle);

        return () => {
            element.removeEventListener("change", handle);
        };
    }, [schema, onChange]);

    useEffect(() => {
        const element = ref.current;
        if (element && JSON.stringify(element.value) !== JSON.stringify(value)) {
            element.value = value;
        }
    }, [value]);

    return <superflytv-ograf-form ref={ref} />;
}

function JsonEditor({
    value,
    onChange,
    onUseForm,
}: {
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
    onUseForm?: () => void;
}) {
    const [text, setText] = useState(() => JSON.stringify(value, null, 2));
    const [error, setError] = useState<string>();

    return (
        <Stack gap="2">
            <Textarea
                fontFamily="mono"
                fontSize="sm"
                minH="36"
                value={text}
                onChange={(event) => {
                    setText(event.target.value);
                    try {
                        const parsed: unknown = !event.target.value.trim() ? {} : JSON.parse(event.target.value);
                        if (!isRecord(parsed)) {
                            throw new Error("Expected an object");
                        }
                        onChange(parsed);
                        setError(undefined);
                    } catch {
                        setError("Invalid JSON object");
                    }
                }}
            />
            {error && (
                <Text color="fg.error" fontSize="sm">
                    {error}
                </Text>
            )}
            {onUseForm && (
                <Button size="xs" variant="outline" alignSelf="flex-start" onClick={onUseForm}>
                    Use form
                </Button>
            )}
        </Stack>
    );
}

type FormElement = HTMLElement & { schema?: GDDSchema; value?: unknown };

declare module "react" {
    namespace JSX {
        // biome-ignore lint/style/useConsistentTypeDefinitions: augmenting JSX needs an interface.
        interface IntrinsicElements {
            "superflytv-ograf-form": React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<FormElement> };
        }
    }
}
