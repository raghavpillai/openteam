import { isAbsolute, relative, resolve } from "node:path";

export function assertSessionPath(sessionsDir: string, input: string): string {
  const candidate = resolve(input);
  const traversal = relative(sessionsDir, candidate);
  if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("Pi session path is outside the OpenTeam session directory");
  }
  if (!candidate.endsWith(".jsonl")) throw new Error("Pi session path must be a JSONL file");
  return candidate;
}
