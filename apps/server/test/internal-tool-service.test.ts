import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InternalToolService } from "../src/services/internal-tool-service";

type Fixture = {
  origin?: string;
  parentOrigin?: string;
  child?: Record<string, unknown> | null;
  plugins?: Record<string, unknown>;
  subagents?: Record<string, unknown>;
  connection?: Record<string, unknown>;
};

const fixture = (options: Fixture = {}) => {
  const deliveries: Array<Record<string, unknown>> = [];
  const prisma = {
    run: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "parent-run"
          ? { origin: options.parentOrigin ?? "user" }
          : { id: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null,
            status: "running", origin: options.origin ?? "user", inboxEvents: [] },
    },
    subagent: { findUnique: async () => options.child ?? null },
    automationResult: { findUnique: async () => null },
    pluginConnection: { findUnique: async () => options.connection ?? null },
  };
  const messaging = {
    sendVisible: async (_context: unknown, input: Record<string, unknown>) => {
      deliveries.push(input);
      return { acknowledgement: "sent", interruptRunId: null };
    },
  };
  const service = new InternalToolService(prisma as never, messaging as never, {} as never, async () => {}, {} as never,
    (options.subagents ?? {}) as never, {} as never, (options.plugins ?? {}) as never);
  const call = (tool: string, args: unknown = {}) =>
    Effect.runPromise(service.execute({ runId: "current", botId: "bot", conversationId: "conversation", channelId: "channel",
      deliveryId: null, callId: crypto.randomUUID(), tool, arguments: args }));
  return { call, deliveries };
};
const child = (subagentType = "executor") => ({ id: "child", parentBotId: "parent", parentRunId: "parent-run", subagentType });

test("SendToUser delivers and removed or unknown tools are rejected without delivering", async () => {
  const { call, deliveries } = fixture();
  await expect(call("SendToUser", { type: "text", content: "Hello" })).resolves.toBe("sent");
  for (const tool of ["SendMessage", "ListAgents"]) await expect(call(tool)).rejects.toThrow(`Unknown tool ${tool}`);
  expect(deliveries).toEqual([{ type: "text", content: "Hello" }]);
});

test("StopSubagent passes all: true or one id, and subagents cannot use parent control-plane tools", async () => {
  const calls: unknown[] = [];
  const subagents = { stop: async (_botId: string, _callId: string, input: unknown) => (calls.push(input), { stopped_all: true }) };
  const parent = fixture({ subagents });
  await parent.call("StopSubagent", { all: true });
  await parent.call("StopSubagent", { subagent_id: "sand-subagent-1" });
  await expect(parent.call("StopSubagent", {})).rejects.toThrow();
  expect(calls).toEqual([{ all: true }, { subagent_id: "sand-subagent-1" }]);

  const worker = fixture({ child: { id: "child-identity", parentBotId: "parent-id" }, subagents });
  for (const [tool, args] of [["request_box_help", { instruction: "Finish 2FA" }], ["StopSubagent", { all: true }]] as const)
    await expect(worker.call(tool, args)).rejects.toThrow("parent-agent only");
  expect(calls).toHaveLength(2);
});

for (const mode of ["automation", "automation-child", "ordinary-child"] as const) {
  test(`${mode} executes connectors using the owning Bot`, async () => {
    let invocation: Record<string, unknown> | undefined;
    const { call } = fixture({
      origin: mode === "automation" ? "routine" : "agent",
      parentOrigin: mode === "automation-child" ? "routine" : "user",
      child: mode === "automation" ? null : child(),
      plugins: { invoke: async (input: Record<string, unknown>) => ((invocation = input), { ok: true }) },
    });
    await call("PluginCall", { connectionId: "connection", toolName: "inspect", arguments: {} });
    expect(invocation?.botId).toBe(mode === "automation" ? "bot" : "parent");
  });
}

const policy = (origin: string, subagentType?: string) => {
  const reached: string[] = [];
  const origins: string[] = [];
  const plugins = {
    fileTransfers: { prepare: async (_context: unknown, args: { tool: string }) => (reached.push(args.tool), { prepared: args.tool }) },
    requestAction: async (input: { action: string; origin: string }) => (reached.push(input.action), origins.push(input.origin), { completed: true }),
  };
  return { ...fixture({ origin, child: subagentType ? child(subagentType) : null, plugins }), reached, origins };
};

test("workers on the parent's connectors transfer files both ways; graphical and media workers cannot", async () => {
  for (const subagentType of ["executor", "knowledgeWork"]) {
    const { call, reached } = policy("agent", subagentType);
    for (const tool of ["UploadFile", "DownloadFile"]) await call("PrepareConnectorTransfer", { tool, input: {} });
    expect(reached).toEqual(["UploadFile", "DownloadFile"]);
  }
  for (const subagentType of ["computerUse", "videoReview", "watchVideo"]) {
    const { call, reached } = policy("agent", subagentType);
    for (const tool of ["UploadFile", "DownloadFile"])
      await expect(call("PrepareConnectorTransfer", { tool, input: {} })).rejects.toThrow("performed by the parent bot");
    expect(reached).toEqual([]);
  }
});

test("routine runs manage installed plugins but cannot touch the visible transcript or install anything", async () => {
  const { call, reached } = policy("routine");
  const allowed: Array<[string, Record<string, unknown>]> = [
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
