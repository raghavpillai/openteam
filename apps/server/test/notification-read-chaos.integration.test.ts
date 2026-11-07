import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { NotificationService } from "../src/services/notification-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("concurrent, duplicated and stale reads preserve newer messages and reactions", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const bot = await prisma.bot.create({ data: { name: "Notification chaos QA", defaultDirectory: "/tmp/notification-chaos" } });
  const channelIds: string[] = [];
  const installationId = crypto.randomUUID();
  try {
    const device = await prisma.pushDevice.create({ data: {
      installationId, platform: "ios", provider: "apns", pushToken: "ab".repeat(32),
      apnsEnvironment: "development", apnsTopic: "dev.openteam.mobile.swift",
      notificationScope: "cd".repeat(32), authRequired: false,
    } });
    for (let index = 0; index < 2; index++) {
      const channel = await prisma.channel.create({ data: {
        kind: "bot_dm", name: `Notification chaos ${index}`,
        members: { create: { botId: bot.id, ordinal: 0 } },
      } });
      channelIds.push(channel.id);
      await prisma.channelMessage.createMany({ data: Array.from({ length: 12 }, (_, message) => ({
        channelId: channel.id, sender: "agent" as const, senderBotId: bot.id, content: `Reply ${message}`,
      })) });
      await prisma.channelNotification.createMany({ data: Array.from({ length: 7 }, () => ({
        key: crypto.randomUUID(), channelId: channel.id, botId: bot.id, kind: "reaction", payload: {},
      })) });
    }
    const service = new NotificationService(prisma, "disabled");
    const messages = await prisma.channelMessage.findMany({ where: { channelId: channelIds[0] }, orderBy: { sequence: "asc" } });
    const reactions = await prisma.channelNotification.findMany({ where: { channelId: channelIds[0] }, orderBy: { sequence: "asc" } });
    const targetMessage = messages[7].sequence.toString();
    const targetActivity = reactions[3].sequence.toString();
    // Reordered requests overlap and contain duplicates. None acknowledges the
    // newest four replies or three reactions in this chat.
    await Promise.all(Array.from({ length: 40 }, (_, index) => Effect.runPromise(service.markChannelRead(
      channelIds[0], messages[index % 8].sequence.toString(), reactions[index % 4].sequence.toString(),
    ))));
    const persisted = await prisma.channelReadState.findUniqueOrThrow({ where: { channelId: channelIds[0] } });
    expect(persisted.lastReadSequence.toString()).toBe(targetMessage);
    expect(persisted.lastReadNotificationSequence.toString()).toBe(targetActivity);
    expect(await prisma.channelReadState.findUnique({ where: { channelId: channelIds[1] } })).toBeNull();
    const snapshot = await Effect.runPromise(service.snapshot());
    expect(snapshot.badgeCount).toBe(26); // Seven unread in the first chat, nineteen in the second.
    const eventCount = await prisma.event.count({ where: { topic: "channel.read", entityId: channelIds[0] } });
    const outboxCount = await prisma.outboxDelivery.count({ where: { target: device.id } });
    expect(eventCount).toBeGreaterThan(0);
    expect(outboxCount).toBeGreaterThan(0);
    await Promise.all(Array.from({ length: 20 }, () => Effect.runPromise(service.markChannelRead(channelIds[0], targetMessage, targetActivity))));
    expect(await prisma.event.count({ where: { topic: "channel.read", entityId: channelIds[0] } })).toBe(eventCount);
    expect(await prisma.outboxDelivery.count({ where: { target: device.id } })).toBe(outboxCount);
    await expect(Effect.runPromise(service.markChannelRead(channelIds[0], "-1", "0"))).rejects.toThrow();
    // An excessive cursor is bounded by stored content. A later reply remains unread.
    await Effect.runPromise(service.markChannelRead(channelIds[0], "999999999999999999", "999999999999999999"));
    const next = await prisma.channelMessage.create({ data: {
      channelId: channelIds[0], sender: "agent", senderBotId: bot.id, content: "Arrived after the read",
    } });
    const stale = await Effect.runPromise(service.markChannelRead(channelIds[0], targetMessage, targetActivity));
    expect(stale.lastReadSequence).toBe(messages.at(-1)!.sequence.toString());
    expect(stale.unreadCount).toBe(1);
    expect(BigInt(stale.lastReadSequence)).toBeLessThan(next.sequence);
    const deliveries = await prisma.outboxDelivery.findMany({ where: { target: device.id } });
    expect(deliveries.every(delivery => (delivery.payload as { kind: string }).kind === "badge-sync")).toBe(true);
  } finally {
    const devices = await prisma.pushDevice.findMany({ where: { installationId }, select: { id: true } });
    await prisma.outboxDelivery.deleteMany({ where: { target: { in: devices.map(device => device.id) } } });
    await prisma.event.deleteMany({ where: { entityId: { in: channelIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
    await prisma.pushDevice.deleteMany({ where: { installationId } });
    await prisma.bot.delete({ where: { id: bot.id } });
    await prisma.$disconnect();
  }
}, 30_000);
