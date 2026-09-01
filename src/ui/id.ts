import { useState } from "react";

const slugifyId = (value: string) =>
    value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

export function useAutoSlug() {
    const [name, setName] = useState("");
    const [id, setId] = useState("");
    const [manualId, setManualId] = useState(false);

    return {
        name: name,
        id: id,
        setName: (value: string) => {
            setName(value);
            if (!manualId) {
                setId(slugifyId(value));
            }
        },
        setId: (value: string) => {
            setId(value);
            setManualId(Boolean(value));
        },
        reset: () => {
            setName("");
            setId("");
            setManualId(false);
        },
    };
}
