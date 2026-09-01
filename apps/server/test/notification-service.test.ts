import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import {
  deliverablePushDeviceWhere,
  NotificationService,
} from "../src/services/notification-service";

describe("NotificationService", () => {
  test("migrates legacy registrations fail-closed and retires before Better Auth sign-out", async () => {
    const migration = await Bun.file(
      new URL(
        "../../../packages/db/prisma/migrations/20260831000700_push_device_session_binding/migration.sql",
        import.meta.url
      )
    ).text();
    expect(migration).toContain('"authRequired" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('FOREIGN KEY ("authSessionId") REFERENCES "session"("id")');

    const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    const signOutBranch = main.slice(
      main.indexOf('url.pathname === "/api/auth/sign-out"'),
      main.indexOf('url.pathname.startsWith("/api/auth/")')
    );
    expect(signOutBranch.indexOf("disablePushDevicesForSession")).toBeGreaterThan(-1);
    expect(signOutBranch.indexOf("disablePushDevicesForSession")).toBeLessThan(
      signOutBranch.indexOf("auth.handler(authRequest)")
    );
  });

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
        {
          installationId: "installation-123",
          platform: "ios",
          pushToken: `ExpoPushToken[${"a".repeat(24)}]`,
          locale: "en-US",
        },
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

  test("keeps auth-disabled registrations deliverable without inventing a session", async () => {
    let persisted: Record<string, unknown> | null = null;
    const prisma = {
      pushDevice: {
        findUnique: async () => null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          persisted = create;
          return { ...create, enabled: true, lastSeenAt: create.lastSeenAt as Date };
        },
      },
    } as unknown as PrismaClient;
    const service = new NotificationService(prisma, "disabled");

    await Effect.runPromise(
      service.register(
        {
          installationId: "disabled-installation",
          platform: "ios",
          pushToken: `ExpoPushToken[${"b".repeat(24)}]`,
        },
        { mode: "disabled" }
      )
    );

    expect(persisted).toMatchObject({ authRequired: false, authSessionId: null });
    await expect(
      Effect.runPromise(
        new NotificationService(prisma, "required").register(
          {
            installationId: "stale-disabled-installation",
            platform: "ios",
            pushToken: `ExpoPushToken[${"d".repeat(24)}]`,
          },
          { mode: "disabled" }
        )
      )
    ).rejects.toThrow("Refresh authentication before registering this push device");
  });

  test("disables every device bound to a session before sign-out", async () => {
    let update: unknown = null;
    let lockCount = 0;
    const tx = {
      $queryRaw: async () => {
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

  test("cannot re-enable a required device after its sign-out session is retired", async () => {
    let releaseRegistration: () => void = () => undefined;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let markRegistrationStarted: () => void = () => undefined;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    let sessionExists = true;
    let enabled = false;
    const pushDevice = {
      findUnique: async () => null,
      upsert: async () => {
        markRegistrationStarted();
        await registrationGate;
        if (!sessionExists) throw new Error("PushDevice_authSessionId_fkey");
        enabled = true;
        return {
          installationId: "late-installation",
          platform: "ios",
          enabled,
          lastSeenAt: new Date(),
        };
      },
      updateMany: async () => {
        enabled = false;
        return { count: 1 };
      },
    };
    const tx = {
      $queryRaw: async () => [],
      pushDevice,
    };
    const prisma = {
      pushDevice,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const service = new NotificationService(prisma);
    const lateRegistration = Effect.runPromise(
      service.register(
        {
          installationId: "late-installation",
          platform: "ios",
          pushToken: `ExpoPushToken[${"c".repeat(24)}]`,
        },
        { mode: "required", sessionId: "retired-session" }
      )
    );
    await registrationStarted;

    await Effect.runPromise(service.disableForSession("retired-session"));
    sessionExists = false;
    releaseRegistration();

    await expect(lateRegistration).rejects.toThrow("PushDevice_authSessionId_fkey");
    expect(enabled).toBe(false);
  });

  test("filters required devices through a live session while preserving disabled mode", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(deliverablePushDeviceWhere("required", now)).toEqual({
      enabled: true,
      authRequired: true,
      authSession: { is: { expiresAt: { gt: now } } },
    });
    expect(deliverablePushDeviceWhere("disabled", now)).toEqual({
      enabled: true,
      authRequired: false,
    });
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
      $queryRaw: async () => [{ count: 1n }],
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
