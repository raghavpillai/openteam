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
  } = {}
) => {
  const deliveries: Array<{
    type?: string;
    content?: string;
    computerHandoff?: { reason: string };
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
    {} as never,
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
      Effect.runPromise(service.execute(request("request_box_help", { reason: "Finish 2FA" })))
    ).resolves.toMatchObject({ sent: true, waiting_for_user: true });
    expect(deliveries).toEqual([
      {
        type: "computer-handoff",
        content: "Finish 2FA",
        computerHandoff: { reason: "Finish 2FA" },
      },
    ]);
  });

  test("routes bounded directory reads for parent agents", async () => {
    const calls: Array<{ kind: string; botId: string; input: unknown }> = [];
    const { service } = serviceFixture({
      administration: {
        listAgents: async (botId: string, input: unknown) => {
          calls.push({ kind: "agents", botId, input });
          return { agents: [] };
        },
        listGroups: async (botId: string, input: unknown) => {
          calls.push({ kind: "groups", botId, input });
          return { groups: [] };
        },
      },
    });

    await expect(
      Effect.runPromise(service.execute(request("ListAgents", { query: "research", limit: 3 })))
    ).resolves.toEqual({ agents: [] });
    await expect(
      Effect.runPromise(service.execute(request("ListGroups", { limit: 2 })))
    ).resolves.toEqual({ groups: [] });
    expect(calls).toEqual([
      { kind: "agents", botId: "bot-1", input: { query: "research", limit: 3 } },
      { kind: "groups", botId: "bot-1", input: { limit: 2 } },
    ]);
  });

  test("blocks directory control-plane tools for subagents before routing", async () => {
    let calls = 0;
    const { service } = serviceFixture({
      childIdentity: { id: "child-identity", parentBotId: "parent-id" },
      administration: {
        listAgents: async () => {
          calls += 1;
        },
        listGroups: async () => {
          calls += 1;
        },
      },
    });

    for (const tool of ["ListAgents", "ListGroups", "request_box_help"]) {
      await expect(Effect.runPromise(service.execute(request(tool, {})))).rejects.toThrow(
        "parent-agent only"
      );
    }
    expect(calls).toBe(0);
  });
});
