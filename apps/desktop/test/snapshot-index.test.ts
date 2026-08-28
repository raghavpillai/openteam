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
    subagents: [
      {
        id: "subagent-1",
        subagentId: "session-1",
        parentBotId: "bot-1",
        parentRunId: "run-1",
        parentChannelId: "channel-1",
        parentToolCallId: "tool-call-1",
        currentRunId: "child-run-1",
        description: "Inspect release state",
        subagentType: "executor",
        runInBackground: true,
        status: "running",
        summary: null,
        errorMessage: null,
        startedAt: stamp,
        completedAt: null,
        stoppedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
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
    expect(index.subagentsByChannel.get("channel-1")?.[0]?.parentToolCallId).toBe("tool-call-1");
  });

  test("retains the latest mirrored A2A name when a peer is absent from the bot list", () => {
    const snapshot = fixture();
    const first = snapshot.channelMessages[0];
    const second = snapshot.channelMessages[1];
    if (!(first && second)) throw new Error("fixture is missing messages");
    first.metadata = {
      fromAgent: { id: "removed-peer", name: "Parity Probe" },
    };
    second.metadata = {
      toAgent: { id: "removed-peer", name: "Parity Watcher Live" },
    };

    expect(createSnapshotIndex(snapshot).agentNameById.get("removed-peer")).toBe(
      "Parity Watcher Live"
    );
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

  test("accepts snapshots from servers that predate subagent activity", () => {
    const { subagents: _subagents, ...legacySnapshot } = fixture();
    const reconciled = reconcileClientSnapshot(
      legacySnapshot as ClientSnapshot,
      null,
      createSnapshotCaches()
    );

    expect(reconciled.subagents).toEqual([]);
    expect(createSnapshotIndex(reconciled).subagentsByChannel.size).toBe(0);
  });

  test("normalizes omitted collections at the unvalidated HTTP boundary", () => {
    const legacySnapshot = fixture() as ClientSnapshot & Record<string, unknown>;
    for (const key of [
      "bots",
      "channels",
      "channelMessages",
      "channelRounds",
      "runs",
      "runItems",
      "approvals",
      "subagents",
    ]) {
      delete legacySnapshot[key];
    }

    const reconciled = reconcileClientSnapshot(
      legacySnapshot as ClientSnapshot,
      null,
      createSnapshotCaches()
    );

    expect(reconciled.bots).toEqual([]);
    expect(reconciled.channels).toEqual([]);
    expect(reconciled.channelMessages).toEqual([]);
    expect(reconciled.channelRounds).toEqual([]);
    expect(reconciled.runs).toEqual([]);
    expect(reconciled.runItems).toEqual([]);
    expect(reconciled.approvals).toEqual([]);
    expect(reconciled.subagents).toEqual([]);
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
