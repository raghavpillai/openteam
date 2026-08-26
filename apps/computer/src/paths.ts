import { resolve, sep } from "node:path";

export class PathContainmentError extends Error {
  constructor(readonly path: string) {
    super("Path escapes the shared workspace root");
    this.name = "PathContainmentError";
  }
}

export const resolveWorkspacePath = (input: string, workspaceRoot: string): string => {
  const root = resolve(workspaceRoot);
  const candidate = resolve(input);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new PathContainmentError(candidate);
  }
  return candidate;
};
