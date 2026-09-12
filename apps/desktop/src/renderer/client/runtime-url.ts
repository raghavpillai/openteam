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

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";

const sameHost = (left: string, right: string): boolean =>
  left === right || (isLoopbackHost(left) && isLoopbackHost(right));

export function resolveViewerUrl(
  viewerUrl: string,
  pageUrl: string,
  apiBase = resolveApiBase(pageUrl)
): string {
  try {
    const viewer = new URL(viewerUrl);
    const page = new URL(pageUrl);
    const api = new URL(apiBase);
    const viewerPort = Number(viewer.port);
    const isDevPage = page.protocol === "http:" || page.protocol === "https:";
    const isViewerPort = viewerPort >= 6200 && viewerPort <= 6299;
    if (!isDevPage || !isViewerPort) return viewer.toString();
    // Vite's /novnc proxy connects to its own machine. A selected remote
    // server must never be routed through that local viewer proxy.
    if (!sameHost(api.hostname, page.hostname)) return viewer.toString();
    if (!isLoopbackHost(viewer.hostname) && !sameHost(viewer.hostname, page.hostname)) {
      return viewer.toString();
    }

    viewer.protocol = page.protocol;
    viewer.host = page.host;
    viewer.pathname = `/novnc/${viewerPort}${viewer.pathname}`;
    return viewer.toString();
  } catch {
    return viewerUrl;
  }
}

/** Remote computers use authenticated frames and input through their selected API. */
export function resolveLiveViewerUrl(viewerUrl: string, pageUrl: string, apiBase: string): string {
  try {
    const page = new URL(pageUrl);
    const api = new URL(apiBase);
    const viewer = new URL(resolveViewerUrl(viewerUrl, pageUrl, apiBase));
    const sameOrigin = page.protocol !== "file:" && viewer.origin === page.origin;
    const localViewer =
      isLoopbackHost(viewer.hostname) &&
      isLoopbackHost(api.hostname) &&
      (page.protocol === "file:" || isLoopbackHost(page.hostname));
    if (!sameOrigin && !localViewer) return "";
    if (viewer.protocol !== "http:" && viewer.protocol !== "https:") return "";
    viewer.searchParams.set("view_only", "false");
    return viewer.toString();
  } catch {
    return "";
  }
}
