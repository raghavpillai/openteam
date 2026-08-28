import { expect, test } from "bun:test";
import { resolveTurnMemoryExchange } from "../src/worker";

test("memory recording prefers clean visible messages and joins visible agent replies", () => {
  const occurredAt = new Date("2026-08-27T20:07:24.726Z");
  expect(
    resolveTurnMemoryExchange({
      visibleUser: { content: "  Remember cobalt headers.  ", createdAt: occurredAt },
      internalUser: {
        content: "<timestamp>wrapped</timestamp><user_query>[t190u] stale</user_query>",
        createdAt: new Date(0),
      },
      visibleAssistant: [{ content: " First update. " }, { content: "Final answer." }],
      internalAssistant: null,
    })
  ).toEqual({
    user: "Remember cobalt headers.",
    assistant: "First update.\nFinal answer.",
    occurredAt: occurredAt.getTime(),
  });
});

test("memory recording falls back to internal messages without a visible delivery", () => {
  const occurredAt = new Date("2026-08-27T20:08:00Z");
  expect(
    resolveTurnMemoryExchange({
      visibleUser: null,
      internalUser: { content: "Internal request", createdAt: occurredAt },
      visibleAssistant: [],
      internalAssistant: { content: "Internal response" },
    })
  ).toEqual({
    user: "Internal request",
    assistant: "Internal response",
    occurredAt: occurredAt.getTime(),
  });
});
