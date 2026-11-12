import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openteam/contracts";
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
    },
    bots: [
      {
        id: "bot-1",
        name: "Bot",
        icon: "●",
        color: "#2f8cff",
        defaultDirectory: "/workspace/bots/bot",
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
        name: "Bot",
        description: "",
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
      inference: "ready",
    },
  };
}

describe("desktop snapshot index", () => {

  test("indexes hot channel data once for fast tab projections", () => {
    const index = createSnapshotIndex(fixture());

    expect(index.botById.get("bot-1")?.name).toBe("Bot");
    expect(index.channelById.get("channel-1")?.name).toBe("Bot");
    expect(index.messagesByChannel.get("channel-1")?.map((message) => message.content)).toEqual([
      "Hello",
      "Hi",
    ]);
    expect(index.latestMessageByChannel.get("channel-1")?.id).toBe("message-2");
    expect(index.activeRunByChannel.get("channel-1")?.id).toBe("run-1");
    expect(index.itemsByRun.get("run-1")?.[0]?.title).toBe("WebSearch");
    expect(index.subagentsByChannel.get("channel-1")?.[0]?.parentToolCallId).toBe("tool-call-1");
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

  test("normalizes omitted collections at the unvalidated HTTP boundary", () => {
    const legacySnapshot = fixture() as ClientSnapshot & Record<string, unknown>;
    for (const key of [
      "bots",
      "channels",
      "channelMessages",
      "channelRounds",
      "runs",
      "runItems",
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

  test("compares nested message metadata and array order while reusing unchanged bodies", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    input.channelMessages[0]!.metadata = { nested: { values: [1, null, { ready: true }] } };
    const first = reconcileClientSnapshot(input, null, caches);
    const equal = reconcileClientSnapshot(structuredClone(input), first, caches);
    expect(equal).toBe(first);
    const changed = structuredClone(input);
    changed.channelMessages[0]!.metadata = { nested: { values: [null, 1, { ready: true }] } };
    const next = reconcileClientSnapshot(changed, first, caches);
    expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
    expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
  });

  test("ignores omitted optional object fields and releases removed cache entities", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    input.channelMessages[0]!.metadata = { optional: undefined, nested: { value: "unchanged" } };
    const first = reconcileClientSnapshot(input, null, caches);
    const equal = reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), first, caches);
    expect(equal).toBe(first);
    const removed = { ...input, channelMessages: input.channelMessages.slice(1) };
    const next = reconcileClientSnapshot(removed, first, caches);
    expect(next.channelMessages).toHaveLength(1);
    expect(caches.channelMessages.has(input.channelMessages[0]!.id)).toBe(false);
  });

  test("preserves long bodies and detects same-length edits without refreshing unrelated entities", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    const body = "original body ".repeat(1024);
    input.channelMessages[0]!.content = body;
    input.runItems[0]!.content = body;
    const first = reconcileClientSnapshot(input, null, caches);
    const equal = reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), first, caches);
    expect(equal).toBe(first);
    expect(equal.channelMessages[0]!.content).toBe(body);
    expect(equal.runItems[0]!.content).toBe(body);

    const changed = structuredClone(input);
    changed.channelMessages[0]!.content = body.slice(0, -1) + "!";
    const next = reconcileClientSnapshot(changed, first, caches);
    expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
    expect(next.channelMessages[0]!.content).toBe(changed.channelMessages[0]!.content);
    expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
    expect(next.runItems).toBe(first.runItems);

    const metadataChanged = structuredClone(changed);
    metadataChanged.channelMessages[0]!.metadata = { toolResult: { rows: [1, 2, 3] } };
    const final = reconcileClientSnapshot(metadataChanged, next, caches);
    expect(final.channelMessages[0]).not.toBe(next.channelMessages[0]);
    expect(final.channelMessages[0]!.content).toBe(changed.channelMessages[0]!.content);
  });

  test("detects changes across long, short and null body transitions", () => {
    const caches = createSnapshotCaches();
    let previous: ClientSnapshot | null = null;
    for (const content of ["x".repeat(4095), "x".repeat(4096), "x".repeat(4095), "", null]) {
      const input = fixture();
      input.runItems[0]!.content = content;
      const next = reconcileClientSnapshot(input, previous, caches);
      if (previous) expect(next.runItems[0]).not.toBe(previous.runItems[0]);
      expect(next.runItems[0]!.content).toBe(content);
      expect(reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), next, caches)).toBe(next);
      previous = next;
    }
  });

  test("handles deeply nested JSON metadata without overflowing the comparator stack", () => {
    const nested = (leaf: string) => {
      let value: unknown = leaf;
      for (let i = 0; i < 3000; i++) value = { value };
      return value;
    };
    const caches = createSnapshotCaches();
    const input = fixture();
    input.channelMessages[0]!.metadata = nested("unchanged");
    const first = reconcileClientSnapshot(input, null, caches);
    const equal = fixture();
    equal.channelMessages[0]!.metadata = nested("unchanged");
    expect(reconcileClientSnapshot(equal, first, caches)).toBe(first);
    const changed = fixture();
    changed.channelMessages[0]!.metadata = nested("changed");
    expect(reconcileClientSnapshot(changed, first, caches).channelMessages[0]).not.toBe(first.channelMessages[0]);
  });

});
