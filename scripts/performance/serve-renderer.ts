import { extname, resolve, sep } from "node:path";

const port = Number(process.env.OPENBOT_AUDIT_RENDERER_PORT ?? 5174);
const apiBase = process.env.OPENBOT_AUDIT_API_URL ?? "http://127.0.0.1:8877";
const distRoot = resolve(import.meta.dir, "../../apps/desktop/dist");

const contentType: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const staticResponse = async (pathname: string) => {
  const requested = resolve(distRoot, `.${pathname}`);
  if (requested !== distRoot && !requested.startsWith(`${distRoot}${sep}`)) {
    return new Response("Not found", { status: 404 });
  }
  const candidate = Bun.file(requested);
  if (await candidate.exists()) {
    return new Response(candidate, {
      headers: {
        "cache-control": "no-store",
        "content-type": contentType[extname(requested)] ?? "application/octet-stream",
      },
    });
  }
  return new Response(Bun.file(resolve(distRoot, "index.html")), {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType[".html"],
    },
  });
};

Bun.serve({
  hostname: "127.0.0.1",
  // Product events send sparse keepalives. Bun's short default idle timeout
  // otherwise severs the audit proxy between heartbeats, making EventSource
  // reconnect and contaminating idle measurements with recovery refreshes.
  idleTimeout: 255,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const upstreamUrl = new URL(`${url.pathname}${url.search}`, apiBase);
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      const headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    return staticResponse(url.pathname === "/" ? "/index.html" : url.pathname);
  },
});

console.log(`OpenBot performance-audit renderer listening on http://127.0.0.1:${port}`);
console.log(`Proxying API requests to ${apiBase}`);
