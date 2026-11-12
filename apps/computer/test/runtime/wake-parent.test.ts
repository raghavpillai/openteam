import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { AUTOMATION_PARENT_ONLY_TOOLS, AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED } from "@openteam/contracts";

/** Routine runs keep these: none of them opens a card or waits for the user. */
const ROUTINE_MANAGEMENT_TOOLS = [
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

test("a routine run that calls a communication tool is told to use WakeParent instead", async () => {
  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp") as any;
  const turn = { requestSource: "automation", runtimeProfile: "agent", subagentType: null, pluginNamespaces: [] };
  for (const [tool, args] of [["SendToUser", { type: "text", content: "Done" }], ["ReactToMessage", { message_address: "t1", emoji: "👍" }]] as const)
    await expect(tools.executeOpenTeamTool(turn, "call", tool, args)).rejects.toThrow(AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED);
});
