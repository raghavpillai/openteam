import { describe, expect, test } from "bun:test";
import { createSerialPoller } from "@openteam/client-core";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("serial mobile poller", () => {
  test("never overlaps a slow task and schedules only after completion", async () => {
    const first = deferred();
    const scheduled: Array<() => void> = [];
    let calls = 0;
    const poller = createSerialPoller({
      intervalMs: 2_500,
      task: async () => {
        calls += 1;
        if (calls === 1) await first.promise;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    });

    poller.start();
    poller.wake();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(0);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("stop cancels the queued request and start resumes immediately", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    let calls = 0;
    const poller = createSerialPoller({
      intervalMs: 2_500,
      task: async () => {
        calls += 1;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length as ReturnType<typeof setTimeout>;
      },
      cancel: (timer) => cancelled.push(timer),
    });

    poller.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    poller.stop();
    expect(cancelled).toHaveLength(1);

    poller.start();
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("keeps scheduling after a handled endpoint rejection", async () => {
    const scheduled: Array<() => void> = [];
    const poller = createSerialPoller({
      intervalMs: 2_500,
      task: async () => {
        throw new Error("offline");
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    });

    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    poller.stop();
  });
});
