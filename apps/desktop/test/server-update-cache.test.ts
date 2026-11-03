import { expect, test } from "bun:test";
import {
  readServerUpdateSnapshot,
  saveServerUpdateSnapshot,
  type ServerUpdateSnapshot,
} from "../src/renderer/lib/server-update-cache";

const server = "https://server.example";
const snapshot = {
  status: {
    serverUrl: server,
    status: "updating",
    targetVersion: "0.0.11",
    currentVersion: "0.0.10",
    phase: "restarting",
    message: "Restarting services",
    jobId: "one",
    safeToCloseDesktop: true,
    updaterAvailable: true,
  },
  observedAt: 1000,
  startedAt: 500,
} as ServerUpdateSnapshot;
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
test("active progress survives a fresh reader, stays server-scoped and clears when finished", () => {
  const disk = storage();
  saveServerUpdateSnapshot(server, snapshot, disk);
  expect(readServerUpdateSnapshot(server, disk, 2000)).toEqual(snapshot);
  expect(readServerUpdateSnapshot("https://other.example", disk, 2000)).toBeNull();
  saveServerUpdateSnapshot(
    server,
    { ...snapshot, status: { ...snapshot.status, status: "updated" } },
    disk
  );
  expect(readServerUpdateSnapshot(server, disk, 2000)).toBeNull();
});
test("expired, future, corrupt and unavailable storage cannot invent active progress", () => {
  const disk = storage();
  saveServerUpdateSnapshot(server, snapshot, disk);
  expect(readServerUpdateSnapshot(server, disk, 1000 + 86400001)).toBeNull();
  expect(readServerUpdateSnapshot(server, disk, 999)).toBeNull();
  disk.setItem("openteam:server-update:" + server, "{");
  expect(readServerUpdateSnapshot(server, disk, 2000)).toBeNull();
  const blocked = {
    ...disk,
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  expect(readServerUpdateSnapshot(server, blocked)).toBeNull();
  expect(() => saveServerUpdateSnapshot(server, snapshot, blocked)).not.toThrow();
});
