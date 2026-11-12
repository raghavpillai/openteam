import { afterEach, describe, expect, jest, test } from "bun:test";
import { createBlobResourceCache } from "../src/renderer/lib/blob-resource-cache";

const caches: ReturnType<typeof createBlobResourceCache>[] = [];
function cache() {
  const value = createBlobResourceCache();
  caches.push(value);
  return value;
}
const readable = async (url: string) => (await fetch(url)).text();

afterEach(() => {
  for (const value of caches.splice(0)) value.clear();
  jest.useRealTimers();
});

describe("shared blob resource ownership", () => {
  test("deduplicates pending loads and pins a URL until its last consumer releases", async () => {
    jest.useFakeTimers();
    const resources = cache();
    let calls = 0;
    const load = async () => {
      calls++;
      return new Blob(["shared"]);
    };
    const first = resources.acquire("image", load);
    const second = resources.acquire("image", load);
    const url = await first.ready;
    expect(await second.ready).toBe(url);
    expect(calls).toBe(1);
    first.release();
    first.release();
    jest.advanceTimersByTime(60_000);
    expect(await readable(url)).toBe("shared");
    second.release();
    jest.advanceTimersByTime(29_999);
    expect(await readable(url)).toBe("shared");
    jest.advanceTimersByTime(1);
    await expect(readable(url)).rejects.toThrow();
  });

  test("reuses a warm resource and restarts its inactive expiry after release", async () => {
    jest.useFakeTimers();
    const resources = cache();
    const first = resources.acquire("image", async () => new Blob(["warm"]));
    const url = await first.ready;
    first.release();
    jest.advanceTimersByTime(20_000);
    const second = resources.acquire("image", async () => {
      throw Error("Fetched twice");
    });
    expect(await second.ready).toBe(url);
    jest.advanceTimersByTime(20_000);
    expect(await readable(url)).toBe("warm");
    second.release();
    jest.advanceTimersByTime(30_000);
    await expect(readable(url)).rejects.toThrow();
  });

  test("evicts inactive entries by byte cost while preserving active consumers", async () => {
    const resources = cache();
    const pinned = resources.acquire("pinned", async () => new Blob(["pinned"]));
    const pinnedUrl = await pinned.ready;
    const large = resources.acquire(
      "large",
      async () => new Blob([new Uint8Array(16 * 1024 * 1024 + 1)])
    );
    const largeUrl = await large.ready;
    expect((await fetch(largeUrl)).status).toBe(200);
    large.release();
    await expect(readable(largeUrl)).rejects.toThrow();
    expect(await readable(pinnedUrl)).toBe("pinned");
    pinned.release();
  });

  test("bounds the number of inactive entries and evicts the oldest", async () => {
    const resources = cache();
    let firstUrl = "";
    let lastUrl = "";
    for (let index = 0; index < 65; index++) {
      const lease = resources.acquire(String(index), async () => new Blob([String(index)]));
      const url = await lease.ready;
      if (index === 0) firstUrl = url;
      lastUrl = url;
      lease.release();
    }
    await expect(readable(firstUrl)).rejects.toThrow();
    expect(await readable(lastUrl)).toBe("64");
  });

  test("aborts an abandoned fetch and prevents late completion from allocating a URL", async () => {
    const resources = cache();
    let signal: AbortSignal | undefined;
    let complete!: (blob: Blob) => void;
    const pending = resources.acquire("image", (nextSignal) => {
      signal = nextSignal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const rejected = pending.ready.catch((error) => error);
    await Promise.resolve();
    pending.release();
    expect(signal?.aborted).toBe(true);
    complete(new Blob(["late"]));
    expect((await rejected).name).toBe("AbortError");
    const retry = resources.acquire("image", async () => new Blob(["retry"]));
    expect(await readable(await retry.ready)).toBe("retry");
    retry.release();
  });

  test("credential invalidation preserves a displayed URL until commit releases it", async () => {
    const resources = cache();
    const first = resources.acquire("image", async () => new Blob(["old account"]));
    const oldUrl = await first.ready;
    resources.clear();
    expect(await readable(oldUrl)).toBe("old account");
    const second = resources.acquire("image", async () => new Blob(["new account"]));
    const nextUrl = await second.ready;
    second.release();
    first.release();
    await expect(readable(oldUrl)).rejects.toThrow();
    expect(await readable(nextUrl)).toBe("new account");
  });

  test("a failed request can be retried without an old release evicting the replacement", async () => {
    const resources = cache();
    const first = resources.acquire("image", async () => {
      throw Error("offline");
    });
    await expect(first.ready).rejects.toThrow("offline");
    const second = resources.acquire("image", async () => new Blob(["recovered"]));
    const url = await second.ready;
    second.release();
    first.release();
    expect(await readable(url)).toBe("recovered");
  });
});
