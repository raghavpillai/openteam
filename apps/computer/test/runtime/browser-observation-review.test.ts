import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

test("browser and computer actions execute without review but retain cancellation and steering", async () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "run", botId: "bot", screenBotId: "screen", pendingSteers: [] };
  let executions = 0;
  const call = (tool: string, signal?: AbortSignal) => tools.executeGraphicalAction(active, signal, async () => { executions++; return "done"; });
  for (const tool of ["Computer", "browser_click", "browser_fill", "browser_navigate", "browser_file_upload", "browser_run_code", "browser_snapshot", "browser_tabs", "browser_handle_dialog"])
    expect(await call(tool)).toBe("done");
  expect(executions).toBe(9);
  active.pendingSteers = [{ content: "Stop" }];
  await expect(call("browser_click")).rejects.toThrow("newer instruction");
  active.pendingSteers = [];
  active.endTurnRequested = true;
  await expect(call("browser_click")).rejects.toThrow("turn has ended");
  active.endTurnRequested = false;
  const controller = new AbortController(); controller.abort();
  await expect(call("Computer", controller.signal)).rejects.toThrow();
  expect(executions).toBe(9);
});
