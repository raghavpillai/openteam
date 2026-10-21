import { expect, test } from "bun:test";
import { graphicalProgressReminder } from "../../src/runtime/graphical-completion";
import type { BotMessage } from "../../src/bot-compaction";
import { routeEvent } from "../../src/runtime/events";
import type { ActiveTurn } from "../../src/runtime/types";

test("graphical checkpoints occur during work, bounded by the user task and prior checkpoint", () => {
  const active = { subagentType: "computerUse", lastStopReason: "toolUse" } as ActiveTurn;
  const result = { role: "toolResult", toolName: "browser_snapshot", content: [] } as BotMessage;
  const twelve = Array.from({ length: 12 }, () => result);
  expect(graphicalProgressReminder(twelve.slice(1), active)).toBeNull();
  expect(graphicalProgressReminder(twelve, active)).toContain("still active");
  expect(graphicalProgressReminder(twelve, active)).toContain("actual user deadline");
  expect(graphicalProgressReminder([...twelve, { role: "custom", customType: "openteam-graphical-progress" }, result], active)).toBeNull();
  expect(graphicalProgressReminder([...twelve, { role: "user", content: "New task" }, result], active)).toBeNull();
  expect(graphicalProgressReminder([...twelve, { role: "assistant", content: "Finished" }], active)).toBeNull();
  for (const change of [{ subagentType: null }, { endTurnRequested: true }, { lastStopReason: "aborted" }, { lastStopReason: "error" }, { pluginAbortController: { signal: AbortSignal.abort() } }]) {
    expect(graphicalProgressReminder(twelve, { ...active, ...change } as ActiveTurn)).toBeNull();
  }
});

test("failed tool events keep the error flag in the persisted result", () => {
  const events: any[] = [];
  const active = {
    turnId: "turn",
    toolArgs: new Map(),
    queue: { push: (event: any) => events.push(event) },
  } as unknown as ActiveTurn;
  routeEvent(undefined, active, {
    type: "tool_execution_end",
    toolCallId: "task",
    toolName: "Task",
    isError: true,
    result: { content: [{ type: "text", text: "Review rejected the request" }], details: {} },
  } as any);
  expect(events[0].item.status).toBe("failed");
  expect(events[0].item.result.isError).toBe(true);
});

test("a computerUse turn ends when the model ends it, with no extra verification prompt", async () => {
  const { ComputerRuntime } = await import("../../src/runtime");
  const runtime = new ComputerRuntime() as any;
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  const prompts: string[] = [];
  const events: any[] = [];
  const active = {
    subagentType: "computerUse", requestSource: "subagent", lastStopReason: "stop", turnId: "turn", runId: "run",
    contextSessionId: "context", attachmentTempDirectories: [], sentMessageCount: 0,
    session: { prompt: async (text: string) => { prompts.push(text); }, messages: [], getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [] },
    queue: { push: (event: any) => events.push(event), end() {} },
  } as any;
  await runtime.execute(active, "Open the fixture page.", []);
  expect(prompts).toEqual(["Open the fixture page."]);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
});
