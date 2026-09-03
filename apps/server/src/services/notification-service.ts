import {
  ApiError,
  PUSH_DELIVERY_ADVISORY_LOCK,
  type PushDeviceView,
  type RegisterPushDeviceInput,
} from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import { unreadBadgeCount, unreadChannelCount } from "@openteam/messaging";
import { Effect } from "effect";
import { appendEvent, toError } from "./service-utils";

const PUSH_DELIVERY_LOCK_TIMEOUT_MS = 20_000;

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

export type PushRegistrationAuthentication =
  | { mode: "disabled" }
  | { mode: "required"; sessionId: string };
export type PushAuthenticationMode = PushRegistrationAuthentication["mode"];

export const deliverablePushDeviceWhere = (
  authMode: PushAuthenticationMode,
  now = new Date()
): Prisma.PushDeviceWhereInput =>
  authMode === "disabled"
    ? { enabled: true, authRequired: false }
    : {
        enabled: true,
        authRequired: true,
        authSession: { is: { expiresAt: { gt: now } } },
      };

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authMode: PushAuthenticationMode = "required"
  ) {}

  register = (input: RegisterPushDeviceInput, authentication: PushRegistrationAuthentication) =>
    Effect.tryPromise({
      try: async () => {
        if (authentication.mode !== this.authMode) {
          throw new ApiError(
            409,
            "auth_mode_changed",
            "Refresh authentication before registering this push device"
          );
        }
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
            authRequired: authentication.mode === "required",
            authSessionId: authentication.mode === "required" ? authentication.sessionId : null,
            timeZone: input.timeZone,
            locale: input.locale,
            lastSeenAt: now,
          },
          update: {
            platform: input.platform,
            pushToken: input.pushToken,
            authRequired: authentication.mode === "required",
            authSessionId: authentication.mode === "required" ? authentication.sessionId : null,
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

  disableForSession = (sessionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const result = await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(
                ${PUSH_DELIVERY_ADVISORY_LOCK.namespace},
                ${PUSH_DELIVERY_ADVISORY_LOCK.key}
              )
            `;
            return tx.pushDevice.updateMany({
              where: { authRequired: true, authSessionId: sessionId, enabled: true },
              data: { enabled: false },
            });
          },
          {
            maxWait: PUSH_DELIVERY_LOCK_TIMEOUT_MS,
            timeout: PUSH_DELIVERY_LOCK_TIMEOUT_MS,
          }
        );
        return { disabledCount: result.count };
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
          const unreadCount = await unreadChannelCount(tx, channelId, state.lastReadSequence);
          if (!previousState || state.lastReadSequence > previousState.lastReadSequence) {
            await appendEvent(tx, "channel.read", channelId, {
              channelId,
              lastReadSequence: state.lastReadSequence.toString(),
              unreadCount,
            });
            const [badgeCount, devices] = await Promise.all([
              unreadBadgeCount(tx),
              tx.pushDevice.findMany({
                where: deliverablePushDeviceWhere(this.authMode),
                select: { id: true },
              }),
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
