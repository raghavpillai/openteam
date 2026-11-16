import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { type EventStreamSource, eventStream, SSE_EVENT_BATCH_SIZE } from "../src/event-stream";
import { EventWakeup } from "../src/event-wakeup";
import { normalizeHistoryLimit, normalizeMessageContextExtent, SnapshotService } from "../src/services/snapshot-service";

const decoder = new TextDecoder();
const event = (sequence: number) => ({ sequence: String(sequence), topic: "message.created", entityId: `message-${sequence}`, payload: { sequence }, createdAt: "2026-08-31T00:00:00.000Z" });
const window = (fields: { oldest?: bigint | null; latest?: bigint | null; cursorExpired?: boolean; events?: ReturnType<typeof event>[] } = {}) =>
  ({ oldest: null, latest: null, cursorExpired: false, cursorAhead: false, events: [], ...fields });
const waitForAbort = (_version: number, _timeout: number, signal?: AbortSignal) =>
  new Promise<number>((resolve) => signal?.addEventListener("abort", () => resolve(0), { once: true }));

describe("pull-driven event stream", () => {
  test("fast readers receive every event in order across bounded windows", async () => {
    const allEvents = Array.from({ length: 130 }, (_, index) => event(index + 1));
    const limits: number[] = [];
    const source: EventStreamSource = {
      eventVersion: 0,
      eventWindowAfter: async (cursor, limit) => {
        limits.push(limit);
        return window({ oldest: 1n, latest: 130n, events: allEvents.filter((candidate) => BigInt(candidate.sequence) > cursor).slice(0, limit) });
      },
      waitForEvent: waitForAbort,
    };
    const reader = eventStream(source, 0n, new AbortController().signal).getReader();
    await reader.read();
    const sequences: number[] = [];
    while (sequences.length < allEvents.length)
      for (const match of decoder.decode((await reader.read()).value).matchAll(/^id: (\d+)$/gm)) sequences.push(Number(match[1]));
    await reader.cancel();
    expect(sequences).toEqual(allEvents.map((_, index) => index + 1));
    expect(limits.every((limit) => limit === SSE_EVENT_BATCH_SIZE)).toBe(true);
  });

  test("invalid cursors emit one snapshot.required product event", async () => {
    const source: EventStreamSource = { eventVersion: 0, eventWindowAfter: async () => window({ oldest: 10n, latest: 20n, cursorExpired: true }), waitForEvent: async (version) => version };
    const reader = eventStream(source, 2n, new AbortController().signal).getReader();
    await reader.read();
    const chunk = decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect(chunk).toContain("id: 20\n");
    expect(chunk).toContain('"topic":"snapshot.required"');
    expect(chunk).toContain('"reason":"cursor_expired"');
  });

  test("cancel aborts a pending event wait", async () => {
    let waitSignal: AbortSignal | undefined;
    const source: EventStreamSource = { eventVersion: 0, eventWindowAfter: async () => window(), waitForEvent: (version, timeout, signal) => { waitSignal = signal; return waitForAbort(version, timeout, signal); } };
    const reader = eventStream(source, 0n, new AbortController().signal).getReader();
    await reader.read();
    const pendingRead = reader.read();
    while (!waitSignal) await Bun.sleep(0);
    await reader.cancel();
    await pendingRead;
    expect(waitSignal?.aborted).toBe(true);
  });

  test("event wakeup does not lose a notification between query and wait", async () => {
    const wakeup = new EventWakeup("postgresql://unused");
    const observed = wakeup.currentVersion;
    wakeup.notify();
    expect(await wakeup.wait(observed, 10_000)).toBe(observed + 1);
  });
});

describe("snapshot pagination", () => {
  test("uses a bounded default and clamps hostile limits", () => {
    expect([Number.NaN, 0, 50.9, 10_000].map(normalizeHistoryLimit)).toEqual([100, 1, 50, 200]);
    expect([Number.NaN, -1, 10_000].map(normalizeMessageContextExtent)).toEqual([50, 0, 100]);
  });

  test("captures the replay cursor before starting bootstrap projection queries, and rejects future cursors", async () => {
    const cursorStarted = Promise.withResolvers<void>(), cursorRead = Promise.withResolvers<{ sequence: bigint } | null>();
    const projectionsStarted = Promise.withResolvers<void>(), botsRead = Promise.withResolvers<never[]>(), channelsRead = Promise.withResolvers<never[]>();
    const queryOrder: string[] = [];
    const projection = (name: string, read: Promise<never[]>) => () => {
      queryOrder.push(name);
      if (queryOrder.length === 3) projectionsStarted.resolve();
      return read;
    };
    const replayEvents: Array<{ sequence: bigint; topic: string; entityId: string; payload: Record<string, unknown>; createdAt: Date }> = [];
    let bounds: { min: bigint | null; max: bigint | null } | null = null;
    const service = new SnapshotService({
      notificationPresence: { findMany: async () => [] },
      notificationPreferences: { findUnique: async () => null },
      event: {
        findFirst: () => { queryOrder.push("cursor"); cursorStarted.resolve(); return cursorRead.promise; },
        aggregate: async () => ({ _min: { sequence: bounds?.min ?? replayEvents[0]?.sequence ?? null }, _max: { sequence: bounds?.max ?? replayEvents.at(-1)?.sequence ?? null } }),
        findMany: async ({ where }: { where: { sequence: { gt: bigint } } }) => replayEvents.filter((event) => event.sequence > where.sequence.gt),
      },
      bot: { findMany: projection("bots", botsRead.promise) },
      channel: { findMany: projection("channels", channelsRead.promise) },
      run: { findMany: async () => [] },
      channelRound: { findMany: async () => [] },
      subagentAttempt: { findMany: async () => [] },
      approval: { findMany: async () => [] },
    } as never, "/workspace", "http://127.0.0.1:1", () => true);

    const bootstrapPromise = Effect.runPromise(service.bootstrap());
    await cursorStarted.promise;
    expect(queryOrder).toEqual(["cursor"]);
    cursorRead.resolve({ sequence: 40n });
    await projectionsStarted.promise;
    replayEvents.push({ sequence: 41n, topic: "bot.updated", entityId: "00000000-0000-0000-0000-000000000041", payload: {}, createdAt: new Date() });
    botsRead.resolve([]);
    channelsRead.resolve([]);
    const bootstrap = await bootstrapPromise;
    expect(bootstrap.cursor).toBe("40");
    expect((await service.eventWindowAfter(BigInt(bootstrap.cursor))).events).toEqual([expect.objectContaining({ sequence: "41", topic: "bot.updated" })]);
    // A cursor past the newest event must not leave the stream permanently idle.
    bounds = { min: 10n, max: 20n };
    expect(await service.eventWindowAfter(21n)).toMatchObject({ oldest: 10n, latest: 20n, cursorExpired: false, cursorAhead: true });
    expect(await service.eventWindowAfter(20n)).toMatchObject({ cursorAhead: false });
  });
});
