import { expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { BotCompactionArchiveStore, BotCompactionCoordinator, type BotMessage, sha256 } from "../../src/bot-compaction";
import type { BotArchiveCommitInput } from "../../src/compaction/types";
import { compactionExtension, compactionObservation, inferCompaction } from "../../src/runtime/compaction";
import { prepareCompactionHistory, recoverStagedPiCompaction } from "../../src/runtime/compaction-history";
import type { ActiveTurn } from "../../src/runtime/types";
import { tempDirs } from "../temp";
import { answer as assistant, offlineComputerRuntime, offlineModel, openSession, piTurn, requestBody, sseResponse, sseStep, toolCall, usage } from "./pi-fixtures";
const tempDir = tempDirs();

const model = offlineModel("compaction-fixture");
const answer = (text: string, stopReason: Parameters<typeof assistant>[2] = "stop") => assistant(model, text, stopReason);
const modelRef = { providerId: model.provider, modelId: model.id };
const request = { systemPrompt: "Original system fixture", userInfoMessage: null, messagesToSummarize: [{ role: "user", content: "Keep blue" }], shorter: false };
const infer = (runtime: unknown, tools: unknown[], summarize: unknown[]) =>
  inferCompaction(runtime as ModelRuntime, () => model, () => tools as never, { modelRef, reasoning: "off" } as ActiveTurn,
    { ...request, messagesToSummarize: summarize as BotMessage[] }, new AbortController().signal);

/** The compaction extension's Pi hooks for `active`. */
function hooks(coordinator: unknown, active: unknown, summarize: () => Promise<{ text: string }>, messages: BotMessage[] = []) {
  const handlers: Record<string, (event: any) => Promise<any>> = {};
  compactionExtension(coordinator as BotCompactionCoordinator, summarize, { buildSessionContext: () => ({ messages }) } as unknown as SessionManager, active as ActiveTurn)
    .factory({ on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
  return handlers;
}

/** Tool host stand-in exposing one synthetic tool that returns `text`. */
const toolHost = (name: string, text: string, onRun: () => void) => ({
  userForms: { beginTurn: async () => {}, endTurn: async () => {} },
  customTools: () => [{
    name, label: name, description: `Synthetic ${name}`, parameters: { type: "object", properties: {} },
    execute: async () => { onRun(); await new Promise<void>((resolve) => setImmediate(resolve)); return { content: [{ type: "text", text }], details: {} }; },
  }],
  acknowledgeToolOutcomes: async () => {},
  cancelApprovals() {},
});
const status = (events: any[]) => events.filter((event) => event.type === "turn.completed").at(-1)?.status;

test("summary adapter rejects error, length and aborted stops even with partial output", async () => {
  for (const stopReason of ["error", "length", "aborted"] as const) {
    const runtime = { completeSimple: async () => ({ ...answer("Unfinished prose", stopReason), errorMessage: "Fixture failure" }) };
    await expect(infer(runtime, [], request.messagesToSummarize)).rejects.toThrow("Fixture failure");
  }
});

test("summary requests retain system authority, transform custom messages, omit malformed images, and never execute tools", async () => {
  let captured: any;
  let executed = false;
  const image = { type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" };
  const receipt = { role: "toolResult", toolCallId: "read-image", toolName: "Read", content: [image], isError: false, timestamp: 1 };
  const tool = { name: "Read", description: "Read files", parameters: {}, execute: async () => { executed = true; throw new Error("must not execute"); } };
  const runtime = { completeSimple: async (_model: unknown, context: unknown) => { captured = context; return answer("Ready"); } };
  const result = await infer(runtime, [tool], [
    ...request.messagesToSummarize,
    { role: "custom", customType: "openteam-ambient", content: "Background job completed", display: false },
    receipt,
  ]);
  expect(result.text).toBe("Ready");
  expect(executed).toBe(false);
  expect(captured.systemPrompt).toBe(request.systemPrompt);
  expect(captured.tools[0].execute).toBeUndefined();
  expect(captured.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "Background job completed" }] });
  expect(JSON.stringify(captured.messages)).toContain("image omitted");
  expect(JSON.stringify(captured.messages)).not.toContain(image.data);
  expect(receipt.content[0]).toBe(image);
  expect(captured.messages.at(-1).content[0].text).toContain("<summary_request>");
});

test("summary serialization repairs an in-flight tool exchange and ignores returned tool calls", async () => {
  let sent: any;
  let executed = false;
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "<think>internal</think>  Keep blue\n" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [toolCall(0, "forbidden", "Read")] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const runtime = {
    completeSimple: (_model: unknown, context: any, options: any) =>
      streamSimple(model, context, { ...options, apiKey: "synthetic-fixture", maxRetries: 0,
        fetch: (async (_url: unknown, init: any) => { sent = await requestBody(init); return sseResponse(model, chunks); }) as typeof fetch,
      }).result(),
  };
  const tool = { name: "Read", description: "Read fixture", parameters: { type: "object", properties: {} }, execute: async () => { executed = true; throw Error("must not execute"); } };
  const result = await infer(runtime, [tool], [
    request.messagesToSummarize[0]!,
    { ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "pending-read", name: "Read", arguments: {} }] },
  ]);
  expect(result.text).toBe("  Keep blue\n");
  expect(executed).toBe(false);
  const callIndex = sent.messages.findIndex((message: any) => message.tool_calls?.[0]?.id === "pending-read");
  expect(callIndex).toBeGreaterThan(0);
  expect(sent.messages[callIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "pending-read" });
  expect(JSON.stringify(sent.messages.at(-1).content)).toContain("<summary_request>");
});

test("streamed input usage starts a summary before assistant completion and every entry point captures durable state", async () => {
  const root = await tempDir("compaction-stream-");
  const coordinator = new BotCompactionCoordinator(new BotCompactionArchiveStore(root), 0);
  const messages: BotMessage[] = [
    { role: "user", content: "Old request" },
    { role: "assistant", content: "Old work" },
    { role: "user", content: "Latest correction" },
  ];
  let usedTokens = 100;
  let calls = 0;
  const active = {
    contextSessionId: crypto.randomUUID(), instructions: "System", modelRef, reasoning: "off", userInfoMessage: null,
    todoUpdate: "Current todo", isRootProject: true, cwd: root, sessionPath: "/fixture/transcript", sentMessageCount: 1,
    requestSource: "turn", queue: { push() {} },
    session: { messages, model, getContextUsage: () => ({ tokens: usedTokens, contextWindow: model.contextWindow }), getAllTools: () => [], getActiveToolNames: () => [] },
  } as unknown as ActiveTurn;
  const handlers = hooks(coordinator, active, async () => { calls++; return { text: "Ready" }; }, messages);
  try {
    await handlers.context!({ messages });
    await handlers.message_start!({ message: { role: "assistant" } });
    const partial = { ...answer("in progress"), usage: usage(60_000), earlyCompactionContextTokenThreshold: 60_000 };
    await handlers.message_update!({ assistantMessageEvent: { type: "text_delta", partial, delta: "progress" } });
    expect(calls).toBe(1);
    expect(active.compactionEarlyThreshold).toBe(60_000);
    expect(compactionObservation(active)).toMatchObject({ todoUpdate: "Current todo", isRootProject: true, transcriptPath: "/fixture/transcript" });
    usedTokens = 60_000;
    messages.push({ ...answer("completed"), usage: usage(60_000) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rendered = JSON.stringify(await coordinator.modelContextMessages(compactionObservation(active)));
    for (const value of ["Current todo", "Project root:", "cursor.ReadTranscript and no id"]) expect(rendered).toContain(value);
    // The session file is private runtime storage; the carrier names no path or automation trigger.
    expect(rendered).not.toContain("fixture/transcript");
    expect(rendered).not.toContain("automation_trigger");
    expect(compactionObservation({ ...active, subagentType: "executor" } as ActiveTurn).transcriptPath).toBeUndefined();
    await handlers.message_start!({ message: { role: "assistant" } });
    expect(active.compactionEarlyThreshold).toBeUndefined();
  } finally {
    coordinator.discardBackground(active.contextSessionId);
  }
});

// Exercise Pi's native overflow, persistence, tool loop, and reopened-session paths.
for (const scenario of ["overflow", "overflow-tools", "overflow-exhausted"] as const) {
  test(`real Pi ${scenario} recovery preserves one conversation across reopen`, async () => {
    const root = await tempDir("compaction-overflow-qa-");
    const store = new BotCompactionArchiveStore(join(root, "archives"));
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const events: any[] = [];
    const requests: any[] = [];
    const summaryRequests: any[] = [];
    const sessions: any[] = [];
    let toolExecutions = 0;
    try {
      const runtime = await offlineComputerRuntime(model, root, async (_url, init) => {
        requests.push(await requestBody(init));
        if (requests.length === 1 || scenario === "overflow-exhausted")
          return Response.json({ error: { message: "This model's maximum context length is 100000 tokens. context_length_exceeded", code: "context_length_exceeded", type: "invalid_request_error" } }, { status: 400 });
        const useTool = scenario === "overflow-tools" && requests.length === 2;
        return sseStep(model, useTool ? [toolCall(0, "read-blue", "ReadBlue")] : `Reply ${requests.length}`, useTool ? 91_000 : 500);
      });
      runtime.modelRuntime.completeSimple = async (_model: unknown, context: unknown) => {
        summaryRequests.push(context);
        return answer(`Summary ${summaryRequests.length}: preserve blue and the tests.`);
      };
      runtime.compaction = coordinator;
      runtime.compactionArchive = store;
      runtime.tools = toolHost("ReadBlue", "BLUE_RESULT_791", () => toolExecutions++);
      const run = async (manager: SessionManager, prompt: string) => {
        // This provider fixture tests compaction, and exposes no delivery tool.
        const active: any = piTurn(model, root, { contextSessionId, sentMessageCount: 1, endTurnRequested: true, queue: { push: (event: unknown) => events.push(event), end() {} } });
        const session = await openSession(runtime, active, manager);
        sessions.push(session);
        await runtime.execute(active, prompt, []);
        return { session, active };
      };
      const manager = SessionManager.create(root, join(root, "sessions"), { id: contextSessionId });
      manager.appendMessage({ role: "user", content: "Original red", timestamp: 1 });
      manager.appendMessage(answer("Old red work"));
      const first = await run(manager, "Keep blue");
      if (scenario === "overflow-exhausted") {
        // Five overflowing model calls for one step, never a sixth.
        expect(requests).toHaveLength(5);
        expect(summaryRequests).toHaveLength(5);
        expect((await store.manifest(contextSessionId)).epoch).toBe(5);
        expect(status(events)).toBe("failed");
        expect(events.filter((event) => event.type === "runtime.error").at(-1)?.message).toContain("summarization-retries");
        return;
      }
      expect(status(events)).toBe("completed");
      expect(requests.length).toBe(scenario === "overflow-tools" ? 3 : 2);
      expect(summaryRequests.length).toBe(scenario === "overflow-tools" ? 2 : 1);
      const reopened = SessionManager.open(first.active.sessionPath!, join(root, "sessions"), root);
      const before = await coordinator.contextMessages(contextSessionId, first.active.compactionReadPiMessages?.() ?? (first.session.messages as BotMessage[]));
      const after = await coordinator.contextMessages(contextSessionId, reopened.buildSessionContext().messages as BotMessage[]);
      expect(after).toEqual(before);
      expect(after.filter((message) => message.role === "assistant" && message.stopReason === "error")).toHaveLength(0);
      await run(reopened, "Also check green");
      expect(events.filter((event) => event.type === "turn.completed").map((event) => event.status)).toEqual(["completed", "completed"]);
      expect(JSON.stringify(requests.at(-1))).toContain("Also check green");
      expect(JSON.stringify(requests.at(-1))).not.toContain("Old red work");
      expect((await store.manifest(contextSessionId)).epoch).toBe(scenario === "overflow-tools" ? 2 : 1);
      if (scenario === "overflow-tools") {
        expect(toolExecutions).toBe(1);
        expect(JSON.stringify(requests.at(-1)).match(/BLUE_RESULT_791/g)).toHaveLength(1);
        const results = requests[2].messages.filter((message: any) => message.role === "tool");
        expect(results).toHaveLength(1);
        expect(requests[2].messages.some((message: any) => message.tool_calls?.some((call: any) => call.id === results[0].tool_call_id))).toBe(true);
      }
      // A mid-turn summary keeps the turn's prompt.
      expect(requests.every((request: any) => JSON.stringify(request.messages[0]).includes("System fixture"))).toBe(true);
    } finally {
      coordinator.discardBackground(contextSessionId);
      for (const session of sessions) session.dispose();
    }
  }, 10_000);
}

test("a too-many-images error is recovered as an overflow, labeled as an image-limit summary", async () => {
  const { isContextOverflow } = await import("@earendil-works/pi-ai");
  const forced: string[] = [];
  const coordinator = { forceReason: (_id: string, reason: string) => forced.push(reason), observe: async () => {} };
  const messages: BotMessage[] = [{ role: "user", content: "Look at these" }];
  const active = {
    contextSessionId: crypto.randomUUID(), instructions: "System", modelRef, reasoning: "off", userInfoMessage: null, cwd: "/tmp",
    session: { messages, model, getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [] },
    queue: { push() {} },
  };
  const handlers = hooks(coordinator, active, async () => ({ text: "" }), messages);
  const failed = { ...answer(""), stopReason: "error", errorMessage: "400 Request contained too many images or documents (max 100)" };
  const replaced = await handlers.message_end!({ message: failed });
  expect(forced).toEqual(["approaching_image_limit"]);
  expect(isContextOverflow(replaced.message, model.contextWindow)).toBe(true);
  expect(isContextOverflow(failed as never, model.contextWindow)).toBe(false);
  expect(await handlers.message_end!({ message: { ...failed, errorMessage: "500 server error" } })).toBeUndefined();
});

test("failed summary preparation explicitly cancels native Pi fallback", async () => {
  const coordinator = { beforePiCompaction: async () => { throw Error("synthetic summary failure"); } };
  const handlers = hooks(coordinator, { contextSessionId: crypto.randomUUID(), instructions: "System", modelRef: {}, queue: { push() {} } }, async () => ({ text: "unused" }));
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handlers.session_before_compact!({ reason: "manual", preparation: { firstKeptEntryId: "kept", tokensBefore: 10 }, signal: new AbortController().signal })).toEqual({ cancel: true });
  } finally {
    log.mockRestore();
  }
});

// Restart recovery of an archive created against an older native Pi coordinate system.
const appendSend = (manager: SessionManager, id: string, receipt: string, args: Record<string, unknown> = {}) => {
  manager.appendMessage({ ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name: "SendToUser", arguments: args }] });
  manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "SendToUser", content: [{ type: "text", text: receipt }], isError: false, timestamp: 2 });
};
const archiveInput = (id: string, count: number): BotArchiveCommitInput => ({
  id, reason: "self_summary_completed", summary: "Original archive: keep the current request", prefixDigest: sha256("synthetic"),
  piBaseMessageCount: count, userInfoMessage: null, lastUserMessage: { role: "user", content: "Current request", timestamp: 1 },
  preservedTailMessages: [], summarizedMessages: [], tokensBefore: 500_944, tokensAfter: 100, imageCount: 0, turnCount: 1, usage: null,
  startedAt: "2001-01-01T00:00:00.000Z", completedAt: "2001-01-01T00:00:01.000Z",
});
async function archived(kind: "owned" | "projected" | "anchored" = "owned", grow = 0) {
  const root = await tempDir("compaction-recovery-");
  const store = new BotCompactionArchiveStore(join(root, "archive"));
  const coordinator = new BotCompactionCoordinator(store, 0);
  const id = crypto.randomUUID(), archiveId = crypto.randomUUID();
  const manager = SessionManager.create(root, join(root, "sessions"), { id });
  const entries: string[] = [];
  // An older native checkpoint deliberately makes raw message indexes differ
  // from the Pi coordinate system the archive was actually created against.
  for (let i = 0; i < 1600; i++) entries.push(manager.appendMessage({ role: "user", content: `old-${i}`, timestamp: i }));
  const basis = manager.appendCompaction("Prior Pi view", entries[108]!, 400_000);
  manager.getEntry(basis)!.timestamp = "2000-01-01T00:00:00.000Z";
  const checkpoint = kind === "owned"
    ? manager.appendCompaction("Original archive: keep the current request", entries[109]!, 500_944, { openteamBotCompaction: true, id: archiveId }, true)
    : basis;
  expect(manager.buildSessionContext().messages).toHaveLength(1493);
  await store.commit(id, { ...archiveInput(archiveId, 1493), ...(kind === "anchored" ? { piBoundary: { leafId: checkpoint, compactionEntryId: basis } } : {}) });
  manager.appendCustomEntry("openteam-compaction-usage", { compactionId: archiveId, epoch: 1, inputTokens: 100, source: "provider" });
  appendSend(manager, "sent-once", "SEND_RECEIPT_791", { text: "Delivered" });
  manager.appendCustomMessageEntry("fixture-notice", "CUSTOM_AFTER_ARCHIVE_792", false);
  const later: string[] = [];
  for (let i = 0; i < 800; i++) later.push(manager.appendMessage({ role: "user", content: `later-${i}`, timestamp: 3 }));
  manager.appendCompaction("Native summary must never replace the archive's coordinate", later[109]!, 500_944, undefined, false);
  expect(manager.buildSessionContext().messages).toHaveLength(692);
  for (let i = 0; i < grow; i++) manager.appendMessage({ role: "user", content: `after-native-${i}`, timestamp: 4 });
  const path = manager.getSessionFile()!;
  await writeFile(path, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { root, store, coordinator, id, archiveId, path, checkpoint, open: () => SessionManager.open(path, join(root, "sessions"), root) };
}

async function localRuntime(f: Awaited<ReturnType<typeof archived>>, deliver = false) {
  let providerCalls = 0, summaryCalls = 0, toolCalls = 0;
  const requests: any[] = [], events: any[] = [];
  const runtime = await offlineComputerRuntime(model, f.root, async (_url, init) => {
    providerCalls++;
    requests.push(await requestBody(init));
    return sseStep(model, deliver && providerCalls === 1 ? [toolCall(0, "fresh-send", "SendToUser")] : "Continue from the persisted receipt", 100);
  });
  runtime.modelRuntime.completeSimple = async () => { summaryCalls++; return answer("Unexpected summary"); };
  runtime.compaction = f.coordinator;
  runtime.compactionArchive = f.store;
  runtime.tools = toolHost("SendToUser", "NEW_SEND_RECEIPT_793", () => toolCalls++);
  const active: any = piTurn(model, f.root, { contextSessionId: f.id, queue: { push: (event: any) => events.push(event), end() {} } });
  const session = await openSession(runtime, active, f.open());
  return { runtime, session, active, requests, events, counts: () => ({ providerCalls, summaryCalls, toolCalls }) };
}

for (const grow of [0, 801, 1000])
  test(`real local ComputerRuntime recovers persisted 1493 -> ${692 + grow} native context`, async () => {
    const f = await archived("owned", grow);
    const original = await readFile(f.path, "utf8");
    const local = await localRuntime(f);
    try {
      await local.runtime.execute(local.active, "Continue without resending the delivered message", []);
      expect(local.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
      expect(status(local.events)).toBe("completed");
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
    const f = await archived(kind);
    const before = await readFile(f.path, "utf8");
    let first: BotMessage[] | undefined;
    for (let i = 0; i < 3; i++) {
      const history = await prepareCompactionHistory(new BotCompactionCoordinator(f.store, 0), f.store, f.open(), f.id);
      const projected = await f.coordinator.contextMessages(f.id, history.read());
      if (first) expect(projected).toEqual(first);
      else first = projected;
      expect(JSON.stringify(projected).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
      expect(projected.some((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((part: any) => part.id === "sent-once"))).toBe(true);
      expect(history.hasUnmeasuredRecovery()).toBe(true);
      const active = { contextSessionId: f.id, instructions: "System", modelRef: {}, compactionReadPiMessages: history.read, compactionUsageInvalidated: history.hasUnmeasuredRecovery } as unknown as ActiveTurn;
      expect(compactionObservation(active).usedTokens).toBeNull();
    }
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

test("missing archive ancestry fails closed even on a longer branch with duplicate-looking messages", async () => {
  const f = await archived("anchored");
  const manager = f.open();
  manager.branch(manager.getBranch()[0]!.id);
  for (let i = 0; i < 1600; i++) manager.appendMessage({ role: "user", content: `old-${i}`, timestamp: i });
  expect(manager.buildSessionContext().messages.length).toBeGreaterThan(1493);
  await expect(prepareCompactionHistory(f.coordinator, f.store, manager, f.id)).rejects.toThrow("cannot prove archive branch boundary");
});

test("staged restart adopts at the matching compaction, preserving later tool receipts once", async () => {
  const f = await archived();
  await f.store.remove(f.id);
  const manager = f.open();
  const staged = crypto.randomUUID();
  const { piBaseMessageCount, ...intent } = archiveInput(staged, 1);
  await f.store.stage(f.id, intent);
  const kept = manager.appendMessage({ role: "user", content: "Checkpoint request", timestamp: 4 });
  const checkpoint = manager.appendCompaction("Staged summary", kept, 500_000, { openteamBotCompaction: true, id: staged }, true);
  appendSend(manager, "later-send", "LATER_RECEIPT");
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

test("manifest adoption failure keeps old coordinates in-session and recovers the staged checkpoint on reopen", async () => {
  const f = await archived("owned", 2);
  const local = await localRuntime(f);
  const commit = spyOn(f.store, "commitStaged").mockRejectedValue(Error("synthetic manifest write failure"));
  try {
    await local.session.compact();
    expect((await f.store.latest(f.id))?.id).toBe(f.archiveId);
    expect(await f.store.stagedId(f.id)).not.toBeNull();
    // The hook error is swallowed by Pi, so the reader must remain usable with
    // the old manifest until the staged checkpoint can be adopted.
    const projected = await f.coordinator.contextMessages(f.id, local.active.compactionReadPiMessages());
    expect(JSON.stringify(projected).match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(local.active.compactionReadPiBoundary().compactionEntryId).toBe(f.checkpoint);
    commit.mockRestore();
    const reopened = f.open();
    reopened.appendCustomMessageEntry("after-failed-adoption", "LATE_ADOPTION_NOTICE", false);
    const history = await prepareCompactionHistory(new BotCompactionCoordinator(f.store, 0), f.store, reopened, f.id);
    const recovered = await f.store.contextMessages(f.id, history.read());
    expect(JSON.stringify(recovered).match(/LATE_ADOPTION_NOTICE/g)).toHaveLength(1);
    expect(await f.store.stagedId(f.id)).toBeNull();
    expect((await f.store.latest(f.id))?.id).not.toBe(f.archiveId);
  } finally {
    commit.mockRestore();
    local.session.dispose();
  }
});

test("synthetic SendToUser executes once, and its durable outcome survives another native compaction and runtime restart", async () => {
  const f = await archived();
  const first = await localRuntime(f, true);
  try {
    await first.runtime.execute(first.active, "Send a new, distinct synthetic response", []);
    expect(first.counts()).toEqual({ providerCalls: 2, summaryCalls: 0, toolCalls: 1 });
    expect(first.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
  } finally {
    first.session.dispose();
  }
  const manager = f.open();
  manager.appendCompaction("Another native compaction", manager.getLeafId()!, 500_944, undefined, false);
  const second = await localRuntime(f);
  try {
    await second.runtime.execute(second.active, "Continue after the completed delivery", []);
    expect(second.counts()).toEqual({ providerCalls: 1, summaryCalls: 0, toolCalls: 0 });
    const request = JSON.stringify(second.requests[0]);
    expect(request.match(/NEW_SEND_RECEIPT_793/g)).toHaveLength(1);
    expect(request.match(/SEND_RECEIPT_791/g)).toHaveLength(1);
    expect(second.events.filter((event: any) => event.type === "runtime.error")).toEqual([]);
    expect(status(second.events)).toBe("completed");
  } finally {
    second.session.dispose();
  }
});
