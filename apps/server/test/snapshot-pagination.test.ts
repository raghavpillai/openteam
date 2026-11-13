import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { normalizeHistoryLimit, normalizeMessageContextExtent, SnapshotService } from "../src/services/snapshot-service";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe("snapshot pagination", () => {
  test("uses a bounded default and clamps hostile limits", () => {
    expect(normalizeHistoryLimit(Number.NaN)).toBe(100);
    expect(normalizeHistoryLimit(0)).toBe(1);
    expect(normalizeHistoryLimit(50.9)).toBe(50);
    expect(normalizeHistoryLimit(10_000)).toBe(200);
    expect(normalizeMessageContextExtent(Number.NaN)).toBe(50);
    expect(normalizeMessageContextExtent(-1)).toBe(0);
    expect(normalizeMessageContextExtent(10_000)).toBe(100);
  });

  test("captures the replay cursor before starting bootstrap projection queries", async () => {
    const cursorStarted = deferred<void>();
    const cursorRead = deferred<{ sequence: bigint } | null>();
    const projectionsStarted = deferred<void>();
    const botsRead = deferred<never[]>();
    const channelsRead = deferred<never[]>();
    const queryOrder: string[] = [];
    let projectionCount = 0;
    const recordProjectionStart = (name: string) => {
      queryOrder.push(name);
      projectionCount += 1;
      if (projectionCount === 2) projectionsStarted.resolve();
    };
    const replayEvents: Array<{
      sequence: bigint;
      topic: string;
      entityId: string;
      payload: Record<string, unknown>;
      createdAt: Date;
    }> = [];
    const service = new SnapshotService(
      {
        notificationPresence: { findMany: async () => [] },
        notificationPreferences: { findUnique: async () => null },
        event: {
          findFirst: () => {
            queryOrder.push("cursor");
            cursorStarted.resolve();
            return cursorRead.promise;
          },
          aggregate: async () => ({
            _min: { sequence: replayEvents[0]?.sequence ?? null },
            _max: { sequence: replayEvents.at(-1)?.sequence ?? null },
          }),
          findMany: async ({ where }: { where: { sequence: { gt: bigint } } }) =>
            replayEvents.filter((event) => event.sequence > where.sequence.gt),
        },
        bot: {
          findMany: () => {
            recordProjectionStart("bots");
            return botsRead.promise;
          },
        },
        channel: {
          findMany: () => {
            recordProjectionStart("channels");
            return channelsRead.promise;
          },
        },
        run: { findMany: async () => [] },
        channelRound: { findMany: async () => [] },
        subagentAttempt: { findMany: async () => [] },
        approval: { findMany: async () => [] },
      } as never,
      "/workspace",
      "http://127.0.0.1:1",
      () => true
    );

    const bootstrapPromise = Effect.runPromise(service.bootstrap());
    await cursorStarted.promise;
    expect(queryOrder).toEqual(["cursor"]);

    cursorRead.resolve({ sequence: 40n });
    await projectionsStarted.promise;
    expect(queryOrder[0]).toBe("cursor");

    replayEvents.push({
      sequence: 41n,
      topic: "bot.updated",
      entityId: "00000000-0000-0000-0000-000000000041",
      payload: { name: "updated while bootstrap projections were reading" },
      createdAt: new Date("2026-08-31T12:00:01.000Z"),
    });
    botsRead.resolve([]);
    channelsRead.resolve([]);

    const bootstrap = await bootstrapPromise;
    expect(bootstrap.cursor).toBe("40");
    expect((await service.eventWindowAfter(BigInt(bootstrap.cursor))).events).toEqual([
      expect.objectContaining({ sequence: "41", topic: "bot.updated" }),
    ]);
  });

  test("rejects future event cursors instead of leaving the stream permanently idle", async () => {
    const service = new SnapshotService(
      {
        notificationPresence: { findMany: async () => [] },
        notificationPreferences: { findUnique: async () => null },
        event: {
          aggregate: async () => ({ _min: { sequence: 10n }, _max: { sequence: 20n } }),
          findMany: async () => [],
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    expect(await service.eventWindowAfter(21n)).toMatchObject({
      oldest: 10n,
      latest: 20n,
      cursorExpired: false,
      cursorAhead: true,
    });
    expect(await service.eventWindowAfter(20n)).toMatchObject({ cursorAhead: false });
  });
});
