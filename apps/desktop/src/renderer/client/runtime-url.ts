const LOCAL_API_BASE = "http://127.0.0.1:8787";

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
import { normalizeBaseUrl } from "@openbot/client-core";
