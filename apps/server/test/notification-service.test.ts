import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { NotificationService } from "../src/services/notification-service";

describe("NotificationService", () => {
  test("registers an installation idempotently and can disable it", async () => {
    let enabled = true;
    const prisma = {
      pushDevice: {
        findUnique: async () => null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => ({
          ...create,
          enabled,
          lastSeenAt: create.lastSeenAt as Date,
        }),
        updateMany: async () => {
          enabled = false;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const service = new NotificationService(prisma);
    const registered = await Effect.runPromise(
      service.register({
        installationId: "installation-123",
        platform: "ios",
        pushToken: `ExpoPushToken[${"a".repeat(24)}]`,
        locale: "en-US",
      })
    );
    expect(registered).toMatchObject({ installationId: "installation-123", enabled: true });
    await expect(Effect.runPromise(service.unregister("installation-123"))).resolves.toEqual({
      ok: true,
    });
    expect(enabled).toBe(false);
  });

  test("advances but never regresses a durable read cursor and excludes A2A rows", async () => {
    let lastReadSequence = 8n;
    const events: unknown[] = [];
    const tx = {
      channel: {
        findUnique: async () => ({ id: "00000000-0000-0000-0000-000000000001" }),
        findMany: async () => [
          {
            id: "00000000-0000-0000-0000-000000000001",
            readState: { lastReadSequence },
          },
        ],
      },
      channelMessage: {
        findFirst: async () => ({ sequence: 12n }),
        findMany: async () => [
          {
            channelId: "00000000-0000-0000-0000-000000000001",
            sequence: 11n,
            metadata: { type: "text" },
          },
          {
            channelId: "00000000-0000-0000-0000-000000000001",
            sequence: 12n,
            metadata: { fromAgent: { id: "peer" } },
          },
        ],
      },
      $executeRaw: async (_strings: TemplateStringsArray, _channelId: string, target: bigint) => {
        if (target > lastReadSequence) lastReadSequence = target;
        return 1;
      },
      channelReadState: {
        findUnique: async () => ({ lastReadSequence }),
        findUniqueOrThrow: async () => ({ lastReadSequence }),
      },
      event: {
        create: async ({ data }: { data: unknown }) => {
          events.push(data);
          return data;
        },
      },
      pushDevice: { findMany: async () => [] },
      outboxDelivery: { createMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const service = new NotificationService(prisma);

    await expect(
      Effect.runPromise(service.markChannelRead("00000000-0000-0000-0000-000000000001", "10"))
    ).resolves.toEqual({
      channelId: "00000000-0000-0000-0000-000000000001",
      lastReadSequence: "10",
      unreadCount: 1,
    });
    await Effect.runPromise(service.markChannelRead("00000000-0000-0000-0000-000000000001", "9"));
    expect(lastReadSequence).toBe(10n);
    expect(events).toHaveLength(1);
  });
});
