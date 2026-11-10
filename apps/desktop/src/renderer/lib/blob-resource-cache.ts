export interface BlobResourceLease {
  ready: Promise<string>;
  release: () => void;
}

interface Entry {
  controller: AbortController;
  ready: Promise<string>;
  references: number;
  url: string | null;
  bytes: number;
  expiresAt: number;
}

const INACTIVE_BYTES = 16 * 1024 * 1024;
const INACTIVE_ENTRIES = 64;
const INACTIVE_TTL_MS = 30_000;

/** Pin displayed resources and bound the compressed blobs kept for reuse. */
export function createBlobResourceCache() {
  const entries = new Map<string, Entry>();
  const inactive = new Map<string, Entry>();
  let inactiveBytes = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const removeInactive = (key: string) => {
    const entry = inactive.get(key);
    if (!entry) return;
    inactive.delete(key);
    inactiveBytes -= entry.bytes;
  };
  const dispose = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    if (inactive.get(key) === entry) removeInactive(key);
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
  };
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const oldest = inactive.values().next().value;
    if (!oldest) return;
    expiryTimer = setTimeout(prune, Math.max(0, oldest.expiresAt - Date.now()));
  };
  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of inactive) {
      if (
        entry.expiresAt > now &&
        inactiveBytes <= INACTIVE_BYTES &&
        inactive.size <= INACTIVE_ENTRIES
      )
        break;
      dispose(key, entry);
    }
    scheduleExpiry();
  };

  return {
    acquire(key: string, load: (signal: AbortSignal) => Promise<Blob>): BlobResourceLease {
      let entry = entries.get(key);
      if (entry) {
        removeInactive(key);
        entry.references++;
        scheduleExpiry();
      } else {
        const controller = new AbortController();
        entry = {
          controller,
          references: 1,
          url: null,
          bytes: 0,
          expiresAt: 0,
          ready: Promise.resolve(""),
        };
        const current = entry;
        entries.set(key, current);
        current.ready = Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return load(controller.signal);
          })
          .then((blob) => {
            controller.signal.throwIfAborted();
            current.bytes = blob.size;
            current.url = URL.createObjectURL(blob);
            return current.url;
          })
          .catch((error) => {
            if (entries.get(key) === current) entries.delete(key);
            throw error;
          });
      }
      const current = entry;
      let released = false;
      return {
        ready: current.ready,
        release() {
          if (released) return;
          released = true;
          current.references--;
          if (current.references > 0) return;
          if (!current.url || entries.get(key) !== current) {
            dispose(key, current);
            return;
          }
          current.expiresAt = Date.now() + INACTIVE_TTL_MS;
          inactive.set(key, current);
          inactiveBytes += current.bytes;
          prune();
        },
      };
    },
    clear() {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
      for (const entry of entries.values()) {
        entry.controller.abort();
        if (entry.references === 0 && entry.url) URL.revokeObjectURL(entry.url);
      }
      entries.clear();
      inactive.clear();
      inactiveBytes = 0;
    },
  };
}
