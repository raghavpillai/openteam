import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createLinkFavicons, linkFaviconHost } from "../src/main/link-favicons";
import { createPublicFaviconFetch, publicFaviconLookup } from "../src/main/public-favicon-fetch";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Route = (url: string) => Response | Promise<Response>;
const fixture = async (routes: Record<string, Route>) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "openteam-favicons-"));
  temporaryDirectories.push(cacheDir);
  const requests: { url: string; init: RequestInit }[] = [];
  let clock = 1_000;
  const favicons = createLinkFavicons({
    cacheDir,
    now: () => clock,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const route = routes[url];
      if (!route) return new Response("missing", { status: 404 });
      return route(url);
    },
  });
  const serve = (host: string) => favicons.serve(new Request(`openteam-favicon://icon/${host}`));
  return { cacheDir, favicons, requests, serve, advance: (ms: number) => { clock += ms; } };
};

const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const image = (bytes: Uint8Array, type = "image/png") => () => new Response(bytes, { headers: { "content-type": type } });

describe("link favicons", () => {
  test("accepts public hosts only", () => {
    expect(linkFaviconHost("en.wikipedia.org")).toBe("en.wikipedia.org");
    expect(linkFaviconHost("Example.COM")).toBe("example.com");
    for (const host of ["localhost", "192.168.1.1", "10.0.0.1", "printer.local", "api.internal", "intranet", "a..b", "x.y/z"]) {
      expect(linkFaviconHost(host)).toBeNull();
    }
  });

  test("serves the declared icon without cookies and caches it on disk", async () => {
    const { serve, requests, cacheDir } = await fixture({
      "https://example.com/": html(`<head><link rel="icon" sizes="64x64" href="/brand.png"></head>`),
      "https://example.com/brand.png": image(png),
    });
    const response = await serve("example.com");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(requests.every(({ init }) => init.credentials === "omit")).toBe(true);
    expect(await readdir(cacheDir)).toHaveLength(1);
  });

  test("rejects non-images and private hosts without fetching", async () => {
    const { serve, requests } = await fixture({
      "https://example.net/": html("<link rel=icon href=/fake.png>"),
      "https://example.net/fake.png": () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
    });
    expect((await serve("example.net")).status).toBe(404);
    const before = requests.length;
    expect((await serve("192.168.0.1")).status).toBe(400);
    expect((await serve("localhost")).status).toBe(400);
    expect(requests.length).toBe(before);
  });

});


describe("favicon destination boundaries", () => {
  for (const target of ["http://127.0.0.1/private.png", "http://192.168.1.1/icon", "http://printer.local/icon", "http://169.254.169.254/latest", "https://user:secret@cdn.example.com/icon"]) {
    test(`never requests a declared private or credentialed icon: ${target}`, async () => {
      const { serve, requests } = await fixture({
        "https://example.com/": html(`<link rel="icon" href="${target}">`),
        [target]: image(png),
      });
      expect((await serve("example.com")).status).toBe(404);
      expect(requests.some(({ url }) => url === target)).toBe(false);
    });
  }

  test("checks every redirect and retains the final page URL for relative icons", async () => {
    const { serve, requests } = await fixture({
      "https://example.com/": () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/docs/" } }),
      "https://cdn.example.com/docs/": html('<link rel="icon" href="brand.png">'),
      "https://cdn.example.com/docs/brand.png": image(png),
    });
    expect((await serve("example.com")).status).toBe(200);
    expect(requests.every(({ init }) => init.redirect === "manual")).toBe(true);
  });

  for (const path of ["/", "/favicon.ico", "/apple-touch-icon.png", "/brand.png"]) {
    test(`blocks a private redirect from ${path}`, async () => {
      const target = "http://127.0.0.1/private.png";
      const { serve, requests } = await fixture({
        "https://example.com/": html('<link rel="icon" href="/brand.png">'),
        [`https://example.com${path}`]: () => new Response(null, { status: 302, headers: { location: target } }),
        [target]: image(png),
      });
      expect((await serve("example.com")).status).toBe(404);
      expect(requests.some(({ url }) => url === target)).toBe(false);
    });
  }
});

test("bounds redirect loops and cancels oversized chunked images", async () => {
  let canceled = false;
  const { serve, requests } = await fixture({
    "https://loop.example/": () => new Response(null, { status: 302, headers: { location: "/" } }),
    "https://loop.example/favicon.ico": () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "image/png" } }),
  });
  expect((await serve("loop.example")).status).toBe(404);
  expect(requests.filter(({ url }) => url === "https://loop.example/")).toHaveLength(6);
  expect(canceled).toBe(true);
});

// Transport-level DNS pinning shared by every favicon request.
const resolver = (answers: { address: string; family: number }[]) =>
  (async () => answers) as typeof lookup;
const resolved = (answers: { address: string; family: number }[]) => new Promise((resolve, reject) => {
  publicFaviconLookup(resolver(answers))("example.com", { all: true }, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});

for (const address of ["127.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "64:ff9b::7f00:1", "2002:7f00:1::"]) {
  test(`DNS refuses ${address}, including mixed public/private answers`, async () => {
    const privateAnswer = { address, family: address.includes(":") ? 6 : 4 };
    await expect(resolved([privateAnswer])).rejects.toThrow("not public");
    await expect(resolved([{ address: "8.8.8.8", family: 4 }, privateAnswer])).rejects.toThrow("not public");
  });
}

test("socket lookup returns validated addresses directly and revalidates the next connection", async () => {
  let calls = 0;
  const pinned = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  const resolve = (async () => ++calls === 1 ? pinned : [{ address: "127.0.0.1", family: 4 }]) as typeof lookup;
  const lookupSocket = publicFaviconLookup(resolve);
  const call = () => new Promise((done, reject) => {
    lookupSocket("rebind.example.com", { all: true }, (error, answers) => error ? reject(error) : done(answers));
  });
  expect(await call()).toEqual(pinned);
  expect(calls).toBe(1);
  await expect(call()).rejects.toThrow("not public");
  expect(calls).toBe(2);
});

test("real HTTP transport never connects to a public hostname resolving to loopback", async () => {
  let connections = 0;
  const server = createServer((_request, response) => { response.end("private"); });
  server.on("connection", () => { connections++; });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const fetch = createPublicFaviconFetch(resolver([{ address: "127.0.0.1", family: 4 }]));
    await expect(fetch(`http://public.example.com:${address.port}/private`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow("not public");
    expect(connections).toBe(0);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
