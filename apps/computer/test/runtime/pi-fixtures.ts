// Offline provider plumbing for suites that drive the real Pi agent loop.
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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

/** An OpenAI-compatible streamed completion made of the given chunk bodies. */
export const sseResponse = (model: { id: string }, chunks: object[]) =>
  new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );

/** A real ModelRuntime whose streamed model calls are answered by `fetch`. */
export async function offlineModelRuntime(model: Model<"openai-completions">, fetch: (url: unknown, init: any) => Promise<Response>) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.checkAuth = async () => ({ type: "api_key" });
  runtime.streamSimple = (_model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: "synthetic-fixture", maxRetries: 0, fetch: fetch as typeof globalThis.fetch });
  return runtime;
}
