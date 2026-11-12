import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "@openteam/contracts";
import { createSnapshotIndex } from "../src/renderer/lib/snapshot-index";
import { activeAsyncTaskChannelIds, activeAsyncTasksForBot } from "../src/renderer/lib/async-tasks";
import { reconcileSidebarRows, sidebarRowIsWorking } from "../src/renderer/lib/sidebar-rows";
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
  test("completed reply and parked ownership leave the sidebar idle until a real wake", () => {
    const snapshot = fixture();
    const original = snapshot.runs[0]!;
    snapshot.runs = [
      { ...original, status: "completed", requestState: "waiting", requestNextCheckAt: "2099-11-04T08:00:00Z" },
      { ...original, id: "latest-result", status: "completed", requestState: "complete" },
      { ...original, id: "blocked", status: "completed", requestState: "blocked" },
    ];
    snapshot.subagents = Array.from({ length: 8 }, (_, i) => ({
      ...snapshot.subagents[0]!, id: `parked-${i}`, subagentId: `parked-${i}`, status: "waiting",
    }));
    const row = () => {
      const index = createSnapshotIndex(snapshot);
      return reconcileSidebarRows(new Map(), snapshot.channels, index.latestMessageByChannel,
        index.activeRunByChannel, activeAsyncTaskChannelIds(snapshot.subagents)).rows[0]!;
    };
    expect(sidebarRowIsWorking(row())).toBe(false);
    expect(activeAsyncTasksForBot(snapshot.subagents, "bot-1")).toHaveLength(8);
    expect(createSnapshotIndex(snapshot).runsByChannel.get("channel-1")).toHaveLength(3);
    for (const status of ["queued", "running"] as const) {
      snapshot.runs.push({ ...original, id: "wake", status });
      expect(sidebarRowIsWorking(row())).toBe(true);
      snapshot.runs.pop();
      expect(sidebarRowIsWorking(row())).toBe(false);
    }
    for (const status of ["provisioning", "queued", "running"] as const) {
      snapshot.subagents.push({ ...snapshot.subagents[0]!, id: "wake", subagentId: "wake", status });
      expect(sidebarRowIsWorking(row())).toBe(true);
      snapshot.subagents.pop();
      expect(sidebarRowIsWorking(row())).toBe(false);
    }
  });

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

  test("preserves JSON property-order comparison for unchanged long content", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    const { content: _content, ...fields } = input.channelMessages[0]!;
    const body = "body".repeat(2048);
    input.channelMessages[0] = { content: body, ...fields };
    const first = reconcileClientSnapshot(input, null, caches);
    expect(reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), first, caches)).toBe(first);
    const reordered = fixture();
    reordered.channelMessages[0] = { ...fields, content: body };
    expect(reconcileClientSnapshot(reordered, first, caches).channelMessages[0]).not.toBe(first.channelMessages[0]);
  });

  test("keeps native serialization for custom serializers and content accessors", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    input.channelMessages[0]!.content = "body".repeat(2048);
    const serialized = { ...input.channelMessages[0], content: "custom serialized content" };
    Object.assign(input.channelMessages[0]!, { toJSON: () => serialized });
    const first = reconcileClientSnapshot(input, null, caches);
    expect(reconcileClientSnapshot(JSON.parse(JSON.stringify(input)), first, caches)).toBe(first);

    let reads = 0;
    const accessorInput = fixture();
    Object.defineProperty(accessorInput.channelMessages[0]!, "content", {
      enumerable: true, get: () => { reads++; return "body".repeat(2048); },
    });
    const accessorCaches = createSnapshotCaches();
    const withAccessor = reconcileClientSnapshot(accessorInput, null, accessorCaches);
    expect(reads).toBe(1);
    const nextAccessor = fixture();
    Object.defineProperty(nextAccessor.channelMessages[0]!, "content", {
      enumerable: true, get: () => { reads++; return "body".repeat(2048); },
    });
    expect(reconcileClientSnapshot(nextAccessor, withAccessor, accessorCaches)).toBe(withAccessor);
    expect(reads).toBe(2);
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

  test("keeps native serialization order when another root accessor changes a long body", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    const { content: _content, metadata: _metadata, ...fields } = input.channelMessages[0]!;
    const bodyA = "A".repeat(4096);
    const bodyB = "B".repeat(4096);
    let reads = 0;
    const accessorMessage: ClientSnapshot["channelMessages"][number] = {
      ...fields,
      get metadata() {
        reads++;
        accessorMessage.content = bodyB;
        return null;
      },
      content: bodyA,
    };
    input.channelMessages[0] = accessorMessage;
    const first = reconcileClientSnapshot(input, null, caches);
    expect(reads).toBe(1);
    expect(first.channelMessages[0]!.content).toBe(bodyB);

    const incoming = fixture();
    incoming.channelMessages[0] = { ...fields, metadata: null, content: bodyA };
    const next = reconcileClientSnapshot(incoming, first, caches);
    expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
    expect(next.channelMessages[0]!.content).toBe(bodyA);
    expect(reads).toBe(1);
    expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
  });

  test("keeps native serialization when nested metadata callbacks change a long body", () => {
    for (const kind of ["getter", "toJSON"] as const) {
      const caches = createSnapshotCaches();
      const input = fixture();
      const { content: _content, metadata: _metadata, ...fields } = input.channelMessages[0]!;
      const bodyA = "A".repeat(4096);
      const bodyB = "B".repeat(4096);
      const message: ClientSnapshot["channelMessages"][number] = {
        ...fields,
        metadata: null,
        content: bodyA,
      };
      let calls = 0;
      message.metadata = kind === "getter" ? {
        get value() { calls++; message.content = bodyB; return true; },
      } : {
        toJSON() { calls++; message.content = bodyB; return null; },
      };
      input.channelMessages[0] = message;
      const first = reconcileClientSnapshot(input, null, caches);
      expect(calls).toBe(1);
      expect(first.channelMessages[0]!.content).toBe(bodyB);
      const incoming = fixture();
      incoming.channelMessages[0] = {
        ...fields, metadata: kind === "getter" ? { value: true } : null, content: bodyA,
      };
      const next = reconcileClientSnapshot(incoming, first, caches);
      expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
      expect(next.channelMessages[0]!.content).toBe(bodyA);
      expect(calls).toBe(1);
      expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
    }
  });

  test("keeps deeply nested metadata safe when a message also has a long body", () => {
    const nested = (leaf: string) => {
      let metadata: unknown = leaf;
      for (let i = 0; i < 3000; i++) metadata = { value: metadata };
      return metadata;
    };
    const caches = createSnapshotCaches();
    const makeInput = (leaf: string) => {
      const input = fixture();
      input.channelMessages[0]!.content = "long body ".repeat(1024);
      input.channelMessages[0]!.metadata = nested(leaf);
      return input;
    };
    const first = reconcileClientSnapshot(makeInput("unchanged"), null, caches);
    expect(reconcileClientSnapshot(makeInput("unchanged"), first, caches)).toBe(first);
    const changed = reconcileClientSnapshot(makeInput("changed"), first, caches);
    expect(changed.channelMessages[0]).not.toBe(first.channelMessages[0]);
    expect(changed.channelMessages[0]!.content).toBe(first.channelMessages[0]!.content);
    expect(changed.channelMessages[1]).toBe(first.channelMessages[1]);
  });

  test("preserves edits with rich metadata and nonstandard arrays beside a long body", () => {
    const rich = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field-${i}`, i]));
    const sparse = new Array(4);
    sparse[3] = "tail";
    for (const metadata of [rich, sparse, [1, null, ["nested", false]]]) {
      const caches = createSnapshotCaches();
      const input = fixture();
      input.channelMessages[0]!.content = "x".repeat(4096);
      input.channelMessages[0]!.metadata = metadata;
      const first = reconcileClientSnapshot(input, null, caches);
      const equal = JSON.parse(JSON.stringify(input));
      expect(reconcileClientSnapshot(equal, first, caches)).toBe(first);
      const changed = JSON.parse(JSON.stringify(input));
      changed.channelMessages[0]!.content = "x".repeat(4095) + "!";
      const next = reconcileClientSnapshot(changed, first, caches);
      expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
      expect(next.channelMessages[0]!.content).toBe(changed.channelMessages[0]!.content);
      expect(next.channelMessages[1]).toBe(first.channelMessages[1]);
    }
  });

  test("preserves the existing circular-metadata error instead of walking indefinitely", () => {
    const input = fixture();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    input.channelMessages[0]!.content = "x".repeat(4096);
    input.channelMessages[0]!.metadata = circular;
    expect(() => reconcileClientSnapshot(input, null, createSnapshotCaches())).toThrow();
  });

  test("does not invoke enumerable symbol getters that native JSON ignores", () => {
    const input = fixture();
    const message = input.channelMessages[0]!;
    const body = "A".repeat(4096);
    message.content = body;
    let reads = 0;
    Object.defineProperty(message, Symbol("not JSON data"), {
      enumerable: true,
      get() { reads++; message.content = "B".repeat(4096); return "ignored"; },
    });
    const caches = createSnapshotCaches();
    const first = reconcileClientSnapshot(input, null, caches);
    expect(reads).toBe(0);
    expect(first.channelMessages[0]!.content).toBe(body);
    const wire = JSON.parse(JSON.stringify(input));
    expect(reconcileClientSnapshot(wire, first, caches)).toBe(first);
    expect(reads).toBe(0);
  });

  test("preserves identity when omitted optional metadata crosses the eligibility budget", () => {
    const input = fixture();
    input.channelMessages[0]!.content = "A".repeat(4096);
    input.channelMessages[0]!.metadata = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`optional-${index}`, undefined])
    );
    const caches = createSnapshotCaches();
    const first = reconcileClientSnapshot(input, null, caches);
    const wire = JSON.parse(JSON.stringify(input));
    const next = reconcileClientSnapshot(wire, first, caches);
    expect(next).toBe(first);
    expect(next.channelMessages[0]).toBe(first.channelMessages[0]);
    expect(next.channelMessages[0]!.content).toBe(input.channelMessages[0]!.content);
  });

  test("preserves unchanged identity through repeated native and separated-body representations", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    const original = input.channelMessages[0]!;
    original.content = "x".repeat(4096);
    const first = reconcileClientSnapshot(input, null, caches);
    let previous = first;
    for (let iteration = 0; iteration < 12; iteration++) {
      const incoming = fixture();
      incoming.channelMessages[0]!.content = original.content;
      if (iteration % 2 === 0)
        Object.defineProperty(incoming.channelMessages[0]!, Symbol("JSON-ignored"), {
          enumerable: true, value: "ignored",
        });
      const next = reconcileClientSnapshot(incoming, previous, caches);
      expect(next).toBe(first);
      expect(next.channelMessages[0]).toBe(original);
      previous = next;
    }
    const edited = fixture();
    edited.channelMessages[0]!.content = "x".repeat(4095) + "!";
    const next = reconcileClientSnapshot(edited, previous, caches);
    expect(next.channelMessages[0]).not.toBe(original);
    expect(next.channelMessages[0]!.content).toBe(edited.channelMessages[0]!.content);
  });

  const rawJSON = (JSON as typeof JSON & { rawJSON?: (value: string) => unknown }).rawJSON;
  test.skipIf(!rawJSON)("keeps raw-JSON number precision native across representation changes", () => {
    const caches = createSnapshotCaches();
    const input = fixture();
    input.channelMessages[0]!.content = "x".repeat(4096);
    input.channelMessages[0]!.metadata = { exact: rawJSON!("9007199254740993") };
    const first = reconcileClientSnapshot(input, null, caches);
    const wire = JSON.parse(JSON.stringify(input));
    Object.defineProperty(wire.channelMessages[0], Symbol("JSON-ignored"), {
      enumerable: true, value: "ignored",
    });
    const next = reconcileClientSnapshot(wire, first, caches);
    expect(next.channelMessages[0]).not.toBe(first.channelMessages[0]);
    expect(next.channelMessages[0]!.metadata).toEqual({ exact: 9007199254740992 });
    expect(next.channelMessages[0]!.content).toBe(first.channelMessages[0]!.content);
  });
});
