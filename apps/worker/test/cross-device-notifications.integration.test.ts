import { generateKeyPairSync } from "node:crypto";
import { ApnsClient } from "../src/apns";
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
import {
  DesktopNotificationManager,
  NOTIFICATION_DELIVERY_DELAY_MS,
} from "../../desktop/src/main/notifications";
import { PushNotificationDispatcher } from "../src/push-notifications";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "messages and old-message reactions fan out, synchronize reads, and cancel stale alerts",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    // Other integration files may leave durable unread channels in this test DB.
    const initialBadgeCount = await unreadBadgeCount(prisma);
    const previousAuth = process.env.OPENTEAM_AUTH_MODE;
    process.env.OPENTEAM_AUTH_MODE = "disabled";
    const bot = await prisma.bot.create({
      data: { name: "Notification QA", icon: "pod", color: "#ff6600", defaultDirectory: "/tmp/notification-qa", status: "active" },
    });
    const channel = await prisma.channel.create({
      data: {
        kind: "bot_dm",
        name: "Notification QA",
        members: { create: { botId: bot.id, ordinal: 0 } },
      },
    });
    const installationIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const native: Array<{headers: Record<string, string>; payload: any}> = [];
    const signingKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const apns = new ApnsClient({ keyId: "QA", teamId: "QA", topic: "dev.openteam.mobile.swift", privateKey: signingKey }, async (_, headers, body) => {
      native.push({headers, payload: JSON.parse(body)}); return {status: 200};
    });
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
    const dispatcher = new PushNotificationDispatcher(prisma, "disabled", apns);
    const pushes = (kind: string) => native.filter((push) => push.payload.data.kind === kind);
    const state = async () =>
      (await channelNotificationStates(prisma, [channel.id])).get(channel.id)!;
    const sync = async () => {
      const current = await state();
      const unreadCount =
        (await unreadChannelCount(prisma, channel.id, BigInt(current.lastReadSequence))) +
        current.activityUnreadCount;
      manager.sync({ channels: [{ ...current, unreadCount }] });
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
      for (const [index, installationId] of installationIds.entries()) {
        await Effect.runPromise(
          service.register(
            {
              installationId,
              platform: "ios",
              provider: "apns",
              pushToken: ["ab", "bc", "de"][index]!.repeat(32),
              apnsEnvironment: index ? "production" : "development",
              apnsTopic: "dev.openteam.mobile.swift",
              notificationScope: "cd".repeat(32),
            },
            { mode: "disabled" }
          )
        );
      }
      await sync();
      const userMessage = await prisma.channelMessage.create({
        data: {
          channelId: channel.id,
          sender: "user",
          content: "Please check",
          metadata: { address: "t0u" },
        },
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
      expect(delivered).toHaveLength(0);
      await Bun.sleep(NOTIFICATION_DELIVERY_DELAY_MS + 25);
      expect(delivered).toHaveLength(1);
      expect(await prisma.channelNotification.count({ where: { channelId: channel.id } })).toBe(1);
      expect(await prisma.outboxDelivery.count({ where: { topic: "push.notification" } })).toBe(3);

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
      const messagePushes = pushes("message");
      expect(messagePushes.map((push) => push.payload.data.messageSequence)).toEqual(
        installationIds.map(() => second.sequence.toString())
      );
      expect(new Set(messagePushes.map((push) => push.headers[":path"])).size).toBe(3);

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
        message_address: "t0u",
        emoji: "👍",
      });
      await messaging.reactToMessage(reactionContext, {
        message_address: "t0u",
        emoji: "👍",
      });
      const reactionState = await sync();
      expect(reactionState.activityUnreadCount).toBe(1);
      expect(reactionState.notifications[0]?.kind).toBe("reaction");
      expect(await unreadBadgeCount(prisma)).toBe(initialBadgeCount + 1);
      await drain();
      expect(pushes("reaction")).toHaveLength(3);
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
      expect(await unreadBadgeCount(prisma)).toBe(initialBadgeCount);
      expect(dismissed).toEqual(delivered);
      await drain();
      const nativeRead = pushes("badge-sync").at(-1)!;
      expect(nativeRead.headers["apns-push-type"]).toBe("background");
      expect(nativeRead.payload.aps).toEqual({ "content-available": 1 });
      expect(nativeRead.payload.data).toMatchObject({
        badgeCount: initialBadgeCount,
        readState: {
          channelId: channel.id,
          lastReadSequence: second.sequence.toString(),
          lastReadNotificationSequence: reactionState.notificationCursor,
        },
      });
      const snapshot = await Effect.runPromise(service.snapshot());
      expect(snapshot.badgeCount).toBe(initialBadgeCount);
      expect(snapshot.readStates).toContainEqual(nativeRead.payload.data.readState);
      await messaging.reactToMessage(
        { ...context, callId: crypto.randomUUID() },
        { message_address: "t0u", emoji: "🔔" }
      );
      await messaging.reactToMessage(
        { ...context, callId: crypto.randomUUID() },
        { message_address: "t0u", emoji: "🔔" }
      );
      await drain();
      expect(pushes("reaction")).toHaveLength(3);
      expect(await unreadBadgeCount(prisma)).toBe(initialBadgeCount);
    } finally {
      manager.clear();
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
