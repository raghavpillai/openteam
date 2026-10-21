import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

function fixture(respond: (name: string, args: any) => Response) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {
    runId: "fixture", botId: "fixture", screenBotId: "fixture", runtimeProfile: "agent", pluginNamespaces: [],
    sentMessageCount: 0, toolActivityAfterLastSend: true, pendingSteers: [], discoveredDynamicTools: new Set(), queue: { push() {} },
  };
  const calls: any[] = [];
  tools.callControlPlaneTool = async (turn: any, id: string, name: string, args: any) => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => { calls.push({ name, args }); return respond(name, args); }) as any;
      return await tools.callControlPlaneToolRequest(turn, id, name, args);
    } finally { globalThis.fetch = originalFetch; }
  };
  const call = (name: string, args: any) => tools.executeOpenTeamTool(active, `call-${calls.length}`, name, args);
  const lookup = (toolName: string, args: any) => {
    active.discoveredDynamicTools.add(`cursor/${toolName}`);
    return call("CallDynamicTool", { namespace: "cursor", toolName, arguments: args });
  };
  return { calls, call, lookup };
}

test("SendToUser failures name the send and give the reason, not an error envelope", async () => {
  const { call } = fixture(() => Response.json({ error: { code: "reply_target_not_found", message: "The reply target was not found" } }, { status: 404 }));
  await expect(call("SendToUser", { type: "text", content: "hi", reply_to: "t9u" })).rejects.toThrow(
    /^Failed to send the message to the user: The reply target was not found$/
  );
  await expect(call("SendToUser", { type: "text" })).rejects.toThrow(
    /^Failed to send the message to the user: Invalid arguments:\ncontent: content is required when type is text$/
  );
  await expect(call("SendToUser", { type: "text", content: "hi", attachments: [{ url: "file:///workspace/a.pdf" }] })).rejects.toThrow(
    "Failed to send the message to the user: Invalid arguments:\nattachments: attachments is not a SendToUser field"
  );
});

test("first-party lookups coerce string-encoded values and report decode failures per field", async () => {
  const { calls, lookup } = fixture(() => Response.json({ stopped_all: true, stopped: [], already_finished: [], failed: [] }));
  await lookup("StopSubagent", { all: "true" });
  expect(calls[0]).toEqual({ name: "StopSubagent", args: { all: true } });
  await expect(lookup("Task", { description: "x", subagent_type: "executor" })).rejects.toThrow(/^Invalid arguments:\nprompt: /);
  await expect(lookup("UpdateAgent", { name: "x" })).rejects.toThrow(
    /^Invalid arguments:\nagent_id: Invalid input: expected string, received undefined$/
  );
});
