import { suppressMobileNotification } from "@openteam/contracts/notification-presence";
import { notificationRouting, unreadBadgeCount } from "@openteam/messaging";
import { ApnsSettingsStore } from "@openteam/db/apns-settings";
import {
  PUSH_DELIVERY_ADVISORY_LOCK,
  type PushNotificationPayload,
  isAgentNotificationKind,
  notificationIsRead,
} from "@openteam/contracts";
import { Prisma, type PrismaClient } from "@openteam/db";
import { ApnsClient } from "./apns";

const MAX_ATTEMPTS = 5;
const PUSH_DELIVERY_TRANSACTION_TIMEOUT_MS = 20_000;

type ClaimedDelivery = {
  id: string;
  deliveryKey: string;
  target: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const retryAt = (attempt: number): Date =>
  new Date(Date.now() + Math.min(5 * 60_000, 2 ** Math.max(0, attempt - 1) * 5_000));

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export type PushAuthenticationMode = "disabled" | "required";

export const pushAuthenticationModeFromEnvironment = (
  value = process.env.OPENTEAM_AUTH_MODE
): PushAuthenticationMode => (value?.trim().toLowerCase() === "disabled" ? "disabled" : "required");

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

export const pushDeviceSessionIsDeliverable = (
  device: {
    enabled: boolean;
    authRequired: boolean;
    authSession: { expiresAt: Date } | null;
  },
  authMode: PushAuthenticationMode,
  now = new Date()
): boolean =>
  device.enabled &&
  (authMode === "disabled"
    ? !device.authRequired
    : device.authRequired && Boolean(device.authSession && device.authSession.expiresAt > now));

export const claimOutboxDeliveries = async (
  client: Pick<PrismaClient, "$queryRaw">,
  topic: string,
  limit: number
): Promise<ClaimedDelivery[]> =>
  client.$queryRaw<ClaimedDelivery[]>(Prisma.sql`
    WITH candidates AS (
      SELECT delivery."id"
      FROM "OutboxDelivery" AS delivery
      WHERE delivery."topic" = ${topic}
        AND delivery."status" IN ('pending', 'failed')
        AND delivery."attempts" < ${MAX_ATTEMPTS}
        AND delivery."availableAt" <= CURRENT_TIMESTAMP
      ORDER BY delivery."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${Math.max(1, Math.min(1_000, Math.floor(limit)))}
    )
    UPDATE "OutboxDelivery" AS delivery
    SET "status" = 'delivering',
        "attempts" = delivery."attempts" + 1,
        "error" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE delivery."id" = candidates."id"
    RETURNING
      delivery."id",
      delivery."deliveryKey",
      delivery."target",
      delivery."payload",
      delivery."attempts"
  `);

type PushAttempt = { delivery: ClaimedDelivery; device: Prisma.PushDeviceGetPayload<{}>; payload: PushNotificationPayload };

export class PushNotificationDispatcher {
  private draining = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly authMode = pushAuthenticationModeFromEnvironment(),
    private readonly apns = new ApnsClient(async () => (await new ApnsSettingsStore(prisma).load()).config)
  ) {}

  async configurationStatus() {
    return new ApnsSettingsStore(this.prisma).status();
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainNotifications();
    } finally {
      this.draining = false;
    }
  }

  private async claim(topic: string, limit: number) {
    return claimOutboxDeliveries(this.prisma, topic, limit);
  }

  private async deliverableDevices(
    client: Pick<PrismaClient, "pushDevice">,
    deviceIds: readonly string[]
  ) {
    const checkedAt = new Date();
    const devices = await client.pushDevice.findMany({
      where: {
        AND: [{ id: { in: [...deviceIds] } }, deliverablePushDeviceWhere(this.authMode, checkedAt)],
      },
      include: { authSession: { select: { expiresAt: true } } },
    });
    return devices.filter((device) =>
      pushDeviceSessionIsDeliverable(device, this.authMode, checkedAt)
    );
  }

  private async drainNotifications(): Promise<void> {
    while (true) {
      const deliveries = await this.claim("push.notification", 100);
      if (deliveries.length === 0) return;
      const devices = await this.deliverableDevices(
        this.prisma,
        deliveries.map((delivery) => delivery.target)
      );
      const deviceById = new Map(devices.map((device) => [device.id, device] as const));
      const sendable = deliveries.flatMap((delivery) => {
        const device = deviceById.get(delivery.target);
        const payload = delivery.payload as unknown as PushNotificationPayload;
        if (
          !device ||
          payload.schemaVersion !== 1 ||
          !(payload.kind === "badge-sync" || isAgentNotificationKind(payload.kind))
        ) {
          return [];
        }
        return [{ delivery, device, payload }];
      });
      const skipped = deliveries.filter(
        (delivery) => !sendable.some((item) => item.delivery.id === delivery.id)
      );
      if (skipped.length > 0) {
        await this.prisma.outboxDelivery.updateMany({
          where: { id: { in: skipped.map((delivery) => delivery.id) } },
          data: { status: "delivered", deliveredAt: new Date() },
        });
      }
      if (sendable.length === 0) continue;

      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(
                ${PUSH_DELIVERY_ADVISORY_LOCK.namespace},
                ${PUSH_DELIVERY_ADVISORY_LOCK.key}
              )::text
            `;
            const currentBadgeCount = await unreadBadgeCount(tx);
            const deviceIds = sendable.map(({ delivery }) => delivery.target);
            await tx.$queryRaw(
              Prisma.sql`
                SELECT "id"
                FROM "PushDevice"
                WHERE "id"::text IN (${Prisma.join(deviceIds)})
                ORDER BY "id"
                FOR UPDATE
              `
            );
            const finalDevices = await this.deliverableDevices(tx, deviceIds);
            const finalDeviceById = new Map(
              finalDevices.map((device) => [device.id, device] as const)
            );
            const routing = sendable.some(item => item.payload.kind !== "badge-sync" && item.device.platform === "ios")
              ? await notificationRouting(tx, this.authMode) : null;
            const allowed = await Promise.all(
              sendable.map((item) => item.payload.kind !== "badge-sync" && item.device.platform === "ios" && routing && suppressMobileNotification(routing)
                ? false : this.notificationIsDeliverable(tx, item.payload))
            );
            const attempted = sendable.flatMap((item, index) => {
              const device = finalDeviceById.get(item.delivery.target);
              return device && allowed[index] ? [{ ...item, device }] : [];
            });
            const retired = sendable.filter(
              (item, index) => !finalDeviceById.has(item.delivery.target) || !allowed[index]
            );
            if (retired.length > 0) {
              await tx.outboxDelivery.updateMany({
                where: { id: { in: retired.map(({ delivery }) => delivery.id) } },
                data: { status: "delivered", deliveredAt: new Date() },
              });
            }
            if (attempted.length === 0) return;
            await this.deliver(tx, attempted, currentBadgeCount);
          },
          {
            maxWait: PUSH_DELIVERY_TRANSACTION_TIMEOUT_MS,
            timeout: PUSH_DELIVERY_TRANSACTION_TIMEOUT_MS,
          }
        );
      } catch (error) {
        for (const item of sendable) {
          await this.prisma.outboxDelivery.update({
            where: { id: item.delivery.id },
            data: {
              status: "failed",
              availableAt: retryAt(item.delivery.attempts),
              error: json({ message: errorMessage(error) }),
            },
          });
        }
      }
    }
  }

  private async deliver(tx: Prisma.TransactionClient, attempted: PushAttempt[], badgeCount: number) {
    await Promise.all(attempted.map(async item => {
      try {
        const result = await this.apns.send(item.device, item.payload, badgeCount, item.delivery.deliveryKey);
        const retired = result.status === 410 || (result.status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(result.reason ?? ""));
        if (retired) await tx.pushDevice.updateMany({ where: { id: item.device.id }, data: { enabled: false } });
        await tx.outboxDelivery.update({ where: { id: item.delivery.id }, data: {
          status: result.status === 200 || retired ? "delivered" : "failed",
          deliveredAt: result.status === 200 || retired ? new Date() : null,
          attempts: retired ? MAX_ATTEMPTS : item.delivery.attempts,
          availableAt: retryAt(item.delivery.attempts),
          error: result.status === 200 ? Prisma.DbNull : json({ message: `APNs rejected notification (${result.status})`, reason: result.reason ?? "Unknown" }),
        } });
      } catch (error) {
        await tx.outboxDelivery.update({ where: { id: item.delivery.id }, data: {
          status: "failed", availableAt: retryAt(item.delivery.attempts), error: json({ message: errorMessage(error) }),
        } });
      }
    }));
  }

  private async notificationIsDeliverable(
    tx: Prisma.TransactionClient,
    payload: PushNotificationPayload
  ): Promise<boolean> {
    if (payload.kind === "badge-sync") return true;
    const [state, bot, channel] = await Promise.all([
      tx.channelReadState.findUnique({ where: { channelId: payload.channelId } }),
      tx.bot.findUnique({ where: { id: payload.botId } }),
      tx.channel.findUnique({ where: { id: payload.channelId } }),
    ]);
    if (
      !bot?.notificationsEnabled ||
      bot.hiddenFromSidebar ||
      !channel ||
      channel.archivedAt ||
      channel.hiddenFromSidebar
    )
      return false;
    // Alerts are durable channel activity; a payload without its sequence is not deliverable.
    if (!payload.notificationSequence) return false;
    const activity = await tx.channelNotification.findUnique({
      where: { sequence: BigInt(payload.notificationSequence) },
    });
    if (!activity || activity.revoked) return false;
    return (
      !state ||
      !notificationIsRead(payload, {
        lastReadSequence: state.lastReadSequence.toString(),
        lastReadNotificationSequence: state.lastReadNotificationSequence.toString(),
      })
    );
  }
}
