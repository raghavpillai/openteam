import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ChatProviderRegistry,
  inputWindow,
  isChatModel,
  KEYLESS_API_KEY,
  modelsEndpoint,
} from "../src/chat-provider-registry";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
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
async function fixture(custom: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openteam-chat-registry-"));
  dirs.push(directory);
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
  const f = await fixture({ openrouter: { baseUrl: "https://openrouter.test/api/v1", api: "openai-completions" } });
  f.state.body = {
    data: [
      {
        id: "author/new-model",
        name: "New model",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
        context_length: 200000,
        top_provider: { max_completion_tokens: 32000 },
        pricing: { prompt: "0.000002", completion: "0.000008" },
      },
      { id: "author/no-tools", architecture: { output_modalities: ["text"] }, supported_parameters: [] },
      { id: "author/image", architecture: { output_modalities: ["image"] }, supported_parameters: ["tools"] },
    ],
  };
  const catalog = await f.registry.catalog("openrouter");
  expect(catalog.providers.find((p) => p.id === "openrouter")).toMatchObject({ custom: false, connected: true });
  const expected = { id: "author/new-model", api: "openai-completions", input: ["text", "image"], contextWindow: 200000, cost: { input: 2, output: 8 } };
  expect(catalog.models).toHaveLength(1);
  expect(catalog.models[0]).toMatchObject({ ...expected, provider: "openrouter", name: "New model", reasoning: true, maxTokens: 32000 });
  const request = f.calls.find((c) => c.url.hostname === "openrouter.test")!;
  expect(request.url.pathname).toBe("/api/v1/models/user");
  expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer synthetic-openrouter-key");
  await f.registry.verify({ providerId: "openrouter", modelId: "author/new-model", reasoning: "medium" });
  expect(JSON.parse(await readFile(f.path, "utf8")).providers.openrouter.models[0]).toMatchObject(expected);
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
        { provider_name: "Other", context_length: 1_050_000, max_prompt_tokens: 930_000, max_completion_tokens: 128_000 },
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

