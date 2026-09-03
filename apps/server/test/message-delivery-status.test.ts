import { describe, expect, test } from "bun:test";
import type { MessageDeliveryStatusView } from "@openteam/contracts";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";

const channelId = "00000000-0000-0000-0000-000000000021";
const clientId = "delivery-nonce-0001";

describe("message delivery status", () => {
  test("distinguishes durable transcript acceptance from idempotency progress and rejection", async () => {
    let storedMessage: Record<string, unknown> | null = null;
    let idempotency: { status: string } | null = null;
    const prisma = {
      channelMessage: { findUnique: async () => storedMessage },
      channel: {
        findUnique: async () => ({ id: channelId, kind: "group", members: [] }),
      },
      idempotencyRecord: { findUnique: async () => idempotency },
    };
    const service = new ChannelService(
      prisma as never,
      {} as never,
      "/workspace",
      async () => new Response(null)
    );
    const status = () =>
      Effect.runPromise(
        service.messageDeliveryStatus(channelId, clientId)
      ) as Promise<MessageDeliveryStatusView>;

    expect(await status()).toMatchObject({ status: "not_found", message: null });

    idempotency = { status: "processing" };
    expect(await status()).toMatchObject({ status: "pending", message: null });

    idempotency = { status: "failed" };
    expect(await status()).toMatchObject({
      status: "rejected",
      code: "server_rejected",
      message: null,
    });

    idempotency = { status: "completed" };
    expect(await status()).toMatchObject({ status: "unknown_durability", message: null });

    storedMessage = {
      id: "00000000-0000-0000-0000-000000000022",
      sequence: 42n,
      channelId,
      sender: "user",
      senderBotId: null,
      sourceRunId: null,
      clientId,
      content: "durably accepted",
      metadata: {},
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
    };
    expect(await status()).toMatchObject({
      status: "accepted",
      acceptedAtMs: Date.parse("2026-09-01T12:00:00.000Z"),
      message: {
        sequence: "42",
        channelId,
        content: "durably accepted",
      },
    });
  });
});
