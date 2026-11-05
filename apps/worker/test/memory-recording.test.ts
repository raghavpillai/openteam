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
      internalAssistant: [{ content: "Checked the headers." }, { content: " " }],
    })
  ).toEqual({
    user: "Remember cobalt headers.",
    assistant: "First update.\nFinal answer.\nChecked the headers.",
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
      internalAssistant: [{ content: "Internal draft" }, { content: "Internal response" }],
    })
  ).toEqual({
    user: "Internal request",
    assistant: "Internal draft\nInternal response",
    occurredAt: occurredAt.getTime(),
  });
});

test("a turn answered with only a reaction or silence is still reviewed", () => {
  const occurredAt = new Date("2026-08-27T20:09:00Z");
  expect(
    resolveTurnMemoryExchange({
      visibleUser: { content: "FYI I'm vegetarian now", createdAt: occurredAt },
      internalUser: null,
      visibleAssistant: [],
      internalAssistant: [],
    })
  ).toEqual({ user: "FYI I'm vegetarian now", assistant: "", occurredAt: occurredAt.getTime() });
  expect(resolveTurnMemoryExchange({ visibleUser: null, internalUser: null, visibleAssistant: [{ content: "Hi" }], internalAssistant: [] })).toBeNull();
});
