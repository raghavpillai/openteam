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
import { PushNotificationDispatcher } from "../src/push-notifications";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "messages and old-message reactions fan out, synchronize reads, and cancel stale alerts",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const previousAuth = process.env.OPENTEAM_AUTH_MODE;
    process.env.OPENTEAM_AUTH_MODE = "disabled";
    const bot = await prisma.bot.create({
      data: { name: "Notification QA", icon: "pod", color: "#ff6600", defaultDirectory: "/tmp/notification-qa" },
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
