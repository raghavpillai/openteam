import { expect, test } from "bun:test";
import { graphicalProgressReminder } from "../../src/runtime/graphical-completion";
import type { BotMessage } from "../../src/bot-compaction";
import { routeEvent } from "../../src/runtime/events";
import type { ActiveTurn } from "../../src/runtime/types";

test("graphical checkpoints occur during work, bounded by the user task and prior checkpoint", () => {
  const active = { subagentType: "computerUse", lastStopReason: "toolUse" } as ActiveTurn;
  const result = { role: "toolResult", toolName: "browser_snapshot", content: [] } as BotMessage;
  const twelve = Array.from({ length: 12 }, () => result);
  expect(graphicalProgressReminder(twelve.slice(1), active)).toBeNull();
  expect(graphicalProgressReminder(twelve, active)).toContain("still active");
  expect(graphicalProgressReminder(twelve, active)).toContain("actual user deadline");
  expect(graphicalProgressReminder([...twelve, { role: "custom", customType: "openteam-graphical-progress" }, result], active)).toBeNull();
  expect(graphicalProgressReminder([...twelve, { role: "user", content: "New task" }, result], active)).toBeNull();
  expect(graphicalProgressReminder([...twelve, { role: "assistant", content: "Finished" }], active)).toBeNull();
  for (const change of [{ subagentType: null }, { endTurnRequested: true }, { lastStopReason: "aborted" }, { lastStopReason: "error" }, { pluginAbortController: { signal: AbortSignal.abort() } }]) {
    expect(graphicalProgressReminder(twelve, { ...active, ...change } as ActiveTurn)).toBeNull();
  }
});

test("failed tool events keep the error flag in the persisted result", () => {
  const events: any[] = [];
  const active = {
    turnId: "turn",
    toolArgs: new Map(),
    queue: { push: (event: any) => events.push(event) },
  } as unknown as ActiveTurn;
  routeEvent(undefined, active, {
    type: "tool_execution_end",
    toolCallId: "task",
    toolName: "Task",
    isError: true,
    result: { content: [{ type: "text", text: "Review rejected the request" }], details: {} },
  } as any);
  expect(events[0].item.status).toBe("failed");
  expect(events[0].item.result.isError).toBe(true);
});

test("a computerUse turn ends when the model ends it, with no extra verification prompt", async () => {
  const { ComputerRuntime } = await import("../../src/runtime");
  const runtime = new ComputerRuntime() as any;
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  const prompts: string[] = [];
  const events: any[] = [];
  const active = {
    subagentType: "computerUse", requestSource: "subagent", lastStopReason: "stop", turnId: "turn", runId: "run",
    contextSessionId: "context", attachmentTempDirectories: [], sentMessageCount: 0,
    session: { prompt: async (text: string) => { prompts.push(text); }, messages: [], getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [] },
    queue: { push: (event: any) => events.push(event), end() {} },
  } as any;
  await runtime.execute(active, "Open the fixture page.", []);
  expect(prompts).toEqual(["Open the fixture page."]);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
});

test("the computerUse breaker counts only real consecutive failures", async () => {
  const { observeGraphicalToolResult, COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES } = await import("../../src/runtime/graphical-completion");
  const active = { subagentType: "computerUse" } as ActiveTurn;
  for (let i = 0; i < COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES - 1; i++) observeGraphicalToolResult(active, true, "net::ERR_CONNECTION_REFUSED");
  observeGraphicalToolResult(active, true, "Operation aborted");
  expect(active.toolFailureBreakerTripped).toBeUndefined();
  observeGraphicalToolResult(active, false, "Clicked");
  expect(active.toolFailureStreak).toEqual([]);
  for (let i = 0; i < COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES; i++) observeGraphicalToolResult(active, true, "net::ERR_CONNECTION_REFUSED");
  expect(active.toolFailureBreakerTripped).toBe(true);
  expect(active.endTurnRequested).toBe(true);
  const executor = { subagentType: "executor" } as ActiveTurn;
  for (let i = 0; i < 30; i++) observeGraphicalToolResult(executor, true, "failed");
  expect(executor.toolFailureBreakerTripped).toBeUndefined();
});

test("a computerUse report with leaked tool-call markup becomes a blocked report", async () => {
  const { blockedReportForRawToolCall } = await import("../../src/runtime/graphical-completion");
  expect(blockedReportForRawToolCall("Status: done\nI opened the page.\n<function=browser_click>{\"ref\":\"e1\"}</function>")).toBe(
    "Status: blocked\n\nI tried to call browser_click, which I do not have here, so that step was not done.\n\nI opened the page."
  );
  expect(blockedReportForRawToolCall("<tool_call>{}</tool_call>")).toBe(
    "Status: blocked\n\nI tried to call a tool, which I do not have here, so that step was not done."
  );
  expect(blockedReportForRawToolCall("Status: done\nAll set.")).toBeUndefined();
  const { graphicalFinalReport } = await import("../../src/runtime/graphical-completion");
  const active = { subagentType: "computerUse", runId: "r", lastAgentMessage: { id: "assistant:r:3", text: "Done.\n<tool_call>{}</tool_call>" } } as any;
  // The relayed report replaces the leaked text in place.
  expect(graphicalFinalReport(active, [])).toEqual({ id: "assistant:r:3", text: "Status: blocked\n\nI tried to call a tool, which I do not have here, so that step was not done.\n\nDone." });
  expect(graphicalFinalReport({ ...active, subagentType: "executor" }, [])).toBeNull();
});

test("a computer that fails 20 calls in a row ends the worker with the blocked report", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
  const { ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { BotCompactionArchiveStore, BotCompactionCoordinator } = await import("../../src/bot-compaction");
  const { ComputerRuntime } = await import("../../src/runtime");
  const root = await mkdtemp(join(tmpdir(), "graphical-breaker-"));
  const model: any = {
    id: "breaker-fixture", name: "Breaker fixture", provider: "openai", api: "openai-completions",
    baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text", "image"], contextWindow: 100_000,
    maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let requests = 0;
  try {
    const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (_model, context, options) => streamSimple(model, context, {
      ...options, apiKey: "fixture", maxRetries: 0,
      fetch: (async () => {
        requests++;
        const content = requests === 1 ? "Opening the booking page now." : null;
        const delta = { role: "assistant", ...(content ? { content } : {}), tool_calls: [{ index: 0, id: `click-${requests}`, type: "function", function: { name: "Lookup", arguments: "{}" } }] };
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
    const runtime = new ComputerRuntime() as any;
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => model;
    runtime.compaction = new BotCompactionCoordinator(new BotCompactionArchiveStore(join(root, "archives")), 0);
    runtime.cleanup = async (active: any) => active.session?.dispose();
    runtime.tools = {
      customTools: () => [{ name: "Lookup", label: "Lookup", description: "Read the desktop", parameters: { type: "object", properties: {} },
        execute: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9222"); } }],
      acknowledgeToolOutcomes: async () => {},
    };
    const events: any[] = [];
    const active: any = {
      contextSessionId: crypto.randomUUID(), runId: "breaker-run", turnId: "breaker-turn",
      modelRef: { providerId: model.provider, modelId: model.id }, reasoning: "off", cwd: root,
      instructions: "Operate the desktop.", subagentType: "computerUse", requestSource: "subagent",
      userInfoMessage: null, pluginAbortController: new AbortController(),
      queue: { push: (event: any) => events.push(event), end() {} }, toolArgs: new Map(), startedItems: new Set(),
      assistantOrdinal: 0, attachmentTempDirectories: [], sentMessageCount: 0,
    };
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    const session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    runtime.bindTurnStop(active, session);
    session.subscribe((event: any) => runtime.routeEvent(active, event));
    await runtime.execute(active, "Book the table.", []);
    expect(requests).toBe(20);
    const reports = events.filter((event) => event.type === "item.completed" && event.item.type === "agentMessage");
    expect(reports.at(-1).item.text).toBe([
      "Status: blocked",
      "The computer is unreachable: the last 20 tool calls all failed with no success in between, so the helper stopped. Last errors: tool_error (20).",
      "Its last update:\n\nOpening the booking page now.",
    ].join("\n\n"));
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
