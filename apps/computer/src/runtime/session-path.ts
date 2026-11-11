import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function assertSessionPath(sessionsDir: string, input: string): string {
  const candidate = resolve(input);
  const traversal = relative(sessionsDir, candidate);
  if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("Pi session path is outside the OpenTeam session directory");
  }
  if (!candidate.endsWith(".jsonl")) throw new Error("Pi session path must be a JSONL file");
  return candidate;
}

/**
 * The file to unlink when a context session is discarded. A session recorded under a session root
 * the agent directory no longer uses (the root was renamed, or the agent dir moved) is stale
 * bookkeeping, not a reason to keep the chat undeletable, so discarding accepts the whole
 * `sessions` parent. Opening a turn stays strict: it never reopens a path from another root.
 */
export function disposableSessionPath(sessionsDir: string, input: string): string | null {
  const candidate = resolve(input);
  if (!candidate.endsWith(".jsonl")) return null;
  const parent = dirname(resolve(sessionsDir));
  const traversal = relative(parent, candidate);
  if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) return null;
  return candidate;
}

/** Resolve parent directories so an old session-root symlink cannot redirect deletion outside sessions. */
export async function resolvedDisposableSessionPath(sessionsDir: string, input: string): Promise<string | null> {
  const candidate = disposableSessionPath(sessionsDir, input);
  if (!candidate) return null;
  try {
    const [root, parent] = await Promise.all([
      realpath(dirname(resolve(sessionsDir))),
      realpath(dirname(candidate)),
    ]);
    const traversal = relative(root, parent);
    if (traversal.startsWith("..") || isAbsolute(traversal)) return null;
    // Use the resolved parent rather than traversing the original symlink again.
    // The final component may itself be a symlink: rm unlinks it without following its target.
    return join(parent, basename(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The context's one Pi session file on disk, which the server may not have recorded yet. */
export async function existingContextSessionPath(sessionsDir: string, contextSessionId: string): Promise<string | null> {
  if (!existsSync(sessionsDir)) return null;
  const suffix = `_${contextSessionId}.jsonl`;
  const candidates = (await readdir(sessionsDir)).filter((name) => name.endsWith(suffix));
  if (candidates.length > 1) throw new Error(`Multiple Pi sessions exist for context ${contextSessionId}`);
  return candidates[0] ? assertSessionPath(sessionsDir, join(sessionsDir, candidates[0])) : null;
}
