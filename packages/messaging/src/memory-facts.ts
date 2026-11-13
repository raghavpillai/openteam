import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const MAX_MEMORY_CONTENT = 500;

/** How a fact was saved, stored in MemoryFact.origin with the run that saved it. */
export type MemoryProvenance = { source: "tool" | "extract" | "template"; turnId?: string };

export const normalizeMemoryContent = (value: string): string => {
  // Match the database's UTF-8 transport even for malformed UTF-16 input. One
  // extra unit lets us inspect a surrogate pair crossing the length boundary.
  const prefix = Buffer.from(value.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CONTENT + 1)).toString("utf8");
  const length = Math.min(prefix.length, MAX_MEMORY_CONTENT);
  const last = prefix.charCodeAt(length - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? length - 1 : length;
  return prefix.slice(0, end).trimEnd();
};

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
