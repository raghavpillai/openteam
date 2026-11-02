import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "/sys/fs/cgroup/desktops";
export const DEFAULT_DESKTOP_MEMORY_LIMIT = "10g";

export function parseMemoryLimit(value: string): number {
  const match = /^(\d+)([kmgt]?)b?$/i.exec(value);
  const units = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  const bytes = match ? Number(match[1]) * units[match[2]!.toLowerCase() as keyof typeof units] : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 ** 2) {
    throw new Error("OPENTEAM_DESKTOP_MEMORY_LIMIT must be an integer size of at least 16 MiB (for example 10g)");
  }
  return bytes;
}

function desktopGroup(botId: string): string {
  // Bot IDs are data, never filesystem paths. No agent can choose a parent group.
  return join(ROOT, createHash("sha256").update(botId).digest("hex"));
}

export function desktopMemoryEnabled(): boolean {
  return Boolean(process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT);
}

export function desktopMemoryForSpawn(botId: string): string | undefined {
  if (!desktopMemoryEnabled()) return undefined;
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("Per-desktop memory limits require the Linux computer supervisor");
  }
  if (!botId) throw new Error("A desktop ID is required for its memory limit");
  const bytes = parseMemoryLimit(process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT!);
  const group = desktopGroup(botId);
  // Never create a fake hierarchy on a normal filesystem or silently fall back.
  if (!readFileSync(join(ROOT, "cgroup.subtree_control"), "utf8").split(/\s+/).includes("memory")) {
    throw new Error("Desktop memory controller is not initialized");
  }
  try { mkdirSync(group, { mode: 0o755 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return configure(group, bytes);
}

function configure(group: string, bytes: number): string {
  writeFileSync(join(group, "memory.max"), String(bytes));
  writeFileSync(join(group, "memory.swap.max"), "0");
  // Kill selection stays local to the over-budget desktop; do not kill its
  // entire GUI as a group when a single runaway process can be reclaimed.
  writeFileSync(join(group, "memory.oom.group"), "0");
  return group;
}

export async function removeDesktopMemory(botId: string): Promise<void> {
  if (!desktopMemoryEnabled()) return;
  const group = desktopGroup(botId);
  try { await writeFile(join(group, "cgroup.kill"), "1"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  // Includes orphaned and double-forked descendants; PID reuse cannot target a
  // different desktop. Only called on explicit destroy or failed-session restart.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await rmdir(group); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code !== "EBUSY") throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error("Desktop memory group is still populated after shutdown");
}
