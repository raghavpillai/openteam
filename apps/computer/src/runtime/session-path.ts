import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export function assertSessionPath(sessionsDir: string, input: string): string {
  const candidate = resolve(input);
  const traversal = relative(sessionsDir, candidate);
  if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("Pi session path is outside the OpenTeam session directory");
  }
  if (!candidate.endsWith(".jsonl")) throw new Error("Pi session path must be a JSONL file");
  return candidate;
}

/** The context's one Pi session file on disk, which the server may not have recorded yet. */
export async function existingContextSessionPath(sessionsDir: string, contextSessionId: string): Promise<string | null> {
  if (!existsSync(sessionsDir)) return null;
  const suffix = `_${contextSessionId}.jsonl`;
  const candidates = (await readdir(sessionsDir)).filter((name) => name.endsWith(suffix));
  if (candidates.length > 1) throw new Error(`Multiple Pi sessions exist for context ${contextSessionId}`);
  return candidates[0] ? assertSessionPath(sessionsDir, join(sessionsDir, candidates[0])) : null;
}
