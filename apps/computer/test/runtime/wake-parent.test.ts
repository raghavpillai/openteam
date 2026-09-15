import { expect, test } from "bun:test";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { AUTOMATION_PARENT_ONLY_TOOLS } from "@openteam/contracts";

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
    "update_state",
    "Task",
    "CheckSubagent",
    "WebFetch",
    "WebSearch",
    "CopyToBox",
    "CopyFromBox",
    "GetPlugin",
    "SearchPlugins",
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
      discoveredDynamicTools: new Set(),
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
