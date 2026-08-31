import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionSettingsStore,
  normalizePermissionSettings,
} from "../src/main/permission-settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("permission settings", () => {
  test("normalizes, deduplicates, bounds, and defaults untrusted settings", () => {
    const normalized = normalizePermissionSettings({
      localToolPermission: "invalid",
      autoReview: {
        isEnabled: false,
        allowInstructions: ["  Read reports  ", "read reports", "", 42],
        blockInstructions: Array.from({ length: 25 }, (_, index) => `Block ${index}`),
      },
    });
    expect(normalized.localToolPermission).toBe("ask");
    expect(normalized.autoReview.isEnabled).toBe(false);
    expect(normalized.autoReview.allowInstructions).toEqual(["Read reports"]);
    expect(normalized.autoReview.blockInstructions).toHaveLength(20);
  });

  test("persists settings atomically and serializes concurrent mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-permissions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "settings.json");
    const store = createPermissionSettingsStore(path);
    await Promise.all([
      store.update({ localToolPermission: "always" }),
      store.addRule("allow", "Read files in the reports folder"),
      store.addRule("block", "Ask before deleting anything"),
    ]);
    expect(await store.read()).toMatchObject({
      localToolPermission: "always",
      autoReview: {
        allowInstructions: ["Read files in the reports folder"],
        blockInstructions: ["Ask before deleting anything"],
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  test("persists and bounds the user-visible Computer label", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-permissions-"));
    temporaryDirectories.push(directory);
    const store = createPermissionSettingsStore(join(directory, "settings.json"));
    const updated = await store.update({ machineLabel: `  ${"x".repeat(100)}  ` });
    expect(updated.machineLabel).toBe("x".repeat(80));
  });

  test("recovers safely from malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-permissions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "settings.json");
    await writeFile(path, "not json");
    expect(await createPermissionSettingsStore(path).read()).toMatchObject({
      localToolPermission: "ask",
      autoReview: { isEnabled: true },
    });
  });
});
