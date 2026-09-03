import { describe, expect, mock, test } from "bun:test";
import type { ClientSnapshot } from "@openteam/contracts";
import { mobileFixture } from "../src/fixtures";

const files = new Map<string, string>();
let writes = 0;

mock.module("expo-file-system/legacy", () => ({
  documentDirectory: "memory://documents/",
  getInfoAsync: async (path: string) => ({ exists: files.has(path) }),
  readAsStringAsync: async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error("missing file");
    return value;
  },
  writeAsStringAsync: async (path: string, value: string) => {
    writes += 1;
    files.set(path, value);
  },
  deleteAsync: async (path: string) => {
    files.delete(path);
  },
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    const value = files.get(from);
    if (value === undefined) throw new Error("missing source");
    files.set(to, value);
    files.delete(from);
  },
}));

const {
  flushCachedSnapshotWrites,
  loadCachedSnapshot,
  scheduleCachedSnapshotSave,
  saveCachedSnapshot,
} = await import("../src/snapshot-cache");

const snapshot = (cursor: string): ClientSnapshot => ({ ...mobileFixture, cursor });

describe("mobile snapshot cache", () => {
  test("serializes and coalesces rapid writes to the latest snapshot", async () => {
    files.clear();
    writes = 0;
    for (let cursor = 1; cursor <= 100; cursor += 1) {
      scheduleCachedSnapshotSave("https://one.test", snapshot(String(cursor)));
    }
    await flushCachedSnapshotWrites();

    expect(writes).toBe(1);
    expect((await loadCachedSnapshot("https://one.test"))?.cursor).toBe("100");
  });

  test("keeps origins isolated and falls back to the other valid journal slot", async () => {
    files.clear();
    writes = 0;
    await saveCachedSnapshot("https://one.test", snapshot("1"));
    await saveCachedSnapshot("https://two.test", snapshot("2"));

    expect((await loadCachedSnapshot("https://two.test"))?.cursor).toBe("2");
    expect((await loadCachedSnapshot("https://one.test"))?.cursor).toBe("1");
    expect(await loadCachedSnapshot("https://missing.test")).toBeNull();
  });
});
