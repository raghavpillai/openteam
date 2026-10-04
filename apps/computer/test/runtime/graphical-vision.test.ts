import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import { assertGraphicalModel } from "../../src/inference-models";

const model: Model<"openai-completions"> = {
  id: "vision-fixture", name: "Vision fixture", provider: "openai", api: "openai-completions",
  baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text", "image"],
  contextWindow: 100_000, maxTokens: 4_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test.each(["computerUse", "browserUse"] as const)("%s rejects a text-only model before starting a session", async (subagentType) => {
  const runtime = new ComputerRuntime() as any;
  runtime.modelRuntime = {};
  runtime.resolveModel = () => ({ ...model, input: ["text"] });
  let refreshes = 0;
  runtime.inferenceProviders = { verify: async () => { refreshes++; } };
  await expect(runtime.createStandaloneSession("/tmp", "Inspect the desktop", {}, {
    subagentType, reasoning: "off",
  }, {})).rejects.toThrow("cannot inspect screenshots");
  expect(refreshes).toBe(1);
});

test("text agents and executors remain usable without vision", () => {
  const text = { ...model, input: ["text"] as ["text"] };
  expect(() => assertGraphicalModel(text, null)).not.toThrow();
  expect(() => assertGraphicalModel(text, "executor")).not.toThrow();
  expect(() => assertGraphicalModel(model, "computerUse")).not.toThrow();
});

test("a Computer screenshot reaches the model request through the real Pi tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphical-vision-"));
  const requests: any[] = [];
  const screenshot = await new (createJimp({ formats: [png] }))({ width: 1280, height: 800, color: 0xffffffff }).getBuffer("image/png");
  let session: any;
  try {
    const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (_model, context, options) => streamSimple(model, context, {
      ...options, apiKey: "fixture", maxRetries: 0,
      fetch: (async (_url: unknown, init: any) => {
        requests.push(JSON.parse(await new Response(init.body).text()));
        const takeScreenshot = requests.length === 1;
        const delta = takeScreenshot
          ? { role: "assistant", tool_calls: [{ index: 0, id: "capture", type: "function", function: { name: "Computer", arguments: '{"action":"screenshot"}' } }] }
          : { role: "assistant", content: "The desktop screenshot was received." };
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: takeScreenshot ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const screens = { actComputerUse: async () => screenshot };
    const runtime = new ComputerRuntime(screens as never) as any;
    const tools = runtime.tools;
    tools.workspaceRoot = root;
    tools.privateBrowser = () => { throw new Error("No browser is needed for this native screenshot"); };
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    let refreshed = false;
    let refreshes = 0;
    runtime.resolveModel = () => refreshed ? model : { ...model, input: ["text"] };
    runtime.inferenceProviders = { verify: async (settings: unknown) => {
      expect(settings).toEqual({ providerId: model.provider, modelId: model.id, reasoning: "off" });
      refreshed = true;
      refreshes++;
    } };
    runtime.compaction = new BotCompactionCoordinator(new BotCompactionArchiveStore(join(root, "archives")), 0);
    let receipt: any;
    runtime.tools = {
      customTools: () => [{
        name: "Computer", label: "Computer", description: "Inspect the native desktop",
        parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
        execute: async (id: string, args: unknown, signal: AbortSignal) => {
          receipt = await tools.callComputerUse(active, args, signal);
          return receipt;
        },
      }],
      acknowledgeToolOutcomes: async () => {},
    };
    const active: any = {
      contextSessionId: crypto.randomUUID(), botId: crypto.randomUUID(), screenBotId: crypto.randomUUID(),
      runId: crypto.randomUUID(), turnId: crypto.randomUUID(),
      modelRef: { providerId: model.provider, modelId: model.id }, reasoning: "off", cwd: root,
      instructions: "Inspect the native desktop", subagentType: "computerUse", requestSource: "subagent",
      userInfoMessage: null, discoveredDynamicTools: new Set(), pluginAbortController: new AbortController(),
      queue: { push() {} },
    };
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    await session.prompt("Take a desktop screenshot and inspect it.");
    expect(refreshes).toBe(1);
    expect(requests).toHaveLength(2);
    const wire = JSON.stringify(requests[1]);
    expect(wire).toContain(`data:image/png;base64,${screenshot.toString("base64")}`);
    expect(wire).not.toContain("image omitted");
    expect(receipt.details).toMatchObject({ coordinateSpace: "desktop", width: 1280, height: 800 });
    expect((await readFile(receipt.details.path)).toString("base64")).toBe(screenshot.toString("base64"));
    const stored = manager.buildSessionContext().messages as any[];
    expect(stored.find(m => m.role === "toolResult" && m.toolName === "Computer").content.some((part: any) => part.type === "image")).toBe(true);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
