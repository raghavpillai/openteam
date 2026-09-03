import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSendJournalStore } from "../src/main/durable-send-journal-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-delivery-journal-"));
  temporaryDirectories.push(directory);
  return { directory, store: new DurableSendJournalStore(directory) };
};

const storedFiles = async (directory: string) =>
  Promise.all(
    (await readdir(directory)).map(async (name) => ({
      name,
      value: JSON.parse(await readFile(join(directory, name), "utf8")) as {
        generation: number;
        scope: string;
        journal: unknown;
      },
    }))
  );

describe("desktop durable-send journal store", () => {
  test("serializes writes and returns the latest complete generation", async () => {
    const { directory, store } = await fixture();
    await Promise.all([
      store.write("desktop:server:account", { revision: 1 }),
      store.write("desktop:server:account", { revision: 2 }),
      store.write("desktop:server:account", { revision: 3 }),
    ]);

    expect(await store.read("desktop:server:account")).toEqual({ revision: 3 });
    const files = await storedFiles(directory);
    expect(files).toHaveLength(2);
    expect(files.every(({ name }) => /^[a-f0-9]{32}\.[ab]\.json$/.test(name))).toBe(true);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const { name } of files) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
  });

  test("falls back to the previous slot when the newest generation is corrupt", async () => {
    const { directory, store } = await fixture();
    const scope = "desktop:server:account";
    await store.write(scope, { revision: 1 });
    await store.write(scope, { revision: 2 });
    const newest = (await storedFiles(directory)).sort(
      (left, right) => right.value.generation - left.value.generation
    )[0];
    if (!newest) throw new Error("missing journal generation");
    await writeFile(join(directory, newest.name), "{corrupt", "utf8");

    expect(await new DurableSendJournalStore(directory).read(scope)).toEqual({ revision: 1 });
  });

  test("recovers a fully written temporary generation after an interrupted rename", async () => {
    const { directory, store } = await fixture();
    const scope = "desktop:server:account";
    await store.write(scope, { revision: 1 });
    const [current] = await storedFiles(directory);
    if (!current) throw new Error("missing journal generation");
    const recovered = {
      generation: current.value.generation + 1,
      scope,
      journal: { revision: 2 },
    };
    await writeFile(join(directory, `${current.name}.next`), JSON.stringify(recovered), {
      mode: 0o600,
    });

    expect(await new DurableSendJournalStore(directory).read(scope)).toEqual({ revision: 2 });
  });

  test("hashes account scopes and never crosses journals", async () => {
    const { directory, store } = await fixture();
    await store.write("../../account-a", { account: "a" });
    await store.write("account-b", { account: "b" });

    expect(await store.read("../../account-a")).toEqual({ account: "a" });
    expect(await store.read("account-b")).toEqual({ account: "b" });
    expect(await store.read("account-c")).toBeNull();
    expect((await readdir(directory)).every((name) => !name.includes("account"))).toBe(true);
  });
});
