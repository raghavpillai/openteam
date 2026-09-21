import { expect, test } from "bun:test";
import { verifyGraphicalTaskCompletion } from "../../src/runtime/graphical-completion";
import { routeEvent } from "../../src/runtime/events";
import type { ActiveTurn } from "../../src/runtime/types";

test("a stopped graphical worker gets one verification opportunity in the same session", async () => {
  const calls: string[] = [];
  const active = {
    subagentType: "computerUse",
    lastStopReason: "stop",
    session: {
      prompt: async (text: string) => {
        calls.push(text);
      },
    },
  } as unknown as ActiveTurn;
  await verifyGraphicalTaskCompletion(active);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("original task");
  expect(calls[0]).toContain("Never retry a denied action");
});

for (const state of [
  { subagentType: "generalPurpose" },
  { lastStopReason: "aborted" },
  { lastStopReason: "error" },
  { endTurnRequested: true },
  { pluginAbortController: AbortSignal.abort() },
]) {
  test(`verification never restarts a non-graphical/terminated worker: ${JSON.stringify(state)}`, async () => {
    let calls = 0;
    const active = {
      subagentType: "browserUse",
      lastStopReason: "stop",
      session: {
        prompt: async () => {
          calls++;
        },
      },
      ...state,
    } as any;
    if (state.pluginAbortController)
      active.pluginAbortController = { signal: state.pluginAbortController };
    await verifyGraphicalTaskCompletion(active);
    expect(calls).toBe(0);
  });
}

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
