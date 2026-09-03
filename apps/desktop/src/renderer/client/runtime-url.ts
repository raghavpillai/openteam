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

export function resolveViewerUrl(viewerUrl: string, pageUrl: string): string {
  try {
    const viewer = new URL(viewerUrl);
    const page = new URL(pageUrl);
    const viewerPort = Number(viewer.port);
    const isDevPage = page.protocol === "http:" || page.protocol === "https:";
    const isViewerPort = viewerPort >= 6200 && viewerPort <= 6299;
    if (!isDevPage || !isViewerPort) return viewer.toString();

    viewer.protocol = page.protocol;
    viewer.host = page.host;
    viewer.pathname = `/novnc/${viewerPort}${viewer.pathname}`;
    return viewer.toString();
  } catch {
    return viewerUrl;
  }
}
