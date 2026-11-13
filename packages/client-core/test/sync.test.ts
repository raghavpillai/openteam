import { describe, expect, test } from "bun:test";
import type { ChannelClientState, ChannelHistoryPage, ClientBootstrapView, ProductEvent } from "@openteam/contracts";
import type { ScreenStatusView } from "@openteam/contracts";
import { TrailingAsyncCoalescer, createReconnectingProductEventStream, createScreenSessionController, type ProductEventHandlers } from "../src";
import { createComputerControlController, ownsComputerControl } from "../src/computer-control";
import { type LiveSnapshotSyncOptions, synchronizeClientSnapshot } from "../src/sync";

describe("bounded live refresh coalescing", () => {
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

const deferred = <T = void,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
};

const event = (sequence: string): ProductEvent => ({ sequence, topic: "channel.message.accepted", entityId: "message-1", payload: {}, createdAt: "2026-09-01T00:00:00.000Z" });

const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

describe("shared reconnecting product event stream", () => {
  test("reconnects from the latest committed cursor and resets backoff after opening", async () => {
    const attempts: Array<{
      after: string;
      handlers: ProductEventHandlers;
      pending: ReturnType<typeof deferred<void>>;
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
});

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
    acceptBootstrap: () => { accepted.push("bootstrap"); return true; },
    acceptHistory: () => { accepted.push("history"); },
    acceptState: () => { accepted.push("state"); },
    defer: (pending) => { deferredWork.push(pending); },
    ...overrides,
  };
  return { options, accepted, deferredWork };
};

describe("coherent live channel refresh", () => {
  test("queues catch-up behind hydration instead of dropping the final message", async () => {
    const loading = deferred();
    let pending: Promise<void> | null = loading.promise;
    let reads = 0;
    const h = harness({
      pendingHistory: () => pending,
      readBootstrap: async () => { reads += 1; return bootstrap(); },
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
});

describe("shared screen session controller", () => {
  test("polls only while active and releases takeover on suspension", async () => {
    let polls = 0;
    const requests: boolean[] = [];
    const results: boolean[] = [];
    const controller = createScreenSessionController({
      pollIntervalMs: 60_000,
      heartbeatMs: 60_000,
      pollStatus: async () => { polls += 1; },
      requestTakeover: async (active) => { requests.push(active); return { humanTakeover: active }; },
      onTakeoverResult: (result) => results.push(result.humanTakeover),
    });

    controller.activate();
    await Promise.resolve();
    expect(polls).toBe(1);
    controller.setTakeover(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([true]);
    expect(results).toEqual([true]);

    controller.deactivate();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([true, false]);
    controller.wake();
    await Promise.resolve();
    expect(polls).toBe(1);
    controller.stop();
  });
});

const status = (id: string | null, generation = 1) =>
  ({ humanTakeover: !!id, controlSession: id ? { id, generation } : null }) as ScreenStatusView;
test("watching a different owner never releases their session", async () => {
  let calls = 0;
  const c = createComputerControlController("ios", async () => { calls++; return status(null); });
  c.open();
  c.observe(status("desktop"));
  await c.close();
  expect(calls).toBe(0);
  expect(ownsComputerControl(status("desktop"), "ios")).toBe(false);
});
