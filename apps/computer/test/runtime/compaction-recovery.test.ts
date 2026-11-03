import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  type BotMessage,
  sha256,
} from "../../src/bot-compaction";
import type { BotArchiveCommitInput } from "../../src/compaction/types";
import { ComputerRuntime } from "../../src/runtime";
import { compactionExtension, compactionObservation } from "../../src/runtime/compaction";
import {
  prepareCompactionHistory,
  recoverStagedPiCompaction,
} from "../../src/runtime/compaction-history";
import type { ActiveTurn } from "../../src/runtime/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const model: any = {
  id: "recovery-fixture",
  name: "Recovery",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://offline.invalid/v1",
  contextWindow: 100_000,
  maxTokens: 1000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 10,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const answer = (text: string): any => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 1,
  usage,
});
const archiveInput = (id: string, count: number): BotArchiveCommitInput => ({
  id,
  reason: "self_summary_completed",
  summary: "Original archive: keep the current request",
  prefixDigest: sha256("synthetic"),
  piBaseMessageCount: count,
  userInfoMessage: null,
  lastUserMessage: { role: "user", content: "Current request", timestamp: 1 },
  preservedTailMessages: [],
  summarizedMessages: [],
  tokensBefore: 500_944,
  tokensAfter: 100,
  imageCount: 0,
  turnCount: 1,
  usage: null,
  startedAt: "2001-01-01T00:00:00.000Z",
  completedAt: "2001-01-01T00:00:01.000Z",
});
async function fixture(kind: "owned" | "projected" | "anchored" = "owned", grow = 0) {
  const root = await mkdtemp(join(tmpdir(), "compaction-recovery-"));
  roots.push(root);
  const store = new BotCompactionArchiveStore(join(root, "archive"));
  const coordinator = new BotCompactionCoordinator(store, 0);
  const id = crypto.randomUUID(),
    archiveId = crypto.randomUUID();
  const manager = SessionManager.create(root, join(root, "sessions"), { id });
  const entries: string[] = [];
  // An older native checkpoint deliberately makes raw message indexes differ
  // from the Pi coordinate system the archive was actually created against.
  for (let i = 0; i < 1600; i++)
    entries.push(manager.appendMessage({ role: "user", content: `old-${i}`, timestamp: i }));
  const basis = manager.appendCompaction("Prior Pi view", entries[108]!, 400_000);
  manager.getEntry(basis)!.timestamp = "2000-01-01T00:00:00.000Z";
  let checkpoint = basis;
  if (kind === "owned")
    checkpoint = manager.appendCompaction(
      "Original archive: keep the current request",
      entries[109]!,
      500_944,
      { openteamBotCompaction: true, id: archiveId },
      true
    );
  expect(manager.buildSessionContext().messages).toHaveLength(1493);
  await store.commit(id, {
    ...archiveInput(archiveId, 1493),
    ...(kind === "anchored"
      ? { piBoundary: { leafId: checkpoint, compactionEntryId: basis } }
      : {}),
  });
  manager.appendCustomEntry("openteam-compaction-usage", {
    compactionId: archiveId,
    epoch: 1,
    inputTokens: 100,
    source: "provider",
  });
  manager.appendMessage({
    ...answer(""),
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "sent-once", name: "SendToUser", arguments: { text: "Delivered" } },
    ],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "sent-once",
    toolName: "SendToUser",
    content: [{ type: "text", text: "SEND_RECEIPT_791" }],
    isError: false,
    timestamp: 2,
  });
  manager.appendCustomMessageEntry("fixture-notice", "CUSTOM_AFTER_ARCHIVE_792", false);
  const later: string[] = [];
  for (let i = 0; i < 800; i++)
    later.push(manager.appendMessage({ role: "user", content: `later-${i}`, timestamp: 3 }));
  manager.appendCompaction(
    "Native summary must never replace the archive's coordinate",
    later[109]!,
    500_944,
    undefined,
    false
  );
  expect(manager.buildSessionContext().messages).toHaveLength(692);
  for (let i = 0; i < grow; i++)
    manager.appendMessage({ role: "user", content: `after-native-${i}`, timestamp: 4 });
  const path = manager.getSessionFile()!;
  await writeFile(
    path,
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
  return {
    root,
    store,
    coordinator,
    id,
    archiveId,
    manager,
    path,
    checkpoint,
    basis,
    open: () => SessionManager.open(path, join(root, "sessions"), root),
  };
}

async function localRuntime(f: Awaited<ReturnType<typeof fixture>>, deliver = false) {
  const runtime = new ComputerRuntime() as any;
  let providerCalls = 0,
    summaryCalls = 0,
    toolCalls = 0;
  const requests: any[] = [],
    events: any[] = [];
  const provider = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  provider.checkAuth = async () => ({ type: "api_key" });
  provider.completeSimple = async () => {
    summaryCalls++;
    return answer("Unexpected summary");
  };
  provider.streamSimple = (_m, context, options) =>
    streamSimple(model, context, {
      ...options,
      apiKey: "synthetic-fixture",
      maxRetries: 0,
      fetch: (async (_url: any, init: any) => {
        providerCalls++;
        requests.push(JSON.parse(await new Response(init.body).text()));
        const send = deliver && providerCalls === 1;
        const delta = send
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "fresh-send",
                  type: "function",
                  function: { name: "SendToUser", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "Continue from the persisted receipt" };
        const rows = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: send ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          },
        ];
        return new Response(
          rows
            .map(
              (row) =>
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...row })}\n\n`
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch,
    });
  runtime.agentDir = f.root;
  runtime.modelRuntime = provider;
  runtime.resolveModel = () => model;
  runtime.compaction = f.coordinator;
  runtime.compactionArchive = f.store;
  runtime.tools = {
    customTools: () => [
      {
        name: "SendToUser",
        label: "Send",
        description: "Synthetic delivery",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          toolCalls++;
          return { content: [{ type: "text", text: "NEW_SEND_RECEIPT_793" }], details: {} };
        },
      },
    ],
    acknowledgeToolOutcomes: async () => {},
    cancelApprovals() {},
    userForms: { beginTurn: async () => {}, endTurn: async () => {} },
  };
  const active: any = {
    runId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    botId: "fixture",
    contextSessionId: f.id,
    modelRef: { providerId: model.provider, modelId: model.id },
    reasoning: "off",
    instructions: "Synthetic system",
    userInfoMessage: null,
    cwd: f.root,
    runtimeProfile: "agent",
    subagentType: null,
    requestSource: "agent",
    resetSelfSummaryCount: true,
    sentMessageCount: 0,
    assistantOrdinal: 0,
    startedItems: new Set(),
    toolArgs: new Map(),
    attachmentTempDirectories: [],
    queue: { push: (event: any) => events.push(event), end() {} },
  };
  const session = await runtime.createStandaloneSession(
    f.root,
    active.instructions,
    f.open(),
    active,
    active.modelRef
  );
  active.session = session;
  active.sessionPath = session.sessionFile;
  active.unsubscribe = session.subscribe((event: any) => runtime.routeEvent(active, event));
  return {
    runtime,
    session,
    active,
    requests,
    events,
    counts: () => ({ providerCalls, summaryCalls, toolCalls }),
  };
}

// This test intentionally imports only pre-existing runtime entry points so it
// can also run, unchanged, with the implementation restored to origin/main.
for (const grow of [0, 801, 1000])
  test(`real local ComputerRuntime recovers persisted 1493 -> ${692 + grow} native context`, async () => {
    const f = await fixture("owned", grow);
    const original = await readFile(f.path, "utf8");
    const local = await localRuntime(f);
    try {
      expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 0, toolCalls: 0 });
      await local.runtime.execute(
        local.active,
        "Continue without resending the delivered message",
        []
      );
      expect(local.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
      expect(
        local.events.filter((event: any) => event.type === "turn.completed").at(-1)?.status
      ).toBe("completed");
      expect(local.counts()).toEqual({ providerCalls: 1, summaryCalls: 0, toolCalls: 0 });
      const request = JSON.stringify(local.requests[0]);
      expect(request.match(/SEND_RECEIPT_791/g)).toHaveLength(1);
      expect(request.match(/CUSTOM_AFTER_ARCHIVE_792/g)).toHaveLength(1);
      expect(request).toContain("later-0");
      expect(request).toContain("later-799");
      expect(request).not.toContain("old-1599");
      expect(request).not.toContain("Native summary must never");
      expect((await readFile(f.path, "utf8")).startsWith(original)).toBe(true);
      expect((await f.store.latest(f.id))?.piBaseMessageCount).toBe(1493);
    } finally {
      local.session.dispose();
    }
  }, 15_000);

for (const kind of ["owned", "projected", "anchored"] as const)
  test(`${kind} archive recovers its original view across repeated opens without writes or execution`, async () => {
    const f = await fixture(kind);
    const before = await readFile(f.path, "utf8");
    let first: BotMessage[] | undefined;
    for (let i = 0; i < 3; i++) {
      const manager = f.open();
      const history = await prepareCompactionHistory(
        new BotCompactionCoordinator(f.store, 0),
        f.store,
        manager,
        f.id
      );
      const projected = await f.coordinator.contextMessages(f.id, history.read());
      if (first) expect(projected).toEqual(first);
      else first = projected;
      expect(JSON.stringify(projected).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
      expect(
        projected.some(
          (message) =>
            message.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part: any) => part.id === "sent-once")
        )
      ).toBe(true);
      expect(history.hasUnmeasuredRecovery()).toBe(true);
      const active = {
        contextSessionId: f.id,
        instructions: "System",
        modelRef: {},
        compactionReadPiMessages: history.read,
        compactionUsageInvalidated: history.hasUnmeasuredRecovery,
      } as unknown as ActiveTurn;
      expect(compactionObservation(active).usedTokens).toBeNull();
    }
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

test("missing archive ancestry fails closed even on a longer branch with duplicate-looking messages", async () => {
  const f = await fixture("anchored");
  const manager = f.open();
  manager.branch(manager.getBranch()[0]!.id);
  for (let i = 0; i < 1600; i++)
    manager.appendMessage({ role: "user", content: `old-${i}`, timestamp: i });
  expect(manager.buildSessionContext().messages.length).toBeGreaterThan(1493);
  await expect(prepareCompactionHistory(f.coordinator, f.store, manager, f.id)).rejects.toThrow(
    "cannot prove archive branch boundary"
  );
});

test("legacy branch without its checkpoint or usage receipt fails closed", async () => {
  const f = await fixture("owned");
  const manager = f.open();
  manager.branch(manager.getBranch()[0]!.id);
  for (let i = 0; i < 1600; i++)
    manager.appendMessage({ role: "user", content: "Duplicate", timestamp: i });
  await expect(prepareCompactionHistory(f.coordinator, f.store, manager, f.id)).rejects.toThrow(
    "cannot prove archive branch boundary"
  );
});

test("staged restart adopts at the matching compaction, preserving later tool receipts once", async () => {
  const f = await fixture();
  await f.store.remove(f.id);
  const manager = f.open();
  const staged = crypto.randomUUID();
  const { piBaseMessageCount, ...intent } = archiveInput(staged, 1);
  await f.store.stage(f.id, intent);
  const kept = manager.appendMessage({ role: "user", content: "Checkpoint request", timestamp: 4 });
  const checkpoint = manager.appendCompaction(
    "Staged summary",
    kept,
    500_000,
    { openteamBotCompaction: true, id: staged },
    true
  );
  manager.appendMessage({
    ...answer(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "later-send", name: "SendToUser", arguments: {} }],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "later-send",
    toolName: "SendToUser",
    content: [{ type: "text", text: "LATER_RECEIPT" }],
    isError: false,
    timestamp: 5,
  });
  const reopened = f.open();
  await recoverStagedPiCompaction(f.coordinator, reopened, f.id);
  expect((await f.store.latest(f.id))?.piBaseMessageCount).toBe(2);
  expect((await f.store.latest(f.id))?.piBoundary?.leafId).toBe(checkpoint);
  const history = await prepareCompactionHistory(f.coordinator, f.store, reopened, f.id);
  const projected = await f.coordinator.contextMessages(f.id, history.read());
  expect(projected.filter((message) => message.role === "toolResult")).toHaveLength(1);
  expect(JSON.stringify(projected)).toContain("LATER_RECEIPT");
  expect(await f.store.stagedId(f.id)).toBeNull();
});

test("healthy per-step reads add no branch scans, context rebuilds, or archive reads", async () => {
  const f = await fixture("anchored");
  const manager = f.open();
  manager.branch(f.checkpoint);
  const history = await prepareCompactionHistory(f.coordinator, f.store, manager, f.id);
  const branches = spyOn(manager, "getBranch"),
    builds = spyOn(manager, "buildSessionContext"),
    latest = spyOn(f.store, "latest");
  for (let i = 0; i < 50; i++) {
    manager.appendCustomEntry("metadata", { i });
    history.read();
    history.boundary();
  }
  expect(branches).toHaveBeenCalledTimes(0);
  expect(builds).toHaveBeenCalledTimes(50); // Exactly the pre-existing one builder per read.
  expect(latest).toHaveBeenCalledTimes(0);
});

test("failed summary preparation explicitly cancels native Pi fallback", async () => {
  const handlers: Record<string, (event: any) => Promise<any>> = {};
  const coordinator = {
    beforePiCompaction: async () => {
      throw Error("synthetic summary failure");
    },
  } as unknown as BotCompactionCoordinator;
  const active = {
    contextSessionId: crypto.randomUUID(),
    instructions: "System",
    modelRef: {},
    queue: { push() {} },
  } as unknown as ActiveTurn;
  compactionExtension(
    coordinator,
    async () => ({ text: "unused" }),
    { buildSessionContext: () => ({ messages: [] }) } as unknown as SessionManager,
    active
  ).factory({
    on: (name: string, handler: any) => {
      handlers[name] = handler;
    },
  } as never);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      await handlers.session_before_compact!({
        reason: "manual",
        preparation: { firstKeptEntryId: "kept", tokensBefore: 10 },
        signal: new AbortController().signal,
      })
    ).toEqual({ cancel: true });
  } finally {
    log.mockRestore();
  }
});

test("real Pi manual compaction cancels on custom preparation failure without native model fallback", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  const before = await readFile(f.path, "utf8");
  const preparation = spyOn(f.coordinator, "beforePiCompaction").mockRejectedValue(
    Error("synthetic preparation failure")
  );
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(local.session.compact()).rejects.toThrow("Compaction cancelled");
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 0, toolCalls: 0 });
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect((await f.store.latest(f.id))?.id).toBe(f.archiveId);
    expect(local.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
  } finally {
    preparation.mockRestore();
    log.mockRestore();
    local.session.dispose();
  }
});

test("manifest adoption failure keeps old coordinates in-session and recovers the staged checkpoint on reopen", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  const commit = spyOn(f.store, "commitStaged").mockRejectedValue(
    Error("synthetic manifest write failure")
  );
  try {
    await local.session.compact();
    expect((await f.store.latest(f.id))?.id).toBe(f.archiveId);
    expect(await f.store.stagedId(f.id)).not.toBeNull();
    // The hook error is swallowed by Pi, so the reader must remain usable with
    // the old manifest until the staged checkpoint can be adopted.
    const projected = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    expect(JSON.stringify(projected).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(local.active.compactionReadPiBoundary().compactionEntryId).toBe(f.checkpoint);
    commit.mockRestore();
    const reopened = f.open();
    reopened.appendCustomMessageEntry("after-failed-adoption", "LATE_ADOPTION_NOTICE", false);
    const history = await prepareCompactionHistory(
      new BotCompactionCoordinator(f.store, 0),
      f.store,
      reopened,
      f.id
    );
    const recovered = await f.store.contextMessages(f.id, history.read());
    expect(JSON.stringify(recovered).match(/LATE_ADOPTION_NOTICE/g)).toHaveLength(1);
    expect(await f.store.stagedId(f.id)).toBeNull();
    expect((await f.store.latest(f.id))?.id).not.toBe(f.archiveId);
  } finally {
    commit.mockRestore();
    local.session.dispose();
  }
});

test("unowned native compaction during a session preserves the existing view and invalidates measured usage", async () => {
  const f = await fixture("anchored");
  const manager = f.open();
  manager.branch(f.checkpoint);
  const history = await prepareCompactionHistory(f.coordinator, f.store, manager, f.id);
  const original = history.read();
  const request = manager.appendMessage({ role: "user", content: "New request", timestamp: 4 });
  manager.appendCompaction("Unexpected native summary", request, 500_944, undefined, false);
  manager.appendCustomMessageEntry("new-notice", "NATIVE_SUFFIX_NOTICE", false);
  const projected = history.read();
  expect(projected.slice(0, original.length)).toEqual(original);
  expect(JSON.stringify(projected).match(/NATIVE_SUFFIX_NOTICE/g)).toHaveLength(1);
  expect(JSON.stringify(projected)).not.toContain("Unexpected native summary");
  expect(history.hasUnmeasuredRecovery()).toBe(true);
  history.acceptUsage();
  expect(history.hasUnmeasuredRecovery()).toBe(false);
  // A new archive adopted in the recovered coordinate remains restartable.
  const nextId = crypto.randomUUID();
  await f.store.commit(f.id, {
    ...archiveInput(nextId, projected.length),
    piBoundary: history.boundary(),
  });
  const reopened = await prepareCompactionHistory(f.coordinator, f.store, f.open(), f.id);
  expect(reopened.read()).toEqual(projected);
});

test("synthetic SendToUser executes once, and its durable outcome survives another native compaction and runtime restart", async () => {
  const f = await fixture();
  const first = await localRuntime(f, true);
  try {
    expect(first.counts()).toEqual({ providerCalls: 0, summaryCalls: 0, toolCalls: 0 });
    await first.runtime.execute(first.active, "Send a new, distinct synthetic response", []);
    expect(first.counts()).toEqual({ providerCalls: 2, summaryCalls: 0, toolCalls: 1 });
    expect(first.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
  } finally {
    first.session.dispose();
  }
  const manager = f.open();
  manager.appendCompaction(
    "Another native compaction",
    manager.getLeafId()!,
    500_944,
    undefined,
    false
  );
  const second = await localRuntime(f);
  try {
    expect(second.counts()).toEqual({ providerCalls: 0, summaryCalls: 0, toolCalls: 0 });
    await second.runtime.execute(second.active, "Continue after the completed delivery", []);
    expect(second.counts()).toEqual({ providerCalls: 1, summaryCalls: 0, toolCalls: 0 });
    const request = JSON.stringify(second.requests[0]);
    expect(request.match(/NEW_SEND_RECEIPT_793/g)).toHaveLength(1);
    expect(request.match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(second.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
    expect(
      second.events.filter((event: any) => event.type === "turn.completed").at(-1)?.status
    ).toBe("completed");
  } finally {
    second.session.dispose();
  }
});

test("owned compactions with identical summary text use distinct durable entry IDs", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  try {
    await local.session.compact();
    const first = await f.store.latest(f.id);
    const manager: SessionManager = local.session.sessionManager;
    manager.appendMessage({ role: "user", content: "Another request", timestamp: 10 });
    manager.appendMessage(answer("Another result"));
    await local.session.compact();
    const second = await f.store.latest(f.id);
    expect(second?.summary).toBe(first?.summary);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.piBoundary?.leafId).toBe(manager.getLeafId()!);
    expect(second?.piBoundary?.leafId).not.toBe(first?.piBoundary?.leafId);
    expect(local.active.compactionReadPiBoundary()).toEqual(second?.piBoundary);
    expect(await f.store.stagedId(f.id)).toBeNull();
  } finally {
    local.session.dispose();
  }
});

test("failed adoption cancels repeated compactions and projection until the original checkpoint can recover", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  const manager: SessionManager = local.session.sessionManager;
  const commit = spyOn(f.store, "commitStaged").mockRejectedValue(
    Error("synthetic repeated adoption failure")
  );
  try {
    await local.session.compact();
    const staged = await f.store.stagedId(f.id);
    const checkpoint = manager.getLeafId();
    expect(staged).not.toBeNull();
    manager.appendMessage({
      ...answer(""),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "failed-adoption-send", name: "SendToUser", arguments: {} },
      ],
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "failed-adoption-send",
      toolName: "SendToUser",
      content: [{ type: "text", text: "FAILED_ADOPTION_RECEIPT_794" }],
      isError: false,
      timestamp: 5,
    });
    manager.appendMessage({
      role: "user",
      content: "Continue after the persisted receipt",
      timestamp: 6,
    });
    for (let i = 0; i < 2; i++)
      await expect(local.session.compact()).rejects.toThrow("Compaction cancelled");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await f.store.stagedId(f.id)).toBe(staged);
    const checkpoints = manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "compaction" &&
          (entry.details as { id?: string } | undefined)?.id === staged
      );
    expect(checkpoints.map((entry) => entry.id)).toEqual([checkpoint!]);
    const before = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    const observation = {
      ...compactionObservation(local.active),
      usedTokens: 99_999,
      freshUsage: true,
      infer: async () => {
        throw Error("must not start another summary");
      },
    };
    await f.coordinator.observe(observation);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.coordinator.modelContextMessages(observation)).toEqual(before);
    expect(await f.store.stagedId(f.id)).toBe(staged);
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 1, toolCalls: 0 });
    commit.mockRestore();
    const history = await prepareCompactionHistory(f.coordinator, f.store, f.open(), f.id);
    const projected = await f.coordinator.contextMessages(f.id, history.read());
    expect((await f.store.latest(f.id))?.piBoundary?.leafId).toBe(checkpoint!);
    expect(await f.store.stagedId(f.id)).toBeNull();
    expect(JSON.stringify(projected).match(/FAILED_ADOPTION_RECEIPT_794/g)).toHaveLength(1);
    expect(JSON.stringify(projected)).toContain("Continue after the persisted receipt");
    expect(JSON.stringify(projected)).not.toContain("old-1599");
  } finally {
    commit.mockRestore();
    local.session.dispose();
  }
});

test("contextState leaves a live reader and failed adoption in the same coordinate until turn cleanup and reopen", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  local.runtime.sessionsDir = join(f.root, "sessions");
  local.runtime.contextSessionsDir = join(f.root, "archive");
  local.runtime.activeByContext.set(f.id, local.active);
  const manager: SessionManager = local.session.sessionManager;
  const commit = spyOn(f.store, "commitStaged").mockRejectedValue(
    Error("synthetic adoption failure")
  );
  try {
    await local.session.compact();
    const staged = await f.store.stagedId(f.id);
    manager.appendCustomMessageEntry("after-failed-adoption", "ACTIVE_ADOPTION_SUFFIX_795", false);
    const before = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    commit.mockRestore();
    const state = await local.runtime.contextState(f.id);
    const after = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    expect(state.epoch).toBe(1);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("old-1599");
    expect(JSON.stringify(after).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(await f.store.stagedId(f.id)).toBe(staged);
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 1, toolCalls: 0 });
    await local.runtime.execute(local.active, "Continue using the already recorded outcome", []);
    expect(local.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
    expect(local.runtime.activeByContext.has(f.id)).toBe(false);
    expect(JSON.stringify(local.requests[0]).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(JSON.stringify(local.requests[0])).not.toContain("old-1599");
    // Once cleanup disposes the reader, an idle status read may finish adoption.
    expect((await local.runtime.contextState(f.id)).epoch).toBe(2);
    const history = await prepareCompactionHistory(f.coordinator, f.store, f.open(), f.id);
    const reopened = await f.coordinator.contextMessages(f.id, history.read());
    expect(JSON.stringify(reopened).match(/ACTIVE_ADOPTION_SUFFIX_795/g)).toHaveLength(1);
    expect(JSON.stringify(reopened)).toContain("Continue using the already recorded outcome");
    expect(JSON.stringify(reopened)).not.toContain("old-1599");
    expect(await f.store.stagedId(f.id)).toBeNull();
    expect(local.counts()).toEqual({ providerCalls: 1, summaryCalls: 1, toolCalls: 0 });
  } finally {
    commit.mockRestore();
    local.runtime.activeByContext.delete(f.id);
    local.session.dispose();
  }
});

test("contextState cannot adopt a checkpoint while its live adoption is still in flight", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  local.runtime.sessionsDir = join(f.root, "sessions");
  local.runtime.contextSessionsDir = join(f.root, "archive");
  local.runtime.activeByContext.set(f.id, local.active);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalCommit = f.store.commitStaged.bind(f.store);
  const commit = spyOn(f.store, "commitStaged").mockImplementation(async (...args) => {
    entered();
    await gate;
    return originalCommit(...args);
  });
  const compacting = local.session.compact();
  try {
    await started;
    const before = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    expect((await local.runtime.contextState(f.id)).epoch).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(
      await f.coordinator.contextMessages(f.id, local.active.compactionReadPiMessages())
    ).toEqual(before);
    release();
    await compacting;
    expect((await local.runtime.contextState(f.id)).epoch).toBe(2);
    const after = await f.coordinator.contextMessages(
      f.id,
      local.active.compactionReadPiMessages()
    );
    expect(JSON.stringify(after)).not.toContain("old-1599");
    expect(local.active.compactionReadPiBoundary()).toEqual(
      (await f.store.latest(f.id))?.piBoundary
    );
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 1, toolCalls: 0 });
  } finally {
    release();
    await compacting;
    commit.mockRestore();
    local.runtime.activeByContext.delete(f.id);
    local.session.dispose();
  }
});

test("an idle status read defers if a live reader appears while its staged lookup is pending", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  local.runtime.sessionsDir = join(f.root, "sessions");
  local.runtime.contextSessionsDir = join(f.root, "archive");
  const commit = spyOn(f.store, "commitStaged").mockRejectedValue(
    Error("synthetic adoption failure")
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookup: ReturnType<typeof spyOn> | undefined;
  try {
    await local.session.compact();
    commit.mockRestore();
    const originalLookup = f.coordinator.stagedId.bind(f.coordinator);
    lookup = spyOn(f.coordinator, "stagedId").mockImplementation(async (id) => {
      entered();
      await gate;
      return originalLookup(id);
    });
    const status = local.runtime.contextState(f.id);
    await started;
    local.runtime.activeByContext.set(f.id, local.active);
    // Reader initialization precedes attachment of the AgentSession in run().
    local.active.session = null;
    release();
    expect((await status).epoch).toBe(1);
    expect((await f.store.latest(f.id))?.id).toBe(f.archiveId);
    expect(await f.store.stagedId(f.id)).not.toBeNull();
    lookup.mockRestore();
    const open = spyOn(SessionManager, "open");
    try {
      expect((await local.runtime.contextState(f.id)).epoch).toBe(1);
      expect(open).toHaveBeenCalledTimes(0);
    } finally {
      open.mockRestore();
    }
    // A stopped turn disposes its reader before releasing the context for idle recovery.
    local.active.session = local.session;
    local.active.stopped = true;
    await local.runtime.cleanup(local.active);
    expect((await local.runtime.contextState(f.id)).epoch).toBe(2);
    expect(await f.store.stagedId(f.id)).toBeNull();
    const history = await prepareCompactionHistory(f.coordinator, f.store, f.open(), f.id);
    expect(history.boundary()).toEqual((await f.store.latest(f.id))?.piBoundary);
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 1, toolCalls: 0 });
  } finally {
    release();
    lookup?.mockRestore();
    commit.mockRestore();
    local.runtime.activeByContext.delete(f.id);
    local.session.dispose();
  }
});

test("a projection already in flight cannot overwrite a newly persisted checkpoint intent", async () => {
  const f = await fixture("owned", 2);
  const local = await localRuntime(f);
  const observation = {
    ...compactionObservation(local.active),
    usedTokens: 99_999,
    freshUsage: true,
    infer: async () => ({ text: "Reusable background summary" }),
  };
  await f.coordinator.observe(observation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = await f.coordinator.contextMessages(f.id, local.active.compactionReadPiMessages());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalUsedTokens = (f.coordinator as any).usedTokens.bind(f.coordinator);
  const measurement = spyOn(f.coordinator as any, "usedTokens").mockImplementation(
    async (...args: any[]) => {
      entered();
      await gate;
      return originalUsedTokens(...args);
    }
  );
  const projectedCommit = spyOn(f.store, "commit");
  const adoption = spyOn(f.store, "commitStaged").mockRejectedValue(
    Error("synthetic adoption failure")
  );
  const projecting = f.coordinator.modelContextMessages(observation);
  try {
    await started;
    await local.session.compact();
    const staged = await f.store.stagedId(f.id);
    expect(staged).not.toBeNull();
    release();
    expect(await projecting).toEqual(before);
    expect(projectedCommit).toHaveBeenCalledTimes(0);
    expect((await f.store.latest(f.id))?.id).toBe(f.archiveId);
    expect(await f.store.stagedId(f.id)).toBe(staged);
    expect(local.counts()).toEqual({ providerCalls: 0, summaryCalls: 0, toolCalls: 0 });
  } finally {
    release();
    await projecting;
    measurement.mockRestore();
    projectedCommit.mockRestore();
    adoption.mockRestore();
    local.session.dispose();
  }
});
