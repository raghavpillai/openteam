import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelsConfig, updateModelsConfig } from "../src/models-config";

test("model config transactions merge concurrent processes and keep private atomic files", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-config-processes-"));
  const path = join(root, "models.json");
  const module = new URL("../src/models-config.ts", import.meta.url).href;
  try {
    const children = Array.from({ length: 6 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `
      import {updateModelsConfig} from ${JSON.stringify(module)};
      await updateModelsConfig(${JSON.stringify(path)}, async document => {
        await new Promise(resolve => setTimeout(resolve, 15));
        document.providers ??= {};
        document.providers['provider-${index}'] = {api:'openai-completions'};
        return true;
      });
    `,
        ],
        { stdout: "pipe", stderr: "pipe" }
      )
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        error: await new Response(child.stderr).text(),
      }))
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ code: 0, error: "" })));
    expect(Object.keys((await readModelsConfig(path)).providers ?? {}).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `provider-${i}`)
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.lock.sqlite`)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("a killed writer releases its model-config lock without losing the last committed document", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-config-crash-"));
  const path = join(root, "models.json");
  await writeFile(path, JSON.stringify({ providers: { original: {} } }));
  const module = new URL("../src/models-config.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import {updateModelsConfig} from ${JSON.stringify(module)};
    await updateModelsConfig(${JSON.stringify(path)}, async document => {
      document.providers.lost = {};
      console.log('LOCKED');
      await new Promise(() => {});
      return true;
    });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("LOCKED");
    let acquired = false;
    const next = updateModelsConfig(path, (document) => {
      acquired = true;
      document.providers!.next = {};
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    await next;
    expect(Object.keys((await readModelsConfig(path)).providers ?? {}).sort()).toEqual([
      "next",
      "original",
    ]);
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("rejected and unchanged transactions preserve the file and release the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-config-errors-"));
  const path = join(root, "models.json");
  const original = '{"providers":{},"keep":"original"}\n';
  await writeFile(path, original);
  try {
    await expect(
      updateModelsConfig(path, (document) => {
        document.keep = "bad";
        throw new Error("rejected edit");
      })
    ).rejects.toThrow("rejected edit");
    expect(await readFile(path, "utf8")).toBe(original);
    const inode = (await stat(path)).ino;
    expect(await updateModelsConfig(path, () => false)).toBe(false);
    expect((await stat(path)).ino).toBe(inode);
    await writeFile(path, "{invalid");
    await expect(updateModelsConfig(path, () => true)).rejects.toThrow("Repair models.json");
    expect(await readFile(path, "utf8")).toBe("{invalid");
    await writeFile(path, original);
    await updateModelsConfig(path, (document) => {
      document.keep = "updated";
      return true;
    });
    expect((await readModelsConfig(path)).keep).toBe("updated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
