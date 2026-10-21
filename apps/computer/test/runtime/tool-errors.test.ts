import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";

function fixture(respond: (name: string, args: any) => Response) {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = {
    runId: "fixture", botId: "fixture", screenBotId: "fixture", runtimeProfile: "agent", pluginNamespaces: [],
    sentMessageCount: 0, toolActivityAfterLastSend: true, discoveredDynamicTools: new Set(), queue: { push() {} },
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

test("first-party lookups match argument keys and enum values loosely before decoding", async () => {
  const { calls, lookup } = fixture(() => Response.json({}));
  // Each loose call and the arguments the reference's normalizeMcpArgumentsToInputSchema makes of it with its
  // CallDynamicTool options (renames and scalar wraps on), run on these tools' schemas through the loader.
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["CheckSubagent", { subagentId: "a1" }, { subagent_id: "a1" }],
    ["StopSubagent", { SubagentID: "a1" }, { subagent_id: "a1" }],
    ["MessageSubagent", { subagentId: "a1", msg: "hi" }, { subagent_id: "a1", message: "hi" }],
    ["GetPlugin", { pluginId: "gmail" }, { plugin_id: "gmail" }],
    ["GetPlugin", { arguments: { plugin_id: "gmail" } }, { plugin_id: "gmail" }],
    ["UninstallPlugin", { pluginId: "x" }, { plugin_id: "x" }],
    ["SearchPlugins", { Query: "mail" }, { query: "mail" }],
    ["ReadTranscript", { In: "this", LIMIT: 5 }, { in: "this", limit: 5 }],
    ["UpdateSkill", { action: "Write", name: "x", description: "use this when", body: "b" }, { action: "write", name: "x", description: "use this when", body: "b" }],
  ];
  // The fixture's empty reply may not render; only what reached the tool host matters here.
  const sent = async (tool: string, args: Record<string, unknown>) => {
    const before = calls.length;
    await lookup(tool, args).catch(() => {});
    return calls.slice(before);
  };
  for (const [tool, loose, repaired] of cases) {
    const expected = await sent(tool, repaired);
    expect(expected).toHaveLength(1);
    expect(await sent(tool, loose)).toEqual(expected);
  }
  // Loose matching runs before string coercion, as the reference's tool parser coerces afterwards.
  expect(await sent("StopSubagent", { All: "true" })).toEqual([{ name: "StopSubagent", args: { all: true } }]);
});

test("CopyToBox takes the reference's computer_path aliases", async () => {
  const { tools, active, lookup } = fixture(() => Response.json({}));
  active.cwd = "/workspace";
  const copies: unknown[] = [];
  tools.nativeToolExecutor.copyFile = async (_direction: string, args: unknown) => { copies.push(args); return { content: [], details: {} }; };
  await lookup("CopyToBox", { local_path: "/Users/a/x.csv", machineId: "m1" });
  expect(copies).toEqual([{ machineId: "m1", computer_path: "/Users/a/x.csv" }]);
  await expect(lookup("CopyToBox", { path: "/Users/a/x.csv", source: "/Users/a/y.csv", machineId: "m1" })).rejects.toThrow(
    "Invalid arguments:\ncomputer_path: Pass the file's absolute path on the user's computer once, as computer_path."
  );
});

test("a missing attachment is named before anything reaches the tool host", async () => {
  const tools = new RuntimeTools({} as any, "http://unused.invalid", "fixture", "/tmp", "/tmp") as any;
  const active: any = { runId: "fixture", botId: "fixture", runtimeProfile: "agent", pluginNamespaces: [], discoveredDynamicTools: new Set() };
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
