import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { AUTOMATION_PARENT_ONLY_TOOLS, AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED } from "@openteam/contracts";

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

test("automation calls WakeParent directly and keeps work tools, with all communication surfaces removed", () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  const turn = {
    requestSource: "automation",
    runtimeProfile: "agent",
    subagentType: null,
    pluginNamespaces: [],
    feedback: "available",
  } as unknown as ActiveTurn;
  const names = [
    ...tools.customTools(turn).map((tool) => tool.name),
    ...tools.contextCatalog(turn).flatMap((namespace) => namespace.tools.map((tool) => tool.name)),
  ];
  expect(tools.customTools(turn).map((tool) => tool.name)).toContain("WakeParent");
  expect(tools.contextCatalog(turn).flatMap((namespace) => namespace.tools.map((tool) => tool.name))).not.toContain("WakeParent");
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
    { requestSource: "automation", runtimeProfile: "subagent", subagentType: "executor" },
  ]) {
    const other = { ...turn, ...profile } as ActiveTurn;
    expect(tools.contextCatalog(other).flatMap((ns) => ns.tools.map((tool) => tool.name))).not.toContain("WakeParent");
    expect(tools.customTools(other).map((tool) => tool.name)).not.toContain("WakeParent");
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
    const wake = tools.customTools(turn).find((tool) => tool.name === "WakeParent")!;
    await expect(
      wake.execute("wake", { message: "Complete report" }, undefined, undefined, {} as never)
    ).rejects.toThrow("storage unavailable");
    expect(turn.endTurnRequested).not.toBe(true);
  } finally {
    server.stop(true);
  }
});

test("routine runs call plugin management directly and feedback after its approval card, and keep working afterwards", async () => {
  const calls: Array<{ tool: string; arguments: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { tool: string; arguments: unknown };
      calls.push(body);
      if (body.tool === "RefreshToolCatalog") return Response.json({ namespaces: [] });
      // Feedback goes out only after the user approves its card.
      if (body.tool === "RequestApproval") return Response.json({ status: "pending", approvalId: "card" });
      if (body.tool === "AwaitApproval") return Response.json({ status: "approved", approvalId: "card" });
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
      botId: "bot",
      runId: "routine-run",
      feedback: "available",
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
    expect(calls.filter((call) => call.tool !== "RefreshToolCatalog").map((call) => call.tool)).toEqual(["RequestApproval", "AwaitApproval", ...ROUTINE_MANAGEMENT_TOOLS]);
    // Each completed plugin change refreshes the routine's own tool catalog.
    expect(calls.filter((call) => call.tool === "RefreshToolCatalog")).toHaveLength(ROUTINE_MANAGEMENT_TOOLS.length - 1);
    expect(turn.endTurnRequested).not.toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a routine run that calls a communication tool is told to use WakeParent instead", async () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp") as any;
  const turn = { requestSource: "automation", runtimeProfile: "agent", subagentType: null, pluginNamespaces: [] };
  for (const [tool, args] of [["SendToUser", { type: "text", content: "Done" }], ["ReactToMessage", { message_address: "t1", emoji: "👍" }]] as const)
    await expect(tools.executeOpenTeamTool(turn, "call", tool, args)).rejects.toThrow(AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED);
});
