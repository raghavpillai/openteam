import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InternalToolService } from "../src/services/internal-tool-service";

for (const mode of ["automation", "automation-child", "ordinary-child"] as const) {
  test(`${mode} executes connectors using the owning Bot`, async () => {
    let invocation: Record<string, unknown> | undefined;
    const prisma = {
      run: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "parent-run"
        ? { origin: mode === "automation-child" ? "routine" : "user" }
        : { id: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, status: "running", origin: mode === "automation" ? "routine" : "agent", inboxEvents: [] } },
      subagent: { findUnique: async () => mode === "automation" ? null : { id: "child", parentBotId: "parent", parentRunId: "parent-run", subagentType: "executor" } },
      automationResult: { findUnique: async () => null },
    };
    const plugins = { invoke: async (input: Record<string, unknown>) => { invocation = input; return { ok: true }; } };
    const service = new InternalToolService(prisma as never, {} as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins as never);
    await Effect.runPromise(service.execute({ runId: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, callId: "call", tool: "PluginCall", arguments: { connectionId: "connection", toolName: "inspect", arguments: {} } }));
    expect(invocation?.botId).toBe(mode === "automation" ? "bot" : "parent");
  });
}

const policyService = (options: { origin: string; subagentType?: string }) => {
  const reached: string[] = [];
  const prisma = {
    run: { findUnique: async () => ({ id: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, status: "running", origin: options.origin, inboxEvents: [] }) },
    subagent: { findUnique: async () => options.subagentType ? { id: "child", parentBotId: "parent", parentRunId: "parent-run", subagentType: options.subagentType } : null },
    automationResult: { findUnique: async () => null },
  };
  const plugins = {
    fileTransfers: { prepare: async (_context: unknown, args: { tool: string }) => (reached.push(args.tool), { prepared: args.tool }) },
    requestAction: async (input: { action: string }) => (reached.push(input.action), { completed: true }),
  };
  const richMessages = { feedback: { send: async () => (reached.push("SendFeedback"), { feedbackStatus: "sent" }) } };
  const service = new InternalToolService(prisma as never, {} as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins as never, richMessages as never);
  const call = (tool: string, args: unknown) =>
    Effect.runPromise(service.execute({ runId: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, callId: crypto.randomUUID(), tool, arguments: args }));
  return { call, reached };
};

test("workers on the parent's connectors transfer files both ways; graphical and media workers cannot", async () => {
  for (const subagentType of ["executor", "knowledgeWork"]) {
    const { call, reached } = policyService({ origin: "agent", subagentType });
    for (const tool of ["UploadFile", "DownloadFile"]) await call("PrepareConnectorTransfer", { tool, input: {} });
    expect(reached).toEqual(["UploadFile", "DownloadFile"]);
  }
  for (const subagentType of ["computerUse", "videoReview", "watchVideo"]) {
    const { call, reached } = policyService({ origin: "agent", subagentType });
    for (const tool of ["UploadFile", "DownloadFile"])
      await expect(call("PrepareConnectorTransfer", { tool, input: {} })).rejects.toThrow("performed by the parent bot");
    expect(reached).toEqual([]);
  }
});

test("routine runs manage installed plugins and send feedback without waking the parent", async () => {
  const { call, reached } = policyService({ origin: "routine" });
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["SendFeedback", { message: "The weekly digest skipped Monday.", wantsResponse: false }],
    ["UninstallPlugin", { plugin_id: "linear" }],
    ["UninstallMcpServer", { server_id: "plugin_custom" }],
    ["RestartMcpServers", {}],
    ["SetMcpInstructions", { server_id: "plugin_slack", instructions: "Reply in threads." }],
    ["RenameMcpAccount", { server_id: "plugin_slack", account_label: "default", new_account_label: "work" }],
    ["RemoveMcpAccount", { server_id: "plugin_slack", account_label: "old" }],
  ];
  for (const [tool, args] of allowed) await call(tool, args);
  expect(reached).toEqual(allowed.map(([tool]) => tool));
  for (const tool of ["SendToUser", "RequestUserForm", "RemapUserFormTargets", "CreateBotShareJson", "InstallPlugin", "AddMcpServer", "AuthenticateMcpServer"])
    await expect(call(tool, {})).rejects.toThrow("Automation runs cannot mutate the visible transcript.");
  expect(reached).toHaveLength(allowed.length);
});
