import { describe, expect, test } from "bun:test";
import type { ProductEvent } from "@openbot/contracts";
import {
  createLiveSyncController,
  createReconnectingProductEventStream,
  type ProductEventHandlers,
} from "../src";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const event = (sequence: string): ProductEvent => ({
  sequence,
  topic: "channel.message.accepted",
  entityId: "message-1",
  payload: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("shared reconnecting product event stream", () => {
  test("reconnects from the latest committed cursor and resets backoff after opening", async () => {
    const attempts: Array<{
      after: string;
      handlers: ProductEventHandlers;
      pending: ReturnType<typeof deferred>;
      signal: AbortSignal;
    }> = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const received: string[] = [];
    const disconnects: unknown[] = [];
    let cursor = "40";
    const stream = createReconnectingProductEventStream({
      cursor: () => cursor,
      listen: (after, handlers, signal) => {
        const pending = deferred();
        attempts.push({ after, handlers, pending, signal });
        return pending.promise;
      },
      onEvent: (next) => received.push(next.sequence),
      onDisconnect: (cause) => disconnects.push(cause),
      delayForAttempt: (attempt) => 1_000 * 2 ** attempt,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    });

    stream.resume();
    await settle();
    expect(attempts[0]?.after).toBe("40");
    attempts[0]?.handlers.onOpen?.();
    attempts[0]?.handlers.onEvent(event("41"));
    cursor = "41";
    attempts[0]?.pending.resolve();
    await settle();

    expect(received).toEqual(["41"]);
    expect(disconnects).toEqual([undefined]);
    expect(scheduled[0]?.delay).toBe(1_000);

    scheduled.shift()?.callback();
    await settle();
    expect(attempts[1]?.after).toBe("41");
    attempts[1]?.pending.reject(new Error("offline"));
    await settle();
    expect(scheduled[0]?.delay).toBe(2_000);
  });

  test("pause cancels reconnects, aborts the active request, and drops stale callbacks", async () => {
    const attempts: Array<{
      handlers: ProductEventHandlers;
      pending: ReturnType<typeof deferred>;
      signal: AbortSignal;
    }> = [];
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const received: string[] = [];
    const stream = createReconnectingProductEventStream({
      cursor: () => "0",
      listen: (_after, handlers, signal) => {
        const pending = deferred();
        attempts.push({ handlers, pending, signal });
        return pending.promise;
      },
      onEvent: (next) => received.push(next.sequence),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (timer) => cancelled.push(timer),
    });

    stream.resume();
    await settle();
    stream.pause();
    expect(attempts[0]?.signal.aborted).toBe(true);
    attempts[0]?.handlers.onEvent(event("1"));
    attempts[0]?.pending.resolve();
    await settle();
    expect(received).toEqual([]);
    expect(scheduled).toHaveLength(0);

    stream.resume();
    await settle();
    attempts[1]?.pending.resolve();
    await settle();
    expect(scheduled).toHaveLength(1);
    stream.pause();
    expect(cancelled).toHaveLength(1);
  });
});

describe("shared live sync controller", () => {
  test("owns event invalidation, foreground catch-up, health, and suspension policy", async () => {
    const attempts: Array<{
      handlers: ProductEventHandlers;
      pending: ReturnType<typeof deferred>;
      signal: AbortSignal;
    }> = [];
    const health: boolean[] = [];
    let synchronizations = 0;
    const liveSync = createLiveSyncController({
      cursor: () => "7",
      listen: (_after, handlers, signal) => {
        const pending = deferred();
        attempts.push({ handlers, pending, signal });
        return pending.promise;
      },
      synchronize: async () => {
        synchronizations += 1;
      },
      handleEvent: (next) => next.sequence === "8",
      onHealthChange: (healthy) => health.push(healthy),
      debounceMs: 0,
    });

    liveSync.setActive(true);
    await settle();
    attempts[0]?.handlers.onOpen?.();
    attempts[0]?.handlers.onEvent(event("8"));
    await Bun.sleep(5);
    expect(synchronizations).toBe(1);
    expect(health).toEqual([true]);

    liveSync.setActive(false);
    expect(attempts[0]?.signal.aborted).toBe(true);
    attempts[0]?.handlers.onEvent(event("8"));
    await Bun.sleep(5);
    expect(synchronizations).toBe(1);

    liveSync.setActive(true, true);
    await Bun.sleep(5);
    expect(synchronizations).toBe(2);
    liveSync.stop();
  });
});
