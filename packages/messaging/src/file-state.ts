import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const jsonFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const safeFolderId = (value: string, label = "folder id"): string => {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`${label} is not a safe folder id`);
  }
  return value;
};

export const slugify = (name: string, fallback: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `${fallback}-${Date.now()}`;
};

export const uniqueSlug = (name: string, fallback: string, occupied: Set<string>): string => {
  const base = slugify(name, fallback);
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 48 - String(suffix).length - 1))}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${base.slice(0, 32)}-${Date.now()}`;
};

export const parseJsonObject = (text: string, label: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
};

export const readText = async (path: string, maximumBytes = 1_000_000): Promise<string | null> => {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    if (before.size > maximumBytes) throw new Error(`${path} is larger than ${maximumBytes} bytes`);
    const text = await readFile(path, "utf8");
    const after = await lstat(path);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`${path} changed while it was being read`);
    }
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const readBytes = async (
  path: string,
  maximumBytes = 1_000_000
): Promise<Uint8Array | null> => {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    if (before.size > maximumBytes) throw new Error(`${path} is larger than ${maximumBytes} bytes`);
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`${path} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const fileTimes = async (
  path: string
): Promise<{ birthtimeMs: number; mtimeMs: number }> => {
  const info = await stat(path);
  return { birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs };
};

export const atomicWrite = async (
  path: string,
  content: string | Uint8Array,
  mode = 0o644
): Promise<void> => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const temporary = join(parent, `.${basename(path)}.${randomBytes(8).toString("hex")}.part`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    try {
      const directory = await open(parent, "r");
      await directory.sync();
      await directory.close();
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export const listDirectories = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const listFiles = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};
