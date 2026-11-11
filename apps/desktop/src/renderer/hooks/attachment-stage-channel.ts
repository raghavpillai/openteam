import { createContext } from "react";

/** Selected channel identity, including when previous conversations remain warm. */
export const AttachmentStageChannel = createContext<string | null>(null);
