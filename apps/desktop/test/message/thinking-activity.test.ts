import { expect, test } from "bun:test";
import type { RunItemView } from "@openteam/contracts";
import {
  thinkingActivity,
  advanceActivity,
  activityElapsedLabel,
} from "../../src/renderer/lib/thinking-activity";
const item = (patch: Partial<RunItemView> = {}): RunItemView => ({
  id: "item",
  runId: "run",
  kind: "tool",
  status: "running",
  title: null,
  content: { tool: "read" },
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
  ...patch,
});
test("activity uses the newest active item and falls back after a tool completes", () => {
  expect(thinkingActivity()).toBe("Thinking");
  expect(thinkingActivity([item()])).toBe("Reading file");
  expect(
    thinkingActivity([
      item(),
      item({ id: "new", content: { tool: "WebSearch" }, createdAt: "2026-09-19T00:00:01Z" }),
    ])
  ).toBe("Searching the web");
  expect(thinkingActivity([item({ status: "completed" })])).toBe("Thinking");
  expect(thinkingActivity([item({ status: "failed" })])).toBe("Thinking");
});
test("only the user delivery tool marks composing; internal text and arguments stay private", () => {
  expect(
    thinkingActivity([item({ kind: "agent_message", content: { text: "private reasoning" } })])
  ).toBe("Thinking");
  expect(
    thinkingActivity([
      item({ content: { tool: "SendToUser", arguments: { text: "private draft" } } }),
    ])
  ).toBe("Typing");
  expect(
    thinkingActivity([item({ content: { tool: "unknown", arguments: { token: "secret" } } })])
  ).toBe("Working");
});
test("caption holds coalesce rapid updates and preserve semantic elapsed time", () => {
  const first = { text: "Thinking", since: 0, previous: null };
  expect(advanceActivity(first, "Reading file", 799, 800)).toBe(first);
  expect(advanceActivity(first, "Thinking", 1600, 800)).toBe(first);
  const latest = advanceActivity(first, "Typing", 800, 800);
  expect(latest).toEqual({ text: "Typing", since: 800, previous: "Thinking" });
  expect(advanceActivity(first, "Reading file", 1199, 1200)).toBe(first);
  expect(advanceActivity(first, "Reading file", 1200, 1200).text).toBe("Reading file");
  expect(activityElapsedLabel(0, 59999)).toBeNull();
  expect(activityElapsedLabel(0, 60000)).toBe("1m");
  expect(activityElapsedLabel(0, 3660000)).toBe("1h 1m");
});
