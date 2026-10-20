import { describe, expect, test } from "bun:test";
import type { ApnsClient } from "../src/apns";
import {
  claimOutboxDeliveries,
  deliverablePushDeviceWhere,
  PushNotificationDispatcher,
  pushAuthenticationModeFromEnvironment,
  pushDeviceSessionIsDeliverable,
} from "../src/push-notifications";
import { computerEventQueuesPushNotification } from "../src/worker";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const apnsDevice = (id: string) => ({
  id,
  platform: "ios",
  provider: "apns",
  pushToken: "ab".repeat(32),
  apnsEnvironment: "production",
  apnsTopic: "dev.openteam.mobile.swift",
  notificationScope: "cd".repeat(32),
  enabled: true,
  authRequired: true,
  authSession: { expiresAt: new Date("2099-01-01T00:00:00.000Z") },
});

const apnsClient = (send: () => Promise<{ status: number }>) => ({ send }) as unknown as ApnsClient;

describe("push notification content", () => {
  test("fails closed unless the worker is explicitly configured for disabled auth", () => {
    expect(pushAuthenticationModeFromEnvironment("disabled")).toBe("disabled");
    expect(pushAuthenticationModeFromEnvironment(" DISABLED ")).toBe("disabled");
    expect(pushAuthenticationModeFromEnvironment("required")).toBe("required");
    expect(pushAuthenticationModeFromEnvironment(undefined)).toBe("required");
    expect(pushAuthenticationModeFromEnvironment("off")).toBe("required");
  });

  test("queries only disabled-mode devices or required devices with an unexpired session", () => {
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
    expect(
      pushDeviceSessionIsDeliverable(
        { enabled: true, authRequired: false, authSession: null },
        "disabled",
        now
      )
    ).toBeTrue();
    expect(
      pushDeviceSessionIsDeliverable(
        { enabled: true, authRequired: false, authSession: null },
        "required",
        now
      )
    ).toBeFalse();
    expect(
      pushDeviceSessionIsDeliverable(
        {
          enabled: true,
          authRequired: true,
          authSession: { expiresAt: new Date("2026-08-31T12:00:01.000Z") },
        },
        "required",
        now
      )
    ).toBeTrue();
    expect(
      pushDeviceSessionIsDeliverable(
        {
          enabled: true,
          authRequired: true,
          authSession: { expiresAt: new Date("2026-08-31T11:59:59.000Z") },
        },
        "required",
        now
      )
    ).toBeFalse();
    expect(
      pushDeviceSessionIsDeliverable(
        { enabled: true, authRequired: true, authSession: null },
        "required",
        now
      )
    ).toBeFalse();
  });

  test("settles a claimed delivery without sending when session filtering removes its device", async () => {
    let queryCount = 0;
    let deviceWhere: unknown = null;
    const settledIds: string[] = [];
    let sends = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCount += 1;
        return queryCount === 1
          ? [
              {
                id: "delivery-expired",
                deliveryKey: "notification:expired",
                target: "expired-device",
                payload: { schemaVersion: 1, kind: "badge-sync", badgeCount: 0 },
                attempts: 1,
              },
            ]
          : [];
      },
      pushDevice: {
        findMany: async ({ where }: { where: unknown }) => {
          deviceWhere = where;
          return [];
        },
      },
      outboxDelivery: {
        updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          settledIds.push(...where.id.in);
          return { count: where.id.in.length };
        },
      },
    };
    const dispatcher = new PushNotificationDispatcher(
      prisma as never,
      "required",
      apnsClient(async () => {
        sends += 1;
        return { status: 200 };
      })
    );

    await dispatcher.drain();

    const clauses = (deviceWhere as { AND: Array<Record<string, unknown>> }).AND;
    expect(clauses[0]).toEqual({ id: { in: ["expired-device"] } });
    expect(clauses[1]).toMatchObject({ enabled: true, authRequired: true });
    expect(settledIds).toEqual(["delivery-expired"]);
    expect(sends).toBe(0);
  });

  test("rechecks the session after badge work and before sending to APNs", async () => {
    let queryCount = 0;
    let deviceReads = 0;
    let retiredDuringBadgeRead = false;
    let sends = 0;
    const settledIds: string[] = [];
    const device = apnsDevice("session-device");
    const prisma = {
      $queryRaw: async () => {
        queryCount += 1;
        if (queryCount === 1) {
          return [
            {
              id: "delivery-session-race",
              deliveryKey: "notification:session-race",
              target: device.id,
              payload: { schemaVersion: 1, kind: "badge-sync", badgeCount: 0 },
              attempts: 1,
            },
          ];
        }
        return [];
      },
      pushDevice: {
        findMany: async () => {
          deviceReads += 1;
          return retiredDuringBadgeRead ? [] : [device];
        },
      },
      outboxDelivery: {
        updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          settledIds.push(...where.id.in);
          return { count: where.id.in.length };
        },
      },
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          $queryRaw: async (query: { sql?: string }) => {
            if (query.sql?.includes('AS "count"')) {
              retiredDuringBadgeRead = true;
              return [{ count: 0n }];
            }
            return [];
          },
          pushDevice: {
            findMany: async () => {
              deviceReads += 1;
              return retiredDuringBadgeRead ? [] : [device];
            },
          },
          outboxDelivery: {
            updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
              settledIds.push(...where.id.in);
              return { count: where.id.in.length };
            },
          },
        }),
    };
    const dispatcher = new PushNotificationDispatcher(
      prisma as never,
      "required",
      apnsClient(async () => {
        sends += 1;
        return { status: 200 };
      })
    );

    await dispatcher.drain();

    expect(deviceReads).toBe(2);
    expect(settledIds).toEqual(["delivery-session-race"]);
    expect(sends).toBe(0);
  });

  test("holds the authorization transaction until the bounded APNs send settles", async () => {
    const sendStarted = deferred();
    const releaseSend = deferred();
    let queryCount = 0;
    let transactionActive = false;
    let authorizationLockQueries = 0;
    const device = apnsDevice("locked-device");
    const tx = {
      $queryRaw: async () => {
        authorizationLockQueries += 1;
        return [];
      },
      pushDevice: {
        findMany: async () => [device],
        updateMany: async () => ({ count: 0 }),
      },
      outboxDelivery: {
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 1 }),
      },
    };
    const prisma = {
      $queryRaw: async () => {
        queryCount += 1;
        if (queryCount === 1) {
          return [
            {
              id: "delivery-locked",
              deliveryKey: "notification:locked",
              target: device.id,
              payload: { schemaVersion: 1, kind: "badge-sync", badgeCount: 0 },
              attempts: 1,
            },
          ];
        }
        return [];
      },
      pushDevice: { findMany: async () => [device] },
      outboxDelivery: {
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
        transactionActive = true;
        try {
          return await operation(tx);
        } finally {
          transactionActive = false;
        }
      },
    };
    const dispatcher = new PushNotificationDispatcher(
      prisma as never,
      "required",
      apnsClient(async () => {
        sendStarted.resolve();
        await releaseSend.promise;
        return { status: 200 };
      })
    );

    const draining = dispatcher.drain();
    await sendStarted.promise;

    expect(transactionActive).toBeTrue();
    expect(authorizationLockQueries).toBe(3);

    releaseSend.resolve();
    await draining;
    expect(transactionActive).toBeFalse();
  });

  test("claims a delivery batch with one database statement", async () => {
    let statements = 0;
    const client = {
      $queryRaw: async () => {
        statements += 1;
        return [
          {
            id: "delivery-1",
            deliveryKey: "notification:1",
            target: "device-1",
            payload: { schemaVersion: 1 },
            attempts: 2,
          },
        ];
      },
    };

    await expect(claimOutboxDeliveries(client as never, "push.notification", 100)).resolves.toEqual(
      [expect.objectContaining({ id: "delivery-1", attempts: 2 })]
    );
    expect(statements).toBe(1);
  });

  test("drains only for stream events that can enqueue a push", () => {
    expect(computerEventQueuesPushNotification({ type: "agent.delta" } as never)).toBeFalse();
    expect(computerEventQueuesPushNotification({ type: "context.state" } as never)).toBeFalse();
    expect(computerEventQueuesPushNotification({ type: "approval.requested" } as never)).toBeFalse();
    expect(computerEventQueuesPushNotification({ type: "turn.completed" } as never)).toBeTrue();
  });

  test("retires an alert that carries no durable activity sequence without sending", async () => {
    let queryCount = 0;
    let sends = 0;
    let activityLookups = 0;
    const settled: unknown[] = [];
    const device = apnsDevice("sequence-device");
    const tx = {
      $queryRaw: async (query: { sql?: string }) =>
        query.sql?.includes('AS "count"') ? [{ count: 0n }] : [],
      pushDevice: { findMany: async () => [device] },
      notificationPreferences: { findUnique: async () => null },
      notificationPresence: { findMany: async () => [] },
      channelReadState: { findUnique: async () => null },
      bot: { findUnique: async () => ({ notificationsEnabled: true, hiddenFromSidebar: false }) },
      channel: { findUnique: async () => ({ archivedAt: null, hiddenFromSidebar: false }) },
      channelNotification: {
        findUnique: async () => {
          activityLookups += 1;
          return { revoked: false };
        },
      },
      outboxDelivery: {
        update: async () => ({}),
        updateMany: async (value: unknown) => {
          settled.push(value);
          return { count: 1 };
        },
      },
    };
    const prisma = {
      $queryRaw: async () =>
        ++queryCount === 1
          ? [
              {
                id: "delivery-without-sequence",
                deliveryKey: "notification:without-sequence",
                target: device.id,
                payload: {
                  schemaVersion: 1,
                  kind: "message",
                  botId: "bot",
                  channelId: "channel",
                  runId: "run",
                  title: "Probe",
                  body: "Done",
                  badgeCount: 1,
                  messageSequence: "4",
                },
                attempts: 1,
              },
            ]
          : [],
      pushDevice: { findMany: async () => [device] },
      outboxDelivery: { update: async () => ({}), updateMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    };
    const dispatcher = new PushNotificationDispatcher(
      prisma as never,
      "required",
      apnsClient(async () => {
        sends += 1;
        return { status: 200 };
      })
    );

    await dispatcher.drain();

    expect(sends).toBe(0);
    expect(activityLookups).toBe(0);
    expect(settled).toEqual([
      {
        where: { id: { in: ["delivery-without-sequence"] } },
        data: { status: "delivered", deliveredAt: expect.any(Date) },
      },
    ]);
  });
});
