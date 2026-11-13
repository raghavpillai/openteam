import { expect, test } from "bun:test";
import { presentationImageResource } from "../src/renderer/lib/presentation-image";
import { protectedResourceUrl } from "../src/renderer/lib/resource-url";
import { createBlobResourceCache } from "../src/renderer/lib/blob-resource-cache";

test("provider URLs become authenticated selected-server resources, never image destinations", () => {
  for (const source of ["https://photos.example.com/a?token=expiring", "https://127.0.0.1/a", "https://[::1]/a", "https://printer.local/a"]) {
    const resource = presentationImageResource(source)!;
    const destination = new URL(protectedResourceUrl(resource, "http://selected-server.test")!);
    expect(destination.origin).toBe("http://selected-server.test");
    expect(destination.pathname).toBe("/api/v0/presentation-image");
    expect(destination.searchParams.get("url")).toBe(source);
  }
  for (const source of ["http://photos.example.com/a", "https://user:pass@photos.example.com/a", "//other.test/a", "data:image/png,anything", "blob:anything", "javascript:alert(1)"])
    expect(presentationImageResource(source)).toBeNull();
});

test("presentation leases share bytes within a generation and fence late completions after rotation", async () => {
  const resources = createBlobResourceCache();
  const resource = presentationImageResource("https://photos.example.com/a?token=expiring")!;
  let calls = 0, done!: (blob: Blob) => void, signal!: AbortSignal;
  const old = resources.acquire(`1:${resource}`, next => { calls++; signal = next; return new Promise(resolve => { done = resolve; }); });
  const rejected = old.ready.catch(error => error);
  await Promise.resolve();
  resources.clear();
  expect(signal.aborted).toBe(true);
  const fresh = resources.acquire(`2:${resource}`, async () => { calls++; return new Blob(["new"]); });
  const shared = resources.acquire(`2:${resource}`, async () => { throw Error("duplicate load"); });
  done(new Blob(["old"]));
  expect((await rejected).name).toBe("AbortError");
  expect(await shared.ready).toBe(await fresh.ready);
  expect(calls).toBe(2);
  old.release(); fresh.release(); shared.release(); resources.clear();
});

test("supported fifty-photo bursts and overlapping accounts recover from bounded queue saturation", async () => {
  const { createPresentationImages } = await import("../../server/src/presentation-image");
  const { createPresentationImageFetch } = await import("../src/renderer/lib/presentation-image");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=", "base64");
  let active = 0, peak = 0, busy = 0;
  const load = createPresentationImages({ fetch: async () => {
    active++; peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(png, { headers: { "content-type": "image/png" } });
  } });
  const fetchImages = createPresentationImageFetch(async (input, init) => {
    const response = await load(new Request(input, init), new Headers(init?.headers).get("authorization")!);
    if (response.status === 503) busy++;
    return response;
  }, 10);
  const batches = ["account-a", "account-b"].map(account => Promise.all(Array.from({ length: 50 }, (_, i) =>
    fetchImages(`https://selected-server.test${presentationImageResource(`https://photos.example.com/${i}`)}`, {
      signal: new AbortController().signal, headers: { authorization: `Bearer ${account}` },
    }))));
  const responses = (await Promise.all(batches)).flat();
  expect(responses).toHaveLength(100);
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(busy).toBeGreaterThan(0);
  expect(peak).toBe(4);
});

test("photo retries cancel with their original credential lease and stop after a finite budget", async () => {
  const { createPresentationImageFetch } = await import("../src/renderer/lib/presentation-image");
  let calls = 0;
  const busy = async () => { calls++; return new Response(null, { status: 503, headers: { "retry-after": "1" } }); };
  const controller = new AbortController();
  const pending = createPresentationImageFetch(busy, 1000)("https://selected.test/api/v0/presentation-image", { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  await expect(pending).rejects.toThrow();
  expect(calls).toBe(1);
  calls = 0;
  expect((await createPresentationImageFetch(busy, 1)("https://selected.test/image", { signal: new AbortController().signal })).status).toBe(503);
  expect(calls).toBe(12);
  for (const status of [401, 422]) {
    calls = 0;
    const fetchImages = createPresentationImageFetch(async () => { calls++; return new Response(null, { status }); }, 1);
    expect((await fetchImages("https://selected.test/image", { signal: new AbortController().signal })).status).toBe(status);
    expect(calls).toBe(1);
  }
});
