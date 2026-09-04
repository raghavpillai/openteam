import { describe, expect, test } from "bun:test";
import type {
  ChannelClientState,
  ChannelHistoryPage,
  ClientBootstrapView,
} from "@openteam/contracts";
import {
  clientReadCoversCursor,
  type LiveSnapshotSyncOptions,
  synchronizeClientSnapshot,
} from "../src/sync";

const deferred = <T>() => {
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
    const loading = deferred<void>();
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
    const read = deferred<ChannelHistoryPage>();
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
