import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  type BotMessage,
} from "../../src/bot-compaction";
import { ComputerRuntime } from "../../src/runtime";
import {
  compactionExtension,
  compactionObservation,
  inferCompaction,
  withPendingSummaryResults,
} from "../../src/runtime/compaction";
import type { ActiveTurn } from "../../src/runtime/types";

const model: Model<"openai-completions"> = {
  id: "compaction-fixture",
  name: "Compaction fixture",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://offline.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const answer = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop"
): AssistantMessage => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason,
  content: text ? [{ type: "text", text }] : [],
  timestamp: Date.now(),
  usage: {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const request = {
  systemPrompt: "Original system fixture",
  userInfoMessage: null,
  messagesToSummarize: [{ role: "user", content: "Keep blue" }],
  shorter: false,
};
const modelRef = { providerId: model.provider, modelId: model.id };

test("compaction omits historic malformed images without changing original receipts", async () => {
  let context: any;
  const image = {type:"image",data:Buffer.from("not an image").toString("base64"),mimeType:"image/png"};
  const history = [{role:"toolResult",toolCallId:"read-image",toolName:"Read",content:[image],isError:false,timestamp:1}];
  await inferCompaction(
    {completeSimple: async (_model: unknown, input: any) => {context=input;return answer("Keep the user task");}} as unknown as ModelRuntime,
    () => model, () => [], {modelRef,reasoning:"off"} as ActiveTurn,
    {...request,messagesToSummarize:history},new AbortController().signal
  );
  expect(JSON.stringify(context.messages)).toContain("image omitted");
  expect(JSON.stringify(context.messages)).not.toContain(image.data);
  expect(history[0]!.content[0]).toBe(image);
});

test("summary wire input marks unfinished calls pending and preserves actual successes and failures", async () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "Continue the reads" }], timestamp: 1 },
    {
      ...answer("", "toolUse"),
      content: [
        { type: "toolCall", id: "a", name: "Read", arguments: { path: "one" } },
        { type: "toolCall", id: "b", name: "Read", arguments: { path: "two" } },
        { type: "toolCall", id: "c", name: "Read", arguments: { path: "three" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "Read",
      content: [{ type: "text", text: "Found one" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "b",
      toolName: "Read",
      content: [{ type: "text", text: "Permission denied" }],
      isError: true,
      timestamp: 3,
    },
  ];
  const original = structuredClone(history);
  const projection = withPendingSummaryResults(history);
  expect(history).toEqual(original);
  expect(projection.filter((message) => message.role === "toolResult")).toHaveLength(3);
  expect(projection.find((message) => message.toolCallId === "b")).toEqual(history[3]);
  expect(projection.find((message) => message.toolCallId === "c")).toMatchObject({
    isError: false,
  });
  let wire = "";
  await inferCompaction(
    {
      completeSimple: (_model: unknown, context: any) =>
        streamSimple(model, context, {
          apiKey: "synthetic-fixture",
          maxRetries: 0,
          fetch: (async (_url: unknown, init: any) => {
            wire = await new Response(init.body).text();
            return new Response(
              'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } }
            );
          }) as typeof fetch,
        }).result(),
    } as unknown as ModelRuntime,
    () => model,
    () => [],
    { modelRef, reasoning: "off" } as ActiveTurn,
    { ...request, messagesToSummarize: history },
    new AbortController().signal
  );
  expect(wire).toContain("Result pending at the summarization snapshot");
  expect(wire).toContain("Found one");
  expect(wire).toContain("Permission denied");
  expect(wire).not.toContain("No result provided");
});

for (const stopReason of ["error", "length", "aborted"] as const) {
  for (const text of ["", "Unfinished prose"]) {
    test(`summary adapter rejects ${stopReason} with ${text ? "partial" : "empty"} output`, async () => {
      const runtime = {
        completeSimple: async () => ({
          ...answer(text, stopReason),
          errorMessage: "Fixture failure",
        }),
      } as unknown as ModelRuntime;
      await expect(
        inferCompaction(
          runtime,
          () => model,
          () => [],
          { modelRef, reasoning: "off" } as ActiveTurn,
          request,
          new AbortController().signal
        )
      ).rejects.toThrow("Fixture failure");
    });
  }
}

test("actual SDK distinguishes empty completions from streams without a finish reason", async () => {
  for (const hasFinishReason of [true, false]) {
    let fetchCalls = 0;
    const completion = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Summarize", timestamp: 1 }] },
      {
        apiKey: "synthetic-fixture",
        maxRetries: 0,
        fetch: (async () => {
          fetchCalls += 1;
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: hasFinishReason
              ? [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }]
              : [],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }) as unknown as typeof fetch,
      }
    ).result();
    expect(fetchCalls).toBe(1);
    expect(completion.content).toEqual([]);
    expect(completion.usage.totalTokens).toBe(110);
    expect(completion.stopReason).toBe(hasFinishReason ? "stop" : "error");
    const inference = inferCompaction(
      { completeSimple: async () => completion } as unknown as ModelRuntime,
      () => model,
      () => [],
      { modelRef, reasoning: "off" } as ActiveTurn,
      request,
      new AbortController().signal
    );
    if (hasFinishReason) {
      // An empty successful completion reaches the immediate retry path with usage.
      await expect(inference).resolves.toMatchObject({ text: "", usage: { totalTokens: 110 } });
    } else {
      // Pi exposes a failed assistant, not Grok's missing-assistant envelope.
      await expect(inference).rejects.toThrow("Stream ended without finish_reason");
    }
  }
});

test("summary requests retain original system authority, transform Pi custom messages, and never execute tools", async () => {
  let captured: any;
  let executed = false;
  const runtime = {
    completeSimple: async (_model: unknown, context: unknown) => {
      captured = context;
      return answer("Ready");
    },
  } as unknown as ModelRuntime;
  const result = await inferCompaction(
    runtime,
    () => model,
    () =>
      [
        {
          name: "Read",
          description: "Read files",
          parameters: {},
          execute: async () => {
            executed = true;
            throw new Error("must not execute");
          },
        },
      ] as never,
    { modelRef, reasoning: "off" } as ActiveTurn,
    {
      ...request,
      messagesToSummarize: [
        ...request.messagesToSummarize,
        {
          role: "custom",
          customType: "openteam-ambient",
          content: "Background job completed",
          display: false,
        },
      ],
    },
    new AbortController().signal
  );
  expect(result.text).toBe("Ready");
  expect(executed).toBe(false);
  expect(captured.systemPrompt).toBe(request.systemPrompt);
  expect(captured.tools[0].execute).toBeUndefined();
  expect(captured.messages[1]).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "Background job completed" }],
  });
  expect(captured.messages.at(-1).content[0].text).toContain("<summary_request>");
});

test("streamed input usage starts a summary before assistant completion and every entry point captures durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "compaction-stream-"));
  const store = new BotCompactionArchiveStore(root);
  const coordinator = new BotCompactionCoordinator(store, 0);
  const messages: BotMessage[] = [
    { role: "user", content: "Old request" },
    { role: "assistant", content: "Old work" },
    { role: "user", content: "Latest correction" },
  ];
  let usedTokens = 100;
  let calls = 0;
  const active = {
    contextSessionId: crypto.randomUUID(),
    instructions: "System",
    modelRef,
    reasoning: "off",
    userInfoMessage: null,
    todoUpdate: "Current todo",
    automationTrigger: "<automation_trigger>clock</automation_trigger>",
    isRootProject: true,
    cwd: root,
    sessionPath: "/fixture/transcript",
    sentMessageCount: 1,
    requestSource: "turn",
    queue: { push() {} },
    session: {
      messages,
      model,
      getContextUsage: () => ({ tokens: usedTokens, contextWindow: model.contextWindow }),
      getAllTools: () => [],
      getActiveToolNames: () => [],
    },
  } as unknown as ActiveTurn;
  const handlers: Record<string, (event: any) => Promise<any>> = {};
  const extension = compactionExtension(
    coordinator,
    async () => {
      calls++;
      return { text: "Ready" };
    },
    { buildSessionContext: () => ({ messages }) } as unknown as SessionManager,
    active
  );
  try {
    extension.factory({
      on: (name: string, handler: any) => {
        handlers[name] = handler;
      },
    } as never);
    await handlers.context!({ messages });
    await handlers.message_start!({ message: { role: "assistant" } });
    const partial = {
      ...answer("in progress"),
      usage: { ...answer("").usage, input: 60_000 },
      earlyCompactionContextTokenThreshold: 60_000,
    };
    await handlers.message_update!({
      assistantMessageEvent: { type: "text_delta", partial, delta: "progress" },
    });
    expect(calls).toBe(1);
    expect(active.compactionEarlyThreshold).toBe(60_000);
    expect(compactionObservation(active)).toMatchObject({
      todoUpdate: "Current todo",
      isRootProject: true,
      automationTrigger: "<automation_trigger>clock</automation_trigger>",
      transcriptPath: "/fixture/transcript",
    });
    usedTokens = 60_000;
    messages.push({ ...answer("completed"), usage: { ...answer("").usage, input: 60_000 } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const projected = await coordinator.modelContextMessages(compactionObservation(active));
    const rendered = JSON.stringify(projected);
    for (const value of [
      "Current todo",
      "automation_trigger",
      "Project root:",
      "fixture/transcript",
    ])
      expect(rendered).toContain(value);
    await handlers.message_start!({ message: { role: "assistant" } });
    expect(active.compactionEarlyThreshold).toBeUndefined();
  } finally {
    coordinator.discardBackground(active.contextSessionId);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  32_000, 100_003, 256_000,
])("real Pi starts at 90% of %i, completes the turn, reopens and adopts without stale pressure", async (contextWindow) => {
  const fixtureModel = { ...model, contextWindow };
  const boundary = Math.ceil(contextWindow * 0.9);
  const root = await mkdtemp(join(tmpdir(), "compaction-real-pi-"));
  const store = new BotCompactionArchiveStore(join(root, "archives"));
  const coordinator = new BotCompactionCoordinator(store, 0);
  const contextSessionId = crypto.randomUUID();
  const events: any[] = [];
  const requests: any[] = [];
  let summarySignal: AbortSignal | undefined;
  let summaryCalls = 0;
  let releaseSummary!: (message: AssistantMessage) => void;
  const generated = new Promise<AssistantMessage>((resolve) => {
    releaseSummary = resolve;
  });
  const runtime = new ComputerRuntime();
  const internals = runtime as any;
  let session: AgentSession | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.checkAuth = async () => ({ type: "api_key" });
    modelRuntime.completeSimple = async (_model, context, options) => {
      summaryCalls++;
      summarySignal = options?.signal;
      expect(JSON.stringify(context.messages)).toContain("Keep blue");
      return generated;
    };
    modelRuntime.streamSimple = (_model, context, options) =>
      streamSimple(fixtureModel, context, {
        ...options,
        apiKey: "synthetic-fixture",
        maxRetries: 0,
        fetch: (async (_url: unknown, init: any) => {
          requests.push(JSON.parse(await new Response(init.body).text()));
          const chunks = [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Work complete" },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: requests.length === 1 ? boundary - 10 : 500,
                completion_tokens: 10,
                total_tokens: requests.length === 1 ? boundary : 510,
              },
            },
          ];
          return new Response(
            chunks
              .map(
                (chunk) =>
                  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch,
      });
    internals.agentDir = root;
    internals.modelRuntime = modelRuntime;
    internals.resolveModel = () => fixtureModel;
    internals.compaction = coordinator;
    internals.compactionArchive = store;
    internals.tools = {
      userForms: { beginTurn: async () => {}, endTurn: async () => {} },
      customTools: () => [],
      acknowledgeToolOutcomes: async () => {},
      cancelApprovals() {},
      refreshPrompt: async () => ({ instructions: "System fixture", userInfo: null }),
      acknowledgePrompt: async () => {},
    };
    const activeTurn = (): ActiveTurn =>
      ({
        runId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        botId: crypto.randomUUID(),
        contextSessionId,
        modelRef,
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
        discoveredDynamicTools: new Set(["fixture/OldSchema"]),
        assistantOrdinal: 0,
        startedItems: new Set(),
        toolArgs: new Map(),
        attachmentTempDirectories: [],
        queue: { push: (event: unknown) => events.push(event), end() {} },
      }) as unknown as ActiveTurn;
    const manager = SessionManager.create(root, join(root, "sessions"), { id: contextSessionId });
    manager.appendMessage({ role: "user", content: "Build red", timestamp: 1 });
    manager.appendMessage(answer("Red work"));
    const first = activeTurn();
    session = await internals.createStandaloneSession(
      root,
      first.instructions,
      manager,
      first,
      modelRef
    );
    first.session = session!;
    expect(compactionObservation(first).maxTokens).toBe(contextWindow);
    first.sessionPath = session!.sessionFile!;
    first.unsubscribe = session!.subscribe((event) => internals.routeEvent(first, event));
    const sessionPath = first.sessionPath;
    await internals.execute(first, "Keep blue", []);
    expect(summaryCalls).toBe(1);
    expect(summarySignal?.aborted).toBe(false);
    expect(events.filter((event) => event.type === "turn.completed").at(-1)?.status).toBe(
      "completed"
    );
    expect((await store.manifest(contextSessionId)).epoch).toBe(0);
    releaseSummary(answer("Blue supersedes red; current task is preserved."));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = activeTurn();
    const reopened = SessionManager.open(sessionPath, join(root, "sessions"), root);
    session = await internals.createStandaloneSession(
      root,
      second.instructions,
      reopened,
      second,
      modelRef
    );
    second.session = session!;
    second.sessionPath = session!.sessionFile!;
    second.unsubscribe = session!.subscribe((event) => internals.routeEvent(second, event));
    await internals.execute(second, "Also keep the tests", []);
    expect(requests).toHaveLength(2);
    expect(summaryCalls).toBe(1);
    expect(JSON.stringify(requests[1])).toContain("summary_content");
    expect(JSON.stringify(requests[1])).toContain("Keep blue");
    expect(JSON.stringify(requests[1])).toContain("Also keep the tests");
    expect(JSON.stringify(requests[1])).not.toContain("Red work");
    expect((await store.manifest(contextSessionId)).epoch).toBe(1);
    expect(events.filter((event) => event.type === "compaction")).toHaveLength(1);
    expect(second.discoveredDynamicTools.size).toBe(0);
    expect(JSON.stringify(second.dynamicDiscoveryMessages)).toContain("summary_content");
    expect(JSON.stringify(second.dynamicDiscoveryMessages)).not.toContain("Red work");
    expect(events.find((event) => event.type === "compaction")?.reason).toBe(
      "pending_summary_adopted"
    );
    expect(
      events.filter((event) => event.type === "turn.completed").map((event) => event.status)
    ).toEqual(["completed", "completed"]);
  } finally {
    coordinator.discardBackground(contextSessionId);
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

// Exercise Pi's native overflow, persistence, tool loop, and reopened-session paths.
for (const scenario of [
  "overflow",
  "overflow-tools",
  "overflow-refresh",
  "overflow-exhausted",
] as const) {
  test(`real Pi ${scenario} recovery preserves one conversation across reopen`, async () => {
    const root = await mkdtemp(join(tmpdir(), "compaction-overflow-qa-"));
    const store = new BotCompactionArchiveStore(join(root, "archives"));
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const events: any[] = [];
    const requests: any[] = [];
    const summaryRequests: any[] = [];
    const sessions: AgentSession[] = [];
    const runtime = new ComputerRuntime() as any;
    let toolExecutions = 0;
    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.checkAuth = async () => ({ type: "api_key" });
      modelRuntime.completeSimple = async (_model, context) => {
        summaryRequests.push(context);
        return answer(`Summary ${summaryRequests.length}: preserve blue and the tests.`);
      };
      modelRuntime.streamSimple = (_model, context, options) =>
        streamSimple(model, context, {
          ...options,
          apiKey: "synthetic-fixture",
          maxRetries: 0,
          fetch: (async (_url: unknown, init: any) => {
            requests.push(JSON.parse(await new Response(init.body).text()));
            if (requests.length === 1 || scenario === "overflow-exhausted")
              return new Response(
                JSON.stringify({
                  error: {
                    message:
                      "This model's maximum context length is 100000 tokens. context_length_exceeded",
                    code: "context_length_exceeded",
                    type: "invalid_request_error",
                  },
                }),
                { status: 400, headers: { "content-type": "application/json" } }
              );
            const useTool = scenario === "overflow-tools" && requests.length === 2;
            const chunks = [
              {
                choices: [
                  {
                    index: 0,
                    delta: useTool
                      ? {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "read-blue",
                              type: "function",
                              function: { name: "ReadBlue", arguments: "{}" },
                            },
                          ],
                        }
                      : { role: "assistant", content: `Reply ${requests.length}` },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }],
                usage: {
                  prompt_tokens: useTool ? 91_000 : 500,
                  completion_tokens: 10,
                  total_tokens: useTool ? 91_010 : 510,
                },
              },
            ];
            return new Response(
              chunks
                .map(
                  (chunk) =>
                    `data: ${JSON.stringify({
                      id: "fixture",
                      object: "chat.completion.chunk",
                      created: 1,
                      model: model.id,
                      ...chunk,
                    })}\n\n`
                )
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } }
            );
          }) as typeof fetch,
        });
      runtime.agentDir = root;
      runtime.modelRuntime = modelRuntime;
      runtime.resolveModel = () => model;
      runtime.compaction = coordinator;
      runtime.compactionArchive = store;
      runtime.tools = {
        userForms: { beginTurn: async () => {}, endTurn: async () => {} },
        customTools: () => [
          {
            name: "ReadBlue",
            label: "Read blue",
            description: "Read the blue fixture",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              toolExecutions++;
              await new Promise<void>((resolve) => setImmediate(resolve));
              return { content: [{ type: "text", text: "BLUE_RESULT_791" }], details: {} };
            },
          },
        ],
        acknowledgeToolOutcomes: async () => {},
        cancelApprovals() {},
        acknowledgePrompt: async () => {},
        refreshPrompt: async (_active: unknown, epoch: number) => ({
          instructions: "System fixture",
          userInfo: null,
          ambientContext: scenario === "overflow-refresh" ? `Refresh epoch ${epoch}` : undefined,
        }),
      };
      const makeTurn = (): ActiveTurn =>
        ({
          runId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          botId: crypto.randomUUID(),
          contextSessionId,
          modelRef,
          reasoning: "off",
          instructions: "System fixture",
          userInfoMessage: null,
          cwd: root,
          runtimeProfile: "agent",
          subagentType: null,
          requestSource: "turn",
          resetSelfSummaryCount: true,
          sentMessageCount: 1,
          endTurnRequested: true,
          toolActivityAfterLastSend: false,
          pendingSteers: [],
          acceptedSteerIds: new Set(),
          discoveredDynamicTools: new Set(["fixture/OldSchema"]),
          assistantOrdinal: 0,
          startedItems: new Set(),
          toolArgs: new Map(),
          attachmentTempDirectories: [],
          queue: { push: (event: unknown) => events.push(event), end() {} },
        }) as unknown as ActiveTurn;
      const run = async (manager: SessionManager, prompt: string) => {
        const active = makeTurn();
        const session: AgentSession = await runtime.createStandaloneSession(
          root,
          active.instructions,
          manager,
          active,
          modelRef
        );
        sessions.push(session);
        active.session = session;
        active.sessionPath = session.sessionFile!;
        active.unsubscribe = session.subscribe((event) => runtime.routeEvent(active, event));
        await runtime.execute(active, prompt, []);
        return { session, active };
      };
      const manager = SessionManager.create(root, join(root, "sessions"), { id: contextSessionId });
      manager.appendMessage({ role: "user", content: "Original red", timestamp: 1 });
      manager.appendMessage(answer("Old red work"));
      const first = await run(manager, "Keep blue");
      if (scenario === "overflow-exhausted") {
        expect(requests).toHaveLength(5);
        expect(summaryRequests).toHaveLength(5);
        expect((await store.manifest(contextSessionId)).epoch).toBe(5);
        expect(events.filter((event) => event.type === "turn.completed").at(-1)?.status).toBe(
          "failed"
        );
        expect(events.filter((event) => event.type === "runtime.error").at(-1)?.message).toContain(
          "summarization-retries"
        );
        return;
      }
      expect(events.filter((event) => event.type === "turn.completed").at(-1)?.status).toBe(
        "completed"
      );
      expect(requests.length).toBe(scenario === "overflow-tools" ? 3 : 2);
      expect(summaryRequests.length).toBe(scenario === "overflow-tools" ? 2 : 1);
      const reopened = SessionManager.open(first.active.sessionPath!, join(root, "sessions"), root);
      const before = await coordinator.contextMessages(
        contextSessionId,
        first.active.compactionReadPiMessages?.() ?? (first.session.messages as BotMessage[])
      );
      const after = await coordinator.contextMessages(
        contextSessionId,
        reopened.buildSessionContext().messages as BotMessage[]
      );
      expect(after).toEqual(before);
      expect(
        after.filter((message) => message.role === "assistant" && message.stopReason === "error")
      ).toHaveLength(0);
      await run(reopened, "Also check green");
      expect(
        events.filter((event) => event.type === "turn.completed").map((event) => event.status)
      ).toEqual(["completed", "completed"]);
      expect(JSON.stringify(requests.at(-1))).toContain("Also check green");
      expect(JSON.stringify(requests.at(-1))).not.toContain("Old red work");
      expect((await store.manifest(contextSessionId)).epoch).toBe(
        scenario === "overflow-tools" ? 2 : 1
      );
      if (scenario === "overflow-tools") {
        expect(toolExecutions).toBe(1);
        expect(JSON.stringify(requests.at(-1)).match(/BLUE_RESULT_791/g)).toHaveLength(1);
        const results = requests[2].messages.filter((message: any) => message.role === "tool");
        expect(results).toHaveLength(1);
        expect(
          requests[2].messages.some((message: any) =>
            message.tool_calls?.some((call: any) => call.id === results[0].tool_call_id)
          )
        ).toBe(true);
      }
      if (scenario === "overflow-refresh")
        expect(JSON.stringify(requests.at(-1)).match(/Refresh epoch 1/g)).toHaveLength(1);
    } finally {
      coordinator.discardBackground(contextSessionId);
      for (const session of sessions) session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
}

test("summary serialization repairs an in-flight tool exchange and ignores returned tool calls", async () => {
  let sent: any;
  let executed = false;
  const runtime = {
    completeSimple: (_model: unknown, context: any, options: any) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "synthetic-fixture",
        maxRetries: 0,
        fetch: (async (_url: unknown, init: any) => {
          sent = JSON.parse(await new Response(init.body).text());
          const chunks = [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "<think>internal</think>  Keep blue\n" },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "forbidden",
                        type: "function",
                        function: { name: "Read", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ];
          return new Response(
            chunks
              .map(
                (chunk) =>
                  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch,
      }).result(),
  } as unknown as ModelRuntime;
  const result = await inferCompaction(
    runtime,
    () => model,
    () =>
      [
        {
          name: "Read",
          description: "Read fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            executed = true;
            throw Error("must not execute");
          },
        },
      ] as never,
    { modelRef, reasoning: "off" } as ActiveTurn,
    {
      ...request,
      messagesToSummarize: [
        request.messagesToSummarize[0]!,
        {
          ...answer(""),
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "pending-read", name: "Read", arguments: {} }],
        },
      ],
    },
    new AbortController().signal
  );
  expect(result.text).toBe("  Keep blue\n");
  expect(executed).toBe(false);
  const callIndex = sent.messages.findIndex(
    (message: any) => message.tool_calls?.[0]?.id === "pending-read"
  );
  expect(callIndex).toBeGreaterThan(0);
  expect(sent.messages[callIndex + 1]).toMatchObject({
    role: "tool",
    tool_call_id: "pending-read",
  });
  expect(JSON.stringify(sent.messages.at(-1).content)).toContain("<summary_request>");
});
