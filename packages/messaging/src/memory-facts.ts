import { createHash } from "node:crypto";

const MAX_MEMORY_CONTENT = 500;

/** How a fact was saved, stored in MemoryFact.origin with the run that saved it. */
export type MemoryProvenance = { source: "tool" | "extract" | "template"; turnId?: string };

export const normalizeMemoryContent = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CONTENT);

export const memoryLogicalId = (content: string): string =>
  createHash("sha1")
    .update(normalizeMemoryContent(content).toLowerCase())
    .digest("hex")
    .slice(0, 16);

/** A learned note keeps its [note] prefix; episode facts rank above other journal facts and notes below them. */
export const memoryTier = (content: string, tier: "profile" | "log"): "profile" | "log" | "note" =>
  content.startsWith("[note] ") ? "note" : tier;

export const memoryImportance = (content: string): number =>
  content.startsWith("[episode] ") ? 1.5 : content.startsWith("[note] ") ? 0.5 : 1;
