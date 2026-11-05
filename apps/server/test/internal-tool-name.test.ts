import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { InternalToolService } from "../src/services/internal-tool-service";

const request = (tool: string, argumentsValue: unknown = { type: "text", content: "Hello" }) => ({
  runId: "run-1",
  botId: "bot-1",
  conversationId: "conversation-1",
  channelId: "conversation-1",
  deliveryId: null,
  tool,
  arguments: argumentsValue,
  callId: `call-${tool}`,
});

const serviceFixture = (
  options: {
    childIdentity?: Record<string, unknown> | null;
    administration?: Record<string, unknown>;
    subagents?: Record<string, unknown>;
  } = {}
) => {
  const deliveries: Array<{
    type?: string;
    content?: string;
    computerHandoff?: { reason: string; category?: string; domain?: string; idpDomain?: string };
  }> = [];
  const service = new InternalToolService(
    {
      run: {
        findUnique: async () => ({
          id: "run-1",
          botId: "bot-1",
          conversationId: "conversation-1",
          channelId: "conversation-1",
          deliveryId: null,
          status: "running",
          origin: "user",
          inboxEvents: [],
        }),
      },
      subagent: { findUnique: async () => options.childIdentity ?? null },
    } as never,
    {
      sendVisible: async (_context: unknown, input: { type?: string; content?: string }) => {
        deliveries.push(input);
        return { acknowledgement: "sent", interruptRunId: null };
      },
    } as never,
    {} as never,
    async () => {},
    {} as never,
    (options.subagents ?? {}) as never,
    (options.administration ?? {}) as never,
    {} as never
  );
  return { deliveries, service };
};

describe("InternalToolService user-delivery tool name", () => {
  test("accepts only SendToUser", async () => {
    const { deliveries, service } = serviceFixture();
    await expect(Effect.runPromise(service.execute(request("SendToUser")))).resolves.toBe("sent");
    expect(deliveries).toEqual([{ type: "text", content: "Hello" }]);
  });

  test("rejects legacy SendMessage calls", async () => {
    const { deliveries, service } = serviceFixture();
    await expect(Effect.runPromise(service.execute(request("SendMessage")))).rejects.toThrow(
      "Unknown tool SendMessage"
    );
    expect(deliveries).toEqual([]);
  });

  test("creates an explicit computer handoff and tells the agent to wait", async () => {
    const { deliveries, service } = serviceFixture();
    await expect(
      // The page address prepares the box browser; the handoff card itself stays the same.
      Effect.runPromise(service.execute(request("request_box_help", { instruction: "Finish 2FA", reason: "auth", url: "https://example.com/login" })))
    ).resolves.toMatchObject({ sent: true, waiting_for_user: true });
    expect(deliveries).toEqual([
      {
        type: "computer-handoff",
        content: "Finish 2FA",
        computerHandoff: { reason: "Finish 2FA", category: "auth" },
      },
    ]);
  });

  test("teammates come from user_info and other conversations from ReadTranscript, so the old lookups are unknown", async () => {
    const { service } = serviceFixture();
    for (const tool of ["ListAgents", "ListGroups", "read_sibling_thread"])
      await expect(Effect.runPromise(service.execute(request(tool, {})))).rejects.toThrow(`Unknown tool ${tool}`);
  });

  test("StopSubagent passes all: true or one id to the subagent service", async () => {
    const calls: unknown[] = [];
    const { service } = serviceFixture({
      subagents: { stop: async (_botId: string, _callId: string, input: unknown) => (calls.push(input), { stopped_all: true }) },
    });
    await Effect.runPromise(service.execute(request("StopSubagent", { all: true })));
    await Effect.runPromise(service.execute(request("StopSubagent", { subagent_id: "sand-subagent-1" })));
    await expect(Effect.runPromise(service.execute(request("StopSubagent", {})))).rejects.toThrow();
    expect(calls).toEqual([{ all: true }, { subagent_id: "sand-subagent-1" }]);
  });

  test("blocks parent control-plane tools for subagents before routing", async () => {
    let calls = 0;
    const { service } = serviceFixture({
      childIdentity: { id: "child-identity", parentBotId: "parent-id" },
      subagents: { stop: async () => { calls += 1; } },
    });

    for (const [tool, args] of [["request_box_help", { instruction: "Finish 2FA" }], ["StopSubagent", { all: true }]] as const) {
      await expect(Effect.runPromise(service.execute(request(tool, args)))).rejects.toThrow(
        "parent-agent only"
      );
    }
    expect(calls).toBe(0);
  });
});
