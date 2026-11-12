import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { replaceTaskProgressContext } from "@openteam/contracts/task-progress";
import { ComputerRuntime } from "../../src/runtime";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { compactionObservation } from "../../src/runtime/compaction";

const input = {
  key: "generated",
  state: "working",
  summary: "Generated the requested artifact",
  evidence: ["/documents/export"],
  remaining: ["Confirm destination receipt"],
  nextAction: "Check receipt",
};
test("worker progress keeps the turn alive, waiting parks it, and compaction sees the latest obligations", async () => {
  let deferred = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { arguments: args } = (await req.json()) as { arguments: Record<string, unknown> };
      return Response.json({
        saved: true,
        deferred,
        progress: { ...args, runId: "run", revision: deferred ? 2 : 1 },
      });
    },
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: "executor",
      pluginNamespaces: [],
      botId: "child",
      instructions: "Original authorization and scope.",
      modelRef: {},
      reasoning: "low",
      compactionReadPiMessages: () => [],
      cwd: "/tmp",
      contextSessionId: "context",
    } as unknown as ActiveTurn;
    const progress = tools.customTools(turn).find((t) => t.name === "ReportTaskProgress")!;
    expect(progress).toBeDefined();
    await progress.execute("progress", input, undefined, undefined, {} as never);
    expect(turn.endTurnRequested).not.toBe(true);
    expect(turn.instructions).toContain("Confirm destination receipt");
    expect(compactionObservation(turn).systemPrompt).toBe("Original authorization and scope.");
    deferred = true;
    await progress.execute(
      "wait",
      { ...input, state: "waiting", checkAt: new Date(Date.now() + 3600_000).toISOString() },
      undefined,
      undefined,
      {} as never
    );
    expect(turn.endTurnRequested).toBe(true);
    expect(turn.instructions.split("<durable_task_state>")).toHaveLength(2);
  } finally {
    server.stop(true);
  }
});
test("only work-capable delegated workers hold progress; terminating WakeParent is unchanged", () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  for (const kind of ["executor", "knowledgeWork", "computerUse"]) {
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: kind,
      pluginNamespaces: [],
    } as unknown as ActiveTurn;
    const names = tools.customTools(turn).map((t) => t.name);
    expect(names).toContain("ReportTaskProgress");
    expect(names).not.toContain("WakeParent");
  }
  const ordinary = {
    requestSource: "turn",
    runtimeProfile: "agent",
    subagentType: null,
    pluginNamespaces: [],
  } as unknown as ActiveTurn;
  expect(tools.customTools(ordinary).map((t) => t.name)).not.toContain("ReportTaskProgress");
});
test("a failed progress write neither ends the task nor invents saved state", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ error: "database unavailable" }, { status: 503 }),
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "agent",
      runtimeProfile: "subagent",
      subagentType: "computerUse",
      pluginNamespaces: [],
      botId: "child",
      instructions: "Original scope",
    } as unknown as ActiveTurn;
    await expect(
      tools
        .customTools(turn)
        .find((t) => t.name === "ReportTaskProgress")!
        .execute("failed", input, undefined, undefined, {} as never)
    ).rejects.toThrow();
    expect(turn.endTurnRequested).not.toBe(true);
    expect(turn.instructions).toBe("Original scope");
  } finally {
    server.stop(true);
  }
});

test("a parent saves a separate request wait, carries it into compaction, and workers cannot access that operation", async () => {
  const requestId = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const request = await req.json() as any;
      expect(request.tool).toBe("ReportRequestProgress");
      return Response.json({ request_run_id: requestId, deferred: request.arguments.state === "waiting", ended: request.arguments.state === "complete",
        requests: request.arguments.state === "complete" ? [] : [{ request_run_id: requestId, progress: request.arguments }] });
    },
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const active = { requestSource: "turn", runtimeProfile: "agent", subagentType: null,
      pluginNamespaces: [], botId: "owner", instructions: "Only one outgoing message is approved.",
      modelRef: {}, reasoning: "low", compactionReadPiMessages: () => [], cwd: "/tmp", contextSessionId: "context" } as unknown as ActiveTurn;
    const operation = tools.customTools(active).find(t => t.name === "ReportRequestProgress")!;
    expect(operation).toBeDefined();
    const waiting = await operation.execute("wait", { ...input, state: "waiting", checkAt: new Date(Date.now() + 3600_000).toISOString() }, undefined, undefined, {} as never);
    expect((waiting as any).terminate).toBe(true);
    expect(active.endTurnRequested).toBe(true);
    const snapshot = active.instructions;
    expect(snapshot).toContain(requestId);
    expect(snapshot).toContain("Confirm destination receipt");
    expect(snapshot).toContain("Only one outgoing message is approved.");
    expect(compactionObservation(active).systemPrompt).toBe("Only one outgoing message is approved.");
    const next = { ...active, endTurnRequested: false };
    const complete = await tools.customTools(next).find(t => t.name === "ReportRequestProgress")!
      .execute("complete", { ...input, state: "complete", remaining: [] }, undefined, undefined, {} as never);
    expect((complete as any).terminate).toBe(true);
    expect(next.endTurnRequested).toBe(true);
    expect(tools.customTools({ ...active, runtimeProfile: "subagent", subagentType: "executor" }).map(t => t.name)).not.toContain("ReportRequestProgress");
    expect(tools.customTools({ ...active, requestSource: "automation" }).map(t => t.name)).not.toContain("ReportRequestProgress");
  } finally { server.stop(true); }
});

test("real provider requests retain their prefix when task snapshots are unchanged or advanced", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-cache-"));
  const runtime = new ComputerRuntime() as any;
  const requests: any[] = [];
  const model: any = { id: "task-cache-fixture", provider: "openai", api: "openai-completions",
    name: "Task cache", baseUrl: "https://offline.invalid/v1", contextWindow: 100_000,
    maxTokens: 1000, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false });
  provider.checkAuth = async () => ({ type: "api_key" });
  provider.streamSimple = (_m, context, options) => streamSimple(model, context, {
    ...options, apiKey: "fixture", maxRetries: 0,
    fetch: (async (_url: any, init: any) => {
      requests.push(JSON.parse(await new Response(init.body).text()));
      const tool = requests.length <= 3;
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0,
        id: `inspect-${requests.length}`, type: "function",
        function: { name: "InspectFixture", arguments: "{}" } }] }
        : { role: "assistant", content: "Status: done\nVerified the requested outcome." };
      const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } }];
      return new Response(chunks.map(c => `data: ${JSON.stringify({ id: `response-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: model.id, ...c })}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  const snapshot = (revision: number) => replaceTaskProgressContext("Keep the original approval and limits.", {
    runId: "fixture-run", revision, state: "working", summary: `Verified receipt revision ${revision}`,
    evidence: ["/requests/receipt"], remaining: ["Inspect the pending document without sending"], nextAction: "Inspect only",
  });
  const active: any = { runId: "fixture-run", turnId: crypto.randomUUID(), botId: "fixture-bot",
    contextSessionId: crypto.randomUUID(), modelRef: { providerId: model.provider, modelId: model.id },
    reasoning: "off", instructions: snapshot(1), userInfoMessage: null, cwd: root,
    runtimeProfile: "subagent", subagentType: "executor", requestSource: "agent",
    resetSelfSummaryCount: true, sentMessageCount: 0, assistantOrdinal: 0,
    startedItems: new Set(), toolArgs: new Map(), attachmentTempDirectories: [],
    queue: { push() {}, end() {} } };
  let inspections = 0;
  runtime.agentDir = root;
  runtime.modelRuntime = provider;
  runtime.resolveModel = () => model;
  runtime.compactionArchive = new BotCompactionArchiveStore(join(root, "archive"));
  runtime.compaction = new BotCompactionCoordinator(runtime.compactionArchive, 0);
  runtime.tools = { customTools: () => [{ name: "InspectFixture", label: "Inspect fixture",
    description: "Read the current request", parameters: { type: "object", properties: {} },
    execute: async () => {
      if (++inspections === 2) active.instructions = snapshot(2);
      return { content: [{ type: "text", text: "Inspection complete; no external changes." }], details: {} };
    } }], acknowledgeToolOutcomes: async () => {}, cancelApprovals() {},
    userForms: { beginTurn: async () => {}, endTurn: async () => {} } };
  try {
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    const session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    active.sessionPath = session.sessionFile;
    runtime.activeByRun.set(active.runId, active);
    active.unsubscribe = session.subscribe((event: any) => runtime.routeEvent(active, event));
    await runtime.execute(active, "Inspect the request within the existing scope.", []);
    expect(inspections).toBe(3);
    expect(requests).toHaveLength(4);
    // A moved, nonpersisted tail message rewrites the prefix on every call.
    // Assert the actual serialized provider requests, including tool results.
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(requests[i - 1].messages);
    }
    expect(JSON.stringify(requests[2])).toContain("Verified receipt revision 2");
    expect(JSON.stringify(requests[2])).toContain("Inspect the pending document without sending");
    const snapshots = manager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.customType === "openteam-task-progress");
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((entry: any) => entry.display === false)).toBe(true);
    // Recreate the Pi session as the worker does for a later wake. The latest
    // parent/worker observations must append after the saved conversation,
    // rather than changing its system prefix and invalidating that history.
    const next: any = { ...active, runId: "next-fixture-run", turnId: crypto.randomUUID(),
      instructions: snapshot(3), session: null, endTurnRequested: false,
      assistantOrdinal: 0, startedItems: new Set(), toolArgs: new Map() };
    const restored = SessionManager.open(active.sessionPath, join(root, "sessions"), root);
    const resumed = await runtime.createStandaloneSession(root, next.instructions, restored, next, next.modelRef);
    next.session = resumed;
    next.sessionPath = resumed.sessionFile;
    runtime.activeByRun.set(next.runId, next);
    next.unsubscribe = resumed.subscribe((event: any) => runtime.routeEvent(next, event));
    await runtime.execute(next, "Read the updated saved status within the same scope.", []);
    expect(requests).toHaveLength(5);
    expect(requests[4].messages.slice(0, requests[3].messages.length)).toEqual(requests[3].messages);
    expect(JSON.stringify(requests[4])).toContain("Verified receipt revision 3");
    expect(requests[4].messages[0]).toEqual(requests[0].messages[0]);
    expect(JSON.stringify(requests[4].messages[0])).not.toContain("Verified receipt revision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
