import { describe, expect, test } from "bun:test";
import type { ApnsClient } from "../src/apns";
import {
  PushNotificationDispatcher,
  pushAuthenticationModeFromEnvironment,
} from "../src/push-notifications";

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
