import { CHAT_PROVIDER_DEFINITIONS } from "./chat-provider-definitions";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { InferenceProviderView, ServerInferenceSettings } from "@openteam/contracts";
import {
  availableInferenceModels,
  replacementFor,
  requireInferenceModel,
} from "./inference-models";

export const CHAT_PROVIDERS = new Set(Object.keys(CHAT_PROVIDER_DEFINITIONS));
export const KEYLESS_API_KEY = "openteam-no-auth";
export type ChatModel = Model<Api>;
type CustomConfig = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<Record<string, unknown>>;
};
type Config = { providers?: Record<string, CustomConfig>; [key: string]: unknown };
type Entry = Record<string, unknown> & { id: string };
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown, fallback: number) =>
  Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : fallback;
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(v);

/** Common non-chat families; structured task metadata takes precedence over inference by ID. */
export const isChatModel = (entry: Entry, known = false, chatEndpoint = false): boolean => {
  if (Array.isArray(entry.supportedGenerationMethods))
    return entry.supportedGenerationMethods.includes("generateContent");
  const task = String(entry.task ?? entry.type ?? "").toLowerCase();
  if (/embed|transcri|speech|audio|rerank|image|moderation|tts/.test(task)) return false;
  if (Array.isArray(entry.supported_endpoints)) {
    return entry.supported_endpoints.some((v) =>
      /(?:chat\/completions|responses|messages)$/.test(String(v))
    );
  }
  const id = entry.id.toLowerCase();
  if (
    /(?:whisper|transcrib|transcri|parakeet|canary|embedding|embed-|rerank|moderation|dall-e|gpt-image|tts|realtime|audio|sora)/.test(
      id
    )
  )
    return false;
  return known || chatEndpoint || /chat|llm|text-generation/.test(task);
};

/** OpenRouter publishes explicit modalities and parameter support; do not guess by ID. */
const openRouterChatModel = (entry: Entry): boolean => {
  const architecture = object(entry.architecture) ? entry.architecture : {};
  return (
    Array.isArray(architecture.output_modalities) &&
    architecture.output_modalities.includes("text") &&
    Array.isArray(entry.supported_parameters) &&
    entry.supported_parameters.includes("tools")
  );
};
const applyOpenRouterMetadata = (model: ChatModel, entry: Entry): void => {
  const architecture = object(entry.architecture) ? entry.architecture : {};
  const top = object(entry.top_provider) ? entry.top_provider : {};
  const pricing = object(entry.pricing) ? entry.pricing : {};
  const price = (value: unknown): number => {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : 0;
  };
  model.api = "openai-completions";
  model.contextWindow = positive(entry.context_length, model.contextWindow);
  model.maxTokens = Math.min(
    positive(top.max_completion_tokens, model.maxTokens),
    model.contextWindow
  );
  model.reasoning =
    Array.isArray(entry.supported_parameters) &&
    entry.supported_parameters.some((p) => p === "reasoning" || p === "reasoning_effort");
  model.input =
    Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image")
      ? ["text", "image"]
      : ["text"];
  model.cost = {
    input: price(pricing.prompt),
    output: price(pricing.completion),
    cacheRead: price(pricing.input_cache_read),
    cacheWrite: price(pricing.input_cache_write),
  };
};

const configFile = async (path: string): Promise<Config> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(value) || (value.providers !== undefined && !object(value.providers)))
      throw new Error("Invalid provider registry");
    return value as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      "The custom provider registry is invalid. Repair models.json before loading providers."
    );
  }
};
export const modelsEndpoint = (baseUrl: string, anthropic = false): URL => {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTP(S) API base URL without credentials, a query, or a fragment.");
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/(chat\/completions|responses|messages|models)$/.test(path))
    throw new Error("Use the API base URL ending in /v1, rather than a specific request endpoint.");
  url.pathname = `${path}${(!path || anthropic) && !/\/v\d+$/.test(path) ? "/v1" : ""}/models`;
  return url;
};
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty model response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error("Model response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ChatProviderRegistry {
  constructor(
    private readonly runtime: () => ModelRuntime,
    readonly modelsPath: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}
  async catalog(providerId?: string) {
    const runtime = this.runtime();
    const signal = AbortSignal.timeout(8_000);
    await runtime.refresh({ allowNetwork: false, signal });
    const config = await configFile(this.modelsPath);
    const custom = config.providers ?? {};
    const allowed = runtime
      .getProviders()
      .filter((p) => CHAT_PROVIDERS.has(p.id) || Object.hasOwn(custom, p.id));
    const groups = await Promise.all(
      allowed.map(async (p) => {
        const isCustom = !CHAT_PROVIDERS.has(p.id) && Object.hasOwn(custom, p.id);
        const authentication = await runtime.checkAuth(p.id, { signal }).catch(() => undefined);
        const row: InferenceProviderView = {
          id: p.id,
          name: CHAT_PROVIDER_DEFINITIONS[p.id]?.name ?? p.name,
          connected: Boolean(authentication),
          authType: authentication?.type ?? null,
          authSource: authentication?.source ?? null,
          custom: isCustom,
          modelCount: 0,
          authMethods: [
            ...(p.auth.oauth
              ? [
                  {
                    type: "oauth" as const,
                    label: p.auth.oauth.name,
                    subscription: Boolean(p.auth.oauth.isSubscription),
                  },
                ]
              : []),
            ...(p.auth.apiKey?.login
              ? [{ type: "api_key" as const, label: p.auth.apiKey.name, subscription: false }]
              : []),
          ],
          modelStatus: authentication ? "unavailable" : "disconnected",
          modelMessage: authentication
            ? undefined
            : "Connect this provider to load its chat models.",
        };
        if (!authentication) return { row, models: [] as ChatModel[] };
        try {
          const models = await this.discover(p.id, custom[p.id], authentication.type, signal);
          row.modelCount = models.length;
          row.modelStatus = "ready";
          row.modelMessage = models.length
            ? undefined
            : "No supported chat models were returned. Check model access or the endpoint's model types.";
          return { row, models };
        } catch (error) {
          row.modelMessage =
            error instanceof DiscoveryError
              ? error.message
              : `Could not load chat models. Check the endpoint and credentials, then refresh the provider.`;
          return { row, models: [] as ChatModel[] };
        }
      })
    );
    // Keep the registry usable when the saved selection names a removed/legacy provider.
    return {
      providers: groups.map((g) => g.row),
      models: groups.flatMap((g) => (!providerId || g.row.id === providerId ? g.models : [])),
      modelProviderId: providerId ?? "",
    };
  }
  private async discover(
    id: string,
    config: CustomConfig | undefined,
    authType: string,
    signal: AbortSignal
  ): Promise<ChatModel[]> {
    const runtime = this.runtime();
    const provider = runtime.getProvider(id)!;
    const resolved = await runtime.getAuth(id, { signal });
    if (!resolved) throw new DiscoveryError(`Reconnect ${provider.name} to load its chat models.`);
    const auth = resolved.auth;
    const keyless = config?.apiKey === KEYLESS_API_KEY;
    const base = config?.baseUrl ?? auth.baseUrl ?? provider.baseUrl;
    if (!base) throw new DiscoveryError("Add an API base URL before loading models.");
    let url: URL;
    const headers = new Headers();
    if (!keyless)
      for (const [name, value] of Object.entries(auth.headers ?? {}))
        if (typeof value === "string") headers.set(name, value);
    if (id === "openai-codex") {
      // Older client versions can receive only hidden review models, leaving
      // an authenticated subscription with an empty chat-model picker.
      url = new URL("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
      headers.set("authorization", `Bearer ${auth.apiKey}`);
      try {
        const claim = JSON.parse(Buffer.from(auth.apiKey!.split(".")[1]!, "base64url").toString());
        const account = claim["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof account === "string") headers.set("chatgpt-account-id", account);
      } catch {}
    } else {
      const anthropic =
        id === "anthropic" || id === "claude-code" || config?.api === "anthropic-messages";
      url = modelsEndpoint(base, anthropic);
      if (id === "openrouter") url.pathname += "/user";
      if (anthropic) {
        headers.set("anthropic-version", "2023-06-01");
        url.searchParams.set("limit", "1000");
        if (auth.apiKey && !keyless) {
          if (authType === "oauth") {
            headers.set("authorization", `Bearer ${auth.apiKey}`);
            headers.set("anthropic-beta", "oauth-2025-04-20");
          } else headers.set("x-api-key", auth.apiKey);
        }
      } else if (config?.api === "google-generative-ai" && auth.apiKey && !keyless)
        headers.set("x-goog-api-key", auth.apiKey);
      else if (auth.apiKey && !keyless && !headers.has("authorization"))
        headers.set("authorization", `Bearer ${auth.apiKey}`);
    }
    headers.set("accept", "application/json");
    const entries: Entry[] = [];
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const response = await this.fetchImpl(url, { headers, signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new DiscoveryError(
            `The provider rejected model discovery (HTTP ${response.status}). Reconnect it or grant model-list access.`
          );
        if (response.status === 404 || response.status === 405)
          throw new DiscoveryError(
            "This endpoint does not expose a model list. Check the API base URL or configure model discovery on the server."
          );
        throw new DiscoveryError(
          `Model discovery failed (HTTP ${response.status}). Check the provider's availability and retry.`
        );
      }
      const body = await responseJson(response);
      const values = object(body)
        ? id === "openai-codex" || config?.api === "google-generative-ai"
          ? body.models
          : body.data
        : undefined;
      if (!Array.isArray(values))
        throw new DiscoveryError(
          "The provider returned an invalid model list. Check the API base URL and protocol."
        );
      for (const value of values) {
        if (!object(value)) throw new Error("Invalid model");
        const modelId =
          id === "openai-codex"
            ? value.slug
            : config?.api === "google-generative-ai" && typeof value.name === "string"
              ? value.name.replace(/^models\//, "")
              : value.id;
        if (!validId(modelId)) throw new Error("Invalid model id");
        if (id === "openai-codex" && value.visibility !== "list") continue;
        entries.push({ ...value, id: modelId });
      }
      if (object(body) && typeof body.nextPageToken === "string" && body.nextPageToken) {
        if (page === 19 || cursors.has(body.nextPageToken))
          throw new DiscoveryError("The provider returned invalid model pagination.");
        cursors.add(body.nextPageToken);
        url.searchParams.set("pageToken", body.nextPageToken);
        continue;
      }
      if (!object(body) || body.has_more !== true) break;
      if (page === 19 || !validId(body.last_id) || cursors.has(body.last_id))
        throw new DiscoveryError(
          "The provider returned invalid model pagination. Retry after fixing its model-list response."
        );
      cursors.add(body.last_id);
      url.searchParams.set("after_id", body.last_id);
    }
    const known = new Map(availableInferenceModels(runtime, id).map((m) => [m.id, m]));
    const custom = !CHAT_PROVIDERS.has(id) && Boolean(config);
    const models = [
      ...new Map(
        entries
          .filter((m) => !replacementFor(id, m.id))
          .filter((m) =>
            id === "openrouter"
              ? openRouterChatModel(m)
              : isChatModel(
                  m,
                  known.has(m.id) ||
                    (id === "openai" &&
                      (known.has(m.id.split(":")[1] ?? "") ||
                        /^(?:gpt-[3-9]|o[1-9](?:-|$)|chatgpt-)/.test(m.id)) &&
                      !/instruct/.test(m.id)),
                  custom || id === "anthropic" || id === "claude-code" || id === "openai-codex"
                )
          )
          .map((m) => {
            const existing =
              known.get(m.id) ??
              (id === "openai" ? known.get(m.id.split(":")[1] ?? "") : undefined);
            const model: ChatModel = {
              ...existing,
              id: m.id,
              provider: id,
              name: String(m.display_name ?? m.displayName ?? m.name ?? existing?.name ?? m.id),
              api:
                existing?.api ??
                (config?.api as Api) ??
                CHAT_PROVIDER_DEFINITIONS[id]?.api ??
                "openai-completions",
              baseUrl: base,
              reasoning:
                existing?.reasoning ??
                (m.thinking === true ||
                  (Array.isArray(m.supported_reasoning_levels) &&
                    m.supported_reasoning_levels.length > 0)),
              input: existing?.input ?? ["text"],
              cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: positive(
                m.context_window ?? m.max_input_tokens ?? m.inputTokenLimit,
                existing?.contextWindow ?? 128000
              ),
              maxTokens: positive(m.max_tokens ?? m.outputTokenLimit, existing?.maxTokens ?? 16384),
            };
            if (id === "openrouter") applyOpenRouterMetadata(model, m);
            return [m.id, model] as const;
          })
      ).values(),
    ].filter((m): m is ChatModel => Boolean(m));
    return models;
  }
  async verify(settings: ServerInferenceSettings): Promise<void> {
    // Check retirements before making network requests, and access before accepting a saved choice.
    if (this.runtime().getModel(settings.providerId, settings.modelId))
      requireInferenceModel(this.runtime(), settings);
    const catalog = await this.catalog(settings.providerId);
    const provider = catalog.providers.find((p) => p.id === settings.providerId);
    if (!provider)
      throw new Error(
        `Provider ${settings.providerId} is not in your registry. Connect a built-in provider, or add a custom endpoint with openteam provider add.`
      );
    const model = catalog.models.find((m) => m.id === settings.modelId);
    if (!model)
      throw new Error(
        provider.modelMessage ??
          `Model ${settings.modelId} is not available from this connected provider. Refresh its model list and choose a listed chat model.`
      );
    // Existing model definitions already survive restart; only persist new discoveries.
    if (
      settings.providerId === "openrouter" ||
      !this.runtime().getModel(settings.providerId, settings.modelId)
    ) {
      const document = await configFile(this.modelsPath);
      document.providers ??= {};
      const config = (document.providers[provider.id] ??= {});
      if (
        config.baseUrl &&
        config.baseUrl.replace(/\/+$/, "") !== model.baseUrl.replace(/\/+$/, "")
      )
        throw new Error("Provider settings changed. Reload the model list and retry.");
      const { id, name, reasoning, input, cost, contextWindow, maxTokens, api, baseUrl } = model;
      config.models = [
        ...(config.models ?? []).filter((m) => m.id !== id),
        { id, name, reasoning, input, cost, contextWindow, maxTokens, api, baseUrl },
      ];
      await mkdir(dirname(this.modelsPath), { recursive: true, mode: 0o700 });
      const temp = `${this.modelsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
        await rename(temp, this.modelsPath);
      } finally {
        await rm(temp, { force: true });
      }
      await this.runtime().refresh({ allowNetwork: false, signal: AbortSignal.timeout(8_000) });
    }
  }
}
class DiscoveryError extends Error {}
