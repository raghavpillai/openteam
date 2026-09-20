import { normalizeBaseUrl } from "@openteam/client-core";

const LOCAL_API_BASE = "http://127.0.0.1:8787";
export const CONFIGURED_API_BASE_KEY = "openteam:server-url";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function resolveApiBase(pageUrl: string, configured?: string): string {
  if (configured) return normalizeBaseUrl(configured);
  try {
    const page = new URL(pageUrl);
    if (page.protocol === "http:" || page.protocol === "https:") return page.origin;
  } catch {
    // Packaged Electron uses the loopback API fallback below.
  }
  return LOCAL_API_BASE;
}

export function resolveConfiguredApiBase(
  pageUrl: string,
  storage: StorageReader,
  environmentConfigured?: string
): string {
  try {
    const persisted = storage.getItem(CONFIGURED_API_BASE_KEY)?.trim();
    if (persisted) return resolveApiBase(pageUrl, persisted);
  } catch {
    // A corrupt or unavailable preference must not prevent the desktop from launching.
  }
  return resolveApiBase(pageUrl, environmentConfigured);
}

export function saveConfiguredApiBase(storage: StorageWriter, value: string): string {
  const normalized = normalizeBaseUrl(value);
  storage.setItem(CONFIGURED_API_BASE_KEY, normalized);
  return normalized;
}

/** The authenticated relay always belongs to the selected API and requested bot. */
export function resolveVncSocketUrl(apiBase: string, path: string, botId: string): string {
  if (path !== `/api/v0/bots/${encodeURIComponent(botId)}/screen/vnc`) {
    throw new Error("Invalid computer endpoint");
  }
  const url = new URL(normalizeBaseUrl(apiBase) + path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
