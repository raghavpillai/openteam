import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ModelProviderConfig = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type ModelsDocument = {
  providers?: Record<string, ModelProviderConfig>;
  [key: string]: unknown;
};

export async function readModelsConfig(path: string): Promise<ModelsDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ("providers" in value &&
        (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)))
    ) {
      throw new Error("Invalid provider registry");
    }
    return value as ModelsDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      "The custom provider registry is invalid. Repair models.json before loading providers."
    );
  }
}

/** Lock the entire read/modify/write transaction, including across CLI processes. */
export async function updateModelsConfig(
  path: string,
  change: (document: ModelsDocument) => boolean | Promise<boolean>
): Promise<boolean> {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock.sqlite`;
  const lock = new Database(lockPath, { create: true });
  let held = false;
  try {
    await chmod(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout = 0");
    const deadline = Date.now() + 8_000;
    for (;;) {
      try {
        lock.exec("BEGIN IMMEDIATE");
        held = true;
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const document = await readModelsConfig(path);
    if (!(await change(document))) return false;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  } finally {
    try {
      if (held) lock.exec("ROLLBACK");
    } finally {
      lock.close();
    }
  }
}
