import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  activityContentSummary,
  attachmentByteLimit,
  attachmentPreviewKind,
  channelMessageSummary,
  filterMentionOptions,
  firstOversizedAttachment,
  formatAttachmentBytes,
  hasTransientRoutineExecution,
  insertPlainTextMention,
  isActiveRunStatus,
  loadingChannelHistory,
  messageAssets,
  messageDisplayProjection,
  messageReactionPills,
  ownReactionEmojiSet,
  mergeLoadedChannelHistoryPage,
  mergeLoadedChannelMessageContext,
  projectRichMessage,
  toggleOwnReaction,
  widgetResponseValue,
} from "../src";

const message = (metadata: unknown): ChannelMessageView => ({
  id: "message-1",
  sequence: "1",
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content: "hello",
  metadata,
  createdAt: "2026-09-01T00:00:00.000Z",
});

describe("shared desktop and iOS product policy", () => {
  test("uses one capability-driven upload policy for video and regular files", () => {
    const video = { fileName: "demo.MOV", mimeType: "application/octet-stream", byteSize: 201 };
    const document = { fileName: "notes.md", mimeType: "text/markdown", byteSize: 101 };
    const capabilities = {
      ...CLIENT_CAPABILITIES.uploads,
      maxRegularBytes: 100,
      maxVideoBytes: 200,
    };

    expect(attachmentByteLimit(video, capabilities)).toBe(200);
    expect(firstOversizedAttachment([video, document], capabilities)).toEqual({
      candidate: video,
      limit: 200,
    });
    expect(formatAttachmentBytes(1_572_864)).toBe("1.5 MB");
    expect(
      attachmentPreviewKind({
        assetId: "asset-1",
        fileName: "report.csv",
        mimeType: "application/octet-stream",
        byteSize: 10,
        kind: "file",
      })
    ).toBe("table");
  });

  test("projects and responds to rich widgets without platform-specific parsing", () => {
    const projection = projectRichMessage(
      message({
        type: "widget",
        widget: {
          prompt: "Choose targets",
          multiSelect: true,
          allowCustom: true,
          options: [{ label: "Production", value: "prod", style: "danger" }],
        },
      })
    );

    expect(projection).toMatchObject({ kind: "widget", state: "active" });
    if (projection?.kind !== "widget") throw new Error("expected widget projection");
    expect(widgetResponseValue(projection.widget, new Set(["prod"]), "  canary  ")).toBe(
      "prod\ncanary"
    );
  });

  test("fails closed for incomplete secret requests", () => {
    expect(
      projectRichMessage(message({ type: "secret-request", secretRequest: { label: "Token" } }))
    ).toBeNull();
    expect(
      projectRichMessage(
        message({
          type: "secret-request",
          secretRequest: { label: "Token", connector: "github", field: "token" },
        })
      )
    ).toMatchObject({ kind: "secret-request", provided: false });
  });

  test("projects the shared computer handoff lifecycle", () => {
    expect(
      projectRichMessage(
        message({
          type: "computer-handoff",
          computerHandoff: { reason: "Finish sign-in" },
        })
      )
    ).toMatchObject({
      kind: "computer-handoff",
      handoff: { reason: "Finish sign-in" },
      state: "requested",
    });
    expect(
      projectRichMessage(
        message({
          type: "computer-handoff",
          computerHandoff: { reason: "Finish sign-in" },
          computerHandoffState: "active",
        })
      )
    ).toMatchObject({ kind: "computer-handoff", state: "active" });
    expect(
      messageDisplayProjection(
        message({ type: "computer-handoff", computerHandoff: { reason: "Finish sign-in" } })
      )
    ).toMatchObject({ displayContent: "", richMessage: true });
  });

  test("projects cloud-agent cards with a renderer-safe Bot snapshot", () => {
    const projection = projectRichMessage(
      message({
        type: "cloud-agent",
        cloudAgent: {
          status: "draft",
          bot: {
            name: "New Bot",
            description: "A team Bot for file-backed agent parity work.",
            color: "#925df2",
            icon: "circle",
          },
        },
      })
    );

    expect(projection).toMatchObject({
      kind: "cloud-agent",
      agent: {
        name: "New Bot",
        status: "draft",
        color: "#925df2",
      },
    });
    expect(
      messageDisplayProjection(message({ type: "cloud-agent", agent: { name: "Bot" } }))
    ).toMatchObject({ displayContent: "", richMessage: true });
    expect(projectRichMessage(message({ type: "cloud-agent", cloudAgent: {} }))).toBeNull();
  });

  test("uses the same optimistic reaction reducer on both clients", () => {
    const reacted = toggleOwnReaction(message({ reactions: [{ emoji: "👍", by: "peer" }] }), "👍");
    expect(reacted.metadata).toEqual({
      reactions: [
        { emoji: "👍", by: "peer" },
        { emoji: "👍", by: "me" },
      ],
    });
    expect(toggleOwnReaction(reacted, "👍").metadata).toEqual({
      reactions: [{ emoji: "👍", by: "peer" }],
    });
  });

  test("shares canonical message assets, reactions, and display projection", () => {
    const asset = {
      assetId: "a".repeat(64),
      fileName: "photo.png",
      mimeType: "image/png",
      byteSize: 42,
      kind: "image" as const,
    };
    const value = message({
      attachment: asset,
      attachments: [asset, { ...asset, assetId: "invalid" }],
      reactions: [
        { by: "me", emoji: "👍" },
        { by: "peer", emoji: "👍" },
        { by: "peer", emoji: "🎉" },
      ],
    });
    value.content = asset.fileName;

    expect(messageAssets(value)).toEqual([asset]);
    expect(messageReactionPills(value)).toEqual([
      { emoji: "👍", count: 2 },
      { emoji: "🎉", count: 1 },
    ]);
    expect([...ownReactionEmojiSet(value)]).toEqual(["👍"]);
    expect(messageDisplayProjection(value)).toMatchObject({
      displayContent: "",
      images: [asset],
      files: [],
    });
  });

  test("shares channel-event, status, and mention policy", () => {
    expect(
      channelMessageSummary(
        message({ type: "event", event: { type: "name-changed", from: "Old", to: "New" } })
      )
    ).toBe("Renamed to New");
    expect(isActiveRunStatus("waiting_approval")).toBe(true);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(hasTransientRoutineExecution([{ status: "completed" }, { status: "running" }])).toBe(
      true
    );
    const mentions = [
      { id: "1", label: "Build Bot", handle: "buildbot" },
      { id: "2", label: "Research", handle: "research" },
    ];
    expect(filterMentionOptions(mentions, "BUILD")).toEqual([mentions[0]!]);
    expect(insertPlainTextMention("hello @bu", 5, " @bu", "buildbot")).toBe("hello @buildbot ");
  });

  test("normalizes primary, thread, and search history lanes", () => {
    const latest = { ...message({}), id: "latest", sequence: "3" };
    const thread = { ...message({}), id: "thread", sequence: "2" };
    const initial = mergeLoadedChannelHistoryPage(
      loadingChannelHistory(),
      {
        channelId: "channel-1",
        messages: [latest],
        threadContext: [thread],
        threadContextTruncated: false,
        beforeSequence: "3",
        hasMore: true,
        revision: "3",
      },
      "replace",
      10
    );
    const search = { ...message({}), id: "search", sequence: "1" };
    const contextual = mergeLoadedChannelMessageContext(
      initial,
      { messages: [search, latest], threadContext: [thread], threadContextTruncated: true },
      20
    );
    expect(contextual.searchContext.map(({ id }) => id)).toEqual(["search"]);
    expect(contextual.searchThreadContext).toEqual([]);
    expect(contextual.searchThreadContextTruncated).toBe(true);

    const older = { ...message({}), id: "older", sequence: "0" };
    const paginated = mergeLoadedChannelHistoryPage(
      contextual,
      {
        channelId: "channel-1",
        messages: [older],
        threadContext: [],
        threadContextTruncated: false,
        beforeSequence: null,
        hasMore: false,
        revision: "4",
      },
      "older",
      30
    );
    expect(paginated.messages.map(({ id }) => id)).toEqual(["older", "latest"]);
    expect(paginated.searchContext.map(({ id }) => id)).toEqual(["search"]);
    expect(paginated.hasMore).toBe(false);
  });

  test("bounds cyclic untrusted activity payloads", () => {
    const payload: Record<string, unknown> = { output: "ok" };
    payload.self = payload;
    const summary = activityContentSummary(payload);
    expect(summary).toContain('"self": "[Circular]"');
    expect(summary?.length).toBeLessThanOrEqual(1_501);
  });
});
