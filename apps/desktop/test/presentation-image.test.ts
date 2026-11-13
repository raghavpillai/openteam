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
