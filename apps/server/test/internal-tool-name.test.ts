import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { InternalToolService } from "../src/services/internal-tool-service";

const request = (tool: string) => ({
  runId: "run-1",
  botId: "bot-1",
  conversationId: "conversation-1",
  channelId: "conversation-1",
  deliveryId: null,
  tool,
  arguments: { type: "text", content: "Hello" },
  callId: `call-${tool}`,
});

const serviceFixture = () => {
  const deliveries: Array<{ type?: string; content?: string }> = [];
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
      subagent: { findUnique: async () => null },
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
    {} as never,
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
});
