import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { atomicWrite, readText } from "./file-state";

export const MEMORY_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
export const MAX_MEMORY_CONTENT = 500;
const MEMORY_PROFILE_HEADER = [
  "# About the user",
  "",
  '<!-- Safe to read, grep, and edit. One fact per line, as "- (YYYY-MM-DD) <fact>". -->',
  "",
].join("\n");
const MEMORY_LOG_HEADER = [
  "# Memory log",
  "",
  '<!-- Safe to read, grep, and edit. One fact per line, as "- (YYYY-MM-DD) <fact>". -->',
  "",
].join("\n");

export interface ParsedMemoryFact {
  date: string;
  createdAt: Date;
  content: string;
  logicalId: string;
  sourceLine: number;
  sourceOrdinal: number;
  tier: "profile" | "log" | "note";
  importance: number;
}

export interface MemoryFileFact extends ParsedMemoryFact {
  sourcePath: string;
}

export const normalizeMemoryContent = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CONTENT);

export const memoryLogicalId = (content: string): string =>
  createHash("sha1")
    .update(normalizeMemoryContent(content).toLowerCase())
    .digest("hex")
    .slice(0, 16);

const validDate = (value: string): Date | null => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};

export const memoryTier = (content: string, profileFile: boolean): ParsedMemoryFact["tier"] =>
  content.startsWith("[note] ") ? "note" : profileFile ? "profile" : "log";

export const memoryImportance = (content: string): number =>
  content.startsWith("[episode] ") ? 1.5 : content.startsWith("[note] ") ? 0.5 : 1;

/** Invalid Markdown is intentionally ignored and preserved on disk. */
export const parseMemoryMarkdown = (text: string, profileFile = false): ParsedMemoryFact[] => {
  const facts: ParsedMemoryFact[] = [];
  let ordinal = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const match = raw.match(MEMORY_LINE);
    const content = match?.[2] ? normalizeMemoryContent(match[2]) : "";
    if (!match?.[1] || !content) continue;
    const createdAt = validDate(match[1]);
    if (!createdAt) continue;
    facts.push({
      date: match[1],
      createdAt,
      content,
      logicalId: memoryLogicalId(content),
      sourceLine: index + 1,
      sourceOrdinal: ordinal,
      tier: memoryTier(content, profileFile),
      importance: memoryImportance(content),
    });
    ordinal += 1;
  }
  return facts;
};

export const memoryLine = (date: Date | string, content: string): string => {
  const day = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  if (!validDate(day)) throw new Error(`Invalid UTC memory date: ${day}`);
  const normalized = normalizeMemoryContent(content);
  if (!normalized) throw new Error("Memory content must not be empty");
  return `- (${day}) ${normalized}`;
};

const markdownFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  await visit(root);
  return result.sort((left, right) => {
    if (left === "profile.md") return -1;
    if (right === "profile.md") return 1;
    return left.localeCompare(right);
  });
};

export const readMemoryTree = async (root: string): Promise<MemoryFileFact[]> => {
  const facts: MemoryFileFact[] = [];
  for (const sourcePath of await markdownFiles(root)) {
    if (sourcePath !== "profile.md" && !/^log\/[^/]+\.md$/.test(sourcePath)) continue;
    const text = await readText(join(root, sourcePath), Number.MAX_SAFE_INTEGER);
    if (text === null) continue;
    for (const fact of parseMemoryMarkdown(text, sourcePath === "profile.md")) {
      facts.push({ ...fact, sourcePath });
    }
  }
  return facts;
};

export const appendMemoryFact = async (
  root: string,
  content: string,
  tier: "profile" | "log" | "note",
  at = new Date()
): Promise<{ added: boolean; sourcePath: string; logicalId: string; content: string }> => {
  const normalized = normalizeMemoryContent(
    tier === "note" && !content.startsWith("[note] ") ? `[note] ${content}` : content
  );
  if (!normalized) throw new Error("Memory content must not be empty");
  const logicalId = memoryLogicalId(normalized);
  const existing = await readMemoryTree(root);
  if (existing.some((fact) => fact.logicalId === logicalId)) {
    return { added: false, sourcePath: "", logicalId, content: normalized };
  }
  const sourcePath = tier === "profile" ? "profile.md" : `log/${at.toISOString().slice(0, 7)}.md`;
  const path = join(root, sourcePath);
  const current = (await readText(path, Number.MAX_SAFE_INTEGER)) ?? "";
  const prefix =
    current.length === 0
      ? tier === "profile"
        ? MEMORY_PROFILE_HEADER
        : MEMORY_LOG_HEADER
      : current;
  const separator = prefix.endsWith("\n") ? "" : "\n";
  await atomicWrite(path, `${prefix}${separator}${memoryLine(at, normalized)}\n`);
  return { added: true, sourcePath, logicalId, content: normalized };
};

export const forgetMemoryFact = async (
  root: string,
  content: string
): Promise<{ forgotten: boolean; logicalId: string }> => {
  const logicalId = memoryLogicalId(content);
  for (const sourcePath of await markdownFiles(root)) {
    if (sourcePath !== "profile.md" && !/^log\/[^/]+\.md$/.test(sourcePath)) continue;
    const path = join(root, sourcePath);
    const current = await readText(path, Number.MAX_SAFE_INTEGER);
    if (current === null) continue;
    const lines = current.split(/\r?\n/);
    const target = lines.findIndex((line) => {
      const match = line.match(MEMORY_LINE);
      return Boolean(match?.[2] && memoryLogicalId(match[2]) === logicalId);
    });
    if (target < 0) continue;
    lines.splice(target, 1);
    await atomicWrite(path, lines.join("\n"));
    return { forgotten: true, logicalId };
  }
  return { forgotten: false, logicalId };
};

/** Remove every indexed fact selected by the owner, preserving unrelated Markdown. */
export const removeMemoryFacts = async (
  root: string,
  logicalId?: string
): Promise<MemoryFileFact[]> => {
  const facts = (await readMemoryTree(root)).filter((fact) => !logicalId || fact.logicalId === logicalId);
  const paths = new Set(facts.map((fact) => fact.sourcePath));
  for (const sourcePath of paths) {
    const path = join(root, sourcePath);
    const text = await readText(path, Number.MAX_SAFE_INTEGER);
    if (text === null) continue;
    const selected = new Set(parseMemoryMarkdown(text, sourcePath === "profile.md")
      .filter((fact) => !logicalId || fact.logicalId === logicalId)
      .map((fact) => fact.sourceLine));
    await atomicWrite(path, text.split(/\r?\n/).filter((_, index) => !selected.has(index + 1)).join("\n"));
  }
  return facts;
};
