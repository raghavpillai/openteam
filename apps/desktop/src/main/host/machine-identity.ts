import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadMachineIdentity(path: string): Promise<string> {
  try {
    const id = (await readFile(path, "utf8")).trim();
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error("Desktop machine identity is invalid; restore its identity file before enrolling");
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = `${path}.${id}.tmp`;
  await writeFile(temporary, `${id}\n`, { flag: "wx", mode: 0o600 });
  // Publish a complete file atomically, without replacing another startup's ID.
  try { await link(temporary, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadMachineIdentity(path);
    throw error;
  } finally { await unlink(temporary); }
  return id;
}
