import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openteam/contracts";
import { createSnapshotIndex } from "../src/renderer/lib/snapshot-index";
import { createSnapshotCaches, reconcileClientSnapshot } from "../src/renderer/lib/snapshot-reconcile";

const stamp = "2026-08-24T20:00:00.000Z";
const COLLECTIONS = ["bots", "channels", "channelMessages", "channelRounds", "runs", "runItems", "subagents"] as const;

const message = (id: string, sequence: string, sender: "user" | "agent", content: string) => ({
  id, sequence, channelId: "channel-1", sender, senderBotId: sender === "agent" ? "bot-1" : null,
  sourceRunId: "run-1", content, metadata: null as unknown, createdAt: stamp,
});

const fixture = () =>
  ({
    cursor: "12",
    workspace: { root: "/workspace", sharedDirectory: "/workspace", botsDirectory: "/workspace/bots" },
    bots: [{ id: "bot-1", name: "Bot", status: "active", dmChannelId: "channel-1", createdAt: stamp, updatedAt: stamp }],
    channels: [{ id: "channel-1", kind: "bot_dm", name: "Bot", members: [{ botId: "bot-1", ordinal: 0 }], createdAt: stamp, updatedAt: stamp }],
    channelMessages: [message("message-1", "10", "user", "Hello"), message("message-2", "11", "agent", "Hi")],
    channelRounds: [],
    runs: [{ id: "run-1", botId: "bot-1", status: "running", runtimeTurnId: "turn-1", channelId: "channel-1", createdAt: stamp, updatedAt: stamp }],
    runItems: [{ id: "item-1", runId: "run-1", kind: "tool", status: "running", title: "WebSearch", content: null as unknown, createdAt: stamp, updatedAt: stamp }],
    subagents: [{ id: "subagent-1", parentRunId: "run-1", status: "running", createdAt: stamp, updatedAt: stamp }],
    runtime: { server: "ready", database: "ready", queue: "ready", computer: "ready", inference: "ready" },
  }) as unknown as ClientSnapshot;

describe("desktop snapshot index", () => {
  test("keeps the running turn stoppable when a newer turn is queued", () => {
    const snapshot = fixture();
    snapshot.runs.push({ ...snapshot.runs[0]!, id: "run-2", status: "queued", runtimeTurnId: null });
    expect(createSnapshotIndex(snapshot).activeRunByChannel.get("channel-1")?.id).toBe("run-1");
  });

  test("keeps identity across unchanged refreshes and changes only the affected collection", () => {
    const caches = createSnapshotCaches();
    const first = reconcileClientSnapshot(fixture(), null, caches);
    const same = reconcileClientSnapshot(fixture(), first, caches);
    expect(same).toBe(first);
    expect(same.channelMessages[0]).toBe(first.channelMessages[0]);
    expect(same.runtime).toBe(first.runtime);

    const changed = fixture();
    changed.runs[0] = { ...changed.runs[0]!, status: "completed" };
    const second = reconcileClientSnapshot(changed, first, caches);
    expect(second).not.toBe(first);
    expect(second.runs[0]).not.toBe(first.runs[0]);
    expect(second.channelMessages).toBe(first.channelMessages);
    expect(second.bots).toBe(first.bots);
  });

  test("normalizes omitted collections at the unvalidated HTTP boundary", () => {
    const legacy = fixture() as ClientSnapshot & Record<string, unknown>;
    for (const key of COLLECTIONS) delete legacy[key];
    const reconciled = reconcileClientSnapshot(legacy, null, createSnapshotCaches());
    for (const key of COLLECTIONS) expect(reconciled[key]).toEqual([]);
  });

  test("detects nested-metadata order changes and same-length long-body edits, reusing unchanged entities", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    const body = "original body ".repeat(1024);
    input.channelMessages[0]!.content = body;
    input.channelMessages[0]!.metadata = { nested: { values: [1, null, { ready: true }] } };
    input.runItems[0]!.content = body;
    const first = reconcileClientSnapshot(input, null, caches);
    expect(reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), first, caches)).toBe(first);

    const reordered = structuredClone(input);
    reordered.channelMessages[0]!.metadata = { nested: { values: [null, 1, { ready: true }] } };
    expect(reconcileClientSnapshot(reordered, first, caches).channelMessages[0]).not.toBe(first.channelMessages[0]);

    const edited = structuredClone(input);
    edited.channelMessages[0]!.content = body.slice(0, -1) + "!";
    const next = reconcileClientSnapshot(edited, first, caches);
    expect(next.channelMessages[0]!.content).toBe(edited.channelMessages[0]!.content);
    expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
    expect(next.runItems).toBe(first.runItems);
  });

  test("handles deeply nested JSON metadata without overflowing the comparator stack", () => {
    const nested = (leaf: string) => {
      let value: unknown = leaf;
      for (let i = 0; i < 3000; i++) value = { value };
      return value;
    };
    const caches = createSnapshotCaches();
    const withMetadata = (leaf: string) => {
      const snapshot = fixture();
      snapshot.channelMessages[0]!.metadata = nested(leaf) as never;
      return snapshot;
    };
    const first = reconcileClientSnapshot(withMetadata("unchanged"), null, caches);
    expect(reconcileClientSnapshot(withMetadata("unchanged"), first, caches)).toBe(first);
    expect(reconcileClientSnapshot(withMetadata("changed"), first, caches).channelMessages[0]).not.toBe(first.channelMessages[0]);
  });
});
