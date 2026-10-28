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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
