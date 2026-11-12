import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

function fixture(respond: (name: string, args: any) => Response) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {
    runId: "fixture", botId: "fixture", screenBotId: "fixture", runtimeProfile: "agent", pluginNamespaces: [],
    sentMessageCount: 0, queue: { push() {} },
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
  const lookup = (toolName: string, args: any) => call("CallDynamicTool", { namespace: "cursor", toolName, arguments: args });
  return { tools, active, calls, call, lookup };
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
  await expect(lookup("Task", { description: "x", subagent_type: "executor" })).rejects.toThrow(/^Error: Invalid arguments:\nprompt: /);
  await expect(lookup("UpdateAgent", { name: "x" })).rejects.toThrow(
    /^Error: Invalid arguments:\nagent_id: Invalid input: expected string, received undefined$/
  );
});

test("a missing attachment is named before anything reaches the tool host", async () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "fixture", botId: "fixture", runtimeProfile: "agent", pluginNamespaces: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("the tool host must not be called"); }) as any;
  try {
    await expect(tools.executeOpenTeamTool(active, "call", "SendToUser", { type: "attachment", url: "file:///tmp/openteam-missing-deliverable.pdf" })).rejects.toThrow(
      /^Failed to send the message to the user: No file at \/tmp\/openteam-missing-deliverable\.pdf on your box, so nothing was sent\./
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("DraftExternalMessage argument problems are named per field and a lone recipient is a list", async () => {
  const { calls, lookup } = fixture(() => Response.json({ sent: true, message_id: "m1" }));
  const draft = { platform: "email", providerIdentifier: "gmail", subject: "Hi", body: "Hello" };
  await expect(lookup("DraftExternalMessage", { ...draft, to: ["ann@example.com"] })).rejects.toThrow(
    /^Error: Invalid arguments:\nfrom: from is required when platform is email$/
  );
  const result = await lookup("DraftExternalMessage", { ...draft, from: "me@example.com", to: "ann@example.com" });
  expect(calls.at(-1)).toMatchObject({ name: "DraftExternalMessage", args: { to: ["ann@example.com"] } });
  expect(result.content[0].text).toStartWith("Draft email from me@example.com to ann@example.com is now an editable card in the chat (id: m1).");
});

test("SendToUser through CallDynamicTool keeps call order with native sends and names a failed send", async () => {
  const { tools, active, call } = fixture(() => Response.json({ error: { code: "reply_target_not_found", message: "The reply target was not found" } }, { status: 404 }));
  await expect(call("CallDynamicTool", { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "hi", reply_to: "t9u" } })).rejects.toThrow(
    /^Error: Failed to send the message to the user: The reply target was not found$/
  );
  const delivered: string[] = [];
  tools.callControlPlaneTool = async (_turn: any, _id: string, _name: string, args: any) => {
    if (args.content === "first") await Bun.sleep(50);
    delivered.push(args.content);
    return { content: [{ type: "text", text: "Sent" }], details: {} };
  };
  active.sendChain = undefined;
  await Promise.all([
    call("SendToUser", { type: "text", content: "first" }),
    call("CallDynamicTool", { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "second" } }),
  ]);
  expect(delivered).toEqual(["first", "second"]);
});
