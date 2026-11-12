import { expect, test } from "bun:test";
import { routeEvent } from "../../src/runtime/events";
import type { ActiveTurn } from "../../src/runtime/types";
import { RuntimeTools } from "../../src/runtime/tools";

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
    contextSessionId: "context", instructions: "Open the fixture page.", attachmentTempDirectories: [], sentMessageCount: 0,
    session: { prompt: async (text: string) => { prompts.push(text); }, messages: [], getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [] },
    queue: { push: (event: any) => events.push(event), end() {} },
  } as any;
  await runtime.execute(active, "Open the fixture page.", []);
  expect(prompts).toEqual(["Open the fixture page."]);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
});

test("the computerUse breaker counts only real consecutive failures", async () => {
  const { observeGraphicalToolResult, COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES } = await import("../../src/runtime/graphical-completion");
  const active = { subagentType: "computerUse" } as ActiveTurn;
  for (let i = 0; i < COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES - 1; i++) observeGraphicalToolResult(active, true, "net::ERR_CONNECTION_REFUSED");
  observeGraphicalToolResult(active, true, "Operation aborted");
  expect(active.toolFailureBreakerTripped).toBeUndefined();
  observeGraphicalToolResult(active, false, "Clicked");
  expect(active.toolFailureStreak).toEqual([]);
  for (let i = 0; i < COMPUTER_USE_MAX_CONSECUTIVE_TOOL_FAILURES; i++) observeGraphicalToolResult(active, true, "net::ERR_CONNECTION_REFUSED");
  expect(active.toolFailureBreakerTripped).toBe(true);
  expect(active.endTurnRequested).toBe(true);
  const executor = { subagentType: "executor" } as ActiveTurn;
  for (let i = 0; i < 30; i++) observeGraphicalToolResult(executor, true, "failed");
  expect(executor.toolFailureBreakerTripped).toBeUndefined();
});

test("a computerUse report with leaked tool-call markup becomes a blocked report", async () => {
  const { blockedReportForRawToolCall } = await import("../../src/runtime/graphical-completion");
  expect(blockedReportForRawToolCall("Status: done\nI opened the page.\n<function=browser_click>{\"ref\":\"e1\"}</function>")).toBe(
    "Status: blocked\n\nI tried to call browser_click, which I do not have here, so that step was not done.\n\nI opened the page."
  );
  expect(blockedReportForRawToolCall("<tool_call>{}</tool_call>")).toBe(
    "Status: blocked\n\nI tried to call a tool, which I do not have here, so that step was not done."
  );
  expect(blockedReportForRawToolCall("Status: done\nAll set.")).toBeUndefined();
  const { graphicalFinalReport } = await import("../../src/runtime/graphical-completion");
  const active = { subagentType: "computerUse", runId: "r", lastAgentMessage: { id: "assistant:r:3", text: "Done.\n<tool_call>{}</tool_call>" } } as any;
  // The relayed report replaces the leaked text in place.
  expect(graphicalFinalReport(active, [])).toEqual({ id: "assistant:r:3", text: "Status: blocked\n\nI tried to call a tool, which I do not have here, so that step was not done.\n\nDone." });
  expect(graphicalFinalReport({ ...active, subagentType: "executor" }, [])).toBeNull();
});

test("graphical actions run directly but stop once the turn has ended or the call is cancelled", async () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "run", botId: "bot", screenBotId: "screen" };
  let executions = 0;
  const call = (tool: string, signal?: AbortSignal) => tools.executeGraphicalAction(active, signal, async () => { executions++; return "done"; });
  for (const tool of ["Computer", "browser_click", "browser_fill_form", "browser_navigate", "browser_file_upload", "browser_run_code", "browser_snapshot", "browser_tabs", "browser_handle_dialog"])
    expect(await call(tool)).toBe("done");
  expect(executions).toBe(9);
  active.endTurnRequested = true;
  await expect(call("browser_click")).rejects.toThrow("turn has ended");
  active.endTurnRequested = false;
  const controller = new AbortController(); controller.abort();
  await expect(call("Computer", controller.signal)).rejects.toThrow();
  expect(executions).toBe(9);
});
