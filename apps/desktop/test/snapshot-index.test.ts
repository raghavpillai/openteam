import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openbot/contracts";
import { createSnapshotIndex } from "../src/renderer/lib/snapshot-index";
import {
  createSnapshotCaches,
  reconcileClientSnapshot,
} from "../src/renderer/lib/snapshot-reconcile";

const stamp = "2026-08-24T20:00:00.000Z";

function fixture(): ClientSnapshot {
  return {
    cursor: "12",
    workspace: {
      root: "/workspace",
      sharedDirectory: "/workspace",
      botsDirectory: "/workspace/bots",
      projectsDirectory: "/workspace/projects",
    },
    bots: [
      {
        id: "bot-1",
        name: "Grok",
        instructions: "Be useful.",
        icon: "●",
        color: "#2f8cff",
        defaultDirectory: "/workspace/bots/grok",
        status: "active",
        createdAt: stamp,
        updatedAt: stamp,
        conversationId: "conversation-1",
        dmChannelId: "channel-1",
      },
    ],
    channels: [
      {
        id: "channel-1",
        kind: "bot_dm",
        name: "Grok",
        directKey: null,
        workingDirectory: null,
        members: [{ botId: "bot-1", ordinal: 0 }],
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    channelMessages: [
      {
        id: "message-1",
        sequence: "10",
        channelId: "channel-1",
        sender: "user",
        senderBotId: null,
        sourceRunId: "run-1",
        content: "Hello",
        metadata: null,
        createdAt: stamp,
      },
      {
        id: "message-2",
        sequence: "11",
        channelId: "channel-1",
        sender: "agent",
        senderBotId: "bot-1",
        sourceRunId: "run-1",
        content: "Hi",
        metadata: null,
        createdAt: stamp,
      },
    ],
    channelRounds: [],
    runs: [
      {
        id: "run-1",
        botId: "bot-1",
        conversationId: "conversation-1",
        status: "running",
        runtimeTurnId: "turn-1",
        origin: "user",
        channelId: "channel-1",
        deliveryId: null,
        error: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    runItems: [
      {
        id: "item-1",
        runId: "run-1",
        kind: "tool",
        status: "running",
        title: "WebSearch",
        content: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    approvals: [],
    runtime: {
      server: "ready",
      database: "ready",
      queue: "ready",
      computer: "ready",
      agent: "ready",
    },
  };
}

describe("desktop snapshot index", () => {
  test("indexes hot channel data once for fast tab projections", () => {
    const index = createSnapshotIndex(fixture());

    expect(index.botById.get("bot-1")?.name).toBe("Grok");
    expect(index.channelById.get("channel-1")?.name).toBe("Grok");
    expect(index.messagesByChannel.get("channel-1")?.map((message) => message.content)).toEqual([
      "Hello",
      "Hi",
    ]);
    expect(index.latestMessageByChannel.get("channel-1")?.id).toBe("message-2");
    expect(index.activeRunByChannel.get("channel-1")?.id).toBe("run-1");
    expect(index.itemsByRun.get("run-1")?.[0]?.title).toBe("WebSearch");
  });

  test("keeps the running turn stoppable when a newer turn is queued", () => {
    const snapshot = fixture();
    const running = snapshot.runs[0];
    if (!running) throw new Error("fixture is missing its running turn");
    snapshot.runs.push({
      ...running,
      id: "run-2",
      status: "queued",
      runtimeTurnId: null,
    });

    expect(createSnapshotIndex(snapshot).activeRunByChannel.get("channel-1")?.id).toBe("run-1");
  });

  test("preserves entity, collection, and snapshot identity across unchanged refreshes", () => {
    const caches = createSnapshotCaches();
    const first = reconcileClientSnapshot(fixture(), null, caches);
    const second = reconcileClientSnapshot(fixture(), first, caches);

    expect(second).toBe(first);
    expect(second.channelMessages).toBe(first.channelMessages);
    expect(second.channelMessages[0]).toBe(first.channelMessages[0]);
    expect(second.runtime).toBe(first.runtime);
  });

  test("changes only the affected entity collection", () => {
    const caches = createSnapshotCaches();
    const first = reconcileClientSnapshot(fixture(), null, caches);
    const changed = fixture();
    const changedRun = changed.runs[0];
    if (!changedRun) throw new Error("fixture is missing its running turn");
    changed.runs[0] = { ...changedRun, status: "completed" };
    const second = reconcileClientSnapshot(changed, first, caches);

    expect(second).not.toBe(first);
    expect(second.runs).not.toBe(first.runs);
    expect(second.runs[0]).not.toBe(first.runs[0]);
    expect(second.channelMessages).toBe(first.channelMessages);
    expect(second.bots).toBe(first.bots);
  });
});
