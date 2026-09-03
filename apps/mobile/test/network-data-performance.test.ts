import { describe, expect, test } from "bun:test";
import {
  CommittedEventCursor,
  LIVE_SYNC_FALLBACK_MS,
  MAX_PARALLEL_UPLOADS,
  mapWithConcurrency,
  TrailingAsyncCoalescer,
} from "@openteam/client-core";
import type { ChannelClientState, ClientSnapshot } from "@openteam/contracts";
import {
  boundedSnapshotForCache,
  MAX_CACHED_MESSAGES_PER_CHANNEL,
  MAX_INACTIVE_HISTORY_CHANNELS,
  mergeBootstrapWithHistory,
  mergeChannelMessages,
  mergeChannelState,
  reconcileActiveHistoryRefresh,
  trimInactiveHistories,
} from "@openteam/product-core/history";
import { mobileFixture } from "../src/fixtures";
import { uploadNativeAsset } from "../src/native-asset-upload";

const scaledSnapshot = (channels: number, messagesPerChannel: number): ClientSnapshot => ({
  ...mobileFixture,
  cursor: "1000",
  bots: [],
  channels: Array.from({ length: channels }, (_, channelIndex) => ({
    id: `channel-${channelIndex}`,
    kind: "group" as const,
    name: `Channel ${channelIndex}`,
    description: "",
    hasAvatar: false,
    unreadCount: 0,
    lastReadSequence: "0",
    directKey: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    members: [],
  })),
  channelMessages: Array.from({ length: channels * messagesPerChannel }, (_, index) => {
    const channelIndex = Math.floor(index / messagesPerChannel);
    const sequence = (index + 1).toString();
    return {
      id: `message-${index}`,
      sequence,
      channelId: `channel-${channelIndex}`,
      sender: "agent" as const,
      senderBotId: null,
      sourceRunId: null,
      content: `message ${sequence}`,
      metadata: {},
      createdAt: new Date(index * 1_000).toISOString(),
    };
  }),
});

describe("mobile networking/data performance", () => {
  test("latest-page sync does not rewind active history pagination", () => {
    expect(
      reconcileActiveHistoryRefresh(
        { beforeSequence: "80", hasMore: true, loading: false },
        { beforeSequence: "280", hasMore: true, loading: false }
      )
    ).toEqual({ beforeSequence: "80", hasMore: true, loading: false });
    expect(
      reconcileActiveHistoryRefresh(
        { beforeSequence: "1", hasMore: false, loading: true },
        { beforeSequence: "280", hasMore: true, loading: false }
      )
    ).toEqual({ beforeSequence: "1", hasMore: false, loading: true });
    expect(
      reconcileActiveHistoryRefresh(undefined, {
        beforeSequence: "280",
        hasMore: true,
        loading: false,
      })
    ).toEqual({ beforeSequence: "280", hasMore: true, loading: false });
  });

  test("coalesces a 100-event burst into one authoritative reconciliation", async () => {
    let reconciliations = 0;
    const coalescer = new TrailingAsyncCoalescer(async () => {
      reconciliations += 1;
    });

    for (let index = 0; index < 100; index += 1) coalescer.trigger();
    await coalescer.flush();

    expect(reconciliations).toBe(1);
    expect(60_000 / 2_000).toBe(30);
    expect(Math.floor(60_000 / LIVE_SYNC_FALLBACK_MS)).toBe(1);
  });

  test("never commits an observed event until bootstrap succeeds and permits rollback", () => {
    const cursor = new CommittedEventCursor();
    cursor.reset("40");
    cursor.observe("41");

    // A failed bootstrap leaves reconnect/replay anchored before event 41.
    expect(cursor.observedThrough()).toBe("41");
    expect(cursor.reconnectAfter()).toBe("40");
    expect(cursor.commit("40")).toBe(false);
    expect(cursor.reconnectAfter()).toBe("40");
    expect(cursor.commit("41")).toBe(true);
    expect(cursor.reconnectAfter()).toBe("41");

    // A restored server may legitimately be behind the cached cursor.
    cursor.reset("100");
    cursor.requireSnapshot("50");
    expect(cursor.commit("50")).toBe(true);
    expect(cursor.reconnectAfter()).toBe("50");
  });

  test("keeps only a small inactive-history LRU and bounds persisted pages", () => {
    const snapshot = scaledSnapshot(100, 300);
    const lru = ["channel-99", "channel-98", "channel-97"];
    const retained = trimInactiveHistories(snapshot, null, lru);
    const cached = boundedSnapshotForCache(snapshot, ["channel-99", ...lru]);
    const retainedCounts = new Map<string, number>();
    for (const message of retained.channelMessages) {
      retainedCounts.set(message.channelId, (retainedCounts.get(message.channelId) ?? 0) + 1);
    }

    expect([...retainedCounts.values()].filter((count) => count > 1)).toHaveLength(
      MAX_INACTIVE_HISTORY_CHANNELS
    );
    expect(retained.channelMessages).toHaveLength(97 + 3 * 120);
    expect(cached.channelMessages).toHaveLength(97 + 3 * MAX_CACHED_MESSAGES_PER_CHANNEL);
  });

  test("keeps an accepted message render key through authoritative message merges", () => {
    const original = mobileFixture.channelMessages[1];
    if (!original) throw new Error("Fixture message is missing");
    const accepted = {
      ...original,
      metadata: {
        clientDelivery: { renderKey: "optimistic-local-1", state: "accepted" },
        localOnly: true,
      },
    };
    const authoritative = {
      ...original,
      sequence: "200",
      content: "Authoritative content",
      metadata: { reactions: [{ by: "bot-research", emoji: "👍" }] },
    };

    const merged = mergeChannelMessages(
      { ...mobileFixture, channelMessages: [accepted] },
      original.channelId,
      [authoritative]
    ).channelMessages[0];

    expect(merged).toMatchObject({
      sequence: "200",
      content: "Authoritative content",
      metadata: {
        reactions: [{ by: "bot-research", emoji: "👍" }],
        clientDelivery: { renderKey: "optimistic-local-1", state: "accepted" },
      },
    });
    expect(merged?.metadata).not.toHaveProperty("localOnly");
  });

  test("keeps an accepted message render key through bootstrap refreshes", () => {
    const original = mobileFixture.channelMessages[1];
    if (!original) throw new Error("Fixture message is missing");
    const retained = {
      ...original,
      metadata: {
        clientDelivery: { renderKey: "optimistic-local-2", state: "accepted" },
      },
    };
    const bootstrapMessage = {
      ...original,
      content: "Bootstrap content",
      metadata: { serverField: true },
    };
    const bootstrap = {
      cursor: mobileFixture.cursor,
      workspace: mobileFixture.workspace,
      bots: mobileFixture.bots,
      channels: mobileFixture.channels,
      latestMessages: [bootstrapMessage],
      channelRounds: mobileFixture.channelRounds,
      activeRuns: mobileFixture.runs,
      pendingApprovals: mobileFixture.approvals,
      subagents: mobileFixture.subagents,
      runtime: mobileFixture.runtime,
      capabilities: {
        uploads: {
          maxAttachmentsPerMessage: 6,
          maxRegularBytes: 25 * 1024 * 1024,
          maxVideoBytes: 200 * 1024 * 1024,
        },
      },
    };

    const merged = mergeBootstrapWithHistory(
      bootstrap,
      { ...mobileFixture, channelMessages: [retained] },
      new Set([original.channelId])
    ).channelMessages.find((message) => message.id === original.id);

    expect(merged?.metadata).toMatchObject({
      clientDelivery: { renderKey: "optimistic-local-2", state: "accepted" },
    });
  });

  test("replaces one channel's run activity without dropping another retained channel", () => {
    const researchRun = mobileFixture.runs[0];
    const researchApproval = mobileFixture.approvals[0];
    if (!researchRun || !researchApproval) throw new Error("Fixture activity is missing");
    const opsRun = {
      ...researchRun,
      id: "run-ops",
      botId: "bot-ops",
      conversationId: "conversation-ops",
      channelId: "channel-ops",
    };
    const opsApproval = {
      ...researchApproval,
      id: "approval-ops",
      runId: opsRun.id,
      ownerConversationId: opsRun.conversationId,
      parentRunId: opsRun.id,
    };
    const nextRun = {
      ...researchRun,
      id: "run-research-next",
      status: "running" as const,
    };
    const state: ChannelClientState = {
      channelId: "channel-research",
      revision: "next",
      channelRounds: [],
      runs: [nextRun],
      runItems: [],
      approvals: [],
      subagents: [],
      truncated: {
        channelRounds: false,
        runs: false,
        runItems: false,
        approvals: false,
        subagents: false,
      },
    };

    const merged = mergeChannelState(
      { ...mobileFixture, runs: [researchRun, opsRun], approvals: [researchApproval, opsApproval] },
      state
    );

    expect(merged.runs.map((run) => run.id).sort()).toEqual(["run-ops", "run-research-next"]);
    expect(merged.approvals.map((approval) => approval.id)).toEqual(["approval-ops"]);
  });

  test("uploads from the native file path with auth, raw bytes, and alt preserved", async () => {
    const calls: Array<{ url: string; options: unknown }> = [];
    const asset = {
      assetId: "a".repeat(64),
      fileName: "camera.png",
      mimeType: "image/png",
      byteSize: 12,
      kind: "image" as const,
    };
    const file = {
      createUploadTask: (url: string, options?: unknown) => ({
        uploadAsync: async () => {
          calls.push({ url, options });
          return { body: JSON.stringify(asset), status: 201, headers: {} };
        },
      }),
    };

    await expect(
      uploadNativeAsset({
        serverUrl: "https://openteam.test",
        file,
        fileName: "camera.png",
        mimeType: "image/png",
        alt: "Camera photo",
        authToken: "session-token",
      })
    ).resolves.toEqual({ ...asset, alt: "Camera photo" });
    expect(calls).toEqual([
      {
        url: "https://openteam.test/api/v0/assets",
        options: {
          httpMethod: "POST",
          headers: {
            authorization: "Bearer session-token",
            "content-type": "image/png",
            "x-file-name": "camera.png",
          },
          mimeType: "image/png",
          onProgress: undefined,
          sessionType: "foreground",
          signal: undefined,
        },
      },
    ]);
  });

  test("limits simultaneous native uploads while preserving selection order", async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapWithConcurrency(
      Array.from({ length: 6 }, (_, index) => index),
      MAX_PARALLEL_UPLOADS,
      async (index) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return index * 2;
      }
    );

    expect(maximum).toBe(MAX_PARALLEL_UPLOADS);
    expect(values).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
