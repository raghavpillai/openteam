import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const acceptedMessage = (channelId: string, clientId: string) => ({
  id: `${channelId}-message`,
  sequence: 1n,
  channelId,
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  clientId,
  content: "hello",
  metadata: { type: "text" },
  createdAt: new Date("2026-09-01T12:00:00.000Z"),
});

describe("durable message acceptance boundary", () => {
  test("returns a direct-message acknowledgement without waiting for bootstrap cancellation", async () => {
    const channelId = "channel-direct";
    const clientId = "nonce-direct-1";
    const cancellation = deferred<Response>();
    const message = acceptedMessage(channelId, clientId);
    const machineId=crypto.randomUUID();
    let runtimeContent="";
    const tx = {
      $executeRaw: async () => 0,
      conversation: {
        findUnique: async () => ({
          botId: "bot-1",
          bot: { id: "bot-1", status: "active", subagentIdentity: null },
        }),
      },
      idempotencyRecord: { create: async () => ({}), update: async () => ({}) },
      channel: {
        findUnique: async () => ({ id: channelId, archivedAt: null }),
        update: async () => ({}),
      },
      channelMessage: { create: async () => message, count: async () => 0 },
      bot: { findMany: async () => [] },
      hostMachine: { findUnique: async()=>({machineId}) },
      event: { create: async () => ({}) },
    };
    const prisma = {
      idempotencyRecord: { findUnique: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const messaging = {
      skipBootstrapForUser: async () => "bootstrap-run-1",
      acceptDirectUserMessage: async (_tx:unknown,input:{content:string}) => (runtimeContent=input.content,{
        run: { id: "run-direct" },
        steer: null,
        interruptRunId: null,
      }),
      scheduleTranscriptProjection: async () => undefined,
    };
    const service = new ChannelService(
      prisma as never,
      messaging as never,
      "/workspace",
      async () => cancellation.promise
    );

    const result = await Promise.race([
      Effect.runPromise(
        service.sendDirectMessage("conversation-1", { content: "hello", clientId,sourceMachineId:machineId })
      ),
      Bun.sleep(100).then(() => "timed-out" as const),
    ]);
    expect(result).not.toBe("timed-out");
    expect(result).toMatchObject({ message: { id: message.id, clientId } });
    expect(runtimeContent).toContain(`[Sent from machine ${machineId}]`);
    cancellation.resolve(new Response(null, { status: 200 }));
  });

  test("returns a group-message acknowledgement without waiting for round advancement", async () => {
    const channelId = "channel-group";
    const clientId = "nonce-group-1";
    const advancement = deferred<void>();
    let advancementStarted = false;
    const message = acceptedMessage(channelId, clientId);
    const tx = {
      $executeRaw: async () => 0,
      channel: {
        findUnique: async () => ({
          id: channelId,
          kind: "group",
          archivedAt: null,
          members: [{ botId: "bot-1" }],
        }),
        update: async () => ({}),
      },
      channelMessage: { create: async () => message, count: async () => 0, findUniqueOrThrow: async () => message, findMany: async () => [] },
      channelRound: { findMany: async () => [] },
      idempotencyRecord: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
      event: { create: async () => ({}) },
    };
    const prisma = {
      idempotencyRecord: { findUnique: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const messaging = {
      scheduleTranscriptProjection: async () => undefined,
      createGroupRound: async () => ({ id: "round-1" }),
      advanceRound: () => {
        advancementStarted = true;
        return advancement.promise;
      },
    };
    const service = new ChannelService(
      prisma as never,
      messaging as never,
      "/workspace",
      async () => new Response(null)
    );

    const result = await Promise.race([
      Effect.runPromise(service.sendGroupMessage(channelId, { content: "hello", clientId })),
      Bun.sleep(100).then(() => "timed-out" as const),
    ]);
    expect(result).not.toBe("timed-out");
    expect(result).toMatchObject({
      message: { id: message.id, clientId },
      round: { id: "round-1" },
    });
    expect(advancementStarted).toBe(true);
    advancement.resolve();
  });
});
