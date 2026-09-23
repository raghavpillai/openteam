import { expect, test } from "bun:test";
import { RuntimeTools } from "../src/runtime/tools";

test("pending approvals allow reporting and stopping, but still block new work and external sends", async () => {
  const runtime = Object.create(RuntimeTools.prototype) as any;
  runtime.pendingApprovals = new Map([["hold", { screenBotId: "screen", runId: "other" }]]);
  const invoked: string[] = [];
  runtime.callControlPlaneTool = async (_active: unknown, _id: string, tool: string) => {
    invoked.push(tool);
    return { content: [], details: {} };
  };
  const active = {
    screenBotId: "screen",
    runtimeProfile: "agent",
    requestSource: "user",
    pluginRuntimePackages: [],
  };
  for (const [tool, args] of [
    ["SendToUser", { type: "text", content: "Blocked; awaiting your decision." }],
    ["WakeParent", { message: "Blocked; could not complete the task." }],
    ["StopSubagent", { subagent_id: "qa-worker" }],
    ["update_state", { target: "routine", action: "pause", id: "qa-routine" }],
  ] as const)
    await runtime.executeScopedTool(active, "fixture", tool, args);
  expect(invoked).toEqual(["SendToUser", "WakeParent", "StopSubagent", "update_state"]);
  for (const [tool, args] of [
    ["SendToUser", { type: "text", content: "External send", channel: "email" }],
    [
      "SendToUser",
      { type: "text", content: "Attachment", images: [{ url: "file:///tmp/private.png" }] },
    ],
    ["update_state", { target: "routine", action: "resume", id: "qa-routine" }],
    ["Shell", { command: "echo forbidden" }],
    ["Task", { prompt: "Start new work", description: "New task", subagent_type: "computerUse" }],
  ] as const)
    await expect(runtime.executeScopedTool(active, "fixture", tool, args)).rejects.toThrow(
      "waiting for approval"
    );
  expect(runtime.pendingApprovals.has("hold")).toBe(true);
  await expect(
    runtime.executeScopedTool({ ...active, requestSource: "automation" }, "fixture", "SendToUser", {
      type: "text",
      content: "Direct automation post",
    })
  ).rejects.toThrow("WakeParent");
});
