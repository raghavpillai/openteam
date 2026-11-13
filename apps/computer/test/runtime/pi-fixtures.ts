// Offline provider plumbing for suites that drive the real Pi agent loop.
import { InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import type { ActiveTurn } from "../../src/runtime/types";

export const offlineModel = (
  id: string,
  overrides: Partial<Model<"openai-completions">> = {}
): Model<"openai-completions"> => ({
  id,
  name: id,
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://offline.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...overrides,
});

export const usage = (input = 100, output = 10) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A completed assistant message as Pi stores it. */
export const answer = (model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason,
  content: text ? [{ type: "text", text }] : [], timestamp: Date.now(), usage: usage(),
});

/** An OpenAI-compatible streamed completion made of the given chunk bodies. */
export const sseResponse = (model: { id: string }, chunks: object[]) =>
  new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );

export const toolCall = (index: number, id: string, name: string, args: unknown = {}) =>
  ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/** One streamed model step: a text reply, or tool calls, then a finish chunk with usage. */
export const sseStep = (model: { id: string }, reply: string | object[], promptTokens = 10) =>
  sseResponse(model, [
    { choices: [{ index: 0, delta: typeof reply === "string" ? { role: "assistant", content: reply } : { role: "assistant", tool_calls: reply }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } },
  ]);

export const requestBody = async (init: any) => JSON.parse(await new Response(init.body).text());

/** A real ModelRuntime whose streamed model calls are answered by `fetch`. */
export async function offlineModelRuntime(model: Model<"openai-completions">, fetch: (url: unknown, init: any) => Promise<Response>) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.checkAuth = async () => ({ type: "api_key" });
  runtime.streamSimple = (_model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: "synthetic-fixture", maxRetries: 0, fetch: fetch as typeof globalThis.fetch });
  return runtime;
}

/** A ComputerRuntime rooted at `root` whose model calls are answered by `fetch`. */
export async function offlineComputerRuntime(
  model: Model<"openai-completions">,
  root: string,
  fetch: (url: unknown, init: any) => Promise<Response>,
  runtime: any = new ComputerRuntime()
) {
  runtime.agentDir = root;
  runtime.modelRuntime = await offlineModelRuntime(model, fetch);
  runtime.resolveModel = () => model;
  return runtime;
}

/** The turn fields the Pi loop reads; tests override what they exercise. */
export const piTurn = (model: { provider: string; id: string }, root: string, overrides: Record<string, unknown> = {}): ActiveTurn =>
  ({
    runId: crypto.randomUUID(), turnId: crypto.randomUUID(), botId: crypto.randomUUID(), contextSessionId: crypto.randomUUID(),
    modelRef: { providerId: model.provider, modelId: model.id }, reasoning: "off", instructions: "System fixture",
    userInfoMessage: null, cwd: root, runtimeProfile: "agent", subagentType: null, requestSource: "agent",
    pluginNamespaces: [], sentMessageCount: 0, assistantOrdinal: 0, startedItems: new Set(), toolArgs: new Map(),
    attachmentTempDirectories: [], queue: { push() {}, end() {} },
    ...overrides,
  }) as unknown as ActiveTurn;

/** Opens a real standalone Pi session for `active` and routes its events through the runtime. */
export async function openSession(runtime: any, active: any, manager: SessionManager, route = true) {
  const session = await runtime.createStandaloneSession(active.cwd, active.instructions, manager, active, active.modelRef);
  active.session = session;
  active.sessionPath = session.sessionFile;
  if (route) active.unsubscribe = session.subscribe((event: any) => runtime.routeEvent(active, event));
  return session;
}
