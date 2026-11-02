import { afterEach, expect, spyOn, test } from "bun:test";
import { BrowserUseSession } from "../../src/browser/use";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const turn = (subagentType: string | null) =>
  ({ botId: "worker", screenBotId: "bot", cwd: "/tmp", subagentType, taskConfiguration: {} }) as unknown as ActiveTurn;

test("a computerUse worker connects its browser while its session is built, once", async () => {
  let endpoints = 0;
  const screens = { browserEndpointForAgent: async () => { endpoints += 1; return "http://127.0.0.1:1"; } };
  const session = { connected: true } as unknown as BrowserUseSession;
  const connect = spyOn(BrowserUseSession, "connect").mockImplementation(async () => session);
  spies.push(connect);
  const tools = new RuntimeTools(screens as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  const internals = tools as unknown as { browserSession(active: ActiveTurn): Promise<BrowserUseSession> };

  tools.prewarmBrowser(turn("executor"));
  expect(endpoints).toBe(0);
  const worker = turn("computerUse");
  tools.prewarmBrowser(worker);
  tools.prewarmBrowser(worker);
  // The first tool call joins the connect the prewarm started.
  expect(await internals.browserSession(worker)).toBe(session);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(endpoints).toBe(1);
  // Once connected, building the tools again does not touch the browser.
  tools.prewarmBrowser(worker);
  expect(endpoints).toBe(1);
});

test("a failed prewarm is silent; the first action reports the failure itself", async () => {
  const screens = { browserEndpointForAgent: async () => { throw new Error("human takeover"); } };
  const tools = new RuntimeTools(screens as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  const internals = tools as unknown as { browserSession(active: ActiveTurn): Promise<BrowserUseSession> };
  const worker = turn("computerUse");
  tools.prewarmBrowser(worker);
  await expect(internals.browserSession(worker)).rejects.toThrow("human takeover");
});
