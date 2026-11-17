import { useEffect, useSyncExternalStore } from "react";
import { api } from "../client/openteam-api";
import { API_BASE } from "../client/http";
import { UpdateQueue } from "../lib/update-queue";

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
      const [version, update] = await Promise.all([api.systemVersion(), api.serverUpdateStatus()]);
      if (!version.releaseVersion) throw new Error("Could not verify the running server version.");
      return { version: version.releaseVersion, update };
    },
    busy: async () => (await api.busyBots()).bots.length > 0,
    startServer: (version) => api.updateServer(version),
    desktop: async () => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      return window.openteam.updates.status();
    },
    downloadDesktop: async () => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      await window.openteam.updates.openDownload();
    },
    checkDesktop: async () => {
      if (!window.openteam) throw new Error("Desktop updates are unavailable in this window.");
      return window.openteam.updates.check();
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
