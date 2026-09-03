import { describe, expect, test } from "bun:test";
import {
  approvalReason,
  claimOutboxDeliveries,
  deliverablePushDeviceWhere,
  enqueuePushNotification,
  expoPushMessage,
  PushNotificationDispatcher,
  pushAuthenticationModeFromEnvironment,
  pushDeviceSessionIsDeliverable,
  truncateNotificationBody,
} from "../src/push-notifications";
import { computerEventQueuesPushNotification } from "../src/worker";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

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

  test("preserves auth-disabled delivery while applying the session filter at enqueue", async () => {
    let deviceWhere: unknown = null;
    const deliveries: unknown[] = [];
    const tx = {
      $queryRaw: async () => [{ count: 0n }],
      pushDevice: {
        findMany: async ({ where }: { where: unknown }) => {
          deviceWhere = where;
          return [{ id: "disabled-mode-device" }];
        },
      },
      outboxDelivery: {
        createMany: async ({ data }: { data: unknown[] }) => {
          deliveries.push(...data);
          return { count: data.length };
        },
      },
    };

    await enqueuePushNotification(
      tx as never,
      "notification:disabled-mode",
      {
        schemaVersion: 1,
        kind: "agent-done",
        botId: "bot",
        channelId: "channel",
        runId: "run",
        title: "Done",
        body: "Finished",
        deepLink: "openteam:///chat/channel",
      },
      "disabled"
    );

    expect(deviceWhere).toEqual({ enabled: true, authRequired: false });
    expect(deliveries).toHaveLength(1);
  });

  test("settles a claimed delivery without sending when session filtering removes its device", async () => {
    let queryCount = 0;
    let deviceWhere: unknown = null;
    const settledIds: string[] = [];
    let expoCalls = 0;
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
      (async () => {
        expoCalls += 1;
        return Response.json({ data: [] });
      }) as unknown as typeof fetch
    );

    await dispatcher.drain();

    const clauses = (deviceWhere as { AND: Array<Record<string, unknown>> }).AND;
    expect(clauses[0]).toEqual({ id: { in: ["expired-device"] } });
    expect(clauses[1]).toMatchObject({ enabled: true, authRequired: true });
    expect(settledIds).toEqual(["delivery-expired"]);
    expect(expoCalls).toBe(0);
  });

  test("rechecks the session after badge work and before sending to Expo", async () => {
    let queryCount = 0;
    let deviceReads = 0;
    let retiredDuringBadgeRead = false;
    let expoCalls = 0;
    const settledIds: string[] = [];
    const device = {
      id: "session-device",
      enabled: true,
      authRequired: true,
      authSession: { expiresAt: new Date("2099-01-01T00:00:00.000Z") },
      pushToken: "ExpoPushToken[session-device]",
    };
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
        if (queryCount === 2) {
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
      $transaction: async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          $queryRaw: async () => [],
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
      (async () => {
        expoCalls += 1;
        return Response.json({ data: [] });
      }) as unknown as typeof fetch
    );

    await dispatcher.drain();

    expect(deviceReads).toBe(2);
    expect(settledIds).toEqual(["delivery-session-race"]);
    expect(expoCalls).toBe(0);
  });

  test("holds the authorization transaction until the bounded Expo send settles", async () => {
    const sendStarted = deferred();
    const releaseSend = deferred();
    let queryCount = 0;
    let transactionActive = false;
    let authorizationLockQueries = 0;
    const device = {
      id: "locked-device",
      enabled: true,
      authRequired: true,
      authSession: { expiresAt: new Date("2099-01-01T00:00:00.000Z") },
      pushToken: "ExpoPushToken[locked-device]",
    };
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
        if (queryCount === 2) return [{ count: 0n }];
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
      (async () => {
        sendStarted.resolve();
        await releaseSend.promise;
        return Response.json({ data: [{ status: "ok", id: "ticket-locked" }] });
      }) as unknown as typeof fetch
    );

    const draining = dispatcher.drain();
    await sendStarted.promise;

    expect(transactionActive).toBeTrue();
    expect(authorizationLockQueries).toBe(2);

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
    expect(computerEventQueuesPushNotification({ type: "approval.requested" } as never)).toBeTrue();
    expect(computerEventQueuesPushNotification({ type: "turn.completed" } as never)).toBeTrue();
  });
  test("prefers a bounded approval reason and normalizes whitespace", () => {
    expect(approvalReason({ reason: "  Approve\nthis   command  " })).toBe("Approve this command");
    expect(approvalReason({ command: "bun test" })).toBe("bun test");
    expect(approvalReason(null)).toBe("Waiting for your input.");
  });

  test("truncates by grapheme without splitting a joined emoji family", () => {
    const family = "👨‍👩‍👧‍👦";
    const result = truncateNotificationBody(`  ${family.repeat(145)}  `);
    expect([
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(result),
    ]).toHaveLength(140);
    expect(result.endsWith("…")).toBe(true);
  });

  test("uses exact badge counts and the shared per-type sound policy", () => {
    const message = expoPushMessage("ExpoPushToken[token]", {
      schemaVersion: 1,
      kind: "agent-done",
      botId: "bot",
      channelId: "channel",
      runId: "run",
      title: "Probe",
      body: "Done",
      deepLink: "openteam:///chat/channel",
      badgeCount: 4,
    });
    expect(message).toMatchObject({ badge: 4, sound: undefined, data: { badgeCount: 4 } });
    expect(
      expoPushMessage("ExpoPushToken[token]", {
        schemaVersion: 1,
        kind: "agent-needs-input",
        botId: "bot",
        channelId: "channel",
        runId: "run",
        approvalId: "approval",
        title: "Probe needs you",
        body: "Approve the command",
        deepLink: "openteam:///chat/channel",
        badgeCount: 4,
      })
    ).toMatchObject({
      title: "Probe needs you",
      body: "Approve the command",
      sound: "default",
      badge: 4,
    });
    expect(
      expoPushMessage("ExpoPushToken[token]", {
        schemaVersion: 1,
        kind: "badge-sync",
        badgeCount: 2,
      })
    ).toEqual({
      to: "ExpoPushToken[token]",
      badge: 2,
      data: { schemaVersion: 1, kind: "badge-sync", badgeCount: 2 },
    });
  });
});
