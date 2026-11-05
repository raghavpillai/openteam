import { isOpenTeamVersion } from "@openteam/contracts/version-compatibility";

type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface ServerUpdateSnapshot {
  status: OpenTeamServerUpdateStatus;
  observedAt: number;
  startedAt: number | null;
}
const key = (server: string) => `openteam:server-update:${server}`;
const MAX_AGE = 24 * 60 * 60 * 1000;

/** A last-known active job, never evidence that a server is currently healthy. */
export function readServerUpdateSnapshot(
  server: string,
  storage: CacheStorage,
  now = Date.now()
): ServerUpdateSnapshot | null {
  try {
    const saved = JSON.parse(storage.getItem(key(server)) ?? "null") as ServerUpdateSnapshot | null;
    if (
      !saved ||
      !Number.isFinite(saved.observedAt) ||
      saved.observedAt > now ||
      now - saved.observedAt > MAX_AGE
    )
      return null;
    const status = saved.status;
    if (
      status?.serverUrl !== server ||
      status.status !== "updating" ||
      !isOpenTeamVersion(status.targetVersion ?? "")
    )
      return null;
    if (
      ![status.phase, status.message, status.currentVersion, status.jobId].every(
        (value) => value === null || typeof value === "string"
      )
    )
      return null;
    if (
      typeof status.safeToCloseDesktop !== "boolean" ||
      typeof status.updaterAvailable !== "boolean"
    )
      return null;
    if (saved.startedAt !== null && (!Number.isFinite(saved.startedAt) || saved.startedAt > now))
      return null;
    return saved;
  } catch {
    return null;
  }
}

export function saveServerUpdateSnapshot(
  server: string,
  snapshot: ServerUpdateSnapshot | null,
  storage: CacheStorage
) {
  try {
    if (snapshot?.status.status === "updating")
      storage.setItem(key(server), JSON.stringify(snapshot));
    else storage.removeItem(key(server));
  } catch {
    /* Storage can be disabled; live server status still works. */
  }
}
