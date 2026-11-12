import { describe, expect, test } from "bun:test";
import { calculateCost, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openRouterCost, openRouterEndpointCost } from "../src/chat-provider-registry";

const pricing = {
  prompt: "0.000002",
  completion: "0.00001",
  input_cache_read: "0.0000001",
  input_cache_write: "0.0000025",
  overrides: [
    {
      min_prompt_tokens: 272000,
      prompt: "0.000004",
      completion: "0.000015",
      input_cache_read: "0.0000002",
      input_cache_write: "0.000005",
    },
  ],
};
const usage = (input: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output: 1000,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const model: Model<"openai-completions"> = {
  id: "openai/gpt-6.1-sol",
  provider: "openrouter",
  api: "openai-completions",
  name: "Sol",
  baseUrl: "https://openrouter.test/api/v1",
  reasoning: true,
  contextWindow: 922000,
  maxTokens: 128000,
  input: ["text", "image"],
  cost: openRouterCost(pricing),
};

describe("OpenRouter pricing overrides", () => {
  test.each([
    271999, 272000, 272001,
  ])("Pi applies request-wide prices at prompt size %i", (tokens) => {
    const result = usage(tokens - 200000, 150000, 50000);
    calculateCost(model, result);
    const tier = tokens > 272000;
    expect(result.cost.input).toBeCloseTo((result.input * (tier ? 4 : 2)) / 1e6);
    expect(result.cost.output).toBeCloseTo(tier ? 0.015 : 0.01);
    expect(result.cost.cacheRead).toBeCloseTo(tier ? 0.03 : 0.015);
    expect(result.cost.cacheWrite).toBeCloseTo(tier ? 0.25 : 0.125);
  });

  test("partial overrides inherit prices and preserve document precedence across unsorted, duplicate thresholds", () => {
    const cost = openRouterCost({
      ...pricing,
      overrides: [
        { min_prompt_tokens: 400000, prompt: "0.000006", completion: "0.00002" },
        { min_prompt_tokens: 272000, prompt: "0.000004" },
        { min_prompt_tokens: 400000, input_cache_read: "0" },
      ],
    });
    expect(cost.tiers?.map((t) => [t.inputTokensAbove, t.input, t.output, t.cacheWrite])).toEqual([
      [272000, 4, 10, 2.5],
      [400000, 4, 20, 2.5],
    ]);
    expect(cost.tiers?.[1]?.cacheRead).toBe(0);
  });

  test("unsupported conditions and invalid overrides never become unconditional tiers", () => {
    const invalid = [
      { min_prompt_tokens: 1, utc_start: 100, utc_end: 200, prompt: "9" },
      { min_prompt_tokens: 1, utc_days: ["monday"], prompt: "9" },
      { min_prompt_tokens: 1, future_condition: true, prompt: "9" },
      { min_prompt_tokens: -1, prompt: "9" },
      { min_prompt_tokens: 1.5, prompt: "9" },
      { min_prompt_tokens: "1", prompt: "9" },
      { min_prompt_tokens: 1, prompt: "NaN" },
      { min_prompt_tokens: 1, completion: -1 },
      { min_prompt_tokens: 1, prompt: "" },
      { min_prompt_tokens: 1, prompt: "1e999" },
      null,
    ];
    expect(openRouterCost({ ...pricing, overrides: invalid }).tiers).toBeUndefined();
    expect(openRouterCost({ ...pricing, overrides: undefined }).tiers).toBeUndefined();
  });

  test("endpoint tiers must match base rates and agree across matching routes", () => {
    const body = (...prices: unknown[]) => ({
      data: { endpoints: prices.map((pricing) => ({ pricing })) },
    });
    const base = openRouterCost({ ...pricing, overrides: undefined });
    expect(openRouterEndpointCost(body({ ...pricing, prompt: "0.000001" }, pricing), base)).toEqual(
      model.cost
    );
    expect(openRouterEndpointCost(body(pricing, pricing), base)).toEqual(model.cost);
    expect(openRouterEndpointCost(body({ ...pricing, prompt: "0.000001" }), base)).toBeUndefined();
    expect(
      openRouterEndpointCost(body(pricing, { ...pricing, overrides: undefined }), base)
    ).toBeUndefined();
    expect(openRouterEndpointCost(body({ prompt: "0.000002" }), base)).toBeUndefined();
    expect(openRouterEndpointCost(body(pricing), {})).toBeUndefined();
  });

  test("real Pi streaming keeps request payloads identical and persists tiered usage", async () => {
    const requests: unknown[] = [];
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(await new Response(init.body).text()));
      const chunks = [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 300000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 100000 },
          },
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;
    const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }] };
    const options = { apiKey: "synthetic", fetch: fetcher, maxRetries: 0 };
    const base = await streamSimple(
      { ...model, cost: openRouterCost({ ...pricing, overrides: undefined }) },
      context,
      options
    ).result();
    const tiered = await streamSimple(model, context, options).result();
    expect(requests[1]).toEqual(requests[0]);
    expect(tiered.content).toEqual(base.content);
    expect(tiered.stopReason).toBe(base.stopReason);
    expect(tiered.usage.cost.total).toBeCloseTo(0.835);
    expect(base.usage.cost.total).toBeCloseTo(0.42);
    const root = await mkdtemp(join(tmpdir(), "openteam-tier-session-"));
    try {
      const session = SessionManager.create(root, root);
      session.appendMessage(tiered);
      const entries = (await readFile(session.getSessionFile()!, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.find((entry) => entry.type === "message").message.usage.cost).toEqual(
        tiered.usage.cost
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
