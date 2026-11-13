import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import type { lookup } from "node:dns/promises";
import { createPublicHttpFetch } from "@openteam/plugin-sdk/public-http";
import { createPresentationImages, presentationImageResponse, rasterDimensions, IMAGE_BYTE_LIMIT } from "../src/presentation-image";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=", "base64");
const jpeg = readFileSync(new URL("../../ios/scripts/fixtures/media-photo.jpg", import.meta.url));
const webp = readFileSync(new URL("../../desktop/src/renderer/assets/model-providers/chatgpt.webp", import.meta.url));
const ca = readFileSync(new URL("../../../packages/plugin-sdk/test/fixtures/public-image/cert.pem", import.meta.url));
const key = readFileSync(new URL("../../../packages/plugin-sdk/test/fixtures/public-image/key.pem", import.meta.url));
const resolver = (addresses: string[]) => (async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) as unknown as typeof lookup;
const request = (source = "https://photo.example.com/photo", signal?: AbortSignal) => new Request(`http://selected-server.test/api/v0/presentation-image?${new URLSearchParams({ url: source })}`, { signal, headers: { authorization: "Bearer selected-server-secret", cookie: "private=session", referer: "https://private-referrer.test/" } });

async function fixture(run: (tools: { load: ReturnType<typeof createPresentationImages>; source: (path: string, host?: string) => string; seen: any[]; connections: () => number }) => Promise<void>, resolve = resolver(["8.8.8.8"])) {
  const seen: any[] = [];
  let connections = 0;
  const server = createServer({ key, cert: ca }, (req, res) => {
    seen.push({ url: req.url, headers: req.headers, sni: (req.socket as any).servername });
    if (req.url === "/redirect-slow") { res.writeHead(302, { location: "/slow" }); res.end(); }
    else if (req.url === "/private") { res.writeHead(302, { location: `https://127.0.0.1:${port}/photo` }); res.end(); }
    else if (req.url === "/mixed") { res.writeHead(302, { location: `https://redirect.example.com:${port}/photo` }); res.end(); }
    else if (req.url === "/http") { res.writeHead(302, { location: `http://photo.example.com:${port}/photo` }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else if (req.url === "/rebind") { res.writeHead(302, { location: "/photo" }); res.end(); }
    else if (req.url === "/jpeg") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(jpeg); }
    else if (req.url === "/webp") { res.writeHead(200, { "content-type": "image/webp" }); res.end(webp); }
    else if (req.url === "/slow") { res.writeHead(200, { "content-type": "image/png" }); res.write(png.subarray(0, 10)); }
    else if (req.url === "/large") { res.writeHead(200, { "content-type": "image/png", "content-length": IMAGE_BYTE_LIMIT + 1 }); res.end(); }
    else if (req.url === "/chunked-large") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.alloc(IMAGE_BYTE_LIMIT + 1)); }
    else { res.writeHead(200, { "content-type": req.url === "/html" ? "text/html" : "image/png", "set-cookie": "upstream=never-forward" }); res.end(png); }
  });
  server.on("connection", () => connections++);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;
  // Test-only adapter maps *already approved* public answers to this owned TLS
  // fixture. The production resolver/validator and Node TLS/SNI remain active.
  const transport = createPublicHttpFetch({ resolve, httpsOnly: true, byteLimit: () => IMAGE_BYTE_LIMIT,
    request: ((url: any, options: any, incoming: any) => httpsRequest(url, { ...options, ca, lookup(host: any, hints: any, callback: any) {
      options.lookup(host, hints, (error: any, answers: any, family: any) => {
        if (error) { callback(error); return; }
        const values = Array.isArray(answers) ? answers.map((a: any) => a.address) : [answers];
        expect(values.every((a: string) => a === "8.8.8.8")).toBe(true);
        if (hints.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      });
    } }, incoming)) as typeof httpsRequest });
  try { await run({ load: createPresentationImages({ fetch: transport, deadlineMs: 1500 }), source: (path, host = "photo.example.com") => `https://${host}:${port}${path}`, seen, connections: () => connections }); }
  finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}

test("real pinned HTTPS preserves public photos, original host/SNI, and strips every caller credential", () => fixture(async ({ load, source, seen }) => {
  const response = await load(request(source("/photo")), "account-a");
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(seen[0].sni).toBe("photo.example.com");
  expect(seen[0].headers.host).toContain("photo.example.com:");
  for (const header of ["authorization", "cookie", "referer", "proxy-authorization"]) expect(seen[0].headers[header]).toBeUndefined();
  expect((await load(request(source("/photo")), "account-a")).status).toBe(200);
  expect(seen).toHaveLength(1);
  expect((await load(request(source("/photo")), "account-b")).status).toBe(200);
  expect(seen).toHaveLength(2);
}));

for (const address of ["127.0.0.1", "::1", "192.168.1.1", "169.254.169.254", "::ffff:127.0.0.1", "fc00::1", "64:ff9b::7f00:1", "2002:7f00:1::"]) {
  test(`no private socket for all-DNS mixed answer ${address}`, () => fixture(async ({ load, source, connections }) => {
    expect((await load(request(source("/photo")), "a")).status).toBe(422);
    expect(connections()).toBe(0);
  }, resolver(["8.8.8.8", address])));
  test(`no private socket for literal ${address}`, () => fixture(async ({ load, source, connections }) => {
    expect((await load(request(source("/photo", address.includes(":") ? `[${address}]` : address)), "a")).status).toBe(422);
    expect(connections()).toBe(0);
  }));
}
for (const path of ["/private", "/http", "/loop", "/html", "/large", "/chunked-large"]) test(`reject ${path} without following an unsafe hop`, () => fixture(async ({ load, source, seen }) => {
  expect((await load(request(source(path)), "a")).status).toBe(422);
  if (path !== "/loop") expect(seen).toHaveLength(1);
  else expect(seen).toHaveLength(4);
}));

test("redirect hop re-resolves and refuses rebinding before the second socket", async () => {
  let calls = 0;
  await fixture(async ({ load, source, seen, connections }) => {
    expect((await load(request(source("/rebind")), "a")).status).toBe(422);
    expect(seen).toHaveLength(1); expect(connections()).toBe(1); expect(calls).toBe(2);
  }, (async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]) as unknown as typeof lookup);
});

test("caller abort and deadline stop incomplete reads; no partial cache", () => fixture(async ({ load, source, seen }) => {
  const controller = new AbortController();
  const pending = load(request(source("/slow"), controller.signal), "a");
  await new Promise(done => setTimeout(done, 50)); controller.abort();
  expect((await pending).status).toBe(422);
  expect((await load(request(source("/photo")), "a")).status).toBe(200);
  expect((await load(request(source("/slow")), "a")).status).toBe(422);
  expect(seen).toHaveLength(3);
}));

test("global concurrency and queue are bounded; queued cancellation releases waiters", async () => {
  let active = 0, peak = 0;
  const load = createPresentationImages({ deadlineMs: 100, fetch: async (_url, init) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise((_done, reject) => init.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true })); }
    finally { active--; }
    return new Response(png);
  } });
  const controller = new AbortController();
  const pending = Array.from({ length: 45 }, (_, i) => load(request(`https://photo.example.com/${i}`, controller.signal), "a"));
  await new Promise(done => setTimeout(done, 10)); controller.abort();
  expect((await Promise.all(pending)).every(r => r.status === 422)).toBe(true);
  expect(peak).toBe(4); expect(active).toBe(0);
});

test("endpoint rejects unauthenticated/invalid sessions before image work", async () => {
  let calls = 0;
  const load = async () => { calls++; return new Response(png); };
  for (const token of [null, "wrong-token"]) {
    const r = new Request(request().url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await presentationImageResponse(r, null, "required", load)).status).toBe(401);
  }
  expect(calls).toBe(0);
});

test("magic, MIME and dimensions agree before returning raster bytes", () => {
  expect(rasterDimensions(png, "image/png")).toEqual([1, 1]);
  for (const mime of ["image/svg+xml", "image/jpeg", "text/html"]) expect(() => rasterDimensions(png, mime)).toThrow();
  const huge = Buffer.from(png); huge.writeUInt32BE(9000, 16);
  expect(() => rasterDimensions(huge, "image/png")).toThrow();
  expect(() => rasterDimensions(Buffer.from("<svg/>"), "image/png")).toThrow();
});

test("public redirect remains supported and uses fresh pinned DNS", async () => {
  let calls = 0;
  await fixture(async ({ load, source, seen }) => {
    expect((await load(request(source("/mixed")), "a")).status).toBe(200);
    expect(seen.map(r => r.sni)).toEqual(["photo.example.com", "redirect.example.com"]);
    expect(calls).toBe(2);
    expect(seen[1].headers.cookie).toBeUndefined();
  }, (async () => { calls++; return [{ address: "8.8.8.8", family: 4 }]; }) as unknown as typeof lookup);
});

test("invalid host, URL credentials and empty DNS cannot create a socket", async () => {
  await fixture(async ({ load, source, connections }) => {
    for (const url of [source("/photo", "printer.local"), source("/photo", "localhost"), source("/photo").replace("https://", "https://user:password@"), source("/photo")])
      expect((await load(request(url), "a")).status).toBe(422);
    expect(connections()).toBe(0);
  }, resolver([]));
});

test("compressed cache is cost bounded, session scoped and expires", async () => {
  let now = 0, calls = 0;
  const bytes = Buffer.alloc(1024 * 1024); png.copy(bytes);
  const load = createPresentationImages({ now: () => now, fetch: async () => { calls++; return new Response(bytes, { headers: { "content-type": "image/png" } }); } });
  for (let i = 0; i < 17; i++) expect((await load(request(`https://photo.example.com/${i}`), "a")).status).toBe(200);
  expect(calls).toBe(17);
  await load(request("https://photo.example.com/16"), "a"); expect(calls).toBe(17);
  await load(request("https://photo.example.com/0"), "a"); expect(calls).toBe(18);
  await load(request("https://photo.example.com/0"), "b"); expect(calls).toBe(19);
  now = 60_001;
  await load(request("https://photo.example.com/0"), "a"); expect(calls).toBe(20);
});

test("more than four legitimate photos queue and finish without being dropped", async () => {
  let active = 0, peak = 0;
  const load = createPresentationImages({ fetch: async () => {
    active++; peak = Math.max(active, peak);
    await new Promise(done => setTimeout(done, 5)); active--;
    return new Response(png, { headers: { "content-type": "image/png" } });
  } });
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => load(request(`https://photo.example.com/${i}`), "a")));
  expect(responses.every(r => r.status === 200)).toBe(true);
  expect(peak).toBe(4);
});

test("caller cancellation remains active after a public redirect", () => fixture(async ({ load, source, seen }) => {
  const controller = new AbortController();
  const pending = load(request(source("/redirect-slow"), controller.signal), "a");
  await new Promise(done => setTimeout(done, 50)); controller.abort();
  expect((await pending).status).toBe(422);
  expect(seen.map(r => r.url)).toEqual(["/redirect-slow", "/slow"]);
}));


test("real raster JPEG photos and WebP remain supported through pinned HTTPS", () => fixture(async ({ load, source }) => {
  for (const [path, bytes, mime] of [["/jpeg", jpeg, "image/jpeg"], ["/webp", webp, "image/webp"]] as const) {
    const response = await load(request(source(path)), "photos");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const [width, height] = rasterDimensions(bytes, mime);
    expect(width > 0 && height > 0).toBe(true);
  }
}));
