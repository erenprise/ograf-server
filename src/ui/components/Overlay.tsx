import { CloseButton, Dialog, Portal } from "@chakra-ui/react";
import type { ReactNode } from "react";

export function Overlay({
    children,
    onClose,
    size = "sm",
}: {
    children: ReactNode;
    onClose: () => void;
    size?: "sm" | "md";
}) {
    return (
        <Dialog.Root open onOpenChange={(d) => !d.open && onClose()} closeOnInteractOutside closeOnEscape size={size}>
            <Portal>
                <Dialog.Backdrop bg="colorPalette.solid/50" backdropFilter="blur(2px)" />
                <Dialog.Positioner>
                    <Dialog.Content>
                        {children}
                        <Dialog.CloseTrigger position="absolute" top="3" right="3" asChild>
                            <CloseButton size="sm" />
                        </Dialog.CloseTrigger>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
}
