import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { AUTOMATION_PARENT_ONLY_TOOLS } from "@openteam/contracts";

/** Routine runs keep these: none of them opens a card or waits for the user. */
const ROUTINE_MANAGEMENT_TOOLS = [
  "SendFeedback",
  "UninstallPlugin",
  "UninstallMcpServer",
  "RestartMcpServers",
  "SetMcpInstructions",
  "RenameMcpAccount",
  "RemoveMcpAccount",
];

test("automation discovers WakeParent and work tools, with all communication surfaces removed", () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  const turn = {
    requestSource: "automation",
    runtimeProfile: "agent",
    subagentType: null,
    pluginNamespaces: [],
  } as unknown as ActiveTurn;
  const names = [
    ...tools.customTools(turn).map((tool) => tool.name),
    ...tools.contextCatalog(turn).flatMap((namespace) => namespace.tools.map((tool) => tool.name)),
  ];
  expect(names).toContain("WakeParent");
  for (const name of AUTOMATION_PARENT_ONLY_TOOLS) expect(names).not.toContain(name);
  for (const name of [
    "Shell",
    "Read",
    "RecallMemory",
    "UpdateMemory",
    "UpdateRoutine",
    "UpdateSkill",
    "UpdateProfile",
    "UpdateAvatar",
    "DisconnectChannel",
    "Task",
    "CheckSubagent",
    "WebFetch",
    "WebSearch",
    "CopyToBox",
    "CopyFromBox",
    "GetPlugin",
    "SearchPlugins",
    ...ROUTINE_MANAGEMENT_TOOLS,
  ])
    expect(names).toContain(name);
  for (const profile of [
    { requestSource: "turn", runtimeProfile: "agent", subagentType: null },
    { requestSource: "agent", runtimeProfile: "subagent", subagentType: "executor" },
  ]) {
    const catalog = tools.contextCatalog({ ...turn, ...profile } as ActiveTurn);
    expect(catalog.flatMap((ns) => ns.tools.map((tool) => tool.name))).not.toContain("WakeParent");
  }
});

test("a rejected WakeParent leaves the automation able to continue", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ error: "storage unavailable" }, { status: 503 }),
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "automation",
      runtimeProfile: "agent",
      subagentType: null,
      pluginNamespaces: [],
      botId: "bot",
    } as unknown as ActiveTurn;
    const native = tools.customTools(turn);
    await native
      .find((tool) => tool.name === "GetDynamicTools")!
      .execute(
        "discover",
        { namespace: "cursor", toolName: "WakeParent" },
        undefined,
        undefined,
        {} as never
      );
    await expect(
      native
        .find((tool) => tool.name === "CallDynamicTool")!
        .execute(
          "wake",
          {
            namespace: "cursor",
            toolName: "WakeParent",
            arguments: { message: "Complete report" },
          },
          undefined,
          undefined,
          {} as never
        )
    ).rejects.toThrow("storage unavailable");
    expect(turn.endTurnRequested).not.toBe(true);
  } finally {
    server.stop(true);
  }
});

test("routine runs call plugin management and feedback directly, and keep working afterwards", async () => {
  const calls: Array<{ tool: string; arguments: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { tool: string; arguments: unknown };
      calls.push(body);
      if (body.tool === "RefreshToolCatalog") return Response.json({ namespaces: [] });
      if (body.tool === "SendFeedback")
        return Response.json({ feedbackStatus: "sent", wantsResponse: false, outcome: "Accepted." });
      return Response.json({ status: "completed", completed: true, actionResult: {}, connections: [] });
    },
  });
  try {
    const tools = new RuntimeTools({} as never, server.url.origin, "fixture", "/tmp", "/tmp");
    const turn = {
      requestSource: "automation",
      runtimeProfile: "agent",
      subagentType: null,
      pluginNamespaces: [],
      pendingSteers: [],
      botId: "bot",
      runId: "routine-run",
    } as unknown as ActiveTurn;
    const native = tools.customTools(turn);
    const get = native.find((tool) => tool.name === "GetDynamicTools")!;
    const invoke = native.find((tool) => tool.name === "CallDynamicTool")!;
    const args: Record<string, Record<string, unknown>> = {
      SendFeedback: { message: "The weekly digest skipped Monday.", wantsResponse: false },
      UninstallPlugin: { plugin_id: "linear" },
      UninstallMcpServer: { server_id: "plugin_custom" },
      RestartMcpServers: {},
      SetMcpInstructions: { server_id: "plugin_slack", instructions: "Reply in threads." },
      RenameMcpAccount: { server_id: "plugin_slack", account_label: "default", new_account_label: "work" },
      RemoveMcpAccount: { server_id: "plugin_slack", account_label: "old" },
    };
    for (const name of ROUTINE_MANAGEMENT_TOOLS) {
      await get.execute(`discover-${name}`, { namespace: "cursor", toolName: name }, undefined, undefined, {} as never);
      const result = await invoke.execute(
        name,
        { namespace: "cursor", toolName: name, arguments: args[name] },
        undefined,
        undefined,
        {} as never
      );
      expect(result.content[0]!.type).toBe("text");
    }
    expect(calls.filter((call) => call.tool !== "RefreshToolCatalog").map((call) => call.tool)).toEqual(ROUTINE_MANAGEMENT_TOOLS);
    // Each completed plugin change refreshes the routine's own tool catalog.
    expect(calls.filter((call) => call.tool === "RefreshToolCatalog")).toHaveLength(ROUTINE_MANAGEMENT_TOOLS.length - 1);
    expect(turn.endTurnRequested).not.toBe(true);
  } finally {
    server.stop(true);
  }
});
