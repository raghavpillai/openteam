import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AuthInteraction } from "@earendil-works/pi-ai";
import { availableInferenceModels, requireInferenceModel } from "../src/inference-models";
import { InferenceProviderService } from "../src/inference-providers";
import { reasoningCapabilities } from "../src/reasoning-capabilities";
import { tempDirs } from "./temp";
import {
  ChatProviderRegistry,
  inputWindow,
  isChatModel,
  KEYLESS_API_KEY,
  modelsEndpoint,
} from "../src/chat-provider-registry";
const tempDir = tempDirs();

const model = (provider: string, id: string) => ({
  provider,
  id,
  name: id,
  api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
  baseUrl: `https://${provider}.test/v1`,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
});
async function fixture(custom: Record<string, unknown> = {}, extraModels: Array<ReturnType<typeof model>> = []) {
  const directory = await tempDir("openteam-chat-registry-");
  const path = join(directory, "models.json");
  await writeFile(path, JSON.stringify({ providers: custom }));
  const connected = new Set(["openai", "anthropic", "google", ...Object.keys(custom)]);
  const providers = ["openai", "anthropic", "openai-codex", "google", ...Object.keys(custom)].map(
    (id) => ({
      id,
      name: id,
      baseUrl: `https://${id}.test/v1`,
      auth: { apiKey: { name: "API key", login: () => {} } },
    })
  );
  const known = [
    model("openai", "gpt-chat"),
    model("openai", "inaccessible-chat"),
    model("openai", "gpt-audio"),
    model("anthropic", "claude-chat"),
    model("google", "unregistered-model"),
    ...extraModels,
  ];
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const state = { status: 200, body: null as unknown, fail: false };
  const runtime = {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getModels: (id?: string) => known.filter((m) => !id || m.provider === id),
    getModel: (id: string, modelId: string) =>
      known.find((m) => m.provider === id && m.id === modelId),
    refresh: async () => ({ errors: new Map(), aborted: false }),
    checkAuth: async (id: string) =>
      connected.has(id) ? { type: "api_key", source: "test" } : undefined,
    getAuth: async (id: string) => ({ auth: { apiKey: `synthetic-${id}-key` } }),
    login: async (id: string, _type: string, interaction: AuthInteraction) => {
      const key = await interaction.prompt({ type: "secret", message: "API key" });
      connected.add(id);
      return { type: "api_key", key };
    },
    logout: async (id: string) => { connected.delete(id); },
    registerProvider: (id: string, config: { models: Array<ReturnType<typeof model>> }) => {
      for (const value of config.models) {
        const existing = known.findIndex((m) => m.provider === id && m.id === value.id);
        if (existing >= 0) known.splice(existing, 1);
        known.push({ ...value, provider: id });
      }
    },
  } as unknown as ModelRuntime;
  const fetcher = (async (raw: URL | string | Request, init: RequestInit) => {
    const url = new URL(String(raw));
    calls.push({ url, init });
    if (state.fail) throw new Error("synthetic-secret-transport-detail");
    if (state.status !== 200)
      return new Response("synthetic-secret-provider-body", { status: state.status });
    return Response.json(
      state.body ?? {
        data: [
          { id: url.hostname.startsWith("anthropic") ? "claude-chat" : "gpt-chat" },
          { id: "gpt-audio" },
          { id: "whisper-1" },
          { id: "text-embedding-3-large" },
        ],
      }
    );
  }) as typeof fetch;
  return {
    path,
    runtime,
    state,
    calls,
    connected,
    registry: new ChatProviderRegistry(() => runtime, path, fetcher),
    fetcher,
  };
}
describe("provider-first chat registry", () => {
  test("exposes only Anthropic, OpenAI auth modes, and explicitly added custom providers", async () => {
    const f = await fixture();
    const catalog = await f.registry.catalog();
    expect(catalog.providers.map((p) => p.id)).toEqual(["openai", "anthropic", "openai-codex"]);
    expect(catalog.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai/gpt-chat",
      "anthropic/claude-chat",
    ]);
    expect(catalog.providers.find((p) => p.id === "openai-codex")).toMatchObject({
      connected: false,
      modelCount: 0,
      modelStatus: "disconnected",
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.some((c) => c.url.hostname.includes("google"))).toBe(false);
    const legacy = await f.registry.catalog("google");
    expect(legacy.models).toEqual([]);
    expect(legacy.providers).toHaveLength(3);
    await expect(
      f.registry.verify({ providerId: "google", modelId: "unregistered-model", reasoning: "off" })
    ).rejects.toThrow("not in your registry");
  });
  test("uses provider-specific authentication and limits display to the selected provider", async () => {
    const f = await fixture();
    const catalog = await f.registry.catalog("anthropic");
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-chat"]);
    for (const { url, init } of f.calls) {
      const h = new Headers(init.headers);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.hostname === "anthropic.test") {
        expect(h.get("x-api-key")).toBe("synthetic-anthropic-key");
        expect(h.get("authorization")).toBeNull();
        expect(h.get("anthropic-version")).toBe("2023-06-01");
      } else {
        expect(h.get("authorization")).toBe("Bearer synthetic-openai-key");
        expect(h.get("x-api-key")).toBeNull();
      }
    }
  });
  test("HTTP errors, malformed bodies, oversized responses and transport failures yield zero models and a secret-free error", async () => {
    const f = await fixture();
    const cases: Array<(state: typeof f.state) => void> = [
      (state) => (state.status = 401),
      (state) => (state.status = 500),
      (state) => (state.body = {}),
      (state) => (state.body = { data: [{ id: 42 }] }),
      (state) => (state.body = { data: [{ id: "bad\u001b[31m" }] }),
      (state) => (state.fail = true),
    ];
    for (const apply of cases) {
      Object.assign(f.state, { status: 200, body: null, fail: false });
      apply(f.state);
      const result = await f.registry.catalog("openai");
      expect(result.models).toEqual([]);
      expect(result.providers[0]?.modelStatus).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("synthetic");
    }
    f.state.fail = false;
    f.state.status = 401;
    expect((await f.registry.catalog("openai")).providers[0]?.modelMessage).toMatch(/Reconnect|Check/);
    f.state.status = 200;
    expect((await f.registry.catalog("openai")).models).toHaveLength(1);
    const oversized = new ChatProviderRegistry(() => f.runtime, f.path, (async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as unknown as typeof fetch);
    expect((await oversized.catalog("openai")).models).toEqual([]);
  });
  test("isolates a broken provider so other connected providers still work", async () => {
    const f = await fixture();
    const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async (raw, init) =>
      String(raw).includes("anthropic")
        ? new Response(null, { status: 503 })
        : f.fetcher(raw, init)) as typeof fetch);
    const result = await registry.catalog();
    expect(result.models.map((m) => m.provider)).toEqual(["openai"]);
    expect(result.providers.find((p) => p.id === "anthropic")?.modelStatus).toBe("unavailable");
  });
  test("custom chat endpoints discover models without prior IDs and persist a selected model for restart", async () => {
    const f = await fixture({
      local: {
        name: "Local",
        baseUrl: "http://local.test/v1",
        api: "openai-completions",
        apiKey: KEYLESS_API_KEY,
        models: [],
      },
    });
    f.connected.clear();
    f.connected.add("local");
    f.state.body = {
      data: [
        { id: "my-local-model" },
        { id: "embeddings-only", task: "embedding" },
        { id: "speech-model", task: "transcription" },
      ],
    };
    const before = await readFile(f.path, "utf8");
    const catalog = await f.registry.catalog("local");
    expect(catalog.models.map((m) => m.id)).toEqual(["my-local-model"]);
    expect(new Headers(f.calls[0]?.init.headers).get("authorization")).toBeNull();
    expect(await readFile(f.path, "utf8")).toBe(before);
    await f.registry.verify({ providerId: "local", modelId: "my-local-model", reasoning: "off" });
    const config = JSON.parse(await readFile(f.path, "utf8"));
    expect(config.providers.local.models[0].id).toBe("my-local-model");
    expect(JSON.stringify(config)).not.toContain("synthetic-local-key");
  });
  test("checks access again on selection and refuses a revoked or transcription model", async () => {
    const f = await fixture();
    await f.registry.catalog("openai");
    const before = await readFile(f.path, "utf8");
    f.state.body = { data: [] };
    await expect(
      f.registry.verify({ providerId: "openai", modelId: "gpt-chat", reasoning: "off" })
    ).rejects.toThrow("No supported chat models");
    expect(await readFile(f.path, "utf8")).toBe(before);
    f.state.body = { data: [{ id: "whisper-1" }] };
    await expect(
      f.registry.verify({ providerId: "openai", modelId: "whisper-1", reasoning: "off" })
    ).rejects.toThrow();
  });
  test("follows Anthropic pagination, deduplicates models, and rejects repeated cursors", async () => {
    const f = await fixture();
    f.connected.clear();
    f.connected.add("anthropic");
    const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async (raw) => {
      const next = new URL(String(raw)).searchParams.has("after_id");
      return Response.json({
        data: [{ id: next ? "claude-next" : "claude-chat" }],
        has_more: !next,
        last_id: "claude-chat",
      });
    }) as typeof fetch);
    expect((await registry.catalog("anthropic")).models.map((m) => m.id)).toEqual([
      "claude-chat",
      "claude-next",
    ]);
    f.state.body = { data: [{ id: "claude-chat" }], has_more: true, last_id: "claude-chat" };
    expect((await f.registry.catalog("anthropic")).models).toEqual([]);
  });
  test("does not silently ignore a corrupt custom registry", async () => {
    const f = await fixture();
    await writeFile(f.path, "broken");
    await expect(f.registry.catalog()).rejects.toThrow("registry is invalid");
  });
});
describe("chat model classification and endpoint paths", () => {
  test("excludes non-chat models by name even if bundled, and uses capability metadata for opaque names", () => {
    for (const id of ["whisper-1", "gpt-4o-transcribe", "gpt-4o-audio-preview", "text-embedding-3-small", "tts-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "parakeet-v3"])
      expect(isChatModel({ id }, true, true), id).toBe(false);
    expect(isChatModel({ id: "opaque", supported_endpoints: ["/v1/audio/transcriptions"] }, false, true)).toBe(false);
    expect(isChatModel({ id: "opaque", supported_endpoints: ["/v1/chat/completions"] })).toBe(true);
  });
  test("model endpoints resolve from base URLs and reject unsafe or non-base URLs", () => {
    for (const [base, expected] of [
      ["http://localhost:11434", "http://localhost:11434/v1/models"],
      ["http://localhost:1234/v1/", "http://localhost:1234/v1/models"],
      ["https://gateway.test/api/v1", "https://gateway.test/api/v1/models"],
    ])
      expect(modelsEndpoint(base!).href).toBe(expected!);
    for (const base of ["file:///tmp/models", "https://user:secret@host/v1", "https://host/v1?api_key=secret", "https://host/v1/chat/completions"])
      expect(() => modelsEndpoint(base), base).toThrow();
  });
});

test("OpenRouter discovers account-filtered tool models and persists capabilities", async () => {
  const f = await fixture({
    openrouter: { baseUrl: "https://openrouter.test/api/v1", api: "openai-completions" },
  });
  f.state.body = {
    data: [
      {
        id: "author/new-model",
        name: "New model",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["minimal", "low", "medium", "high"] },
        context_length: 200000,
        top_provider: { max_completion_tokens: 32000 },
        pricing: { prompt: "0.000002", completion: "0.000008" },
      },
      {
        id: "author/no-tools",
        architecture: { output_modalities: ["text"] },
        supported_parameters: [],
      },
      {
        id: "author/image",
        architecture: { output_modalities: ["image"] },
        supported_parameters: ["tools"],
      },
    ],
  };
  const catalog = await f.registry.catalog("openrouter");
  expect(catalog.providers.find((p) => p.id === "openrouter")).toMatchObject({
    custom: false,
    connected: true,
  });
  expect(catalog.models).toHaveLength(1);
  expect(catalog.models[0]).toMatchObject({
    id: "author/new-model",
    provider: "openrouter",
    name: "New model",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 2, output: 8 },
  });
  const request = f.calls.find((c) => c.url.hostname === "openrouter.test")!;
  expect(request.url.pathname).toBe("/api/v1/models/user");
  expect(new Headers(request.init.headers).get("authorization")).toBe(
    "Bearer synthetic-openrouter-key"
  );
  await f.registry.verify({
    providerId: "openrouter",
    modelId: "author/new-model",
    reasoning: "medium",
  });
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  expect(saved.providers.openrouter.models[0]).toMatchObject({
    id: "author/new-model",
    api: "openai-completions",
    contextWindow: 200000,
    input: ["text", "image"],
    cost: { input: 2, output: 8 },
  });
  f.state.status = 401;
  expect((await f.registry.catalog("openrouter")).models).toEqual([]);
});

test("the usable window is the smallest advertised input limit, else the fallback", () => {
  expect(inputWindow([1_050_000, 922_000], 128_000)).toBe(922_000);
  expect(inputWindow([200_000, undefined, "100000", 0, -1, 1.5], 128_000)).toBe(200_000);
  expect(inputWindow([], 128_000)).toBe(128_000);
});

test("OpenRouter saves the selected model with its endpoints' prompt cap as the window", async () => {
  const f = await fixture({
    openrouter: { baseUrl: "https://openrouter.test/api/v1", api: "openai-completions" },
  });
  const list = {
    data: [
      {
        id: "openai/gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["minimal", "low", "medium", "high"] },
        context_length: 1_050_000,
        top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
      },
    ],
  };
  let endpoints: unknown = {
    data: {
      id: "openai/gpt-6.1-sol",
      endpoints: [
        { provider_name: "OpenAI", context_length: 1_050_000, max_prompt_tokens: 922_000, max_completion_tokens: 128_000 },
        { provider_name: "Azure", context_length: 1_050_000, max_prompt_tokens: null, max_completion_tokens: 128_000 },
      ],
    },
  };
  const fetcher = f.fetcher;
  const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async (raw: URL | string | Request, init: RequestInit) => {
    const url = new URL(String(raw));
    if (url.pathname.endsWith("/endpoints")) {
      f.calls.push({ url, init });
      return endpoints instanceof Error ? Promise.reject(endpoints) : Response.json(endpoints);
    }
    f.state.body = list;
    return fetcher(raw, init);
  }) as typeof fetch);
  // The list shows the advertised window; only the saved model is checked against its endpoints.
  expect((await registry.catalog("openrouter")).models[0]?.contextWindow).toBe(1_050_000);
  expect(f.calls.some((c) => c.url.pathname.endsWith("/endpoints"))).toBe(false);
  const saved = async () => {
    await registry.verify({ providerId: "openrouter", modelId: "openai/gpt-6.1-sol", reasoning: "medium" });
    return JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0];
  };
  expect(await saved()).toMatchObject({ contextWindow: 922_000, maxTokens: 128_000 });
  const request = f.calls.find((c) => c.url.pathname.endsWith("/endpoints"))!;
  expect(request.url.pathname).toBe("/api/v1/models/openai/gpt-6.1-sol/endpoints");
  expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer synthetic-openrouter-key");
  // Without a published cap, or when the lookup fails, the advertised window stays.
  endpoints = { data: { endpoints: [{ context_length: 1_050_000 }] } };
  expect((await saved()).contextWindow).toBe(1_050_000);
  endpoints = new Error("offline");
  expect((await saved()).contextWindow).toBe(1_050_000);
});


test("OpenRouter persists endpoint pricing tiers and reloads them after restart", async () => {
  const f = await fixture({ openrouter: { baseUrl: "https://openrouter.test/api/v1", api: "openai-completions" } });
  f.connected.clear();
  f.connected.add("openrouter");
  const pricing = {
    prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000025",
    overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015" }],
  };
  f.state.body = { data: [{
    id: "openai/gpt-6.1-sol", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["low", "medium", "high"] }, context_length: 1050000,
    top_provider: { max_completion_tokens: 128000 }, pricing: { ...pricing, overrides: undefined },
  }] };
  let offline = false;
  const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async (url: any, init: any) => {
    if (!String(url).endsWith("/endpoints")) return f.fetcher(url, init);
    if (offline) throw new Error("offline");
    return Response.json({ data: { endpoints: [{ max_prompt_tokens: 922000, pricing }] } });
  }) as typeof fetch);
  await registry.verify({ providerId: "openrouter", modelId: "openai/gpt-6.1-sol", reasoning: "medium" });
  const document = JSON.parse(await readFile(f.path, "utf8"));
  const saved = structuredClone(document.providers.openrouter.models[0]);
  expect(saved.cost.tiers).toEqual([{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: saved.cost.cacheRead, cacheWrite: 2.5 }]);
  expect(saved).toMatchObject({ api: "openai-completions", contextWindow: 922000, maxTokens: 128000, input: ["text", "image"] });
  const restarted = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: f.path,
    modelsStorePath: join(f.path, "..", "restart-models-store.json"), refreshOnCreate: false });
  await restarted.refresh({ allowNetwork: false });
  expect(restarted.getModel("openrouter", saved.id)?.cost).toEqual(saved.cost);
  // Startup refresh upgrades already-selected models even if their window is already capped.
  delete document.providers.openrouter.models[0].cost.tiers;
  await writeFile(f.path, JSON.stringify(document));
  await registry.refreshPromptCaps();
  expect(JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0]).toEqual(saved);
  const before = await readFile(f.path, "utf8");
  await registry.refreshPromptCaps();
  expect(await readFile(f.path, "utf8")).toBe(before);
  offline = true;
  await registry.refreshPromptCaps();
  expect(await readFile(f.path, "utf8")).toBe(before);
});

test("issue 281: advertised efforts drive API selection, validation and saved mappings", async () => {
  const f = await fixture({ openrouter: { baseUrl: "https://openrouter.test/api/v1" } });
  const entry = {
    id: "anthropic/claude-fable-5.2",
    name: "Anthropic: Claude Fable 5.2",
    architecture: { output_modalities: ["text"] },
    supported_parameters: ["tools", "reasoning"],
    reasoning: {
      supported_efforts: ["max", "xhigh", "high", "medium", "low"],
      mandatory: true,
      default_effort: "high",
    },
  };
  f.state.body = { data: [entry] };
  const service = new InferenceProviderService(() => f.runtime, f.path, f.fetcher);
  expect((await service.catalog("openrouter")).models[0]).toMatchObject({
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "high",
  });
  for (const reasoning of ["xhigh", "max"] as const) {
    await service.verify({ providerId: "openrouter", modelId: entry.id, reasoning });
    const saved = JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0];
    expect(saved.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    // Simulate a saved/bundled snapshot remaining available during future discovery.
    f.runtime.registerProvider("openrouter", { models: [saved] } as never);
  }
  // A later refresh removes max/xhigh and changes the default, overriding the snapshot.
  entry.reasoning.supported_efforts = ["high", "low"];
  entry.reasoning.default_effort = "low";
  expect((await service.catalog("openrouter")).models[0]).toMatchObject({
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
  });
  await expect(
    service.verify({ providerId: "openrouter", modelId: entry.id, reasoning: "max" })
  ).rejects.toThrow("Choose one of: low, high");
  await service.verify({ providerId: "openrouter", modelId: entry.id, reasoning: "low" });
  expect(
    JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0].thinkingLevelMap.max
  ).toBeNull();
  // Removing effort metadata must also clear saved controls rather than resurrecting them.
  f.state.body = { data: [{ ...entry, reasoning: { mandatory: true } }] };
  expect((await service.catalog("openrouter")).models[0]).toMatchObject({
    reasoningLevels: [],
    defaultReasoningLevel: "off",
  });
  await service.verify({ providerId: "openrouter", modelId: entry.id, reasoning: "off" });
  await expect(
    service.verify({ providerId: "openrouter", modelId: entry.id, reasoning: "high" })
  ).rejects.toThrow("provider default");
  const beforeFailure = await readFile(f.path, "utf8");
  f.state.status = 503;
  await expect(
    service.verify({ providerId: "openrouter", modelId: entry.id, reasoning: "off" })
  ).rejects.toThrow("HTTP 503");
  expect(await readFile(f.path, "utf8")).toBe(beforeFailure);
});

test("known providers also persist advertised capabilities instead of retaining bundled efforts", async () => {
  const f = await fixture();
  f.state.body = {
    data: [
      {
        id: "claude-chat",
        supported_reasoning_levels: ["low", "max"],
        default_reasoning_level: "max",
      },
    ],
  };
  const discovered = (await f.registry.catalog("anthropic")).models[0]!;
  expect(reasoningCapabilities(discovered)).toEqual({
    reasoningLevels: ["low", "max"],
    defaultReasoningLevel: "max",
  });
  await expect(
    f.registry.verify({ providerId: "anthropic", modelId: "claude-chat", reasoning: "high" })
  ).rejects.toThrow("Choose one of: low, max");
  await f.registry.verify({ providerId: "anthropic", modelId: "claude-chat", reasoning: "max" });
  expect(
    JSON.parse(await readFile(f.path, "utf8")).providers.anthropic.models[0].thinkingLevelMap
  ).toMatchObject({ high: null, max: "max" });
  f.state.body = { data: [{ id: "claude-chat", thinking: false }] };
  expect(reasoningCapabilities((await f.registry.catalog("anthropic")).models[0]!)).toEqual({
    reasoningLevels: ["off"],
    defaultReasoningLevel: "off",
  });
  await f.registry.verify({ providerId: "anthropic", modelId: "claude-chat", reasoning: "off" });
  expect(JSON.parse(await readFile(f.path, "utf8")).providers.anthropic.models[0].reasoning).toBe(
    false
  );
});

describe("inference provider service", () => {
  const eventually = async <T>(read: () => T, matches: (value: T) => boolean): Promise<T> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const value = read();
      if (matches(value)) return value;
      await Bun.sleep(5);
    }
    throw new Error("Expected provider session state was not reached");
  };

  test("exposes catalogs and keeps submitted secrets out of session views", async () => {
    const f = await fixture();
    f.connected.delete("anthropic");
    const service = new InferenceProviderService(() => f.runtime, f.path, f.fetcher);
    const catalog = await service.catalog("anthropic");
    expect(catalog.providers.find((p) => p.id === "anthropic")).toMatchObject({ connected: false, modelCount: 0 });
    expect(catalog.models).toEqual([]);
    const waitingFor = (id: string) => eventually(() => service.authSession(id), (session) => session.status === "waiting");
    const started = service.startAuthSession("anthropic", "api_key");
    const waiting = await waitingFor(started.id);
    expect(waiting.prompt).toMatchObject({ type: "secret", message: "API key" });
    service.respond(started.id, waiting.prompt!.id, "super-secret-value");
    const complete = await eventually(() => service.authSession(started.id), (session) => session.status === "connected");
    expect(f.connected.has("anthropic")).toBe(true);
    expect(JSON.stringify(complete)).not.toContain("super-secret-value");
    const expiring = service.startAuthSession("anthropic", "api_key");
    await waitingFor(expiring.id);
    (service as unknown as { sessions: Map<string, { createdAt: number }> }).sessions.get(expiring.id)!.createdAt = Date.now() - 16 * 60_000;
    expect(service.authSession(expiring.id).status).toBe("cancelled");
  });

  test("does not invent effort controls when OpenRouter omits supported efforts", async () => {
    const f = await fixture({ openrouter: { baseUrl: "https://openrouter.test/api/v1", api: "openai-completions" } });
    const entry = (id: string, parameters: string[], reasoning?: unknown) => ({
      id, name: id, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools", ...parameters], ...(reasoning ? { reasoning } : {}),
    });
    f.state.body = { data: [
      entry("openrouter/auto", ["reasoning"]),
      entry("anthropic/claude-sonnet-5.5", ["reasoning"], { mandatory: true }),
      entry("anthropic/claude-haiku-5.5", ["reasoning"], { mandatory: false }),
      entry("author/no-reasoning", []),
    ] };
    const catalog = await new InferenceProviderService(() => f.runtime, f.path, f.fetcher).catalog("openrouter");
    expect(catalog.models.map((model) => [model.modelId, model.reasoningLevels, model.defaultReasoningLevel])).toEqual([
      ["openrouter/auto", [], "off"],
      ["anthropic/claude-sonnet-5.5", [], "off"],
      ["anthropic/claude-haiku-5.5", [], "off"],
      ["author/no-reasoning", ["off"], "off"],
    ]);
  });

  test("retired ChatGPT models are hidden even from a cached catalog and rejected with a replacement", async () => {
    const f = await fixture({}, [...["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol"].map((id) => model("openai-codex", id)), model("openai", "gpt-5.4")]);
    expect(availableInferenceModels(f.runtime, "openai-codex").map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
    expect(availableInferenceModels(f.runtime, "openai").map((m) => m.id)).toContain("gpt-5.4");
    for (const [modelId, replacement] of [["gpt-5.4", "gpt-5.6-terra"], ["gpt-5.4-mini", "gpt-5.6-luna"]] as const) {
      const ref = { providerId: "openai-codex", modelId };
      expect(() => requireInferenceModel(f.runtime, ref)).toThrow(`Select openai-codex/${replacement}`);
      await expect(new InferenceProviderService(() => f.runtime, f.path).verify({ ...ref, reasoning: "low" })).rejects.toThrow("retired for ChatGPT sign-in");
    }
  });
});

test("input metadata: flat beats nested, image implies text, malformed keeps the previous input", async () => {
  const cases: Array<[Record<string, unknown>, Array<"text" | "image"> | undefined, Array<"text" | "image">]> = [
    [{ modalities: { input: ["text", "image"] } }, undefined, ["text", "image"]],
    [{ modalities: { input: [null, {}, "image", "audio"] } }, ["text"], ["text", "image"]],
    [{ input_modalities: ["text"], modalities: { input: ["image"] } }, ["text", "image"], ["text"]],
    [{ input_modalities: null, modalities: { input: ["image"] } }, undefined, ["text", "image"]],
    [{ modalities: { input: ["audio"] } }, ["text", "image"], ["text"]],
    [{ modalities: { input: "image" } }, ["text", "image"], ["text", "image"]],
    [{}, undefined, ["text"]],
  ];
  for (const [metadata, previous, expected] of cases) {
    const f = await fixture({
      magpie: { baseUrl: "https://magpie.test/v1", api: "openai-completions" },
    });
    f.connected.clear();
    f.connected.add("magpie");
    if (previous)
      f.runtime.registerProvider("magpie", {
        models: [{ ...model("magpie", "vision-chat"), input: [...previous] }],
      } as never);
    f.state.body = { data: [{ id: "vision-chat", ...metadata }] };
    const catalog = await f.registry.catalog("magpie");
    expect(catalog.models[0]?.input, JSON.stringify({ metadata, previous })).toEqual(expected);
  }
});

test("a late OpenRouter verification cannot undo a concurrently refreshed prompt cap or pricing tiers", async () => {
  const saved = {
    ...model("openrouter", "vendor/chat"),
    api: "openai-completions",
    reasoning: false,
    contextWindow: 16000,
    baseUrl: "https://openrouter.test/api/v1",
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  };
  const f = await fixture({
    openrouter: { baseUrl: saved.baseUrl, api: "openai-completions", models: [saved] },
  });
  f.connected.clear();
  f.connected.add("openrouter");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const base = { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000025" };
  let endpoints = 0;
  const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async (
    raw: URL | string | Request,
    init: RequestInit
  ) => {
    if (new URL(String(raw)).pathname.endsWith("/endpoints")) {
      const older = ++endpoints === 1;
      if (older) {
        entered.resolve();
        await release.promise;
      }
      return Response.json({
        data: {
          endpoints: [
            {
              max_prompt_tokens: older ? 12000 : 4000,
              pricing: {
                ...base,
                overrides: older ? undefined : [{ min_prompt_tokens: 8000, prompt: "0.000006" }],
              },
            },
          ],
        },
      });
    }
    f.state.body = {
      data: [
        {
          id: saved.id,
          context_length: 16000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
          pricing: base,
        },
      ],
    };
    return f.fetcher(raw, init);
  }) as typeof fetch);
  const read = async () =>
    JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0];
  const verifying = registry.verify({ providerId: "openrouter", modelId: saved.id, reasoning: "off" });
  try {
    await entered.promise;
    await registry.refreshPromptCaps();
    const current = await read();
    expect(current.contextWindow).toBe(4000);
    expect(current.cost.tiers).toHaveLength(1);
    release.resolve();
    await verifying;
    expect(await read()).toMatchObject({ contextWindow: 4000, cost: current.cost });
  } finally {
    release.resolve();
    await verifying;
  }
});

test("a pending OpenRouter prompt-cap refresh preserves an in-flight deployment URL edit", async () => {
  const saved = {
    ...model("openrouter", "vendor/chat"),
    api: "openai-completions",
    contextWindow: 16000,
    baseUrl: "https://openrouter.test/api/v1",
  };
  const f = await fixture({ openrouter: { baseUrl: saved.baseUrl, models: [saved] } });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registry = new ChatProviderRegistry(() => f.runtime, f.path, (async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ data: { endpoints: [{ max_prompt_tokens: 4000 }] } });
  }) as unknown as typeof fetch);
  const operation = registry.refreshPromptCaps();
  try {
    await entered.promise;
    const edited = JSON.parse(await readFile(f.path, "utf8"));
    edited.providers.openrouter.models[0].baseUrl = "https://new-deployment.test/api/v1";
    const bytes = JSON.stringify(edited);
    await writeFile(f.path, bytes);
    release.resolve();
    await operation;
    expect(await readFile(f.path, "utf8")).toBe(bytes);
  } finally {
    release.resolve();
    await operation;
  }
});
