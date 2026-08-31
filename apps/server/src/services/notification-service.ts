import type { PushDeviceView, RegisterPushDeviceInput } from "@openbot/contracts";
import { ApiError } from "@openbot/contracts";
import type { Prisma, PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { appendEvent, toError } from "./service-utils";

const toView = (device: {
  installationId: string;
  platform: "ios" | "android";
  enabled: boolean;
  lastSeenAt: Date;
}): PushDeviceView => ({
  installationId: device.installationId,
  platform: device.platform,
  enabled: device.enabled,
  lastSeenAt: device.lastSeenAt.toISOString(),
});

const unreadBadgeCount = async (tx: Prisma.TransactionClient): Promise<number> => {
  const channels = await tx.channel.findMany({
    where: {
      archivedAt: null,
      members: {
        some: { bot: { hiddenFromSidebar: false, subagentIdentity: { is: null } } },
      },
    },
    select: { id: true, readState: { select: { lastReadSequence: true } } },
  });
  const readByChannel = new Map(
    channels.map((channel) => [channel.id, channel.readState?.lastReadSequence ?? 0n] as const)
  );
  const messages = await tx.channelMessage.findMany({
    where: { channelId: { in: channels.map((channel) => channel.id) }, sender: "agent" },
    select: { channelId: true, sequence: true, metadata: true },
  });
  return messages.filter((message) => {
    if (message.sequence <= (readByChannel.get(message.channelId) ?? 0n)) return false;
    const metadata =
      message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : {};
    return !("fromAgent" in metadata) && !("toAgent" in metadata);
  }).length;
};

export class NotificationService {
  constructor(private readonly prisma: PrismaClient) {}

  register = (input: RegisterPushDeviceInput) =>
    Effect.tryPromise({
      try: async () => {
        const now = new Date();
        const existingToken = await this.prisma.pushDevice.findUnique({
          where: { pushToken: input.pushToken },
          select: { installationId: true },
        });
        if (existingToken && existingToken.installationId !== input.installationId) {
          await this.prisma.pushDevice.delete({ where: { pushToken: input.pushToken } });
        }
        const device = await this.prisma.pushDevice.upsert({
          where: { installationId: input.installationId },
          create: {
            installationId: input.installationId,
            platform: input.platform,
            pushToken: input.pushToken,
            timeZone: input.timeZone,
            locale: input.locale,
            lastSeenAt: now,
          },
          update: {
            platform: input.platform,
            pushToken: input.pushToken,
            timeZone: input.timeZone,
            locale: input.locale,
            enabled: true,
            lastSeenAt: now,
          },
        });
        return toView(device);
      },
      catch: toError,
    });

  unregister = (installationId: string) =>
    Effect.tryPromise({
      try: async () => {
        const result = await this.prisma.pushDevice.updateMany({
          where: { installationId },
          data: { enabled: false },
        });
        if (result.count === 0) {
          throw new ApiError(404, "push_device_not_found", "Push device was not registered");
        }
        return { ok: true };
      },
      catch: toError,
    });

  markChannelRead = (channelId: string, throughSequence?: string) =>
    Effect.tryPromise({
      try: async () =>
        this.prisma.$transaction(async (tx) => {
          const channel = await tx.channel.findUnique({
            where: { id: channelId },
            select: { id: true },
          });
          if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
          const latest = await tx.channelMessage.findFirst({
            where: { channelId },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          });
          const latestSequence = latest?.sequence ?? 0n;
          let requested = latestSequence;
          if (throughSequence !== undefined) {
            if (!/^\d+$/.test(throughSequence)) {
              throw new ApiError(400, "invalid_sequence", "throughSequence must be an integer");
            }
            requested = BigInt(throughSequence);
          }
          const target = requested > latestSequence ? latestSequence : requested;
          const previousState = await tx.channelReadState.findUnique({ where: { channelId } });
          await tx.$executeRaw`
            INSERT INTO "ChannelReadState" ("channelId", "lastReadSequence", "createdAt", "updatedAt")
            VALUES (${channelId}::uuid, ${target}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT ("channelId") DO UPDATE SET
              "lastReadSequence" = GREATEST(
                "ChannelReadState"."lastReadSequence",
                EXCLUDED."lastReadSequence"
              ),
              "updatedAt" = CASE
                WHEN EXCLUDED."lastReadSequence" > "ChannelReadState"."lastReadSequence"
                THEN CURRENT_TIMESTAMP
                ELSE "ChannelReadState"."updatedAt"
              END
          `;
          const state = await tx.channelReadState.findUniqueOrThrow({ where: { channelId } });
          const unreadMessages = await tx.channelMessage.findMany({
            where: {
              channelId,
              sender: "agent",
              sequence: { gt: state.lastReadSequence },
            },
            select: { metadata: true },
          });
          const unreadCount = unreadMessages.filter((message) => {
            const metadata =
              message.metadata &&
              typeof message.metadata === "object" &&
              !Array.isArray(message.metadata)
                ? (message.metadata as Record<string, unknown>)
                : {};
            return !("fromAgent" in metadata) && !("toAgent" in metadata);
          }).length;
          if (!previousState || state.lastReadSequence > previousState.lastReadSequence) {
            await appendEvent(tx, "channel.read", channelId, {
              channelId,
              lastReadSequence: state.lastReadSequence.toString(),
              unreadCount,
            });
            const [badgeCount, devices] = await Promise.all([
              unreadBadgeCount(tx),
              tx.pushDevice.findMany({ where: { enabled: true }, select: { id: true } }),
            ]);
            if (devices.length > 0) {
              await tx.outboxDelivery.createMany({
                data: devices.map((device) => ({
                  deliveryKey: `notification:badge:${channelId}:${state.lastReadSequence}:${device.id}`,
                  topic: "push.notification",
                  target: device.id,
                  payload: {
                    schemaVersion: 1,
                    kind: "badge-sync",
                    badgeCount,
                  },
                })),
                skipDuplicates: true,
              });
            }
          }
          return {
            channelId,
            lastReadSequence: state.lastReadSequence.toString(),
            unreadCount,
          };
        }),
      catch: toError,
    });
}
