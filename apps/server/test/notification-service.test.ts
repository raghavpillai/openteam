import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { NotificationService } from "../src/services/notification-service";

const apnsRegistration = (installationId: string) => ({
  installationId,
  platform: "ios" as const,
  provider: "apns" as const,
  pushToken: "ab".repeat(32),
  apnsEnvironment: "production" as const,
  apnsTopic: "dev.openteam.mobile.swift",
  notificationScope: "cd".repeat(32),
});

describe("NotificationService", () => {
  test("registers an installation idempotently and can disable it", async () => {
    let enabled = true;
    let persisted: Record<string, unknown> | null = null;
    const prisma = {
      pushDevice: {
        findUnique: async () => null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          persisted = create;
          return {
            ...create,
            enabled,
            lastSeenAt: create.lastSeenAt as Date,
          };
        },
        updateMany: async () => {
          enabled = false;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const service = new NotificationService(prisma);
    const registered = await Effect.runPromise(
      service.register(
        { ...apnsRegistration("installation-123"), locale: "en-US" },
        { mode: "required", sessionId: "session-123" }
      )
    );
    expect(registered).toMatchObject({ installationId: "installation-123", enabled: true });
    expect(persisted).toMatchObject({ authRequired: true, authSessionId: "session-123" });
    await expect(Effect.runPromise(service.unregister("installation-123"))).resolves.toEqual({
      ok: true,
    });
    expect(enabled).toBe(false);
  });

  test("disables every device bound to a session before sign-out", async () => {
    let update: unknown = null;
    let lockCount = 0;
    const tx = {
      notificationPresence: { updateMany: async () => ({ count: 0 }) },
      event: { create: async () => ({}) },
      $executeRaw: async () => {
        lockCount += 1;
        return 1;
      },
      pushDevice: {
        updateMany: async (input: unknown) => {
          update = input;
          return { count: 2 };
        },
      },
    };
    const prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;

    await expect(
      Effect.runPromise(new NotificationService(prisma).disableForSession("session-retiring"))
    ).resolves.toEqual({ disabledCount: 2 });
    expect(lockCount).toBe(1);
    expect(update).toEqual({
      where: { authRequired: true, authSessionId: "session-retiring", enabled: true },
      data: { enabled: false },
    });
  });

  test("advances but never regresses a durable read cursor and excludes A2A rows", async () => {
    let lastReadSequence = 8n;
    const events: unknown[] = [];
    const tx = {
      channelNotification: { findFirst: async () => null },
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
        if (_strings.join("").includes("INSERT") && target > lastReadSequence)
          lastReadSequence = target;
        return 1;
      },
      $queryRaw: async (query: { sql: string }) =>
        query.sql.includes("notificationCursor") ? [] : [{ count: 1n }],
      channelReadState: {
        findUnique: async () => ({ lastReadSequence, lastReadNotificationSequence: 0n }),
        findUniqueOrThrow: async () => ({ lastReadSequence, lastReadNotificationSequence: 0n }),
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
      lastReadNotificationSequence: "0",
      unreadCount: 1,
    });
    await Effect.runPromise(service.markChannelRead("00000000-0000-0000-0000-000000000001", "9"));
    expect(lastReadSequence).toBe(10n);
    expect(events).toHaveLength(1);
  });
});

describe("native push registration", () => {
  const input = {installationId:"swift-installation",platform:"ios" as const,provider:"apns" as const,pushToken:"AB".repeat(32),apnsEnvironment:"development" as const,apnsTopic:"dev.openteam.mobile.swift",notificationScope:"cd".repeat(32)};
  test("persists native transport settings and normalizes a rotated APNs token", async () => {
    let persisted: any;
    const prisma = {pushDevice:{findUnique:async()=>null,upsert:async({create}:any)=>{persisted=create;return {...create,enabled:true};}}} as unknown as PrismaClient;
    await Effect.runPromise(new NotificationService(prisma,"disabled").register(input,{mode:"disabled"}));
    expect(persisted).toMatchObject({provider:"apns",apnsEnvironment:"development",apnsTopic:input.apnsTopic,notificationScope:input.notificationScope,pushToken:input.pushToken.toLowerCase(),authRequired:false});
  });
});
