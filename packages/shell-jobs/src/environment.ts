import { openSync, closeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Dedicated fd 3 carries environment state, never tool output or transcript data. */
export const SHELL_ENVIRONMENT_CAPTURE = `trap '__openteam_status=$?; for __openteam_name in $(compgen -e); do printf "%s=%s\\0" "$__openteam_name" "${"${!__openteam_name}"}"; done >&3; exit "$__openteam_status"' EXIT`;

export async function loadShellEnvironment(
  directory: string,
  scope: string,
  base: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv
) {
  const path = join(
    directory,
    `environment-${createHash("sha256").update(scope).digest("hex")}.json`
  );
  let environment = base;
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      !Object.values(saved).every((value) => typeof value === "string")
    )
      throw new Error("Malformed shell environment");
    environment = { ...(saved as NodeJS.ProcessEnv), ...overrides };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("The persisted shell environment could not be read");
  }
  return { path, environment };
}

export async function persistShellEnvironment(path: string, chunks: readonly Buffer[]) {
  if (!chunks.length) return;
  const environment = Object.fromEntries(
    Buffer.concat(chunks)
      .toString("utf8")
      .split("\0")
      .flatMap((entry) => {
        const equals = entry.indexOf("=");
        return equals > 0 ? [[entry.slice(0, equals), entry.slice(equals + 1)]] : [];
      })
  );
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(environment), { mode: 0o600 });
  await rename(temporary, path);
}

/** A private inherited file descriptor avoids extra-pipe drain races in Bun. */
export function createShellEnvironmentCapture(directory: string) {
  const path = join(directory, `environment-capture-${randomUUID()}.tmp`);
  const fd = openSync(path, "wx", 0o600);
  let closed = false;
  return {
    fd,
    closeParent() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
    async persist(destination: string) {
      try {
        if ((await stat(path)).size > 4 * 1024 * 1024)
          throw new Error("Exported shell environment exceeds 4 MiB");
        const bytes = await readFile(path);
        if (bytes.length) await persistShellEnvironment(destination, [bytes]);
      } finally {
        await rm(path, { force: true });
      }
    },
  };
}
