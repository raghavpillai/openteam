import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicFaviconFetch } from "./public-favicon-fetch";

/** Pages request `openteam-favicon://icon/<host>`; the main process answers with that site's icon. */
export const LINK_FAVICON_SCHEME = "openteam-favicon";

const HIT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FAILURE_LIFETIME_MS = 60 * 1000;
const MAX_IMAGE_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 256_000;
const TIMEOUT_MS = 8_000;

type Icon = { type: string; bytes: Uint8Array };
type CacheEntry = { expiresAt: number; type: string | null; data: string | null };
type Lookup = { icon: Icon | null; lifetime: number };

/**
 * Public web hosts only: no IP literals, localhost or local-network names, so a
 * message link never makes the app probe the user's own network.
 */
export function linkFaviconHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) return null;
  if (/^[0-9.]+$/.test(host) || !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return null;
  if ([".local", ".localhost", ".internal", ".lan", ".home.arpa"].some((suffix) => host.endsWith(suffix))) return null;
  return host;
}

const sniffImageType = (bytes: Uint8Array, declared: string | null) => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return "image/x-icon";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  const type = declared?.split(";")[0]?.trim().toLowerCase();
  // SVG is shown through <img>, which never runs its scripts.
  if (type === "image/svg+xml" && new TextDecoder().decode(bytes.slice(0, 512)).includes("<svg")) return type;
  return null;
};

async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) return null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find(Boolean) ?? null;

/** The best `<link rel="icon">` (or apple-touch-icon) the page declares. */
export function declaredIcon(html: string, base: URL): URL | null {
  let best: { score: number; url: URL } | null = null;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, "rel")?.toLowerCase();
    const href = attribute(tag, "href");
    if (!rel?.includes("icon") || !href) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!publicFaviconURL(url)) continue;
    const score = rel.includes("apple-touch-icon") ? 3 : attribute(tag, "sizes") ? 2 : 1;
    if (!best || score > best.score) best = { score, url };
  }
  return best?.url ?? null;
}

const publicFaviconURL = (url: URL) =>
  (url.protocol === "https:" || url.protocol === "http:") &&
  !url.username && !url.password && linkFaviconHost(url.hostname) !== null;

/**
 * Site icons for chat links, fetched from the linked site itself (never a
 * third-party icon service) and cached on disk: found icons for a week, sites
 * without one for a day, and network failures for a minute.
 */
export function createLinkFavicons({
  cacheDir,
  fetch = createPublicFaviconFetch(),
  now = Date.now,
}: {
  cacheDir: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}) {
  const memory = new Map<string, { expiresAt: number; icon: Icon | null }>();
  const pending = new Map<string, Promise<Icon | null>>();
  const file = (host: string) => join(cacheDir, `${createHash("sha256").update(host).digest("hex")}.json`);
  const request = async (raw: URL | string) => {
    let url = new URL(raw);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    for (let hop = 0; hop <= 5; hop++) {
      if (!publicFaviconURL(url)) throw new Error("Favicon destination is not public");
      const response = await fetch(String(url), { redirect: "manual", credentials: "omit", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Favicon redirect has no location");
      url = new URL(location, url);
    }
    throw new Error("Too many favicon redirects");
  };

  async function image(url: URL | string): Promise<Icon | null> {
    const { response } = await request(url);
    if (!response.ok) return null;
    const bytes = await readLimited(response, MAX_IMAGE_BYTES);
    const type = bytes && bytes.byteLength > 0 ? sniffImageType(bytes, response.headers.get("content-type")) : null;
    return bytes && type ? { type, bytes } : null;
  }

  async function lookup(host: string): Promise<Lookup> {
    const root = new URL(`https://${host}/`);
    let reached = false;
    try {
      const { response: page, url: pageURL } = await request(root);
      reached = true;
      if (page.ok && page.headers.get("content-type")?.includes("html")) {
        const html = await readLimited(page, MAX_PAGE_BYTES);
        const declared = html ? declaredIcon(new TextDecoder().decode(html), pageURL) : null;
        const icon = declared ? await image(declared).catch(() => null) : null;
        if (icon) return { icon, lifetime: HIT_LIFETIME_MS };
      }
    } catch {}
    for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
      try {
        const icon = await image(new URL(path, root));
        reached = true;
        if (icon) return { icon, lifetime: HIT_LIFETIME_MS };
      } catch {}
    }
    // An unreachable site may come back soon; a site without an icon will not.
    return { icon: null, lifetime: reached ? MISS_LIFETIME_MS : FAILURE_LIFETIME_MS };
  }

  async function load(host: string): Promise<Icon | null> {
    try {
      const entry = JSON.parse(await readFile(file(host), "utf8")) as CacheEntry;
      if (entry.expiresAt > now()) {
        const icon = entry.data && entry.type ? { type: entry.type, bytes: Buffer.from(entry.data, "base64") } : null;
        memory.set(host, { expiresAt: entry.expiresAt, icon });
        return icon;
      }
    } catch {}
    const { icon, lifetime } = await lookup(host);
    const expiresAt = now() + lifetime;
    memory.set(host, { expiresAt, icon });
    const entry: CacheEntry = { expiresAt, type: icon?.type ?? null, data: icon ? Buffer.from(icon.bytes).toString("base64") : null };
    await mkdir(cacheDir, { recursive: true }).catch(() => {});
    await writeFile(file(host), JSON.stringify(entry)).catch(() => {});
    return icon;
  }

  async function iconFor(host: string): Promise<Icon | null> {
    const cached = memory.get(host);
    if (cached && cached.expiresAt > now()) return cached.icon;
    let task = pending.get(host);
    if (!task) {
      task = load(host).finally(() => pending.delete(host));
      pending.set(host, task);
    }
    return task;
  }

  return {
    iconFor,
    async serve(incoming: Request): Promise<Response> {
      let url: URL;
      try {
        url = new URL(incoming.url);
      } catch {
        return new Response(null, { status: 400 });
      }
      const host = url.hostname === "icon" ? linkFaviconHost(decodeURIComponent(url.pathname.slice(1))) : null;
      if (!host) return new Response(null, { status: 400 });
      const icon = await iconFor(host).catch(() => null);
      if (!icon) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      return new Response(Uint8Array.from(icon.bytes).buffer, {
        headers: { "content-type": icon.type, "cache-control": "max-age=3600", "x-content-type-options": "nosniff" },
      });
    },
  };
}
