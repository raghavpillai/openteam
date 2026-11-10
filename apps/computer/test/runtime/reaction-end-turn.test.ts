import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import { ComputerRuntime } from "../../src/runtime";

function fixture(response: Record<string, unknown> | ((name: string) => Record<string, unknown>)) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "fixture", botId: "fixture", screenBotId: "fixture", sentMessageCount: 0, queue: { push() {} } };
  const calls: any[] = [];
  tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { calls.push({ id, name, args }); return Response.json(typeof response === "function" ? response(name) : response); }) as any;
      return await tools.callControlPlaneToolRequest(turn, id, name, args);
    } finally { globalThis.fetch = originalFetch; }
  };
  const call = (id: string, args: any, name = "ReactToMessage") => tools.executeOpenTeamTool(active, id, name, args);
  return { active, calls, call };
}

test("a reaction with end_turn is the whole reply: it counts as delivery and ends the turn", async () => {
  const { active, calls, call } = fixture({ reacted: true, removed: false });
  const result = await call("react", { message_address: "t3u", emoji: "👍", end_turn: true });
  expect(result.terminate).toBe(true);
  expect(result.content[0].text).toBe("Reacted 👍 on t3u. (Reactions toggle: react the same emoji again to take it back.)");
  expect(active).toMatchObject({ endTurnRequested: true, sentMessageCount: 1 });
  expect(calls[0].args).toMatchObject({ end_turn: true });
  await expect(call("shell", { command: "true" }, "Shell")).rejects.toThrow("turn has ended");
});

test("a reaction without end_turn acknowledges the user while allowing background work to continue", async () => {
  const { active, call } = fixture((name) => name === "ReactToMessage" ? { reacted: true, removed: false } : { sent: true });
  const result = await call("react", { message_address: "t3u", emoji: "👍" });
  expect(result.terminate).toBeUndefined();
  expect(active.endTurnRequested).toBeUndefined();
  expect(active.sentMessageCount).toBe(1);
  await call("next", { type: "text", content: "The result is 391.", end_turn: true }, "SendToUser");
  expect(active.endTurnRequested).toBe(true);
  expect(active.sentMessageCount).toBe(2);
});

test("an invalid reaction cannot discharge the delivery obligation", async () => {
  const { active, call } = fixture({ reacted: false, removed: false });
  await call("react", { message_address: "t9u", emoji: "👍" });
  expect(active.sentMessageCount).toBe(0);
  expect(active.endTurnRequested).toBeUndefined();
});

test("a failed reaction never ends the turn", async () => {
  const { active, call } = fixture({ error: { message: "not visible" } });
  await call("react", { message_address: "t3u", emoji: "👍", end_turn: true }).catch(() => undefined);
  expect(active.endTurnRequested).toBeUndefined();
  expect(active.sentMessageCount).toBe(0);
});

test("settling after a successful background tapback does not inject a text-delivery nudge", async () => {
  const { active, call } = fixture({ reacted: true, removed: false });
  const runtime = new ComputerRuntime() as any;
  const prompts: string[] = [];
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  Object.assign(active, {
    requestSource: "turn", subagentType: null, turnId: "t", contextSessionId: "c", attachmentTempDirectories: [],
    session: { messages: [], prompt: async (text: string) => {
      prompts.push(text);
      await call("react", { message_address: "t3u", emoji: "👍" });
    } }, queue: { push() {}, end() {} },
  });
  await runtime.execute(active, "Keep the final answer short.", []);
  expect(prompts).toEqual(["Keep the final answer short."]);
  expect(active.endTurnRequested).toBeUndefined();
});
