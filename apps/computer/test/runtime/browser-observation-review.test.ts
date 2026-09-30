import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

const fixture = () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "test-control", "/tmp", "/tmp") as any;
  const active = { runId: "test", screenBotId: "screen", botId: "bot", runtimeProfile: "agent", pendingSteers: [] };
  let reviews = 0, executions = 0;
  tools.nativeToolExecutor.withReviewContext = (_context: unknown, fn: () => unknown) => fn();
  tools.nativeToolExecutor.autoReviewAction = async () => { reviews++; throw new Error("review denied"); };
  tools.executeHostTool = async (_active: unknown, _id: string, _tool: string, _signal: unknown, fn: (a: unknown[]) => unknown) => fn([]);
  const capture = async () => { executions++; return "observed"; };
  const call = (name: string, args: Record<string, unknown> = {}) => tools.reviewGraphicalAction(active, "call", name, args, undefined, capture);
  return { tools, active, call, get reviews() { return reviews; }, get executions() { return executions; } };
};

test("canonical browser screenshot uses the read-only path; mutations still require review", async () => {
  const f = fixture();
  expect(await f.call("browser_snapshot")).toBe("observed");
  expect(await f.call("browser_take_screenshot")).toBe("observed");
  expect(f.reviews).toBe(0);
  expect(f.executions).toBe(2);
  await expect(f.call("browser_click")).rejects.toThrow("review denied");
  expect(f.reviews).toBe(1);
  expect(f.executions).toBe(2);
});

test("read-only screenshot still respects pending approval, steering and ended turns", async () => {
  const f = fixture();
  f.tools.pendingApprovals.set("approval", { runId: "test", screenBotId: "screen" });
  await expect(f.call("browser_take_screenshot")).rejects.toThrow("waiting for approval");
  f.tools.pendingApprovals.clear();
  (f.active as any).pendingSteers = [{ content: "Stop" }];
  await expect(f.call("browser_take_screenshot")).rejects.toThrow("newer instruction");
  (f.active as any).pendingSteers = [];
  (f.active as any).endTurnRequested = true;
  await expect(f.call("browser_take_screenshot")).rejects.toThrow("turn has ended");
  expect(f.executions).toBe(0);
  expect(f.reviews).toBe(0);
});

test("page text search uses the same observation path as its underlying snapshot", async () => {
  const f = fixture();
  expect(await f.call("browser_find")).toBe("observed");
  expect(f.reviews).toBe(0);
  expect(f.executions).toBe(1);
  for (const action of ["browser_fill", "browser_navigate", "browser_file_upload", "browser_cdp", "browser_handle_dialog", "browser_navigate_back"])
    await expect(f.call(action)).rejects.toThrow("review denied");
  expect(f.reviews).toBe(6);
  expect(f.executions).toBe(1);
});

test("page text search cannot proceed past pending approval or newer instructions", async () => {
  const f = fixture();
  f.tools.pendingApprovals.set("approval", { runId: "test", screenBotId: "screen" });
  await expect(f.call("browser_find")).rejects.toThrow("waiting for approval");
  f.tools.pendingApprovals.clear();
  (f.active as any).pendingSteers = [{ content: "Stop" }];
  await expect(f.call("browser_find")).rejects.toThrow("newer instruction");
  (f.active as any).pendingSteers = [];
  (f.active as any).endTurnRequested = true;
  await expect(f.call("browser_find")).rejects.toThrow("turn has ended");
  expect(f.executions).toBe(0);
});


test("tab listing, bounded waits and geometry use observation routing while tab mutations remain reviewed", async () => {
  const f = fixture();
  expect(await f.call("browser_tabs", { action: "list" })).toBe("observed");
  expect(await f.call("browser_wait_for", { text: "Ready" })).toBe("observed");
  expect(await f.call("browser_get_bounding_box", { ref: "e1" })).toBe("observed");
  expect(f.reviews).toBe(0);
  for (const action of ["new", "select", "close", undefined])
    await expect(f.call("browser_tabs", { action })).rejects.toThrow("review denied");
  await expect(f.call("browser_highlight")).rejects.toThrow("review denied");
  expect(f.executions).toBe(3);
});

test("additional observations retain steering and pending-approval gates", async () => {
  for (const [name, args] of [["browser_tabs", {action: "list"}], ["browser_wait_for", {time: 1}], ["browser_get_bounding_box", {ref: "e1"}]] as const) {
    const f = fixture();
    f.tools.pendingApprovals.set("approval", {runId: "test", screenBotId: "screen"});
    await expect(f.call(name, args)).rejects.toThrow("waiting for approval");
    f.tools.pendingApprovals.clear();
    (f.active as any).pendingSteers = [{content: "Stop"}];
    await expect(f.call(name, args)).rejects.toThrow("newer instruction");
    expect(f.executions).toBe(0);
  }
});


test("browser scripts go through action review, including scripts that claim to be read-only", async () => {
  const f = fixture();
  await expect(f.call("browser_run_code", {code:"async(page)=>await page.title()"})).rejects.toThrow("review denied");
  expect(f.reviews).toBe(1);
  expect(f.executions).toBe(0);
});
