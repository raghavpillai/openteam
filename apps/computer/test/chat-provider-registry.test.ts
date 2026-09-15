import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ChatProviderRegistry,
  isChatModel,
  modelsEndpoint,
  KEYLESS_API_KEY,
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
  test("never exposes models for disconnected providers or falls back to the bundled catalog", async () => {
    const f = await fixture();
    f.connected.clear();
    expect((await f.registry.catalog()).models).toEqual([]);
    expect(f.calls).toHaveLength(0);
    f.connected.add("openai");
    f.state.body = { data: [] };
    expect((await f.registry.catalog()).models).toEqual([]);
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
  test.each([
    401, 403, 404, 405, 429, 500,
  ])("HTTP %i yields zero selectable models and an actionable, secret-free error", async (status) => {
    const f = await fixture();
    f.state.status = status;
    const result = await f.registry.catalog("openai");
    expect(result.models).toEqual([]);
    expect(result.providers[0]?.modelStatus).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(result.providers[0]?.modelMessage).toMatch(/Reconnect|Check/);
    f.state.status = 200;
    expect((await f.registry.catalog("openai")).models).toHaveLength(1);
  });
  test.each([
    {},
    { data: [{ id: 42 }] },
    { data: [{ id: "bad\u001b[31m" }] },
  ])("rejects malformed model responses %j", async (body) => {
    const f = await fixture();
    f.state.body = body;
    const result = await f.registry.catalog("openai");
    expect(result.models).toEqual([]);
    expect(result.providers[0]?.modelStatus).toBe("unavailable");
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
  test("ChatGPT uses its subscription catalog and excludes hidden models", async () => {
    const f = await fixture();
    f.connected.clear();
    f.connected.add("openai-codex");
    f.state.body = {
      models: [
        { slug: "gpt-visible", visibility: "list" },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-5.4", visibility: "list" },
      ],
    };
    const result = await f.registry.catalog("openai-codex");
    expect(result.models.map((m) => m.id)).toEqual(["gpt-visible"]);
    expect((await f.registry.catalog("openai-codex")).models.map((m) => m.id)).toEqual([
      "gpt-visible",
    ]);
    expect(f.calls[0]?.url.origin).toBe("https://chatgpt.com");
    expect(f.calls[0]?.url.pathname).toBe("/backend-api/codex/models");
  });
  test("Google-compatible custom endpoints filter generation methods", async () => {
    const f = await fixture({
      gemini: { baseUrl: "https://gemini.test/v1beta", api: "google-generative-ai", models: [] },
    });
    f.connected.clear();
    f.connected.add("gemini");
    f.state.body = {
      models: [
        { name: "models/gemini-chat", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
      ],
    };
    const result = await f.registry.catalog("gemini");
    expect(result.models.map((m) => m.id)).toEqual(["gemini-chat"]);
    expect(new Headers(f.calls[0]?.init.headers).get("x-goog-api-key")).toBe(
      "synthetic-gemini-key"
    );
  });
  test("rejects oversized responses and redacts transport failures", async () => {
    const f = await fixture();
    f.state.fail = true;
    let result = await f.registry.catalog("openai");
    expect(result.models).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("synthetic");
    const registry = new ChatProviderRegistry(
      () => f.runtime,
      f.path,
      (async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as unknown as typeof fetch
    );
    result = await registry.catalog("openai");
    expect(result.models).toEqual([]);
  });
  test("does not silently ignore a corrupt custom registry", async () => {
    const f = await fixture();
    await writeFile(f.path, "broken");
    await expect(f.registry.catalog()).rejects.toThrow("registry is invalid");
  });
});
describe("chat model classification and endpoint paths", () => {
  test.each([
    "whisper-1",
    "gpt-4o-transcribe",
    "gpt-4o-audio-preview",
    "text-embedding-3-small",
    "tts-1",
    "dall-e-3",
    "gpt-image-1",
    "omni-moderation-latest",
    "parakeet-v3",
  ])("excludes %s from chat even if bundled", (id) =>
    expect(isChatModel({ id }, true, true)).toBe(false));
  test("uses capability metadata for opaque model names", () => {
    expect(
      isChatModel({ id: "opaque", supported_endpoints: ["/v1/audio/transcriptions"] }, false, true)
    ).toBe(false);
    expect(isChatModel({ id: "opaque", supported_endpoints: ["/v1/chat/completions"] })).toBe(true);
  });
  test.each([
    ["http://localhost:11434", "http://localhost:11434/v1/models"],
    ["http://localhost:1234/v1/", "http://localhost:1234/v1/models"],
    ["https://gateway.test/api/v1", "https://gateway.test/api/v1/models"],
  ])("%s resolves to %s", (base, expected) => expect(modelsEndpoint(base).href).toBe(expected));
  test.each([
    "file:///tmp/models",
    "https://user:secret@host/v1",
    "https://host/v1?api_key=secret",
    "https://host/v1/chat/completions",
  ])("rejects unsafe or non-base URL %s", (base) => expect(() => modelsEndpoint(base)).toThrow());
});
