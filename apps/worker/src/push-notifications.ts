import {
  type AgentNotificationPayload,
  agentNotificationDeliveryPolicy,
  notificationApprovalReason,
  PUSH_DELIVERY_ADVISORY_LOCK,
  type PushNotificationPayload,
  truncateNotificationText,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { unreadBadgeCount as countUnreadMessages } from "@openbot/messaging";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_ATTEMPTS = 5;
const RECEIPT_DELAY_MS = 15 * 60_000;
const PUSH_DELIVERY_TRANSACTION_TIMEOUT_MS = 20_000;

type ClaimedDelivery = {
  id: string;
  deliveryKey: string;
  target: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

type PushTicket = {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: { error?: unknown };
};

type PushReceipt = {
  status?: unknown;
  message?: unknown;
  details?: { error?: unknown };
};

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const retryAt = (attempt: number): Date =>
  new Date(Date.now() + Math.min(5 * 60_000, 2 ** Math.max(0, attempt - 1) * 5_000));

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export const truncateNotificationBody = truncateNotificationText;

export const approvalReason = notificationApprovalReason;

type QueuedAgentNotificationPayload = Omit<AgentNotificationPayload, "badgeCount"> & {
  badgeCount?: number;
};

export const unreadBadgeCount = countUnreadMessages;

export type PushAuthenticationMode = "disabled" | "required";

export const pushAuthenticationModeFromEnvironment = (
  value = process.env.OPENBOT_AUTH_MODE
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

export const enqueuePushNotification = async (
  tx: Prisma.TransactionClient,
  deliveryKey: string,
  payload: QueuedAgentNotificationPayload,
  authMode = pushAuthenticationModeFromEnvironment()
): Promise<void> => {
  const devices = await tx.pushDevice.findMany({
    where: deliverablePushDeviceWhere(authMode),
    select: { id: true },
  });
  if (devices.length === 0) return;
  const fullPayload: AgentNotificationPayload = {
    ...payload,
    badgeCount:
      payload.badgeCount ??
      Math.max(payload.kind === "agent-needs-input" ? 1 : 0, await unreadBadgeCount(tx)),
  };
  await tx.outboxDelivery.createMany({
    data: devices.map((device) => ({
      deliveryKey: `${deliveryKey}:${device.id}`,
      topic: "push.notification",
      target: device.id,
      payload: json(fullPayload),
    })),
    skipDuplicates: true,
  });
};

export const expoPushMessage = (
  pushToken: string,
  payload: PushNotificationPayload,
  badgeCount = payload.badgeCount
) => {
  const deliveredPayload: PushNotificationPayload = { ...payload, badgeCount };
  if (payload.kind === "badge-sync") {
    return {
      to: pushToken,
      badge: Math.max(0, Math.floor(badgeCount)),
      data: deliveredPayload,
    };
  }
  const policy = agentNotificationDeliveryPolicy(payload.kind);
  return {
    to: pushToken,
    title: payload.title,
    body: truncateNotificationBody(payload.body),
    sound: policy.sound ?? undefined,
    badge: Math.max(0, Math.floor(badgeCount)),
    data: deliveredPayload,
  };
};

export class PushNotificationDispatcher {
  private draining = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly request: typeof fetch = fetch,
    private readonly accessToken = process.env.EXPO_ACCESS_TOKEN?.trim() || null,
    private readonly authMode = pushAuthenticationModeFromEnvironment()
  ) {}

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainNotifications();
      await this.drainReceipts();
    } finally {
      this.draining = false;
    }
  }

  private headers(): HeadersInit {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
    };
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
          !["agent-needs-input", "agent-done", "badge-sync"].includes(payload.kind)
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
        const currentBadgeCount = await unreadBadgeCount(
          this.prisma as unknown as Prisma.TransactionClient
        );
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(
                ${PUSH_DELIVERY_ADVISORY_LOCK.namespace},
                ${PUSH_DELIVERY_ADVISORY_LOCK.key}
              )
            `;
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
            const attempted = sendable.flatMap((item) => {
              const device = finalDeviceById.get(item.delivery.target);
              return device ? [{ ...item, device }] : [];
            });
            const retired = sendable.filter((item) => !finalDeviceById.has(item.delivery.target));
            if (retired.length > 0) {
              await tx.outboxDelivery.updateMany({
                where: { id: { in: retired.map(({ delivery }) => delivery.id) } },
                data: { status: "delivered", deliveredAt: new Date() },
              });
            }
            if (attempted.length === 0) return;
            const response = await this.request(EXPO_SEND_URL, {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify(
                attempted.map(({ device, payload }) =>
                  expoPushMessage(device.pushToken, payload, currentBadgeCount)
                )
              ),
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
            const body = (await response.json()) as { data?: PushTicket[] };
            const tickets = Array.isArray(body.data) ? body.data : [];
            for (const [index, item] of attempted.entries()) {
              const ticket = tickets[index];
              const deviceError = ticket?.details?.error === "DeviceNotRegistered";
              if (deviceError) {
                await tx.pushDevice.updateMany({
                  where: { id: item.device.id },
                  data: { enabled: false },
                });
              }
              if (ticket?.status !== "ok" || typeof ticket.id !== "string") {
                await tx.outboxDelivery.update({
                  where: { id: item.delivery.id },
                  data: {
                    status: deviceError ? "delivered" : "failed",
                    attempts: deviceError ? MAX_ATTEMPTS : item.delivery.attempts,
                    deliveredAt: deviceError ? new Date() : null,
                    availableAt: retryAt(item.delivery.attempts),
                    error: json({
                      message:
                        typeof ticket?.message === "string"
                          ? ticket.message
                          : "Expo did not return a push ticket",
                      details: ticket?.details ?? null,
                    }),
                  },
                });
                continue;
              }
              await tx.outboxDelivery.update({
                where: { id: item.delivery.id },
                data: { status: "delivered", deliveredAt: new Date(), error: Prisma.DbNull },
              });
              await tx.outboxDelivery.createMany({
                data: {
                  deliveryKey: `${item.delivery.deliveryKey}:receipt`,
                  topic: "push.receipt",
                  target: item.device.id,
                  payload: json({ ticketId: ticket.id }),
                  availableAt: new Date(Date.now() + RECEIPT_DELAY_MS),
                },
                skipDuplicates: true,
              });
            }
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

  private async drainReceipts(): Promise<void> {
    while (true) {
      const deliveries = await this.claim("push.receipt", 1_000);
      if (deliveries.length === 0) return;
      const ticketIds = deliveries.flatMap((delivery) => {
        const payload = delivery.payload as { ticketId?: unknown };
        return typeof payload.ticketId === "string" ? [payload.ticketId] : [];
      });
      if (ticketIds.length === 0) {
        await this.prisma.outboxDelivery.updateMany({
          where: { id: { in: deliveries.map((delivery) => delivery.id) } },
          data: { status: "delivered", deliveredAt: new Date() },
        });
        continue;
      }
      try {
        const response = await this.request(EXPO_RECEIPTS_URL, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ ids: ticketIds }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Expo receipt request failed (${response.status})`);
        const body = (await response.json()) as { data?: Record<string, PushReceipt> };
        const receipts = body.data ?? {};
        await this.prisma.$transaction(async (tx) => {
          for (const delivery of deliveries) {
            const payload = delivery.payload as { ticketId?: unknown };
            const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : "";
            const receipt = receipts[ticketId];
            if (!receipt) {
              await tx.outboxDelivery.update({
                where: { id: delivery.id },
                data: {
                  status: "failed",
                  availableAt: retryAt(delivery.attempts),
                  error: json({ message: "Expo receipt is not ready" }),
                },
              });
              continue;
            }
            const deviceError = receipt.details?.error === "DeviceNotRegistered";
            if (deviceError) {
              await tx.pushDevice.updateMany({
                where: { id: delivery.target },
                data: { enabled: false },
              });
            }
            await tx.outboxDelivery.update({
              where: { id: delivery.id },
              data: {
                status: "delivered",
                deliveredAt: new Date(),
                error:
                  receipt.status === "ok"
                    ? Prisma.DbNull
                    : json({
                        message: receipt.message ?? "Push receipt failed",
                        details: receipt.details,
                      }),
              },
            });
          }
        });
      } catch (error) {
        for (const delivery of deliveries) {
          await this.prisma.outboxDelivery.update({
            where: { id: delivery.id },
            data: {
              status: "failed",
              availableAt: retryAt(delivery.attempts),
              error: json({ message: errorMessage(error) }),
            },
          });
        }
      }
    }
  }
}
