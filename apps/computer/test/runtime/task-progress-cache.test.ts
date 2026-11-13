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

test.each([
  { compact: false, rootTask: false },
  { compact: true, rootTask: false },
  { compact: true, rootTask: true },
])("real provider requests retain task snapshots %j", async ({ compact, rootTask }) => {
  const root = await mkdtemp(join(tmpdir(), "task-cache-"));
  const runtime = new ComputerRuntime() as any;
  const requests: any[] = [];
  const summaryRequests: any[] = [];
  const summarySignals: AbortSignal[] = [];
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  let summaryDone: Promise<any> | undefined;
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
      const request = JSON.parse(await new Response(init.body).text());
      const summary = JSON.stringify(request.messages.at(-1)).includes("<summary_request>");
      (summary ? summaryRequests : requests).push(request);
      const tool = !summary && requests.length <= 3;
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0,
        id: `inspect-${requests.length}`, type: "function",
        function: { name: "InspectFixture", arguments: "{}" } }] }
        : { role: "assistant", content: summary ? "Keep the pending document within the existing approval limits." : "Status: done\nVerified the requested outcome." };
      const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: compact && tool ? 90_000 : 1000, completion_tokens: 10, total_tokens: compact && tool ? 90_010 : 1010 } }];
      return new Response(chunks.map(c => `data: ${JSON.stringify({ id: `response-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: model.id, ...c })}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  provider.completeSimple = (m, context, options) => {
    summarySignals.push(options!.signal!);
    summaryDone = (async () => {
      await summaryGate;
      return provider.streamSimple(m, context, options).result();
    })();
    return summaryDone;
  };
  const snapshot = (revision: number) => {
    const progress = { runId: "fixture-run", revision, state: "working", summary: `Verified receipt revision ${revision}`,
      evidence: ["/requests/receipt"], remaining: ["Inspect the pending document without sending"], nextAction: "Inspect only" };
    return replaceTaskProgressContext("Keep the original approval and limits.", rootTask ? { requests: [progress] } : progress);
  };
  const active: any = { runId: "fixture-run", turnId: crypto.randomUUID(), botId: "fixture-bot",
    contextSessionId: crypto.randomUUID(), modelRef: { providerId: model.provider, modelId: model.id },
    reasoning: "off", instructions: snapshot(1), userInfoMessage: null, cwd: root,
    runtimeProfile: rootTask ? "agent" : "subagent", subagentType: rootTask ? null : "executor", requestSource: rootTask ? "turn" : "agent",
    // Root fixture starts after acknowledgement; this test exercises compaction,
    // rather than the separate SendToUser reminder/retry policy.
    resetSelfSummaryCount: true, sentMessageCount: rootTask ? 1 : 0, userAcknowledged: rootTask, assistantOrdinal: 0,
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
      if (compact && inspections === 3) {
        expect(summarySignals).toHaveLength(1);
        expect(summarySignals[0]!.aborted).toBe(false);
        active.instructions = snapshot(3);
        releaseSummary();
        await summaryDone;
      }
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
    for (let i = 1; i < (compact ? 3 : requests.length); i++) {
      expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(requests[i - 1].messages);
    }
    expect(JSON.stringify(requests[2])).toContain("Verified receipt revision 2");
    expect(JSON.stringify(requests[2])).toContain("Inspect the pending document without sending");
    if (compact) {
      expect(summarySignals).toHaveLength(1);
      expect(summarySignals[0]!.aborted).toBe(false);
      expect(summaryRequests).toHaveLength(1);
      expect(summaryRequests[0].messages[0]).toEqual(requests[0].messages[0]);
      // Summary inference reuses the captured conversation prefix, including tools.
      expect(summaryRequests[0].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
      expect(summaryRequests[0].tools).toEqual(requests[0].tools);
      expect(JSON.stringify(summaryRequests[0].messages[0])).not.toContain("durable_task_state");
      const adopted = JSON.stringify(requests[3]);
      expect(adopted).toContain("summary_content");
      expect(adopted).toContain("Verified receipt revision 3");
      expect(adopted.indexOf("summary_content")).toBeLessThan(adopted.indexOf("Verified receipt revision 3"));
    }
    const snapshots = manager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.customType === "openteam-task-progress");
    expect(snapshots).toHaveLength(compact ? 3 : 2);
    expect(snapshots.every((entry: any) => entry.display === false)).toBe(true);
    // Recreate the Pi session as the worker does for a later wake. The latest
    // parent/worker observations must append after the saved conversation,
    // rather than changing its system prefix and invalidating that history.
    const next: any = { ...active, runId: "next-fixture-run", turnId: crypto.randomUUID(),
      instructions: snapshot(4), session: null, endTurnRequested: false,
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
    expect(JSON.stringify(requests[4])).toContain("Verified receipt revision 4");
    expect(requests[4].messages[0]).toEqual(requests[0].messages[0]);
    expect(JSON.stringify(requests[4].messages[0])).not.toContain("Verified receipt revision");
  } finally {
    releaseSummary();
    runtime.compaction.discardBackground(active.contextSessionId);
    await rm(root, { recursive: true, force: true });
  }
});
