import { describe, expect, test } from "bun:test";
import {
  InMemoryCredentialStore,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { inferenceReasoningOptions } from "../../src/runtime/reasoning";
import { inferCompaction } from "../../src/runtime/compaction";
import type { ActiveTurn } from "../../src/runtime/types";
import { tempDirs } from "../temp";
const tempDir = tempDirs();

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://offline.invalid",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh", max: "max" },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = {
  messages: [{ role: "user" as const, content: "Offline request test", timestamp: 0 }],
};
// Synthetic token only supplies the account-id claim needed by the serializer.
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64url")}.test`;

function captureRequests() {
  const requests: Array<Record<string, unknown>> = [];
  const options: SimpleStreamOptions = {
    apiKey: token,
    transport: "sse",
    maxRetries: 0,
    fetch: (async (_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const decoded = new Headers(init?.headers).get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
      requests.push(JSON.parse(new TextDecoder().decode(decoded)));
      // Stop after serialization. No network request or real credential is used.
      return new Response(JSON.stringify({ error: { message: "Offline request captured" } }), { status: 400 });
    }) as typeof fetch,
  };
  return { requests, options };
}

/** A ComputerRuntime whose real Pi sessions serialize requests for `routed` into `capture`, fully offline. */
async function capturingRuntime(routed: Model<any>, stream: (model: any, context: any, options: any) => any) {
  const directory = await tempDir("openteam-reasoning-");
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.checkAuth = async () => ({ type: "api_key" });
  const capture = captureRequests();
  // Keep the real session, agent loop, extensions and provider serializer;
  // substitute only credentials/transport.
  modelRuntime.streamSimple = (_model, messages, options) => stream(routed, messages, { ...options, ...capture.options });
  const runtime = new ComputerRuntime();
  const internals = runtime as any;
  internals.start = async () => {};
  internals.agentDir = directory;
  internals.modelRuntime = modelRuntime;
  internals.resolveModel = () => routed;
  internals.customTools = () => [];
  internals.compactionExtension = () => ({ name: "offline-compaction", hidden: true, factory() {} });
  const session = (reasoning: string): Promise<AgentSession> => {
    const manager = SessionManager.inMemory(directory);
    return internals.createStandaloneSession(directory, "Offline", manager, { contextSessionId: manager.getSessionId(), reasoning } as ActiveTurn,
      { providerId: routed.provider, modelId: routed.id });
  };
  return { runtime, modelRuntime, capture, directory, session };
}

describe("Codex reasoning request semantics", () => {
  test.each([
    ["off", "none"],
    ["high", "high"],
  ] as const)("serializes %s as explicit %s effort", async (requested, effort) => {
    const capture = captureRequests();
    await streamSimple(model, context, { ...capture.options, ...inferenceReasoningOptions(model, requested) }).result();
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort } });
  });

  test("respects model capability mappings when off is unsupported", async () => {
    const restricted = { ...model, thinkingLevelMap: { off: null, minimal: null } };
    const capture = captureRequests();
    await streamSimple(restricted, context, { ...capture.options, ...inferenceReasoningOptions(restricted, "off") }).result();
    expect(capture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  });

  test("omits off for a dynamic Codex model with no off mapping, and keeps other providers and non-reasoning models on Pi's path", () => {
    expect(inferenceReasoningOptions({ ...model, thinkingLevelMap: undefined }, "off")).toEqual({});
    expect(inferenceReasoningOptions({ ...model, api: "anthropic-messages", provider: "anthropic" }, "off").onPayload).toBeUndefined();
    expect(inferenceReasoningOptions({ ...model, reasoning: false }, "off").onPayload).toBeUndefined();
  });

  test("normal ComputerRuntime sessions send none through the actual Pi request pipeline", async () => {
    const { capture, session: open } = await capturingRuntime(model, streamSimple);
    const session = await open("off");
    try {
      await session.prompt("Capture the request.");
      expect(session.thinkingLevel).toBe("off");
      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0]).toMatchObject({ reasoning: { effort: "none" } });
    } finally {
      session.dispose();
    }
  });
});

describe("OpenRouter reasoning across inference paths", () => {
  test.each([
    "xhigh",
    "max",
    "off",
  ] as const)("preserves %s through chat, utility inference and compaction", async (requested) => {
    const { streamSimple: routedStream } = await import(
      "@earendil-works/pi-ai/api/openai-completions"
    );
    const { openRouterReasoning } = await import("../../src/reasoning-capabilities");
    const routedModel: Model<"openai-completions"> = {
      ...model,
      id: "author/dynamic",
      provider: "openrouter",
      api: "openai-completions",
      ...openRouterReasoning(
        requested === "off"
          ? { mandatory: true }
          : {
              supported_efforts: ["low", "high", "xhigh", "max"],
              mandatory: true,
            }
      ),
    };
    const { runtime, modelRuntime, capture, directory, session: open } = await capturingRuntime(routedModel, routedStream);
    await expect(
      runtime.infer({
        instructions: "Offline",
        prompt: "Capture",
        cwd: directory,
        timeoutMs: 1000,
        model: "openrouter/author/dynamic",
        reasoning: requested,
      })
    ).rejects.toThrow("Offline request captured");
    await expect(
      inferCompaction(
        modelRuntime,
        () => routedModel,
        () => [],
        {
          reasoning: requested,
          modelRef: { providerId: routedModel.provider, modelId: routedModel.id },
        } as ActiveTurn,
        { systemPrompt: "Offline", userInfoMessage: null, messagesToSummarize: [], shorter: false },
        new AbortController().signal
      )
    ).rejects.toThrow("Offline request captured");
    const session = await open(requested);
    try {
      await session.prompt("Capture request");
      expect(capture.requests).toHaveLength(3);
      for (const payload of capture.requests) {
        if (requested === "off") expect(payload).not.toHaveProperty("reasoning");
        else expect(payload.reasoning).toEqual({ effort: requested });
      }
    } finally {
      session.dispose();
    }
  });
});
