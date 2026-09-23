import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
const deferred = () => {
  let resolve!: (v?: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
};
const model: any = {
  id: "lifecycle-fixture",
  provider: "openai",
  api: "openai-completions",
  name: "Lifecycle",
  baseUrl: "https://offline.invalid/v1",
  contextWindow: 10000,
  maxTokens: 1000,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = (n = 100) => ({
  input: n,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: n + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const answer = (text: string) => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text }],
  usage: usage(),
  stopReason: "stop",
  timestamp: Date.now(),
});

for (const timing of ["pending", "ready", "capacity"] as const) {
  test(`four consecutive real Pi compactions with duplicate and ordered steers while summary ${timing}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continual-lifecycle-"));
    const store = new BotCompactionArchiveStore(join(root, "archive"));
    const coordinator = new BotCompactionCoordinator(store, 0);
    const id = crypto.randomUUID();
    const runtime = new ComputerRuntime() as any;
    const requests: any[] = [];
    const events: any[] = [];
    let toolCalls = 0,
      ordinal = 0,
      round = 0,
      summaryCalls = 0;
    let summaryStarted = deferred(),
      releaseSummary = deferred(),
      toolStarted = deferred(),
      releaseTool = deferred(),
      capacityStarted = deferred();
    const waitForCapacity = coordinator.waitForModelCapacity.bind(coordinator);
    coordinator.waitForModelCapacity = async (input, signal) => {
      if ((input.usedTokens ?? 0) >= input.maxTokens) capacityStarted.resolve();
      return waitForCapacity(input, signal);
    };
    let path: string | undefined;
    const provider = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.completeSimple = async () => {
      summaryCalls++;
      summaryStarted.resolve();
      await releaseSummary.promise;
      return answer(
        `Summary round ${round}: preserve initial task and continue pending work.`
      ) as any;
    };
    provider.streamSimple = (_m, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "fixture",
        maxRetries: 0,
        fetch: (async (_url: any, init: any) => {
          const request = JSON.parse(await new Response(init.body).text());
          requests.push({ round, ordinal: ++ordinal, request });
          const tool = ordinal === 1;
          const delta = tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `pause-${round}`,
                    type: "function",
                    function: { name: "PauseFixture", arguments: "{}" },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "Continuing the current task with the latest correction.",
              };
          const rows = [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: {
                prompt_tokens: tool ? 9000 : 500,
                completion_tokens: 10,
                total_tokens: tool ? 9010 : 510,
              },
            },
          ];
          return new Response(
            rows
              .map(
                (r) =>
                  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...r })}\n\n`
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch,
      });
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => model;
    runtime.compaction = coordinator;
    runtime.compactionArchive = store;
    runtime.tools = {
      customTools: () => [
        {
          name: "PauseFixture",
          label: "Pause fixture",
          description: "Wait for a controlled QA boundary",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            toolCalls++;
            toolStarted.resolve();
            await releaseTool.promise;
            return {
              content: [
                {
                  type: "text",
                  text: `Tool result ${round}` + (timing === "capacity" ? "x".repeat(8000) : ""),
                },
              ],
              details: {},
            };
          },
        },
      ],
      acknowledgeToolOutcomes: async () => {},
      interruptShellWaits() {},
      cancelApprovals() {},
      refreshPrompt: async () => ({ instructions: "System fixture", userInfo: null }),
      acknowledgePrompt: async () => {},
      userForms: { beginTurn: async () => {}, endTurn: async () => {} },
    };
    try {
      for (round = 1; round <= 4; round++) {
        ordinal = 0;
        summaryStarted = deferred();
        releaseSummary = deferred();
        toolStarted = deferred();
        releaseTool = deferred();
        capacityStarted = deferred();
        const startEvents = events.length;
        const active: any = {
          runId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          botId: "fixture-bot",
          contextSessionId: id,
          modelRef: { providerId: model.provider, modelId: model.id },
          reasoning: "off",
          instructions: "System fixture",
          userInfoMessage: null,
          cwd: root,
          runtimeProfile: "agent",
          subagentType: null,
          requestSource: "turn",
          resetSelfSummaryCount: true,
          sentMessageCount: 1,
          toolActivityAfterLastSend: false,
          pendingSteers: [],
          acceptedSteerIds: new Set(),
          discoveredDynamicTools: new Set(),
          assistantOrdinal: 0,
          startedItems: new Set(),
          toolArgs: new Map(),
          attachmentTempDirectories: [],
          queue: { push: (e: any) => events.push(e), end() {} },
        };
        const manager = path
          ? SessionManager.open(path, join(root, "sessions"), root)
          : SessionManager.create(root, join(root, "sessions"), { id });
        if (!path) {
          manager.appendMessage({ role: "user", content: "Initial durable task", timestamp: 1 });
          manager.appendMessage(answer("Initial progress") as any);
        }
        const session = await runtime.createStandaloneSession(
          root,
          active.instructions,
          manager,
          active,
          active.modelRef
        );
        active.session = session;
        path = session.sessionFile!;
        active.sessionPath = path;
        runtime.activeByRun.set(active.runId, active);
        active.unsubscribe = session.subscribe((e: any) => runtime.routeEvent(active, e));
        const running = runtime.execute(active, `Continue cycle ${round}`, []);
        await Promise.all([summaryStarted.promise, toolStarted.promise]);
        if (timing === "ready") {
          releaseSummary.resolve();
          await new Promise((r) => setImmediate(r));
        }
        const a = {
          inboxId: `a-${round}`,
          clientMessageId: `ma-${round}`,
          content: `STEER-A-${round}: current value alpha-${round}`,
        };
        const b = {
          inboxId: `b-${round}`,
          clientMessageId: `mb-${round}`,
          content: `STEER-B-${round}: current value beta-${round} supersedes alpha`,
        };
        await runtime.steer(active.runId, a);
        await runtime.steer(active.runId, a);
        await runtime.steer(active.runId, b);
        expect(events.slice(startEvents).filter((e) => e.type === "input.delivered")).toHaveLength(
          0
        );
        if (timing === "capacity") {
          releaseTool.resolve();
          await capacityStarted.promise;
          expect(requests.filter((request) => request.round === round)).toHaveLength(1);
        }
        releaseSummary.resolve();
        await new Promise((r) => setImmediate(r));
        releaseTool.resolve();
        await running;
        const delivered = events
          .slice(startEvents)
          .filter((e) => e.type === "input.delivered")
          .map((e) => e.inboxId);
        expect(delivered).toEqual([a.inboxId, b.inboxId]);
        expect(toolCalls).toBe(round);
        expect(summaryCalls).toBe(round);
        expect((await store.manifest(id)).epoch).toBe(round);
        const inputs = requests
          .filter((r) => r.round === round)
          .map((r) => JSON.stringify(r.request));
        expect(inputs.some((s) => s.includes("summary_content") && s.includes(a.content))).toBe(
          true
        );
        expect(inputs.at(-1)).toContain(b.content);
        const firstA = inputs.findIndex((s) => s.includes(a.content)),
          firstB = inputs.findIndex((s) => s.includes(b.content));
        expect(firstA).toBeLessThanOrEqual(firstB);
        expect(
          events
            .slice(startEvents)
            .filter((e) => e.type === "turn.completed")
            .at(-1)?.status
        ).toBe("completed");
      }
    } finally {
      coordinator.discardBackground(id);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}

for (const timing of ["terminal-ready", "terminal-pending"] as const) {
  test(`terminal tool result finishes successfully and resumes across four turns while summary ${timing}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continual-lifecycle-"));
    const store = new BotCompactionArchiveStore(join(root, "archive"));
    const coordinator = new BotCompactionCoordinator(store, 0);
    const id = crypto.randomUUID();
    const runtime = new ComputerRuntime() as any;
    const requests: any[] = [];
    const events: any[] = [];
    let toolCalls = 0,
      ordinal = 0,
      round = 0,
      summaryCalls = 0;
    let currentActive: any;
    let summaryStarted = deferred(),
      releaseSummary = deferred(),
      toolStarted = deferred(),
      releaseTool = deferred();
    let path: string | undefined;
    const provider = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.completeSimple = async () => {
      summaryCalls++;
      summaryStarted.resolve();
      await releaseSummary.promise;
      return answer(
        `Summary round ${round}: preserve initial task and continue pending work.`
      ) as any;
    };
    provider.streamSimple = (_m, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "fixture",
        maxRetries: 0,
        fetch: (async (_url: any, init: any) => {
          const request = JSON.parse(await new Response(init.body).text());
          requests.push({ round, ordinal: ++ordinal, request });
          const tool = ordinal === 1;
          const delta = tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `pause-${round}`,
                    type: "function",
                    function: { name: "PauseFixture", arguments: "{}" },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "Continuing the current task with the latest correction.",
              };
          const rows = [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: {
                prompt_tokens: tool ? 9000 : 500,
                completion_tokens: 10,
                total_tokens: tool ? 9010 : 510,
              },
            },
          ];
          return new Response(
            rows
              .map(
                (r) =>
                  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...r })}\n\n`
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch,
      });
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => model;
    runtime.compaction = coordinator;
    runtime.compactionArchive = store;
    runtime.tools = {
      customTools: () => [
        {
          name: "PauseFixture",
          label: "Pause fixture",
          description: "Wait for a controlled QA boundary",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            toolCalls++;
            toolStarted.resolve();
            await releaseTool.promise;
            currentActive.endTurnRequested = true;
            return {
              content: [{ type: "text", text: `Tool result ${round}` }],
              details: {},
              terminate: true,
            };
          },
        },
      ],
      acknowledgeToolOutcomes: async () => {},
      interruptShellWaits() {},
      cancelApprovals() {},
      refreshPrompt: async () => ({ instructions: "System fixture", userInfo: null }),
      acknowledgePrompt: async () => {},
      userForms: { beginTurn: async () => {}, endTurn: async () => {} },
    };
    try {
      for (round = 1; round <= 4; round++) {
        ordinal = 0;
        summaryStarted = deferred();
        releaseSummary = deferred();
        toolStarted = deferred();
        releaseTool = deferred();
        const startEvents = events.length;
        const active: any = {
          runId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          botId: "fixture-bot",
          contextSessionId: id,
          modelRef: { providerId: model.provider, modelId: model.id },
          reasoning: "off",
          instructions: "System fixture",
          userInfoMessage: null,
          cwd: root,
          runtimeProfile: "agent",
          subagentType: null,
          requestSource: "turn",
          resetSelfSummaryCount: true,
          sentMessageCount: 1,
          toolActivityAfterLastSend: false,
          pendingSteers: [],
          acceptedSteerIds: new Set(),
          discoveredDynamicTools: new Set(),
          assistantOrdinal: 0,
          startedItems: new Set(),
          toolArgs: new Map(),
          attachmentTempDirectories: [],
          queue: { push: (e: any) => events.push(e), end() {} },
        };
        currentActive = active;
        const manager = path
          ? SessionManager.open(path, join(root, "sessions"), root)
          : SessionManager.create(root, join(root, "sessions"), { id });
        if (!path) {
          manager.appendMessage({ role: "user", content: "Initial durable task", timestamp: 1 });
          manager.appendMessage(answer("Initial progress") as any);
        }
        const session = await runtime.createStandaloneSession(
          root,
          active.instructions,
          manager,
          active,
          active.modelRef
        );
        active.session = session;
        path = session.sessionFile!;
        active.sessionPath = path;
        runtime.activeByRun.set(active.runId, active);
        active.unsubscribe = session.subscribe((e: any) => runtime.routeEvent(active, e));
        const running = runtime.execute(active, `Continue cycle ${round}`, []);
        await Promise.all([summaryStarted.promise, toolStarted.promise]);
        if (timing === "terminal-ready") {
          releaseSummary.resolve();
          await new Promise((r) => setImmediate(r));
        }
        releaseTool.resolve();
        await running;
        expect(toolCalls).toBe(round);
        expect(summaryCalls).toBe(round);
        expect(
          events
            .slice(startEvents)
            .filter((e) => e.type === "turn.completed")
            .at(-1)?.status
        ).toBe("completed");
        expect(events.slice(startEvents).filter((e) => e.type === "runtime.error")).toHaveLength(0);
        expect(session.messages.at(-1)?.role).toBe("toolResult");
        expect((await store.manifest(id)).epoch).toBe(
          timing === "terminal-ready" ? round : round - 1
        );
        if (round > 1) {
          expect(JSON.stringify(requests.filter((r) => r.round === round)[0].request)).toContain(
            `Summary round ${round - 1}`
          );
          const measurements = manager
            .getEntries()
            .filter(
              (e: any) => e.type === "custom" && e.customType === "openteam-compaction-usage"
            );
          expect(measurements).toHaveLength(round - 1);
          expect((measurements.at(-1) as any).data.inputTokens).toBe(9000);
          expect((measurements.at(-1) as any).data.source).toBe("provider");
        }
        releaseSummary.resolve();
        await new Promise((r) => setImmediate(r));
        if (timing === "terminal-ready") {
          const latest = await store.latest(id);
          expect(latest?.metrics?.summaryOutputTokens).toBe(10);
          expect(latest?.metrics?.tokensAfterSource).toBe("estimate");
          expect(latest?.metrics?.generationDurationMs).toBeGreaterThanOrEqual(0);
        }
      }
    } finally {
      coordinator.discardBackground(id);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
