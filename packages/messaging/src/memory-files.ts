import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { atomicWrite, listFiles, readText } from "./file-state";

export const MEMORY_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
export const MAX_MEMORY_CONTENT = 500;

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
    const date = match?.[1] ? validDate(match[1]) : null;
    const content = match?.[2] ? normalizeMemoryContent(match[2]) : "";
    if (!date || !content) continue;
    facts.push({
      date: date.toISOString().slice(0, 10),
      createdAt: date,
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
    let entries;
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
    if (sourcePath !== "profile.md" && !/^log\/\d{4}-\d{2}\.md$/.test(sourcePath)) continue;
    const text = await readText(join(root, sourcePath), 2_000_000);
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
): Promise<{ added: boolean; sourcePath: string; logicalId: string }> => {
  const normalized = normalizeMemoryContent(
    tier === "note" && !content.startsWith("[note] ") ? `[note] ${content}` : content
  );
  if (!normalized) throw new Error("Memory content must not be empty");
  const logicalId = memoryLogicalId(normalized);
  const existing = await readMemoryTree(root);
  if (existing.some((fact) => fact.logicalId === logicalId)) {
    return { added: false, sourcePath: "", logicalId };
  }
  const sourcePath = tier === "profile" ? "profile.md" : `log/${at.toISOString().slice(0, 7)}.md`;
  const path = join(root, sourcePath);
  const current = (await readText(path, 2_000_000)) ?? "";
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await atomicWrite(path, `${current}${separator}${memoryLine(at, normalized)}\n`);
  return { added: true, sourcePath, logicalId };
};

export const forgetMemoryFact = async (
  root: string,
  content: string
): Promise<{ forgotten: boolean; logicalId: string }> => {
  const logicalId = memoryLogicalId(content);
  for (const sourcePath of await markdownFiles(root)) {
    if (sourcePath !== "profile.md" && !/^log\/\d{4}-\d{2}\.md$/.test(sourcePath)) continue;
    const path = join(root, sourcePath);
    const current = await readText(path, 2_000_000);
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

export const ensureDreamingLayout = async (memoryRoot: string): Promise<void> => {
  const dreaming = join(memoryRoot, ".dreaming");
  await Promise.all(
    ["evidence", "explicit", "synthesized", "tombstones"].map((folder) =>
      mkdir(join(dreaming, folder), { recursive: true, mode: 0o700 })
    )
  );
};

export const markMemoryOrigin = async (
  memoryRoot: string,
  logicalId: string,
  origin: "explicit" | "synthesized"
): Promise<void> => {
  await ensureDreamingLayout(memoryRoot);
  const opposite = origin === "explicit" ? "synthesized" : "explicit";
  await atomicWrite(join(memoryRoot, ".dreaming", origin, `${logicalId}.memory`), "", 0o600);
  await rm(join(memoryRoot, ".dreaming", opposite, `${logicalId}.memory`), {
    force: true,
  });
  if (origin === "explicit") {
    await rm(join(memoryRoot, ".dreaming", "tombstones", `${logicalId}.deleted`), { force: true });
  }
};

export const tombstoneMemory = async (memoryRoot: string, logicalId: string): Promise<void> => {
  await ensureDreamingLayout(memoryRoot);
  await atomicWrite(join(memoryRoot, ".dreaming", "tombstones", `${logicalId}.deleted`), "", 0o600);
  await Promise.all(
    ["explicit", "synthesized"].map((origin) =>
      rm(join(memoryRoot, ".dreaming", origin, `${logicalId}.memory`), {
        force: true,
      })
    )
  );
};

export const consumeEvidence = async (
  memoryRoot: string
): Promise<Array<{ id: string; occurredAt: number; user: string; assistant: string }>> => {
  const directory = join(memoryRoot, ".dreaming", "evidence");
  const entries: Array<{
    id: string;
    occurredAt: number;
    user: string;
    assistant: string;
  }> = [];
  for (const name of await listFiles(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    try {
      const text = await readText(path, 20_000);
      const value = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.occurredAt !== "number" ||
        typeof value.user !== "string" ||
        typeof value.assistant !== "string"
      ) {
        throw new Error("invalid evidence");
      }
      entries.push({
        id: value.id,
        occurredAt: value.occurredAt,
        user: value.user.slice(0, 8_000),
        assistant: value.assistant.slice(0, 8_000),
      });
    } catch {
      await rm(path, { force: true });
    }
  }
  return entries.sort((a, b) => a.occurredAt - b.occurredAt).slice(-12);
};
