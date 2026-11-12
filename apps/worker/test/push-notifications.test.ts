import { describe, expect, test } from "bun:test";
import type { ApnsClient } from "../src/apns";
import {
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
    for (const [value, mode] of [["disabled", "disabled"], [" DISABLED ", "disabled"], ["required", "required"], [undefined, "required"], ["off", "required"]] as const)
      expect(pushAuthenticationModeFromEnvironment(value)).toBe(mode);
  });

  test("queries only disabled-mode devices or required devices with an unexpired session", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(deliverablePushDeviceWhere("required", now)).toEqual({ enabled: true, authRequired: true, authSession: { is: { expiresAt: { gt: now } } } });
    expect(deliverablePushDeviceWhere("disabled", now)).toEqual({ enabled: true, authRequired: false });
    const session = (offsetMs: number) => ({ expiresAt: new Date(now.getTime() + offsetMs) });
    for (const [authRequired, authSession, mode, deliverable] of [
      [false, null, "disabled", true],
      [false, null, "required", false],
      [true, session(1000), "required", true],
      [true, session(-1000), "required", false],
      [true, null, "required", false],
    ] as const)
      expect(pushDeviceSessionIsDeliverable({ enabled: true, authRequired, authSession }, mode, now)).toBe(deliverable);
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

  test("drains only for stream events that can enqueue a push", () => {
    for (const type of ["agent.delta", "context.state", "approval.requested"])
      expect(computerEventQueuesPushNotification({ type } as never)).toBeFalse();
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

const outboxDevice = {
  pushToken: "a".repeat(64),
  apnsTopic: "dev.openteam.mobile.swift",
  apnsEnvironment: "development",
  notificationScope: "b".repeat(64),
};
async function dispatch(result: { status: number; reason?: string } | Error) {
  const devices = [
    {
      ...outboxDevice,
      id: "native",
      provider: "apns",
      enabled: true,
      authRequired: false,
      authSession: null,
    },
  ];
  const updates: any[] = [],
    disabled: any[] = [],
    sends: string[] = [];
  let claim = 0;
  const tx = {
    $queryRaw: async () => [{ count: 3n }],
    pushDevice: {
      findMany: async () => devices,
      updateMany: async (value: any) => {
        disabled.push(value);
        return { count: 1 };
      },
    },
    outboxDelivery: {
      update: async (value: any) => {
        updates.push(value);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
      createMany: async () => ({ count: 1 }),
    },
  };
  const prisma = {
    ...tx,
    $queryRaw: async () =>
      ++claim === 1
        ? devices.map((d) => ({
            id: d.id,
            deliveryKey: "key:" + d.id,
            target: d.id,
            payload: { schemaVersion: 1, kind: "badge-sync", badgeCount: 3 },
            attempts: 1,
          }))
        : [],
    $transaction: async (fn: any) => fn(tx),
  };
  const client = {
    send: async (d: any) => {
      sends.push(d.id);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const dispatcher = new PushNotificationDispatcher(prisma as never, "disabled", client as never);
  await dispatcher.drain();
  return { updates, disabled, sends };
}

describe("native push outbox recovery", () => {
  test("settles an accepted APNs delivery", async () => {
    const value = await dispatch({ status: 200 });
    expect(value.sends).toEqual(["native"]);
    expect(value.disabled).toEqual([]);
    expect(value.updates.at(-1)).toMatchObject({
      where: { id: "native" },
      data: { status: "delivered", deliveredAt: expect.any(Date) },
    });
  });
  test("retires unregistered tokens instead of repeatedly sending to a deleted app", async () => {
    for (const result of [
      { status: 410, reason: "Unregistered" },
      { status: 400, reason: "BadDeviceToken" },
    ]) {
      const value = await dispatch(result);
      expect(value.disabled).toEqual([{ where: { id: "native" }, data: { enabled: false } }]);
      expect(value.updates.at(-1).data).toMatchObject({ status: "delivered", attempts: 5 });
    }
  });
  test("retries temporary rejection and connection failures without disabling the device", async () => {
    for (const result of [
      { status: 503, reason: "ServiceUnavailable" },
      new Error("APNs request timed out"),
    ]) {
      const value = await dispatch(result);
      expect(value.disabled).toEqual([]);
      expect(value.updates.at(-1).data.status).toBe("failed");
      expect(value.updates.at(-1).data.availableAt.getTime()).toBeGreaterThan(Date.now());
    }
  });
});
