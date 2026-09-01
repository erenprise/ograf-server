import { Button, type ButtonProps, Clipboard } from "@chakra-ui/react";

export function CopyButton({ value, label, ...props }: { value: string; label?: string } & ButtonProps) {
    return (
        <Clipboard.Root value={value} timeout={1500} display="inline-flex">
            <Clipboard.Trigger asChild>
                <Button aria-label="Copy to clipboard" title="Copy" size="xs" variant="ghost" flexShrink="0" {...props}>
                    <Clipboard.Indicator copied={label ? "✓ Copied" : "✓"}>
                        {label ? `⧉ ${label}` : "⧉"}
                    </Clipboard.Indicator>
                </Button>
            </Clipboard.Trigger>
        </Clipboard.Root>
    );
}
