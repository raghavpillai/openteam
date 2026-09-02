import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ClientSnapshot } from "@openbot/contracts";
import {
  a2aProjectionFor,
  collapseA2ATimeline,
  createSnapshotIndex,
  deriveThreads,
  selectMobileChannelRows,
} from "../src";

const message = (
  id: string,
  metadata: unknown = {},
  createdAt = "2026-01-01T00:00:00.000Z"
): ChannelMessageView => ({
  id,
  sequence: id.replace(/\D/g, "") || "1",
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content: id,
  metadata,
  createdAt,
});

const snapshot = (): ClientSnapshot => ({
  cursor: "1",
  workspace: { root: "/", sharedDirectory: "/s", botsDirectory: "/b", projectsDirectory: "/p" },
  bots: [
    {
      id: "bot-1",
      name: "Bot",
      title: "",
      description: "",
      instructions: "",
      icon: "circle",
      color: "blue",
      hasAvatar: false,
      notificationsEnabled: true,
      hiddenFromSidebar: false,
      defaultDirectory: "/",
      status: "active",
      onboardingStatus: "completed",
      onboardingVersion: 1,
      onboardingCompletedAt: null,
      provisioningError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation-1",
      dmChannelId: "channel-1",
    },
  ],
  channels: [
    {
      id: "channel-1",
      kind: "bot_dm",
      name: "Bot",
      description: "",
      hasAvatar: false,
      directKey: "bot:bot-1",
      workingDirectory: null,
      members: [{ botId: "bot-1", ordinal: 0 }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  channelMessages: [message("message-1")],
  channelRounds: [],
  runs: [],
  runItems: [],
  approvals: [],
  subagents: [],
  runtime: {
    server: "ready",
    database: "ready",
    queue: "ready",
    computer: "ready",
    inference: "ready",
  },
});

describe("portable product projections", () => {
  test("builds one snapshot index for desktop and mobile selectors", () => {
    const value = snapshot();
    expect(createSnapshotIndex(value).latestMessageByChannel.get("channel-1")?.id).toBe(
      "message-1"
    );
    expect(selectMobileChannelRows(value)[0]?.bot?.id).toBe("bot-1");
  });

  test("keeps hidden agents addressable while omitting their rows from mobile navigation", () => {
    const value = snapshot();
    value.bots[0] = { ...value.bots[0]!, hiddenFromSidebar: true };
    expect(createSnapshotIndex(value).botById.get("bot-1")?.name).toBe("Bot");
    expect(selectMobileChannelRows(value)).toEqual([]);

    value.bots[0] = { ...value.bots[0]!, hiddenFromSidebar: false };
    value.channels[0] = {
      ...value.channels[0]!,
      kind: "group",
      directKey: null,
      hiddenFromSidebar: true,
    };
    expect(createSnapshotIndex(value).channelById.has("channel-1")).toBe(true);
    expect(selectMobileChannelRows(value)).toEqual([]);
  });

  test("projects A2A metadata", () => {
    expect(
      a2aProjectionFor(message("message-2", { fromAgent: { id: "peer-1", name: "Peer" } }))
    ).toEqual({ direction: "incoming", peerId: "peer-1", peerName: "Peer" });
  });

  test("keeps same-peer A2A runs on their original sides of an ordinary message", () => {
    const first = message(
      "message-1",
      { toAgent: { id: "peer-1", name: "Peer" } },
      "2026-01-01T00:00:00.000Z"
    );
    const ordinary = message("message-2", {}, "2026-01-01T00:00:05.000Z");
    const later = message(
      "message-3",
      { fromAgent: { id: "peer-1", name: "Peer" } },
      "2026-01-01T00:00:10.000Z"
    );

    const collapsed = collapseA2ATimeline([first, ordinary, later], (candidate) => candidate);

    expect(collapsed.map(({ id }) => id)).toEqual(["a2a:message-1", "message-2", "a2a:message-3"]);
    expect(
      collapsed.flatMap((candidate) =>
        "entries" in candidate ? candidate.entries.map(({ id }) => id) : [candidate.id]
      )
    ).toEqual([first.id, ordinary.id, later.id]);
  });

  test("starts a new same-peer A2A run after an intervening peer without reordering entries", () => {
    const first = message(
      "message-1",
      { toAgent: { id: "peer-1", name: "Peer 1" } },
      "2026-01-01T00:00:00.000Z"
    );
    const intervening = message(
      "message-2",
      { fromAgent: { id: "peer-2", name: "Peer 2" } },
      "2026-01-01T00:00:05.000Z"
    );
    const returned = message(
      "message-3",
      { fromAgent: { id: "peer-1", name: "Peer 1" } },
      "2026-01-01T00:00:10.000Z"
    );
    const contiguous = message(
      "message-4",
      { toAgent: { id: "peer-1", name: "Peer 1" } },
      "2026-01-01T00:00:15.000Z"
    );

    const collapsed = collapseA2ATimeline(
      [first, intervening, returned, contiguous],
      (candidate) => candidate
    );

    expect(collapsed.map(({ id }) => id)).toEqual([
      "a2a:message-1",
      "a2a:message-2",
      "a2a:message-3",
    ]);
    expect(collapsed.at(-1)).toMatchObject({ entries: [returned, contiguous] });
    expect(
      collapsed.flatMap((candidate) =>
        "entries" in candidate ? candidate.entries.map(({ id }) => id) : [candidate.id]
      )
    ).toEqual([first.id, intervening.id, returned.id, contiguous.id]);
  });

  test("derives nested reply threads", () => {
    const root = message("message-1");
    const reply = message("message-2", { branched: true, replyTo: root.id });
    const nested = message("message-3", { branched: true, replyTo: reply.id });
    expect(
      deriveThreads([root, reply, nested])
        .get(root.id)
        ?.replies.map(({ id }) => id)
    ).toEqual([reply.id, nested.id]);
  });
});
