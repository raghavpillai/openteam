import {
  agentNotificationDeliveryPolicy,
  notificationApprovalReason,
  truncateNotificationText,
  type AgentNotificationPayload,
  type PushNotificationPayload,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_ATTEMPTS = 5;
const RECEIPT_DELAY_MS = 15 * 60_000;

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

export const unreadBadgeCount = async (tx: Prisma.TransactionClient): Promise<number> => {
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

export const enqueuePushNotification = async (
  tx: Prisma.TransactionClient,
  deliveryKey: string,
  payload: QueuedAgentNotificationPayload
): Promise<void> => {
  const devices = await tx.pushDevice.findMany({
    where: { enabled: true },
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
    private readonly accessToken = process.env.EXPO_ACCESS_TOKEN?.trim() || null
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
    const candidates = await this.prisma.outboxDelivery.findMany({
      where: {
        topic,
        status: { in: ["pending", "failed"] },
        attempts: { lt: MAX_ATTEMPTS },
        availableAt: { lte: new Date() },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    const claimed = [];
    for (const candidate of candidates) {
      const result = await this.prisma.outboxDelivery.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["pending", "failed"] },
          attempts: candidate.attempts,
        },
        data: { status: "delivering", attempts: { increment: 1 }, error: Prisma.DbNull },
      });
      if (result.count > 0) claimed.push({ ...candidate, attempts: candidate.attempts + 1 });
    }
    return claimed;
  }

  private async drainNotifications(): Promise<void> {
    while (true) {
      const deliveries = await this.claim("push.notification", 100);
      if (deliveries.length === 0) return;
      const devices = await this.prisma.pushDevice.findMany({
        where: { id: { in: deliveries.map((delivery) => delivery.target) }, enabled: true },
      });
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
        const response = await this.request(EXPO_SEND_URL, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(
            sendable.map(({ device, payload }) =>
              expoPushMessage(device.pushToken, payload, currentBadgeCount)
            )
          ),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Expo push request failed (${response.status})`);
        const body = (await response.json()) as { data?: PushTicket[] };
        const tickets = Array.isArray(body.data) ? body.data : [];
        await this.prisma.$transaction(async (tx) => {
          for (const [index, item] of sendable.entries()) {
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
        });
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
