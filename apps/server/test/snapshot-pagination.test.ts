import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MAX_THREAD_CONTEXT_MESSAGES, normalizeHistoryLimit, normalizeMessageContextExtent, SnapshotService } from "../src/services/snapshot-service";

type RawQuery = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

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

  test("client state carries run items only for queued or running runs", async () => {
    const channelId = "00000000-0000-0000-0000-000000000020";
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds));
    const run = (id: string, status: string, seconds: number) => ({
      id,
      botId: "bot-1",
      channelId,
      status,
      createdAt: at(seconds),
      updatedAt: at(seconds),
    });
    const item = (id: string, runId: string, seconds: number) => ({
      id,
      runId,
      kind: "tool",
      createdAt: at(seconds),
      updatedAt: at(seconds),
    });
    const running = run("run-active", "running", 2);
    const finished = run("run-finished", "completed", 1);
    const waiting = { ...run("request-waiting", "completed", 0), requestProgress: { state: "waiting", evidence: ["private evidence"] }, requestNextCheckAt: at(3600) };
    const itemQueries: string[][] = [];
    const service = new SnapshotService(
      {
        channel: { findFirst: async () => ({ id: channelId }) },
        channelRound: { findMany: async () => [] },
        run: {
          findMany: async ({ where }: any) =>
            where.OR ? [waiting, running] : [finished],
        },
        subagentAttempt: { findMany: async () => [] },
        event: { findFirst: async () => ({ sequence: 7n }) },
        runItem: {
          findMany: async ({ where }: { where: { runId: { in: string[] } } }) => {
            itemQueries.push(where.runId.in);
            return [
              item("item-active", "run-active", 3),
              item("item-finished", "run-finished", 1),
            ].filter((candidate) => where.runId.in.includes(candidate.runId));
          },
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const state = await Effect.runPromise(service.channelState(channelId));

    expect(state.runs.map(({ id }) => id)).toEqual(["request-waiting", "run-finished", "run-active"]);
    expect(state.runs[0]?.requestState).toBe("waiting");
    expect(JSON.stringify(state)).not.toContain("private evidence");
    expect(itemQueries).toEqual([["run-active"]]);
    expect(state.runItems.map(({ id }) => id)).toEqual(["item-active"]);
    expect(state.truncated.runItems).toBe(false);
  });

  test("keeps the history cursor contiguous while supplying an older thread-root chain", async () => {
    const channelId = "00000000-0000-0000-0000-000000000010";
    const message = (sequence: number, metadata: Record<string, unknown> = {}) => ({
      id: `00000000-0000-0000-0000-${String(sequence).padStart(12, "0")}`,
      clientId: `send-${sequence}`,
      sequence: BigInt(sequence),
      channelId,
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      content: `message ${sequence}`,
      metadata,
      createdAt: new Date(sequence * 1_000),
    });
    const rows = [
      message(1),
      message(2, {
        branched: true,
        replyTo: "00000000-0000-0000-0000-000000000001",
      }),
      ...Array.from({ length: 7 }, (_, index) => message(index + 3)),
      message(10, {
        branched: true,
        replyTo: "00000000-0000-0000-0000-000000000002",
      }),
    ];
    const rootMessage = rows[0];
    const replyMessage = rows[1];
    const targetMessage = rows[9];
    if (!rootMessage || !replyMessage || !targetMessage) throw new Error("invalid test fixture");
    const findMany = async (input: {
      where: {
        channelId: string;
        sequence?: { lt?: bigint; gt?: bigint };
        id?: { in: string[] };
      };
      orderBy?: { sequence: "asc" | "desc" };
      take?: number;
    }) => {
      let matches = rows.filter((row) => row.channelId === input.where.channelId);
      const beforeSequence = input.where.sequence?.lt;
      if (beforeSequence !== undefined) {
        matches = matches.filter((row) => row.sequence < beforeSequence);
      }
      const afterSequence = input.where.sequence?.gt;
      if (afterSequence !== undefined) {
        matches = matches.filter((row) => row.sequence > afterSequence);
      }
      if (input.where.id) {
        const ids = new Set(input.where.id.in);
        matches = matches.filter((row) => ids.has(row.id));
      }
      if (input.orderBy?.sequence === "desc") matches.reverse();
      return input.take === undefined ? matches : matches.slice(0, input.take);
    };
    let threadQueries = 0;
    const prisma = {
      channel: { findFirst: async () => ({ id: channelId }) },
      channelMessage: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          rows.find((row) => row.id === where.id) ?? null,
        findMany,
      },
      event: { findFirst: async () => ({ sequence: 42n }) },
      $queryRaw: async (query: RawQuery) => {
        threadQueries += 1;
        expect(query.values?.[0]).toBe(channelId);
        expect(query.values?.[2]).toEqual([replyMessage.id]);
        return [
          { ...replyMessage, traversalDepth: 1, seedOrder: 1 },
          { ...rootMessage, traversalDepth: 2, seedOrder: 1 },
        ];
      },
    };
    const service = new SnapshotService(
      prisma as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const page = await Effect.runPromise(service.history(channelId, null, 2));

    expect(page.messages.map(({ sequence }) => sequence)).toEqual(["9", "10"]);
    expect(page.beforeSequence).toBe("9");
    expect(page.threadContext.map(({ sequence }) => sequence)).toEqual(["1", "2"]);
    expect(page.threadContext.map(({ clientId }) => clientId)).toEqual(["send-1", "send-2"]);
    expect(page.threadContextTruncated).toBe(false);
    expect(page.messages.length + page.threadContext.length).toBeLessThanOrEqual(
      2 + MAX_THREAD_CONTEXT_MESSAGES
    );
    expect(threadQueries).toBe(1);

    const context = await Effect.runPromise(service.messageContext(targetMessage.id, 1, 1));
    expect(context).toMatchObject({
      targetMessageId: targetMessage.id,
      beforeSequence: "9",
      afterSequence: "10",
      hasMoreBefore: true,
      hasMoreAfter: false,
      threadContextTruncated: false,
    });
    expect(context.messages.map(({ sequence }) => sequence)).toEqual(["9", "10"]);
    expect(context.threadContext.map(({ sequence }) => sequence)).toEqual(["1", "2"]);
    expect(threadQueries).toBe(2);

    const afterContext = await Effect.runPromise(service.messageContext(rootMessage.id, 0, 2));
    expect(afterContext).toMatchObject({
      targetMessageId: rootMessage.id,
      beforeSequence: "1",
      afterSequence: "3",
      hasMoreBefore: false,
      hasMoreAfter: true,
    });
    expect(afterContext.messages.map(({ sequence }) => sequence)).toEqual(["1", "2", "3"]);
    expect(afterContext.threadContext).toEqual([]);
    expect(threadQueries).toBe(2);
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

  test("shares one bootstrap load across overlapping client refreshes", async () => {
    const cursorStarted = deferred<void>();
    const releaseCursor = deferred<void>();
    let cursorReads = 0;
    const service = new SnapshotService(
      {
        notificationPresence: { findMany: async () => [] },
        notificationPreferences: { findUnique: async () => null },
        event: {
          findFirst: async () => {
            cursorReads += 1;
            cursorStarted.resolve();
            await releaseCursor.promise;
            return { sequence: 52n };
          },
        },
        bot: { findMany: async () => [] },
        channel: { findMany: async () => [] },
        run: { findMany: async () => [] },
        channelRound: { findMany: async () => [] },
        subagentAttempt: { findMany: async () => [] },
        approval: { findMany: async () => [] },
      } as never,
      "/workspace",
      "http://127.0.0.1:1",
      () => true
    );

    const first = Effect.runPromise(service.bootstrap());
    await cursorStarted.promise;
    const second = Effect.runPromise(service.bootstrap());
    await Promise.resolve();

    expect(cursorReads).toBe(1);
    releaseCursor.resolve();
    const [firstBootstrap, secondBootstrap] = await Promise.all([first, second]);
    expect(firstBootstrap).toBe(secondBootstrap);
    expect(firstBootstrap.cursor).toBe("52");
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
