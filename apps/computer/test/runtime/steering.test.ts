import { describe, expect, test } from "bun:test";
import { ComputerRuntime, decodeInlineImages } from "../../src/runtime";

const PNG_BYTES = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4////fwAJ+wP92PZgeAAAAABJRU5ErkJggg==";
const INLINE_PNG = `data:image/png;base64,${PNG_BYTES}`;

describe("live Pi steering of a running worker", () => {
  test("deduplicates accepted inputs and acknowledges them when Pi inserts the user message", async () => {
    const runtime = new ComputerRuntime();
    const events: unknown[] = [];
    const prompts: Array<{ content: string; options: unknown }> = [];
    const active = {
      runId: "run-1",
      turnId: "run-1",
      initialUserStarted: false,
      pendingSteers: [],
      acceptedSteerIds: new Set<string>(),
      queue: { push: (event: unknown) => events.push(event) },
      session: {
        isStreaming: true,
        prompt: async (content: string, options: unknown) => {
          prompts.push({ content, options });
        },
      },
    };
    const internals = runtime as unknown as {
      activeByRun: Map<string, typeof active>;
      routeEvent: (turn: typeof active, event: unknown) => void;
    };
    internals.activeByRun.set(active.runId, active);
    const input = {
      inboxId: "inbox-1",
      clientMessageId: "message-1",
      content: "Redirect the work",
    };

    await runtime.steer(active.runId, input);
    await runtime.steer(active.runId, input);
    expect(prompts).toEqual([
      {
        content: "Redirect the work",
        options: { source: "rpc", streamingBehavior: "steer" },
      },
    ]);

    internals.routeEvent(active, { type: "message_end", message: { role: "user" } });
    expect(events).toEqual([{ type: "prompt.delivered", turnId: "run-1" }]);
    events.length = 0;
    internals.routeEvent(active, { type: "message_end", message: { role: "user" } });
    expect(events).toEqual([
      {
        type: "input.delivered",
        turnId: "run-1",
        inboxId: "inbox-1",
        clientMessageId: "message-1",
      },
    ]);
  });

  test("rejects steering after the active Pi stream has ended", async () => {
    const runtime = new ComputerRuntime();
    const active = {
      session: { isStreaming: false },
    };
    const internals = runtime as unknown as {
      activeByRun: Map<string, typeof active>;
    };
    internals.activeByRun.set("run-1", active);

    await expect(
      runtime.steer("run-1", {
        inboxId: "inbox-1",
        clientMessageId: "message-1",
        content: "Too late",
      })
    ).rejects.toThrow("Run is not actively processing a Pi turn");
  });

  test("decodes inline uploads as structured Pi image content", () => {
    expect(decodeInlineImages([{ url: INLINE_PNG }])).toEqual([
      { type: "image", data: PNG_BYTES, mimeType: "image/png" },
    ]);
    expect(() => decodeInlineImages([{ url: "data:image/png;base64,not-base64" }])).toThrow(
      "invalid base64 data"
    );
  });
});

test("queued corrections prevent native, browser and computer actions from executing", async () => {
  const runtime = new ComputerRuntime();
  const tools = (runtime as any).tools;
  let executions = 0;
  tools.processSecrets = async () => ({});
  tools.screens = {commandEnvironment:async()=>({})};
  tools.nativeToolExecutor = { shell: async () => { executions++; return { content: [], details: {} }; } };
  const active = { subagentType: "computerUse", runtimeProfile: "subagent", pluginNamespaces: [], pendingSteers: [{ inboxId: "new-input", content: "Correct the task" }] };
  const catalog = tools.customTools(active);
  for (const name of ["Shell", "Read", "Computer", "browser_click"]) {
    const tool = catalog.find((candidate: any) => candidate.name === name);
    expect(tool).toBeDefined();
    await expect(tool.execute("stale-call", {}, undefined, undefined, {})).rejects.toThrow("newer instruction is queued");
  }
  expect(executions).toBe(0);
  expect(active.pendingSteers).toHaveLength(1);
  active.pendingSteers.splice(0);
  await catalog.find((tool: any) => tool.name === "Shell").execute("current-call", {command:"pwd"}, undefined, undefined, {});
  expect(executions).toBe(1);
});

test("every queued steer reaches the next model request together", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
  const { ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { BotCompactionArchiveStore, BotCompactionCoordinator } = await import("../../src/bot-compaction");
  const root = await mkdtemp(join(tmpdir(), "steer-all-"));
  const model: any = {
    id: "steer-fixture", name: "Steer fixture", provider: "openai", api: "openai-completions",
    baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 100_000,
    maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const requests: any[] = [];
  let release!: () => void;
  const toolStarted = new Promise<void>((started) => {
    (globalThis as any).__steerStarted = started;
  });
  let session: any;
  try {
    const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (_model, context, options) => streamSimple(model, context, {
      ...options, apiKey: "fixture", maxRetries: 0,
      fetch: (async (_url: unknown, init: any) => {
        requests.push(JSON.parse(await new Response(init.body).text()));
        const delta = requests.length === 1
          ? { role: "assistant", tool_calls: [{ index: 0, id: "wait", type: "function", function: { name: "Wait", arguments: "{}" } }] }
          : { role: "assistant", content: "Done." };
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
    const runtime = new ComputerRuntime() as any;
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => model;
    runtime.compaction = new BotCompactionCoordinator(new BotCompactionArchiveStore(join(root, "archives")), 0);
    runtime.tools = {
      customTools: () => [{ name: "Wait", label: "Wait", description: "Wait", parameters: { type: "object", properties: {} },
        execute: async () => {
          (globalThis as any).__steerStarted();
          await new Promise<void>((resolve) => { release = resolve; });
          return { content: [{ type: "text", text: "waited" }], details: {} };
        } }],
      acknowledgeToolOutcomes: async () => {},
    };
    const active: any = {
      contextSessionId: crypto.randomUUID(), runId: crypto.randomUUID(), turnId: crypto.randomUUID(),
      modelRef: { providerId: model.provider, modelId: model.id }, reasoning: "off", cwd: root,
      instructions: "Work.", subagentType: null, requestSource: "subagent", userInfoMessage: null,
      discoveredDynamicTools: new Set(), pluginAbortController: new AbortController(), queue: { push() {} },
    };
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    const running = session.prompt("Start.");
    await toolStarted;
    await session.prompt("First correction.", { streamingBehavior: "steer" });
    await session.prompt("Second correction.", { streamingBehavior: "steer" });
    release();
    await running;
    expect(requests).toHaveLength(2);
    const sent = JSON.stringify(requests[1].messages);
    expect(sent).toContain("First correction.");
    expect(sent).toContain("Second correction.");
  } finally {
    session?.dispose();
    delete (globalThis as any).__steerStarted;
    await rm(root, { recursive: true, force: true });
  }
});
