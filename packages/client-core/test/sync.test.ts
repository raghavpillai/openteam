import { describe, expect, test } from "bun:test";
import type {
  ChannelClientState,
  ChannelHistoryPage,
  ClientBootstrapView,
  ProductEvent,
} from "@openteam/contracts";
import {
  TrailingAsyncCoalescer,
  createLiveSyncController,
  createReconnectingProductEventStream,
  type ProductEventHandlers,
} from "../src";
import {
  clientReadCoversCursor,
  type LiveSnapshotSyncOptions,
  synchronizeClientSnapshot,
} from "../src/sync";

describe("bounded live refresh coalescing", () => {
  test("refreshes during a continuous burst rather than waiting for silence", async () => {
    let refreshes = 0;
    const coalescer = new TrailingAsyncCoalescer(async () => {
      refreshes += 1;
    }, 15);
    const stream = setInterval(() => coalescer.trigger(), 2);
    try {
      await Bun.sleep(70);
      expect(refreshes).toBeGreaterThanOrEqual(2);
    } finally {
      clearInterval(stream);
      coalescer.cancel();
    }
  });

  test("never overlaps refreshes and preserves an update received during a slow read", async () => {
    const first = deferred();
    let calls = 0;
    let running = 0;
    let maximum = 0;
    const coalescer = new TrailingAsyncCoalescer(async () => {
      calls += 1;
      maximum = Math.max(maximum, ++running);
      if (calls === 1) await first.promise;
      running -= 1;
    }, 0);
    coalescer.trigger();
    await Bun.sleep(5);
    coalescer.trigger();
    coalescer.trigger();
    first.resolve();
    await coalescer.flush();
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    coalescer.cancel();
  });
});

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

const deferredValue = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bootstrap = (cursor = "10") =>
  ({ cursor, channels: [{ id: "chat" }] }) as ClientBootstrapView;
const history = (revision = "10") =>
  ({ channelId: "chat", revision, messages: [] }) as unknown as ChannelHistoryPage;
const state = (revision = "10") => ({ channelId: "chat", revision }) as ChannelClientState;
const harness = (overrides: Partial<LiveSnapshotSyncOptions> = {}) => {
  const accepted: string[] = [];
  const deferredWork: Array<Promise<unknown> | undefined> = [];
  const identity = {};
  const options: LiveSnapshotSyncOptions = {
    readBootstrap: async () => bootstrap(),
    readHistory: async () => history(),
    readState: async () => state(),
    activeChannel: () => "chat",
    historyIdentity: () => identity,
    pendingHistory: () => null,
    isCurrent: () => true,
    acceptBootstrap: () => {
      accepted.push("bootstrap");
      return true;
    },
    acceptHistory: () => {
      accepted.push("history");
    },
    acceptState: () => {
      accepted.push("state");
    },
    defer: (pending) => {
      deferredWork.push(pending);
    },
    ...overrides,
  };
  return { options, accepted, deferredWork };
};

describe("coherent live channel refresh", () => {
  test("rejects a page older than the last event without waiting for another event", async () => {
    const h = harness({ readHistory: async () => history("9") });
    expect(await synchronizeClientSnapshot(h.options)).toBe("deferred");
    expect(h.accepted).toEqual(["bootstrap"]);
    expect(h.deferredWork).toHaveLength(1);
    h.options.readHistory = async () => history("11");
    expect(await synchronizeClientSnapshot(h.options)).toBe("applied");
    expect(h.accepted.slice(-3)).toEqual(["bootstrap", "history", "state"]);
  });
  test("queues catch-up behind hydration instead of dropping the final message", async () => {
    const loading = deferredValue<void>();
    let pending: Promise<void> | null = loading.promise;
    let reads = 0;
    const h = harness({
      pendingHistory: () => pending,
      readBootstrap: async () => {
        reads += 1;
        return bootstrap();
      },
    });
    expect(await synchronizeClientSnapshot(h.options)).toBe("deferred");
    expect(h.deferredWork).toEqual([loading.promise]);
    expect(reads).toBe(1);
    expect(h.accepted).toEqual(["bootstrap"]);
    pending = null;
    loading.resolve();
    await loading.promise;
    expect(await synchronizeClientSnapshot(h.options)).toBe("applied");
    expect(h.accepted).toEqual(["bootstrap", "bootstrap", "history", "state"]);
  });
  test("does not overwrite a local history change that wins the in-flight race", async () => {
    const read = deferredValue<ChannelHistoryPage>();
    let identity = {};
    const h = harness({ historyIdentity: () => identity, readHistory: () => read.promise });
    const request = synchronizeClientSnapshot(h.options);
    identity = {};
    read.resolve(history());
    expect(await request).toBe("deferred");
    expect(h.accepted).toEqual(["bootstrap"]);
    expect(h.deferredWork).toHaveLength(1);
  });
  test("drops retired account results and does not retry a departed channel", async () => {
    const retired = harness({ isCurrent: () => false });
    expect(await synchronizeClientSnapshot(retired.options)).toBe("stale");
    expect(retired.accepted).toEqual([]);
    let active = "chat";
    const switched = harness({
      activeChannel: () => active,
      readHistory: async () => {
        active = "other";
        return history();
      },
    });
    expect(await synchronizeClientSnapshot(switched.options)).toBe("applied");
    expect(switched.accepted).toEqual(["bootstrap"]);
    expect(switched.deferredWork).toHaveLength(0);
  });
  test("requires fresh activity as well as history and retains bigint precision", async () => {
    const h = harness({ readState: async () => state("9") });
    expect(await synchronizeClientSnapshot(h.options)).toBe("deferred");
    expect(clientReadCoversCursor("9007199254740993", "9007199254740994")).toBe(false);
    expect(clientReadCoversCursor("9007199254740994", "9007199254740993")).toBe(true);
    expect(clientReadCoversCursor("invalid", "10")).toBe(false);
  });
  test("transport failures remain retryable rather than silently accepting a partial snapshot", async () => {
    const h = harness({
      readHistory: async () => {
        throw new Error("offline");
      },
    });
    await expect(synchronizeClientSnapshot(h.options)).rejects.toThrow("offline");
    expect(h.accepted).toEqual([]);
  });
});
