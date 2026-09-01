import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MAX_THREAD_CONTEXT_MESSAGES,
  normalizeHistoryLimit,
  normalizeMessageContextExtent,
  SnapshotService,
  selectBoundedActivity,
} from "../src/services/snapshot-service";

type RawQuery = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

const rawSql = (query: RawQuery): string => query.strings?.join("?") ?? String(query);

const requireRawQuery = (query: RawQuery | null, name: string): RawQuery => {
  if (query === null) throw new Error(`${name} SQL was not executed`);
  return query;
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

  test("prioritizes current state while enforcing a hard response cap", () => {
    const row = (id: string, createdAt: number) => ({ id, createdAt: new Date(createdAt) });
    const selected = selectBoundedActivity(
      [row("current-2", 2), row("current-1", 1)],
      [row("recent-3", 3), row("recent-2", 2), row("recent-1", 1)],
      3
    );

    expect(selected.items.map(({ id }) => id)).toEqual(["current-1", "current-2", "recent-3"]);
    expect(selected.truncated).toBe(true);
  });

  test("keeps the history cursor contiguous while supplying an older thread-root chain", async () => {
    const channelId = "00000000-0000-0000-0000-000000000010";
    const message = (sequence: number, metadata: Record<string, unknown> = {}) => ({
      id: `00000000-0000-0000-0000-${String(sequence).padStart(12, "0")}`,
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
        expect(rawSql(query)).toContain("WITH RECURSIVE");
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

  test("does not reload a reply target that is already in the requested window", async () => {
    const channelId = "00000000-0000-0000-0000-000000000015";
    const rootId = "00000000-0000-0000-0000-000000000016";
    const replyId = "00000000-0000-0000-0000-000000000017";
    const rows = [
      {
        id: rootId,
        sequence: 1n,
        channelId,
        sender: "user",
        senderBotId: null,
        sourceRunId: null,
        content: "root",
        metadata: {},
        createdAt: new Date(1_000),
      },
      {
        id: replyId,
        sequence: 2n,
        channelId,
        sender: "user",
        senderBotId: null,
        sourceRunId: null,
        content: "reply",
        metadata: { branched: true, replyTo: rootId },
        createdAt: new Date(2_000),
      },
    ];
    let rawQueryCount = 0;
    const service = new SnapshotService(
      {
        channel: { findFirst: async () => ({ id: channelId }) },
        channelMessage: { findMany: async () => [...rows].reverse() },
        event: { findFirst: async () => ({ sequence: 2n }) },
        $queryRaw: async () => {
          rawQueryCount += 1;
          return [];
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const page = await Effect.runPromise(service.history(channelId, null, 2));
    expect(page.messages.map(({ id }) => id)).toEqual([rootId, replyId]);
    expect(page.threadContext).toEqual([]);
    expect(rawQueryCount).toBe(0);
  });

  test("loads a pathological deep thread with one bounded database query", async () => {
    const channelId = "00000000-0000-0000-0000-000000000020";
    const message = (sequence: number, replyTo: string | null = null) => ({
      id: `00000000-0000-0000-0001-${String(sequence).padStart(12, "0")}`,
      sequence: BigInt(sequence),
      channelId,
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      content: `message ${sequence}`,
      metadata: replyTo === null ? {} : { branched: true, replyTo },
      createdAt: new Date(sequence * 1_000),
    });
    const ancestors = Array.from({ length: MAX_THREAD_CONTEXT_MESSAGES + 1 }, (_, index) => {
      const sequence = MAX_THREAD_CONTEXT_MESSAGES + 1 - index;
      return message(
        sequence,
        sequence === 1 ? null : `00000000-0000-0000-0001-${String(sequence - 1).padStart(12, "0")}`
      );
    });
    const firstAncestor = ancestors[0];
    if (!firstAncestor) throw new Error("invalid deep-thread fixture");
    const loaded = message(102, firstAncestor.id);
    let rawQueryCount = 0;
    let threadSql = "";
    const service = new SnapshotService(
      {
        channel: { findFirst: async () => ({ id: channelId }) },
        channelMessage: {
          findMany: async () => [loaded],
        },
        event: { findFirst: async () => ({ sequence: 500n }) },
        $queryRaw: async (query: RawQuery) => {
          rawQueryCount += 1;
          threadSql = rawSql(query);
          return ancestors.map((row, index) => ({
            ...row,
            traversalDepth: index + 1,
            seedOrder: 1,
          }));
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const page = await Effect.runPromise(service.history(channelId, null, 1));

    expect(rawQueryCount).toBe(1);
    expect(page.threadContext).toHaveLength(MAX_THREAD_CONTEXT_MESSAGES);
    expect(page.threadContext[0]?.sequence).toBe("2");
    expect(page.threadContext.at(-1)?.sequence).toBe("101");
    expect(page.threadContextTruncated).toBe(true);
    expect(threadSql).toContain(`current."traversalDepth" < ?`);
    expect(threadSql).toContain('NOT (parent."id" = ANY(current.path))');
    expect(threadSql).toContain('parent."id" = current."replyToId"');
    expect(threadSql).not.toContain('parent."id"::text');
    expect(threadSql).toContain("LIMIT ?");
  });

  test("orders shared ancestors and terminates cycles or missing parents", async () => {
    const channelId = "00000000-0000-0000-0000-000000000030";
    const message = (sequence: number, replyTo: string | null = null) => ({
      id: `00000000-0000-0000-0002-${String(sequence).padStart(12, "0")}`,
      sequence: BigInt(sequence),
      channelId,
      sender: "agent",
      senderBotId: null,
      sourceRunId: null,
      content: `message ${sequence}`,
      metadata: replyTo === null ? {} : { branched: true, replyTo },
      createdAt: new Date(sequence * 1_000),
    });
    const second = message(2);
    const third = message(3, second.id);
    second.metadata = { branched: true, replyTo: third.id };
    const loaded = message(4, third.id);
    let cycleQueries = 0;
    const cycleService = new SnapshotService(
      {
        channel: { findFirst: async () => ({ id: channelId }) },
        channelMessage: { findMany: async () => [loaded] },
        event: { findFirst: async () => ({ sequence: 4n }) },
        $queryRaw: async () => {
          cycleQueries += 1;
          return [
            { ...third, traversalDepth: 1, seedOrder: 1 },
            { ...second, traversalDepth: 2, seedOrder: 1 },
          ];
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const cyclePage = await Effect.runPromise(cycleService.history(channelId, null, 1));
    expect(cycleQueries).toBe(1);
    expect(cyclePage.threadContext.map(({ sequence }) => sequence)).toEqual(["2", "3"]);
    expect(cyclePage.threadContextTruncated).toBe(false);

    const missing = message(5, "00000000-0000-0000-0002-999999999999");
    let missingQueries = 0;
    const missingService = new SnapshotService(
      {
        channel: { findFirst: async () => ({ id: channelId }) },
        channelMessage: { findMany: async () => [missing] },
        event: { findFirst: async () => ({ sequence: 5n }) },
        $queryRaw: async () => {
          missingQueries += 1;
          return [];
        },
      } as never,
      "/workspace",
      "http://computer",
      () => true
    );

    const missingPage = await Effect.runPromise(missingService.history(channelId, null, 1));
    expect(missingQueries).toBe(1);
    expect(missingPage.threadContext).toEqual([]);
    expect(missingPage.threadContextTruncated).toBe(false);
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

  test("keeps profile, avatar, read, and unread bootstrap fields with array-backed SQL", async () => {
    const botId = "00000000-0000-0000-0000-000000000040";
    const channelId = "00000000-0000-0000-0000-000000000041";
    const conversationId = "00000000-0000-0000-0000-000000000042";
    const now = new Date("2026-08-31T12:00:00.000Z");
    const bot = {
      id: botId,
      name: "Profile bot",
      title: "Performance engineer",
      description: "Keeps the original profile fields",
      instructions: "Measure first",
      icon: "●",
      color: "#336699",
      notificationsEnabled: false,
      hiddenFromSidebar: false,
      avatarPath: "/avatars/profile.png",
      defaultDirectory: "/workspace/bots/profile",
      status: "ready",
      onboardingStatus: "complete",
      onboardingVersion: 2,
      onboardingCompletedAt: now,
      provisioningError: null,
      createdAt: now,
      updatedAt: now,
      conversation: { id: conversationId },
      channelMemberships: [
        { channelId, channel: { id: channelId, kind: "bot_dm", archivedAt: null } },
      ],
    };
    const channel = {
      id: channelId,
      kind: "bot_dm",
      name: "Profile bot",
      description: "Direct channel description",
      avatarPath: "/avatars/channel.png",
      directKey: `bot:${botId}`,
      workingDirectory: "/workspace/bots/profile",
      members: [{ botId, ordinal: 0 }],
      createdAt: now,
      updatedAt: now,
    };
    const latestMessage = {
      id: "00000000-0000-0000-0000-000000000043",
      sequence: 43n,
      channelId,
      sender: "agent",
      senderBotId: botId,
      sourceRunId: null,
      content: "Latest visible response",
      metadata: {},
      createdAt: now,
    };
    let latestQuery: RawQuery | null = null;
    let unreadQuery: RawQuery | null = null;
    const service = new SnapshotService(
      {
        bot: { findMany: async () => [bot] },
        channel: { findMany: async () => [channel] },
        event: { findFirst: async () => ({ sequence: 43n }) },
        run: { findMany: async () => [] },
        channelRound: { findMany: async () => [] },
        subagentAttempt: { findMany: async () => [] },
        approval: { findMany: async () => [] },
        $queryRaw: async (query: RawQuery) => {
          const sql = rawSql(query);
          if (sql.includes("CROSS JOIN LATERAL")) {
            latestQuery = query;
            return [latestMessage];
          }
          unreadQuery = query;
          return [{ channelId, unreadCount: 3 }];
        },
      } as never,
      "/workspace",
      "http://127.0.0.1:1",
      () => true
    );

    const bootstrap = await Effect.runPromise(service.bootstrap());

    expect(bootstrap.bots[0]).toMatchObject({
      id: botId,
      title: "Performance engineer",
      description: "Keeps the original profile fields",
      hasAvatar: true,
      notificationsEnabled: false,
      conversationId,
      dmChannelId: channelId,
    });
    expect(bootstrap.channels[0]).toMatchObject({
      id: channelId,
      description: "Direct channel description",
      hasAvatar: true,
      unreadCount: 3,
      members: [{ botId, ordinal: 0 }],
    });
    expect(bootstrap.latestMessages[0]).toMatchObject({
      id: latestMessage.id,
      sequence: "43",
      content: "Latest visible response",
    });

    const capturedLatestQuery = requireRawQuery(latestQuery, "latest-message");
    const capturedUnreadQuery = requireRawQuery(unreadQuery, "unread-count");
    expect(rawSql(capturedLatestQuery)).toContain("unnest(?::uuid[])");
    expect(rawSql(capturedLatestQuery)).toContain('ORDER BY message."sequence" DESC');
    expect(capturedLatestQuery.values).toEqual([[channelId]]);
    expect(rawSql(capturedUnreadQuery)).toContain('LEFT JOIN "ChannelReadState"');
    expect(rawSql(capturedUnreadQuery)).toContain(
      'message."sequence" > COALESCE(state."lastReadSequence", 0)'
    );
    expect(rawSql(capturedUnreadQuery)).toContain("= ANY(?::uuid[])");
    expect(capturedUnreadQuery.values).toEqual([[channelId]]);
  });

  test("rejects future event cursors instead of leaving the stream permanently idle", async () => {
    const service = new SnapshotService(
      {
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
