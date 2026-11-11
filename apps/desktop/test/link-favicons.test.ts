import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkFavicons, declaredIcon, linkFaviconHost } from "../src/main/link-favicons";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ico = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 1, 0, 16, 16]);

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

  test("prefers the icon the page declares", () => {
    const base = new URL("https://example.com/docs/");
    const page = `<link rel="icon" href="/small.ico"><link rel="icon" sizes="32x32" href="icon-32.png"><link rel='apple-touch-icon' href='https://cdn.example.com/touch.png'>`;
    expect(declaredIcon(page, base)?.href).toBe("https://cdn.example.com/touch.png");
    expect(declaredIcon(`<link rel="stylesheet" href="a.css">`, base)).toBeNull();
    expect(declaredIcon(`<link rel="icon" href="javascript:alert(1)">`, base)).toBeNull();
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

  test("falls back to /favicon.ico and sniffs its type", async () => {
    const { serve } = await fixture({
      "https://example.org/": html("<title>No icon declared</title>"),
      "https://example.org/favicon.ico": image(ico, "application/octet-stream"),
    });
    const response = await serve("example.org");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
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

  test("shares one lookup and remembers misses for a day", async () => {
    let pageLoads = 0;
    const { serve, advance } = await fixture({
      "https://no-icon.example/": () => { pageLoads += 1; return html("<p>plain</p>")(); },
    });
    await Promise.all([serve("no-icon.example"), serve("no-icon.example"), serve("no-icon.example")]);
    expect(pageLoads).toBe(1);
    advance(60 * 60 * 1000);
    expect((await serve("no-icon.example")).status).toBe(404);
    expect(pageLoads).toBe(1);
    advance(24 * 60 * 60 * 1000);
    await serve("no-icon.example");
    expect(pageLoads).toBe(2);
  });

  test("retries an unreachable site after a minute", async () => {
    let attempts = 0;
    let clock = 0;
    const { cacheDir } = await fixture({});
    const favicons = createLinkFavicons({
      cacheDir,
      now: () => clock,
      fetch: async () => { attempts += 1; throw new Error("offline"); },
    });
    const serve = () => favicons.serve(new Request("openteam-favicon://icon/down.example"));
    expect((await serve()).status).toBe(404);
    expect(attempts).toBe(3); // page, /favicon.ico, /apple-touch-icon.png
    clock += 30_000;
    await serve();
    expect(attempts).toBe(3);
    clock += 31_000;
    await serve();
    expect(attempts).toBe(6);
  });
});
