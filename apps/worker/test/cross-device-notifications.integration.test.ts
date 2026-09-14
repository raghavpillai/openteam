import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import {
  AgentMessaging,
  channelNotificationStates,
  publishMessageNotification,
  unreadBadgeCount,
  unreadChannelCount,
} from "@openteam/messaging";
import { Effect } from "effect";
import { NotificationService } from "../../server/src/services/notification-service";
import { DesktopNotificationManager } from "../../desktop/src/main/notifications";
import { PushNotificationDispatcher, claimOutboxDeliveries } from "../src/push-notifications";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "messages and old-message reactions fan out, synchronize reads, and cancel stale alerts",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const previousAuth = process.env.OPENTEAM_AUTH_MODE;
    process.env.OPENTEAM_AUTH_MODE = "disabled";
    const bot = await prisma.bot.create({
      data: {
        name: "Notification QA",
        icon: "pod",
        color: "#ff6600",
        defaultDirectory: "/tmp/notification-qa",
      },
    });
    const channel = await prisma.channel.create({
      data: {
        kind: "bot_dm",
        name: "Notification QA",
        members: { create: { botId: bot.id, ordinal: 0 } },
      },
    });
    const installationIds = [crypto.randomUUID(), crypto.randomUUID()];
    const sent: Array<{
      to: string;
      title?: string;
      badge: number;
      data: {
        kind: string;
        messageSequence?: string;
        notificationSequence?: string;
        readState?: unknown;
      };
    }> = [];
    const delivered: string[] = [];
    const dismissed: string[] = [];
    const manager = new DesktopNotificationManager({
      isFocused: () => false,
      isSupported: () => true,
      deliver: (notification) => delivered.push(notification.notificationId!),
      dismiss: (id) => dismissed.push(id),
      setBadge: () => {},
    });
    const service = new NotificationService(prisma, "disabled");
    const dispatcher = new PushNotificationDispatcher(
      prisma,
      (async (_url, init) => {
        const batch = JSON.parse(String(init?.body));
        sent.push(...batch);
        return Response.json({
          data: batch.map(() => ({ status: "ok", id: crypto.randomUUID() })),
        });
      }) as typeof fetch,
      null,
      "disabled"
    );
    const state = async () =>
      (await channelNotificationStates(prisma, [channel.id])).get(channel.id)!;
    const sync = async () => {
      const current = await state();
      const unreadCount =
        (await unreadChannelCount(prisma, channel.id, BigInt(current.lastReadSequence))) +
        current.activityUnreadCount;
      manager.sync({ agents: [], channels: [{ ...current, unreadCount }] });
      return current;
    };
    const drain = async () => {
      await prisma.outboxDelivery.updateMany({
        where: { topic: "push.notification", status: "pending" },
        data: { availableAt: new Date(0) },
      });
      await dispatcher.drain();
      expect(
        await prisma.outboxDelivery.findMany({
          where: { status: "failed" },
          select: { error: true },
        })
      ).toEqual([]);
    };
    try {
      await prisma.pushDevice.createMany({
        data: installationIds.map((id) => ({
          installationId: id,
          platform: "ios" as const,
          pushToken: `ExpoPushToken[${id}]`,
          authRequired: false,
        })),
      });
      await sync();
      const userMessage = await prisma.channelMessage.create({
        data: { channelId: channel.id, sender: "user", content: "Please check" },
      });
      const conversation = await prisma.conversation.create({ data: { botId: bot.id } });
      const run = await prisma.run.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          channelId: channel.id,
          userMessageId: userMessage.id,
        },
      });
      const messaging = new AgentMessaging(
        prisma,
        { sendDebounced: async () => {} } as never,
        {} as never,
        {} as never
      );
      const context = {
        botId: bot.id,
        channelId: channel.id,
        conversationId: conversation.id,
        runId: run.id,
        callId: crypto.randomUUID(),
        origin: "user" as const,
        deliveryId: null,
        replyToMessageId: null,
        isFork: false,
      };
      await messaging.sendVisible(context, { type: "text", content: "First response" });
      await messaging.sendVisible(context, { type: "text", content: "First response" });
      const first = await prisma.channelMessage.findUniqueOrThrow({
        where: {
          channelId_clientId: { channelId: channel.id, clientId: `tool:${context.callId}` },
        },
      });
      await prisma.$transaction((tx) => publishMessageNotification(tx, first)); // Completion must not double-alert.
      const firstState = await sync();
      expect(firstState.notifications[0]).toMatchObject({
        title: "Notification QA",
        sender: { name: "Notification QA", icon: "pod", color: "#ff6600" },
      });
      expect(delivered).toHaveLength(1);
      expect(await prisma.channelNotification.count({ where: { channelId: channel.id } })).toBe(1);
      expect(await prisma.outboxDelivery.count({ where: { topic: "push.notification" } })).toBe(2);

      const secondContext = { ...context, callId: crypto.randomUUID() };
      await messaging.sendVisible(secondContext, { type: "text", content: "Second response" });
      const second = await prisma.channelMessage.findUniqueOrThrow({
        where: {
          channelId_clientId: { channelId: channel.id, clientId: `tool:${secondContext.callId}` },
        },
      });
      await Effect.runPromise(
        service.markChannelRead(
          channel.id,
          first.sequence.toString(),
          firstState.notificationCursor
        )
      );
      const secondState = await sync();
      expect(dismissed).toEqual([delivered[0]!]);
      expect(secondState.notifications.map((n) => n.messageSequence)).toEqual([
        second.sequence.toString(),
      ]);
      await drain();
      const messagePushes = sent.filter((push) => push.data.kind === "message");
      expect(messagePushes).toHaveLength(2);
      expect(
        messagePushes.every((push) => push.data.messageSequence === second.sequence.toString())
      ).toBe(true);
      expect(new Set(messagePushes.map((push) => push.to)).size).toBe(2);

      await Effect.runPromise(
        service.markChannelRead(
          channel.id,
          second.sequence.toString(),
          secondState.notificationCursor
        )
      );
      await sync();
      expect(dismissed).toEqual(delivered);
      const reactionContext = { ...context, callId: crypto.randomUUID() };
      await messaging.reactToMessage(reactionContext, {
        message_address: `t${userMessage.sequence}u`,
        emoji: "👍",
      });
      await messaging.reactToMessage(reactionContext, {
        message_address: `t${userMessage.sequence}u`,
        emoji: "👍",
      });
      const reactionState = await sync();
      expect(reactionState.activityUnreadCount).toBe(1);
      expect(reactionState.notifications[0]?.kind).toBe("reaction");
      expect(await unreadBadgeCount(prisma)).toBe(1);
      await drain();
      expect(sent.filter((push) => push.data.kind === "reaction")).toHaveLength(2);
      await Effect.runPromise(
        service.markChannelRead(
          channel.id,
          second.sequence.toString(),
          reactionState.notificationCursor
        )
      );
      await Effect.runPromise(
        service.markChannelRead(
          channel.id,
          first.sequence.toString(),
          firstState.notificationCursor
        )
      );
      const read = await sync();
      expect(read.lastReadSequence).toBe(second.sequence.toString());
      expect(read.lastReadNotificationSequence).toBe(reactionState.notificationCursor);
      expect(read.notifications).toEqual([]);
      expect(await unreadBadgeCount(prisma)).toBe(0);
      expect(dismissed).toEqual(delivered);
      await drain();
      expect(sent.filter((push) => push.data.kind === "badge-sync").at(-1)).toMatchObject({
        badge: 0,
        data: {
          readState: {
            channelId: channel.id,
            lastReadNotificationSequence: reactionState.notificationCursor,
          },
        },
      });
      await messaging.reactToMessage(
        { ...context, callId: crypto.randomUUID() },
        { message_address: `t${userMessage.sequence}u`, emoji: "🔔" }
      );
      await messaging.reactToMessage(
        { ...context, callId: crypto.randomUUID() },
        { message_address: `t${userMessage.sequence}u`, emoji: "🔔" }
      );
      await drain();
      expect(sent.filter((push) => push.data.kind === "reaction")).toHaveLength(2);
      expect(await unreadBadgeCount(prisma)).toBe(0);
    } finally {
      const devices = await prisma.pushDevice.findMany({
        where: { installationId: { in: installationIds } },
      });
      await prisma.outboxDelivery.deleteMany({
        where: { target: { in: devices.map((device) => device.id) } },
      });
      await prisma.pushDevice.deleteMany({ where: { installationId: { in: installationIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { scope: `reaction:${bot.id}` } });
      await prisma.channel.delete({ where: { id: channel.id } });
      await prisma.bot.delete({ where: { id: bot.id } });
      await prisma.$disconnect();
      if (previousAuth === undefined) delete process.env.OPENTEAM_AUTH_MODE;
      else process.env.OPENTEAM_AUTH_MODE = previousAuth;
    }
  },
  30_000
);

test.skipIf(!databaseUrl)(
  "late push receipts cannot disable a replacement or renewed device registration",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const service = new NotificationService(prisma, "disabled");
    try {
      for (const scenario of ["rotated", "renewed", "current", "legacy"] as const) {
        const installationId = crypto.randomUUID();
        const token = `ExpoPushToken[${installationId}]`;
        const device = await prisma.pushDevice.create({
          data: {
            installationId,
            platform: "ios",
            pushToken: token,
            authRequired: false,
            lastSeenAt: new Date("2026-01-01T00:00:00Z"),
          },
        });
        try {
          const ticketId = crypto.randomUUID();
          const dispatcher = new PushNotificationDispatcher(
            prisma,
            (async (url, init) => {
              if (String(url).endsWith("/getReceipts")) {
                expect(JSON.parse(String(init?.body))).toEqual({ ids: [ticketId] });
                return Response.json({
                  data: {
                    [ticketId]: { status: "error", details: { error: "DeviceNotRegistered" } },
                  },
                });
              }
              expect(JSON.parse(String(init?.body))[0].to).toBe(token);
              return Response.json({ data: [{ status: "ok", id: ticketId }] });
            }) as typeof fetch,
            null,
            "disabled"
          );
          await prisma.outboxDelivery.create({
            data: {
              deliveryKey: `receipt-qa:${installationId}`,
              availableAt: new Date(0),
              topic: "push.notification",
              target: device.id,
              payload: { schemaVersion: 1, kind: "badge-sync", badgeCount: 0 },
            },
          });
          await dispatcher.drain();
          expect(
            await prisma.outboxDelivery.findMany({
              where: { target: device.id, status: "failed" },
              select: { error: true },
            })
          ).toEqual([]);
          const receipt = await prisma.outboxDelivery.findFirstOrThrow({
            where: { target: device.id, topic: "push.receipt" },
          });
          if (scenario === "rotated" || scenario === "renewed") {
            await Effect.runPromise(
              service.register(
                {
                  installationId,
                  platform: "ios",
                  pushToken:
                    scenario === "rotated" ? `ExpoPushToken[new-${installationId}]` : token,
                },
                { mode: "disabled" }
              )
            );
          }
          await prisma.outboxDelivery.update({
            where: { id: receipt.id },
            data: {
              availableAt: new Date(0),
              ...(scenario === "legacy" ? { payload: { ticketId } } : {}),
            },
          });
          await dispatcher.drain();
          const current = await prisma.pushDevice.findUniqueOrThrow({ where: { id: device.id } });
          expect({ scenario, enabled: current.enabled }).toEqual({
            scenario,
            enabled: scenario !== "current",
          });
          expect(
            (await prisma.outboxDelivery.findUniqueOrThrow({ where: { id: receipt.id } })).error
          ).toMatchObject({ details: { error: "DeviceNotRegistered" } });
        } finally {
          await prisma.outboxDelivery.deleteMany({ where: { target: device.id } });
          await prisma.pushDevice.delete({ where: { id: device.id } });
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  },
  30_000
);

test.skipIf(!databaseUrl)(
  "expired worker claims recover without stealing active work or changing UTC schedules",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    try {
      for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        const topic = `notification-lease-qa:${crypto.randomUUID()}`;
        try {
          await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
            const now = Date.now();
            await tx.outboxDelivery.createMany({
              data: [
                {
                  key: "abandoned",
                  status: "delivering" as const,
                  attempts: 1,
                  age: 180_000,
                  due: -60_000,
                },
                { key: "active", status: "delivering" as const, attempts: 1, age: 0, due: -60_000 },
                {
                  key: "exhausted",
                  status: "delivering" as const,
                  attempts: 5,
                  age: 180_000,
                  due: -60_000,
                },
                { key: "ready", status: "pending" as const, attempts: 0, age: 0, due: -60_000 },
                { key: "future", status: "pending" as const, attempts: 0, age: 0, due: 60_000 },
              ].map((item) => ({
                deliveryKey: `${topic}:${item.key}`,
                topic,
                target: "lease-qa",
                payload: {},
                status: item.status,
                attempts: item.attempts,
                updatedAt: new Date(now - item.age),
                availableAt: new Date(now + item.due),
              })),
            });
            const claimed = await claimOutboxDeliveries(tx, topic, 100);
            expect(claimed.map((item) => item.deliveryKey).sort()).toEqual([
              `${topic}:abandoned`,
              `${topic}:ready`,
            ]);
            expect(claimed.find((item) => item.deliveryKey.endsWith(":abandoned"))?.attempts).toBe(
              2
            );
            expect(await claimOutboxDeliveries(tx, topic, 100)).toEqual([]);
            const exhausted = await tx.outboxDelivery.findUniqueOrThrow({
              where: { deliveryKey: `${topic}:exhausted` },
            });
            expect(exhausted.status).toBe("failed");
            expect(exhausted.error).toMatchObject({
              message: expect.stringContaining("lease expired"),
            });
            const ready = await tx.outboxDelivery.findUniqueOrThrow({
              where: { deliveryKey: `${topic}:ready` },
            });
            expect(Math.abs(ready.updatedAt.getTime() - now)).toBeLessThan(5_000);
          });
        } finally {
          await prisma.outboxDelivery.deleteMany({ where: { topic } });
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  },
  30_000
);
