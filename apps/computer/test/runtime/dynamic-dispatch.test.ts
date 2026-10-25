import { expect, test } from "bun:test";
import { ComputerRuntime } from "../../src/runtime";

const runtimeTools = () => (new ComputerRuntime() as any).tools;
const turn = (overrides: Record<string, unknown> = {}): any => ({
  runId: "run", botId: "bot", contextSessionId: crypto.randomUUID(), cwd: "/tmp", runtimeProfile: "agent", subagentType: null,
  requestSource: "turn", sentMessageCount: 0, queue: { push() {} }, pluginNamespaces: [], ...overrides,
});
const connector = (namespaceStatus = "ready") => ({
  name: "gmail", description: "Gmail (default)", namespaceStatus,
  tools: [{ connectionId: "c", name: "search_threads", description: "Search", inputSchema: { type: "object" }, source: "gmail/gmail" }],
});

async function withControlPlane(respond: (tool: string, args: any) => unknown, run: () => Promise<any>): Promise<any> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return Response.json(await respond(body.tool, body.arguments));
  }) as any;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("a connector tool runs without a prior GetDynamicTools lookup", async () => {
  const tools = runtimeTools();
  const calls: any[] = [];
  const result = await withControlPlane((tool, args) => { calls.push([tool, args]); return { content: [{ type: "text", text: "found 3" }] }; },
    () => tools.executeOpenTeamTool(turn({ pluginNamespaces: [connector()] }), "call", "CallDynamicTool", { namespace: "gmail", toolName: "search_threads", arguments: { query: "x" } }));
  expect(result.content).toEqual([{ type: "text", text: "found 3" }]);
  expect(calls).toEqual([["PluginCall", { connectionId: "c", namespace: "gmail", toolName: "search_threads", arguments: { query: "x" } }]]);
});

test("CallDynamicTool on a tool the agent already has directly runs it natively", async () => {
  const tools = runtimeTools();
  const searches: string[] = [];
  tools.webTools.search = async (query: string) => { searches.push(query); return { content: [{ type: "text", text: "results" }], details: {} }; };
  const executor = turn({ runtimeProfile: "subagent", subagentType: "executor" });
  const result = await tools.executeOpenTeamTool(executor, "call", "CallDynamicTool", { namespace: "cursor", toolName: "WebSearch", arguments: { search_term: "openteam" } });
  expect(result.content[0].text).toBe("results");
  expect(searches).toEqual(["openteam"]);
  await expect(tools.executeOpenTeamTool(executor, "lookup", "GetDynamicTools", { namespace: "cursor", toolName: "WebSearch" })).rejects.toThrow(
    'Error: Tool "WebSearch" is already available directly and is not part of dynamic namespace "cursor". Invoke "WebSearch" directly instead of using dynamic tool discovery or invocation.'
  );
});

test("dynamic tool failures read Error: <message>, and a miss refreshes the catalog once", async () => {
  const tools = runtimeTools();
  const active = turn();
  await expect(tools.executeOpenTeamTool(active, "a", "CallDynamicTool", { namespace: "cursor", toolName: "Nope" })).rejects.toThrow(/^Error: Built-in tool "Nope" not found in namespace "cursor"\. Available tools: /);
  const refreshed: string[] = [];
  const result = await withControlPlane((tool) => {
    refreshed.push(tool);
    return tool === "RefreshToolCatalog" ? { namespaces: [connector()] } : { content: [{ type: "text", text: "ok" }] };
  }, () => tools.executeOpenTeamTool(active, "b", "CallDynamicTool", { namespace: "gmail", toolName: "search_threads" }));
  expect(result.content[0].text).toBe("ok");
  expect(refreshed).toEqual(["RefreshToolCatalog", "PluginCall"]);
  await expect(withControlPlane(() => ({ namespaces: [] }), () =>
    tools.executeOpenTeamTool(turn(), "c", "GetDynamicTools", { namespace: "slack" }))).rejects.toThrow(/^Error: namespace "slack" not found\. Available namespaces: cursor$/);
});

test("a signed-out connector tells the main agent to authenticate and anyone else to report it", async () => {
  const tools = runtimeTools();
  const call = { namespace: "gmail", toolName: "search_threads", arguments: {} };
  const reason = "Error: This MCP server requires authentication before its tools can be used.";
  await expect(tools.executeOpenTeamTool(turn({ pluginNamespaces: [connector("needsAuth")] }), "a", "CallDynamicTool", call)).rejects.toThrow(
    `${reason} Call AuthenticateMcpServer with server_id "gmail" to show the user its sign-in, then finish unrelated work and end your turn. Don't reach the service another way meanwhile.`
  );
  await expect(tools.executeOpenTeamTool(turn({ runtimeProfile: "subagent", subagentType: "executor", pluginNamespaces: [connector("needsAuth")] }), "b", "CallDynamicTool", call)).rejects.toThrow(
    `${reason} You cannot do that from here, so report the status in your result instead of retrying.`
  );
  await expect(tools.executeOpenTeamTool(turn({ requestSource: "automation", pluginNamespaces: [connector("needsAuth")] }), "c", "CallDynamicTool", call)).rejects.toThrow(
    `${reason} You cannot do that from here, so report the status with WakeParent instead of retrying.`
  );
});

test("only an agent that can start a sign-in is told to call AuthenticateMcpServer", () => {
  const tools = runtimeTools();
  const description = (active: any) => tools.customTools(active).find((tool: any) => tool.name === "GetDynamicTools").description as string;
  expect(description(turn())).toEndWith("Call AuthenticateMcpServer on it instead of refetching this descriptor; it is already installed, so never propose installing it.");
  expect(description(turn({ runtimeProfile: "subagent", subagentType: "executor" }))).toEndWith(
    'MCP authentication: a namespace whose namespaceStatus is "needsAuth" stays unusable until the user connects it. You cannot do that from here, so report the status in your result instead of retrying.'
  );
  expect(description(turn({ requestSource: "automation" }))).toEndWith("You cannot do that from here, so report the status with WakeParent instead of retrying.");
});

test("a first-party dynamic tool called by its bare name is run through CallDynamicTool", async () => {
  const { directDynamicToolsExtension } = await import("../../src/runtime/direct-dynamic-tools");
  const handlers = new Map<string, Function>();
  directDynamicToolsExtension({ registered: () => ["Shell", "CallDynamicTool"], cursor: () => ["TodoWrite", "Task"] })
    .factory({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
  const end = handlers.get("message_end")!;
  const assistant = { role: "assistant", content: [
    { type: "text", text: "On it." },
    { type: "toolCall", id: "1", name: "TodoWrite", arguments: { todos: [] } },
    { type: "toolCall", id: "2", name: "Shell", arguments: { command: "ls" } },
    { type: "toolCall", id: "3", name: "Nope", arguments: {} },
  ] };
  expect((await end({ message: assistant })).message.content).toEqual([
    { type: "text", text: "On it." },
    { type: "toolCall", id: "1", name: "CallDynamicTool", arguments: { namespace: "cursor", toolName: "TodoWrite", arguments: { todos: [] } } },
    { type: "toolCall", id: "2", name: "Shell", arguments: { command: "ls" } },
    { type: "toolCall", id: "3", name: "Nope", arguments: {} },
  ]);
  expect(await end({ message: { role: "assistant", content: [{ type: "toolCall", id: "4", name: "Shell", arguments: {} }] } })).toBeUndefined();
  // A name that exists nowhere gets the reference text and the names that do exist.
  const missing = { role: "toolResult", toolName: "Nope", toolCallId: "3", isError: true, content: [{ type: "text", text: "Tool Nope not found" }] };
  expect((await end({ message: missing })).message.content).toEqual([{ type: "text", text: "Tool not found: Nope. Available tools: Shell, CallDynamicTool, TodoWrite, Task" }]);
  expect(await end({ message: { ...missing, isError: false } })).toBeUndefined();
});

test("connector call failures are classified like the reference's", async () => {
  const tools = runtimeTools();
  const original = globalThis.fetch;
  const respond = (status: number, error: Record<string, string>) => { globalThis.fetch = (async () => Response.json({ error }, { status })) as any; };
  const call = (active: any, id: string) => tools.executeOpenTeamTool(active, id, "CallDynamicTool", { namespace: "gmail", toolName: "search_threads", arguments: {} });
  try {
    respond(401, { code: "plugin_auth_required", message: "Authorization expired or was revoked. Sign in to this account again." });
    await expect(call(turn({ pluginNamespaces: [connector()] }), "a")).rejects.toThrow(
      'Error: Authorization expired or was revoked. Sign in to this account again. Call AuthenticateMcpServer with server_id "gmail" to show the user its sign-in, then finish unrelated work and end your turn.'
    );
    respond(500, { code: "internal_error", message: "socket hang up" });
    await expect(call(turn({ pluginNamespaces: [connector()] }), "b")).rejects.toThrow(new Error("Error: Tool execution error. socket hang up"));
    respond(500, { code: "internal_error", message: "MCP error -32602: Invalid arguments for tool search_threads" });
    await expect(call(turn({ pluginNamespaces: [connector()] }), "c")).rejects.toThrow(
      `Error: MCP error -32602: Invalid arguments for tool search_threads\n\n<system_reminder>\nThe namespace rejected these arguments as invalid. Before retrying, call GetDynamicTools with {"namespace":"gmail","toolName":"search_threads"} and rebuild the arguments from the returned input schema.\n</system_reminder>`
    );
    respond(409, { code: "plugin_identifier_stale", message: "This account was renamed. Re-run GetMcpServerStatus or GetDynamicTools before calling its tools again." });
    await expect(call(turn({ pluginNamespaces: [connector()] }), "d")).rejects.toThrow(new Error("Error: This account was renamed. Re-run GetMcpServerStatus or GetDynamicTools before calling its tools again."));
  } finally { globalThis.fetch = original; }
});

test("ListMachines is looked up in the cursor namespace and lists the registered computers", async () => {
  const tools = runtimeTools();
  tools.nativeToolExecutor.listMachines = async () => ({ content: [{ type: "text", text: '{"machines":[]}' }], details: {} });
  const result = await tools.executeOpenTeamTool(turn(), "m", "CallDynamicTool", { namespace: "cursor", toolName: "ListMachines", arguments: {} });
  expect(result.content[0].text).toBe('{"machines":[]}');
  expect(tools.customTools(turn()).map((tool: any) => tool.name)).not.toContain("ListMachines");
  const automation = turn({ requestSource: "automation" });
  expect(tools.customTools(automation).map((tool: any) => tool.name)).toEqual(["WakeParent", "ListSections", "RecallMemory", "UpdateMemory", "UpdateRoutine", "Shell", "Read", "Screenshot", "GetDynamicTools", "CallDynamicTool"]);
  expect(tools.cursorToolNames(automation)).toContain("ListMachines");
});
