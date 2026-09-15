import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InternalToolService } from "../src/services/internal-tool-service";

for (const mode of ["automation", "automation-child", "ordinary-child"] as const) {
  test(`${mode} derives connector review permissions from the run, ignoring tool arguments`, async () => {
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
    await Effect.runPromise(service.execute({ runId: "current", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, callId: "call", tool: "PluginCall", arguments: { connectionId: "connection", toolName: "inspect", arguments: {}, allowReviewUI: true } }));
    expect(invocation?.allowReviewUI).toBe(mode === "ordinary-child");
    expect(invocation?.botId).toBe(mode === "automation" ? "bot" : "parent");
  });
}
