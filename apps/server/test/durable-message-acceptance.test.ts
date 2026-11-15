import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";

test("a direct message is acknowledged without waiting for bootstrap cancellation and carries its source machine", async () => {
  const channelId = "channel-direct", clientId = "nonce-direct-1", machineId = crypto.randomUUID();
  const cancellation = Promise.withResolvers<Response>();
  const message = { id: `${channelId}-message`, sequence: 1n, channelId, sender: "user", senderBotId: null, sourceRunId: null, clientId, content: "hello", metadata: { type: "text" }, createdAt: new Date() };
  let runtimeContent = "";
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    conversation: { findUnique: async () => ({ botId: "bot-1", bot: { id: "bot-1", status: "active", subagentIdentity: null } }) },
    idempotencyRecord: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
    channel: { findUnique: async () => ({ id: channelId, archivedAt: null }), update: async () => ({}) },
    channelMessage: { create: async () => message, count: async () => 0 },
    bot: { findMany: async () => [] },
    hostMachine: { findUnique: async () => ({ machineId }) },
    event: { create: async () => ({}) },
  };
  const prisma = { idempotencyRecord: { findUnique: async () => null }, $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };
  const messaging = {
    skipBootstrapForUser: async () => "bootstrap-run-1",
    acceptDirectUserMessage: async (_tx: unknown, input: { content: string }) => { runtimeContent = input.content; return { run: { id: "run-direct" }, interruptRunId: null }; },
    scheduleTranscriptProjection: async () => undefined,
  };
  const service = new ChannelService(prisma as never, messaging as never, "/workspace", async () => cancellation.promise);
  const result = await Promise.race([
    Effect.runPromise(service.sendDirectMessage("conversation-1", { content: "hello", clientId, sourceMachineId: machineId })),
    Bun.sleep(100).then(() => "timed-out" as const),
  ]);
  expect(result).toMatchObject({ message: { id: message.id, clientId } });
  expect(runtimeContent).toContain(`[Sent from machine ${machineId}]`);
  cancellation.resolve(new Response(null, { status: 200 }));
});
