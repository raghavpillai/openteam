import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { inferCompaction } from "../../src/runtime/compaction";
import { inferenceReasoningOptions } from "../../src/runtime/reasoning";
import type { ActiveTurn } from "../../src/runtime/types";

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
      const decoded =
        new Headers(init?.headers).get("content-encoding") === "zstd"
          ? Bun.zstdDecompressSync(bytes)
          : bytes;
      requests.push(JSON.parse(new TextDecoder().decode(decoded)));
      // Stop after serialization. No network request or real credential is used.
      return new Response(JSON.stringify({ error: { message: "Offline request captured" } }), {
        status: 400,
      });
    }) as typeof fetch,
  };
  return { requests, options };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("Codex reasoning request semantics", () => {
  test.each([
    ["off", "none"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)("serializes %s as explicit %s effort", async (requested, effort) => {
    const capture = captureRequests();
    await streamSimple(model, context, {
      ...capture.options,
      ...inferenceReasoningOptions(model, requested),
    }).result();
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort } });
  });

  test("respects model capability mappings when off is unsupported", async () => {
    const restricted = { ...model, thinkingLevelMap: { off: null, minimal: null } };
    const capture = captureRequests();
    await streamSimple(restricted, context, {
      ...capture.options,
      ...inferenceReasoningOptions(restricted, "off"),
    }).result();
    expect(capture.requests[0]).toMatchObject({ reasoning: { effort: "low" } });
  });

  test("keeps other providers and non-reasoning models on Pi's existing path", () => {
    expect(
      inferenceReasoningOptions(
        { ...model, api: "anthropic-messages", provider: "anthropic" },
        "off"
      ).onPayload
    ).toBeUndefined();
    expect(
      inferenceReasoningOptions({ ...model, reasoning: false }, "off").onPayload
    ).toBeUndefined();
  });

  test("memory inference and compaction also send explicit none", async () => {
    const capture = captureRequests();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.checkAuth = async () => ({ type: "api_key" });
    modelRuntime.streamSimple = (_model, messages, options) =>
      streamSimple(model, messages, {
        ...options,
        ...capture.options,
      });
    const runtime = new ComputerRuntime();
    const internals = runtime as unknown as {
      start: () => Promise<void>;
      modelRuntime: ModelRuntime;
      resolveModel: () => typeof model;
    };
    internals.start = async () => {};
    internals.modelRuntime = modelRuntime;
    internals.resolveModel = () => model;
    await expect(
      runtime.infer({
        instructions: "Offline test",
        prompt: "Capture",
        cwd: "/workspace",
        timeoutMs: 1_000,
        model: "openai-codex/gpt-5.6-sol",
        reasoning: "off",
      })
    ).rejects.toThrow("Offline request captured");
    await expect(
      inferCompaction(
        modelRuntime,
        () => model,
        () => [],
        {
          reasoning: "off",
          modelRef: { providerId: model.provider, modelId: model.id },
        } as ActiveTurn,
        {
          systemPrompt: "Offline test",
          userInfoMessage: null,
          messagesToSummarize: [],
          shorter: false,
        },
        new AbortController().signal
      )
    ).rejects.toThrow("Offline request captured");
    expect(capture.requests).toHaveLength(2);
    for (const request of capture.requests)
      expect(request).toMatchObject({ reasoning: { effort: "none" } });
  });

  test("normal ComputerRuntime sessions send none through the actual Pi request pipeline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openteam-reasoning-"));
    directories.push(directory);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.checkAuth = async () => ({ type: "api_key" });
    const capture = captureRequests();
    // Keep the real session, agent loop, extensions and provider serializer;
    // substitute only credentials/transport so this test stays fully offline.
    modelRuntime.streamSimple = (_model, messages, options) =>
      streamSimple(model, messages, {
        ...options,
        ...capture.options,
      });
    const runtime = new ComputerRuntime();
    const internals = runtime as unknown as {
      agentDir: string;
      modelRuntime: ModelRuntime;
      resolveModel: () => typeof model;
      customTools: () => [];
      compactionExtension: () => { name: string; hidden: boolean; factory: () => void };
      createStandaloneSession: (
        cwd: string,
        instructions: string,
        manager: SessionManager,
        active: ActiveTurn,
        ref: { providerId: string; modelId: string }
      ) => Promise<AgentSession>;
    };
    internals.agentDir = directory;
    internals.modelRuntime = modelRuntime;
    internals.resolveModel = () => model;
    internals.customTools = () => [];
    internals.compactionExtension = () => ({
      name: "offline-compaction",
      hidden: true,
      factory() {},
    });
    const session = await internals.createStandaloneSession(
      directory,
      "Offline test",
      SessionManager.inMemory(directory),
      { reasoning: "off" } as ActiveTurn,
      { providerId: model.provider, modelId: model.id }
    );
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
