import { describe, expect, test } from "bun:test";
import { createKeyedRequestCoordinator } from "../src";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("keyed request coordinator", () => {
  test("deduplicates same-key work and removes it after settlement", async () => {
    const coordinator = createKeyedRequestCoordinator();
    const pending = deferred<number>();
    let calls = 0;
    const first = coordinator.run("channel-1", async () => {
      calls += 1;
      return pending.promise;
    });
    const second = coordinator.run("channel-1", async () => {
      calls += 1;
      return 2;
    });
    expect(first).toBe(second);
    expect(calls).toBe(1);
    pending.resolve(1);
    expect(await first).toBe(1);
    await coordinator.run("channel-1", async () => {
      calls += 1;
      return 3;
    });
    expect(calls).toBe(2);
  });

  test("invalidates leases so stale results cannot commit", async () => {
    const coordinator = createKeyedRequestCoordinator();
    let captured: Parameters<typeof coordinator.isCurrent>[0] | null = null;
    const request = coordinator.run("channel-1", async (lease) => {
      captured = lease;
      return "done";
    });
    expect(coordinator.isCurrent(captured!)).toBe(true);
    coordinator.invalidate("channel-1");
    expect(coordinator.isCurrent(captured!)).toBe(false);
    expect(await request).toBe("done");
  });
});
