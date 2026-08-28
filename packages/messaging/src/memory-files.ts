import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { atomicWrite, listFiles, readText } from "./file-state";

export const MEMORY_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
export const MAX_MEMORY_CONTENT = 500;
export const MAX_MEMORY_EVIDENCE_SIDE_CHARS = 8_000;
export const MAX_SYNTHESIS_MEMORIES = 512;
export const MAX_SYNTHESIS_CHANGES = 64;
export const MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MEMORY_EVIDENCE_FILE = /^([0-9a-f-]{36})\.json$/;
const MEMORY_EVIDENCE_OMISSION = "\n[...middle omitted...]\n";
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

export type MemoryOrigin = "explicit" | "synthesized" | "legacy";

export interface MemorySynthesisSnapshotFact {
  id: string;
  content: string;
  createdAt: number;
  kind: "profile" | "log";
  origin: MemoryOrigin;
}

export interface MemorySynthesisSnapshot {
  fingerprint: string;
  memories: MemorySynthesisSnapshotFact[];
}

export type MemorySynthesisChange =
  | {
      action: "create";
      content: string;
      kind: "profile" | "log";
      sourceEvidenceIds: string[];
    }
  | {
      action: "update";
      id: string;
      content: string;
      kind: "profile" | "log";
      sourceEvidenceIds: string[];
    }
  | { action: "remove"; id: string; sourceEvidenceIds: string[] };

export const normalizeMemoryContent = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CONTENT);

export const boundMemoryEvidenceText = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length <= MAX_MEMORY_EVIDENCE_SIDE_CHARS) return normalized;
  const available = MAX_MEMORY_EVIDENCE_SIDE_CHARS - MEMORY_EVIDENCE_OMISSION.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${normalized.slice(0, head)}${MEMORY_EVIDENCE_OMISSION}${normalized.slice(-tail)}`;
};

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
  const prefix =
    current.length === 0
      ? tier === "profile"
        ? MEMORY_PROFILE_HEADER
        : MEMORY_LOG_HEADER
      : current;
  const separator = prefix.endsWith("\n") ? "" : "\n";
  await atomicWrite(path, `${prefix}${separator}${memoryLine(at, normalized)}\n`);
  return { added: true, sourcePath, logicalId };
};

export const forgetMemoryFact = async (
  root: string,
  content: string
): Promise<{ forgotten: boolean; logicalId: string }> => {
  const logicalId = memoryLogicalId(content);
  for (const sourcePath of await markdownFiles(root)) {
    if (sourcePath !== "profile.md" && !/^log\/[^/]+\.md$/.test(sourcePath)) continue;
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

export const clearMemoryOrigin = async (memoryRoot: string, logicalId: string): Promise<void> => {
  await Promise.all(
    ["explicit", "synthesized"].map((origin) =>
      rm(join(memoryRoot, ".dreaming", origin, `${logicalId}.memory`), { force: true })
    )
  );
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

export const memoryOrigin = async (
  memoryRoot: string,
  logicalId: string
): Promise<MemoryOrigin> => {
  if (await isRegularFile(join(memoryRoot, ".dreaming", "explicit", `${logicalId}.memory`))) {
    return "explicit";
  }
  if (await isRegularFile(join(memoryRoot, ".dreaming", "synthesized", `${logicalId}.memory`))) {
    return "synthesized";
  }
  return "legacy";
};

export const isMemoryTombstoned = async (memoryRoot: string, content: string): Promise<boolean> =>
  isRegularFile(join(memoryRoot, ".dreaming", "tombstones", `${memoryLogicalId(content)}.deleted`));

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
    const filename = name.match(MEMORY_EVIDENCE_FILE);
    if (!filename?.[1]) continue;
    const path = join(directory, name);
    try {
      const text = await readText(path, 20_000);
      const value = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      if (
        !value ||
        value.id !== filename[1] ||
        typeof value.occurredAt !== "number" ||
        !Number.isFinite(value.occurredAt) ||
        value.occurredAt < 0 ||
        typeof value.user !== "string" ||
        typeof value.assistant !== "string"
      ) {
        throw new Error("invalid evidence");
      }
      entries.push({
        id: value.id,
        occurredAt: value.occurredAt,
        user: boundMemoryEvidenceText(value.user),
        assistant: boundMemoryEvidenceText(value.assistant),
      });
    } catch {
      await rm(path, { force: true });
    }
  }
  return entries.sort((a, b) => a.occurredAt - b.occurredAt).slice(-12);
};

export const clearSpooledEvidence = async (
  memoryRoot: string,
  evidenceIds: readonly string[]
): Promise<void> => {
  await Promise.all(
    evidenceIds
      .filter((id) => /^[0-9a-f-]{36}$/.test(id))
      .map((id) => rm(join(memoryRoot, ".dreaming", "evidence", `${id}.json`), { force: true }))
  );
};

const synthesisFiles = async (
  memoryRoot: string
): Promise<Array<{ sourcePath: string; raw: string }>> => {
  const files = [
    {
      sourcePath: "profile.md",
      raw: (await readText(join(memoryRoot, "profile.md"), 2_000_000)) ?? "",
    },
  ];
  for (const name of await listFiles(join(memoryRoot, "log"))) {
    if (!name.endsWith(".md")) continue;
    const sourcePath = `log/${name}`;
    files.push({
      sourcePath,
      raw: (await readText(join(memoryRoot, sourcePath), 2_000_000)) ?? "",
    });
  }
  return files;
};

export const memorySynthesisFingerprint = async (memoryRoot: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const file of await synthesisFiles(memoryRoot)) {
    hash.update(file.sourcePath).update("\0").update(file.raw).update("\0");
  }
  return hash.digest("hex");
};

export const prepareMemorySynthesis = async (
  memoryRoot: string
): Promise<MemorySynthesisSnapshot> => {
  const facts = await readMemoryTree(memoryRoot);
  const withOrigins = await Promise.all(
    facts.map(async (fact) => ({
      fact,
      origin: await memoryOrigin(memoryRoot, fact.logicalId),
    }))
  );
  withOrigins.sort((left, right) => {
    if (left.origin === "explicit" && right.origin !== "explicit") return -1;
    if (right.origin === "explicit" && left.origin !== "explicit") return 1;
    const leftProfile = left.fact.sourcePath === "profile.md";
    const rightProfile = right.fact.sourcePath === "profile.md";
    if (leftProfile !== rightProfile) return leftProfile ? -1 : 1;
    const date = right.fact.createdAt.getTime() - left.fact.createdAt.getTime();
    return date || right.fact.sourceOrdinal - left.fact.sourceOrdinal;
  });
  const seen = new Set<string>();
  const memories: MemorySynthesisSnapshotFact[] = [];
  for (const { fact, origin } of withOrigins) {
    if (seen.has(fact.logicalId)) continue;
    seen.add(fact.logicalId);
    memories.push({
      id: fact.logicalId,
      content: fact.content,
      createdAt: fact.createdAt.getTime(),
      kind: fact.sourcePath === "profile.md" ? "profile" : "log",
      origin,
    });
    if (memories.length >= MAX_SYNTHESIS_MEMORIES) break;
  }
  return { fingerprint: await memorySynthesisFingerprint(memoryRoot), memories };
};

const removeFirstMemoryById = async (memoryRoot: string, logicalId: string): Promise<boolean> => {
  for (const { sourcePath, raw } of await synthesisFiles(memoryRoot)) {
    const lines = raw.split(/\r?\n/);
    const index = lines.findIndex((line) => {
      const match = line.match(MEMORY_LINE);
      return Boolean(match?.[2] && memoryLogicalId(match[2]) === logicalId);
    });
    if (index < 0) continue;
    lines.splice(index, 1);
    await atomicWrite(join(memoryRoot, sourcePath), lines.join("\n"));
    return true;
  }
  return false;
};

export const markTemporalMemoryReview = async (
  memoryRoot: string,
  now = Date.now()
): Promise<void> => {
  await ensureDreamingLayout(memoryRoot);
  await atomicWrite(
    join(memoryRoot, ".dreaming", "next-refresh-at"),
    `${now + MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS}\n`,
    0o600
  );
};

export const isTemporalMemoryReviewDue = async (
  memoryRoot: string,
  now = Date.now()
): Promise<boolean> => {
  const raw = await readText(join(memoryRoot, ".dreaming", "next-refresh-at"), 100);
  const timestamp = Number.parseInt(raw?.trim() ?? "", 10);
  return !Number.isFinite(timestamp) || timestamp <= now;
};

export const applyMemorySynthesis = async (
  memoryRoot: string,
  snapshot: MemorySynthesisSnapshot,
  changes: readonly MemorySynthesisChange[],
  now = new Date()
): Promise<"committed" | "stale" | "invalid"> => {
  if ((await memorySynthesisFingerprint(memoryRoot)) !== snapshot.fingerprint) return "stale";
  if (changes.length > MAX_SYNTHESIS_CHANGES) return "invalid";

  const snapshotById = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
  const current = await readMemoryTree(memoryRoot);
  const currentById = new Map<string, MemoryFileFact>();
  for (const fact of current)
    if (!currentById.has(fact.logicalId)) currentById.set(fact.logicalId, fact);
  const occupied = new Set(current.map((fact) => fact.logicalId));
  const touched = new Set<string>();
  const removals: Array<{
    id: string;
    replacement?: { content: string; kind: "profile" | "log" };
  }> = [];
  const creations: Array<{ content: string; kind: "profile" | "log" }> = [];

  for (const change of changes) {
    if (change.action === "create") {
      const content = normalizeMemoryContent(change.content);
      if (!content) return "invalid";
      const id = memoryLogicalId(content);
      if (await isMemoryTombstoned(memoryRoot, content)) continue;
      if (occupied.has(id)) continue;
      occupied.add(id);
      creations.push({ content, kind: change.kind });
      continue;
    }

    if (touched.has(change.id)) return "invalid";
    touched.add(change.id);
    const before = snapshotById.get(change.id);
    const existing = currentById.get(change.id);
    if (!before || !existing || before.origin === "explicit") return "invalid";
    if (change.action === "remove") {
      occupied.delete(change.id);
      removals.push({ id: change.id });
      continue;
    }
    const content = normalizeMemoryContent(change.content);
    if (!content) return "invalid";
    if (await isMemoryTombstoned(memoryRoot, content)) continue;
    occupied.delete(change.id);
    const replacementId = memoryLogicalId(content);
    if (occupied.has(replacementId)) return "invalid";
    occupied.add(replacementId);
    removals.push({ id: change.id, replacement: { content, kind: change.kind } });
  }

  for (const removal of removals) {
    await removeFirstMemoryById(memoryRoot, removal.id);
    await clearMemoryOrigin(memoryRoot, removal.id);
  }
  for (const addition of [
    ...creations,
    ...removals.flatMap((entry) => (entry.replacement ? [entry.replacement] : [])),
  ]) {
    const written = await appendMemoryFact(memoryRoot, addition.content, addition.kind, now);
    await clearMemoryOrigin(memoryRoot, written.logicalId);
    await markMemoryOrigin(memoryRoot, written.logicalId, "synthesized");
  }
  await markTemporalMemoryReview(memoryRoot, now.getTime());
  return "committed";
};
