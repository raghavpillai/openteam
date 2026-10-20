import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

function fixture(response: Record<string, unknown>) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "fixture", botId: "fixture", screenBotId: "fixture", sentMessageCount: 0, toolActivityAfterLastSend: true, pendingSteers: [], queue: { push() {} } };
  const calls: any[] = [];
  tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { calls.push({ id, name, args }); return Response.json(response); }) as any;
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
  expect(active).toMatchObject({ endTurnRequested: true, sentMessageCount: 1, toolActivityAfterLastSend: false });
  expect(calls[0].args).toMatchObject({ end_turn: true });
  await expect(call("shell", { command: "true" }, "Shell")).rejects.toThrow("turn has ended");
});

test("a reaction without end_turn keeps the turn open and owes a reply", async () => {
  const { active, call } = fixture({ reacted: true, removed: false });
  const result = await call("react", { message_address: "t3u", emoji: "👍" });
  expect(result.terminate).toBeUndefined();
  expect(active.endTurnRequested).toBeUndefined();
  expect(active.sentMessageCount).toBe(0);
});

test("a failed reaction never ends the turn", async () => {
  const { active, call } = fixture({ error: { message: "not visible" } });
  await call("react", { message_address: "t3u", emoji: "👍", end_turn: true }).catch(() => undefined);
  expect(active.endTurnRequested).toBeUndefined();
  expect(active.sentMessageCount).toBe(0);
});
