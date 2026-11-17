import { useEffect, useSyncExternalStore } from "react";
import type { BusyBotsView, ServerUpdateView, SystemVersionView } from "@openteam/contracts";
import { API_BASE, request } from "../client/http";
import { UpdateQueue } from "../lib/update-queue";
import { withDeadline } from "../lib/request-errors";

// Bound each round trip as well as the overall queue. Aborting also cancels a stalled body read.
const queueRequest = <T>(path: string, init?: RequestInit) =>
  withDeadline((signal) => request<T>(path, { ...init, signal }), 15_000);

const key = `openteam:update-queue:${API_BASE}:${window.openteam?.versions.app ?? "web"}`;
let restored: unknown = null;
try {
  restored = JSON.parse(localStorage.getItem(key) ?? "null");
} catch {
  /* Storage is optional. */
}
const queue = new UpdateQueue(
  {
    async server() {
      const [version, update] = await Promise.all([
        queueRequest<SystemVersionView>("/api/v0/system/version"),
        queueRequest<ServerUpdateView>("/api/v0/system/update"),
      ]);
      if (!version.releaseVersion) throw new Error("Could not verify the running server version.");
      return { version: version.releaseVersion, update };
    },
    busy: async () =>
      (await queueRequest<BusyBotsView>("/api/v0/system/busy-bots")).bots.length > 0,
    startServer: (version) =>
      queueRequest<ServerUpdateView>("/api/v0/system/update", {
        method: "POST",
        body: JSON.stringify({ targetVersion: version }),
      }),
    desktop: async () => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      return withDeadline(() => window.openteam!.updates.status(), 15_000);
    },
    downloadDesktop: async (version) => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      await window.openteam.updates.openDownload(version);
    },
    checkDesktop: async () => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      return withDeadline(() => window.openteam!.updates.check(), 15_000);
    },
    wait: () => new Promise((resolve) => window.setTimeout(resolve, 1_500)),
    now: Date.now,
    save: (state) => {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* Keep running in memory. */
      }
    },
  },
  restored
);

export function useUpdateQueue() {
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useEffect(() => {
    void queue.resume();
  }, []);
  return { state, start: queue.start, retry: queue.retry };
}
