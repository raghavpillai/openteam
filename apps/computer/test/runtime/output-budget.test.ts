import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { withAgentOutputBudget } from "../../src/runtime/output-budget";

test("provider requests leave room for conversation history without mutating catalog limits", async () => {
  const catalog: Model<"openai-completions"> = {
    id: "output-budget-fixture", name: "Output budget fixture", provider: "openrouter",
    api: "openai-completions", baseUrl: "https://offline.invalid", reasoning: false,
    input: ["text", "image"], contextWindow: 500_000, maxTokens: 450_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const requests: Record<string, any>[] = [];
  const model = withAgentOutputBudget(catalog);
  await streamSimple(model, {
    messages: [{ role: "user", content: "Inspect this conversation. ".repeat(12_000), timestamp: 0 }],
  }, {
    apiKey: "synthetic-test-key", maxRetries: 0,
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(await new Response(init?.body).text()));
      return new Response(JSON.stringify({ error: { message: "Offline request captured" } }), { status: 400 });
    }) as typeof fetch,
  }).result();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.max_tokens ?? requests[0]!.max_completion_tokens).toBe(50_000);
  expect(catalog.maxTokens).toBe(450_000);
  expect(model.contextWindow).toBe(500_000);
});

test("preserves smaller provider output limits and handles odd context sizes", () => {
  const small = { contextWindow: 128_000, maxTokens: 8_192 };
  expect(withAgentOutputBudget(small)).toBe(small);
  expect(withAgentOutputBudget({ contextWindow: 131_071, maxTokens: 100_000 }).maxTokens).toBe(13_107);
  expect(withAgentOutputBudget({ contextWindow: 1, maxTokens: 1 }).maxTokens).toBe(1);
  const unknown = { contextWindow: 0, maxTokens: 8_192 };
  expect(withAgentOutputBudget(unknown)).toBe(unknown);
});
