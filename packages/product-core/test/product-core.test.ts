import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ClientSnapshot } from "@openteam/contracts";
import {
  createSnapshotIndex,
  deriveThreads,
  selectChannelRows,
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
  workspace: { root: "/", sharedDirectory: "/s", botsDirectory: "/b" },
  bots: [
    {
      id: "bot-1",
      name: "Bot",
      title: "",
      description: "",
      instructions: "",
      icon: "helmet",
      color: "blue",
      hasAvatar: false,
      notificationsEnabled: true,
      hiddenFromSidebar: false,
      draftingDisabled: false,
      draftAllowedRecipients: [],
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
  subagents: [],
  runtime: {
    server: "ready",
    database: "ready",
    queue: "ready",
    computer: "ready",
    inference: "ready",
    transcription: "missing",
  },
});

describe("portable product projections", () => {
  test("builds one snapshot index for desktop and mobile selectors", () => {
    const value = snapshot();
    expect(createSnapshotIndex(value).latestMessageByChannel.get("channel-1")?.id).toBe(
      "message-1"
    );
    expect(selectChannelRows(value)[0]?.bot?.id).toBe("bot-1");
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
