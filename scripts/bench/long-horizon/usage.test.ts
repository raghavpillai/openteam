import { expect, test } from "bun:test";
import { summarizeUsage } from "./usage";

test("restart transcript copies do not double-count provider responses or actions", () => {
  const response = { type: "message", id: "a", message: { role: "assistant", responseId: "provider-1",
    usage: { input: 20, output: 5, cacheRead: 10, cost: { total: 0.2 } },
    content: [{ type: "toolCall", name: "browser_run_code", arguments: {} }] } };
  expect(summarizeUsage([response, response, { type: "message", id: "b", message: { role: "assistant", content: [] } }]))
    .toMatchObject({ modelResponses: 2, responsesWithoutUsage: 1, inputTokens: 20, outputTokens: 5,
      cacheReadTokens: 10, estimatedUsd: 0.2, browserCalls: 1, toolCalls: 1 });
});
