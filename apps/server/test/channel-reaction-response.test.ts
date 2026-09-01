import { describe, expect, test } from "bun:test";
import type { ReactToChannelMessageView } from "@openbot/contracts";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";

describe("channel reaction response", () => {
  test("returns the authoritative updated message without duplicating it in the event log", async () => {
    const messageId = "00000000-0000-0000-0000-000000000001";
    const channelId = "00000000-0000-0000-0000-000000000002";
    const stored = {
      id: messageId,
      sequence: 7n,
      channelId,
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      clientId: null,
      content: "an older loaded message",
      metadata: {},
      createdAt: new Date("2026-08-29T12:00:00.000Z"),
      channel: { archivedAt: null, members: [{ botId: "bot-1" }] },
      senderBot: null,
    };
    let persistedResponse: unknown;
    let eventPayload: unknown;
    const tx = {
      channelMessage: {
        findUnique: async () => stored,
        update: async ({ data }: { data: { metadata: unknown } }) => ({
          ...stored,
          metadata: data.metadata,
        }),
      },
      idempotencyRecord: {
        create: async () => ({}),
        update: async ({ data }: { data: { response: unknown } }) => {
          persistedResponse = data.response;
          return {};
        },
      },
      event: {
        create: async ({ data }: { data: { payload: unknown } }) => {
          eventPayload = data.payload;
          return data;
        },
      },
    };
    const prisma = {
      idempotencyRecord: { findUnique: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const messaging = { scheduleTranscriptProjection: async () => undefined };
    const service = new ChannelService(
      prisma as never,
      messaging as never,
      "/workspace",
      async () => new Response(null)
    );

    const result = (await Effect.runPromise(
      service.reactToMessage(messageId, {
        emoji: "👍",
        clientId: "reaction-request-1",
        timeZone: "UTC",
      })
    )) as ReactToChannelMessageView;

    expect(result.message).toMatchObject({
      id: messageId,
      sequence: "7",
      metadata: { reactions: [{ by: "me", emoji: "👍" }] },
    });
    expect(result.reacted).toBe(true);
    expect(persistedResponse).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("message");
  });
});
