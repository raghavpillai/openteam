import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The computer image ships Node for subprocess integrations that require its streams. */
export const nodeBinary = (): string => {
  const candidates = [
    process.env.OPENTEAM_NODE_BINARY,
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, "node")),
  ];
  const resolved = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!resolved) throw new Error("The computer runtime requires a Node.js executable");
  return resolved;
};
