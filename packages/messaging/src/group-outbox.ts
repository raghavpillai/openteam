import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import type { Prisma } from "@openteam/db";
import { GROUP_MAX_MEMBER_TURNS, GROUP_MAX_MESSAGES_PER_TURN } from "./group-routing";
import { nextMessageAddress } from "./message-address";
import { publishMessageNotification } from "./notifications";

const scopeFor = (deliveryId: string, runId: string) => `group-outbox:${deliveryId}:${runId}`;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type BufferedMessage = {
  id: string;
  callId: string;
  ordinal: number;
  content: string;
  metadata: Record<string, unknown>;
};

/** The reference budget is delivered messages, including several from one turn. */
export async function groupMessageCount(
  tx: Prisma.TransactionClient,
  channelId: string,
  rootMessageId: string
) {
  return tx.channelMessage.count({
    where: {
      channelId,
      sender: "agent",
      OR: [
        { metadata: { path: ["groupRootMessageId"], equals: rootMessageId } },
        { sourceRun: { delivery: { round: { rootMessageId } } } },
      ],
    },
  });
}

/** Persist the outbox without publishing transcript rows or notifications. */
export async function stageGroupMessage(
  tx: Prisma.TransactionClient,
  context: { deliveryId: string; runId: string; botId: string; channelId: string; callId: string },
  message: { content: string; metadata: Record<string, unknown> },
  limitNotice: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-outbox:${context.deliveryId}`}))`;
  const delivery = await tx.channelDelivery.findUnique({
    where: { id: context.deliveryId },
    include: { run: true, round: true },
  });
  if (
    !delivery ||
    delivery.botId !== context.botId ||
    delivery.round.channelId !== context.channelId ||
    delivery.run?.id !== context.runId ||
    !["queued", "running"].includes(delivery.run.status) ||
    !["queued", "processing"].includes(delivery.status)
  ) {
    throw new ApiError(409, "group_turn_inactive", "This room turn is no longer active");
  }
  const scope = scopeFor(delivery.id, context.runId);
  const existing = await tx.idempotencyRecord.findUnique({
    where: { scope_key: { scope, key: context.callId } },
  });
  const requestHash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This message call was already used with different content"
      );
    return existing.response as unknown as BufferedMessage;
  }
  const count = await tx.idempotencyRecord.count({ where: { scope, status: "processing" } });
  if (count >= GROUP_MAX_MESSAGES_PER_TURN)
    throw new ApiError(409, "group_response_already_sent", limitNotice);
  const buffered: BufferedMessage = {
    id: randomUUID(),
    callId: context.callId,
    ordinal: count,
    ...message,
  };
  await tx.idempotencyRecord.create({
    data: {
      scope,
      key: context.callId,
      requestHash,
      response: json(buffered),
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    },
  });
  return buffered;
}

/** Called under the delivery lock. A crash can replay this without another post. */
export async function settleGroupOutbox(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  publish: boolean
) {
  const delivery = await tx.channelDelivery.findUnique({
    where: { id: deliveryId },
    include: { run: true, round: true },
  });
  if (!delivery?.run) return [];
  const scope = scopeFor(deliveryId, delivery.run.id);
  const entries = await tx.idempotencyRecord.findMany({ where: { scope, status: "processing" } });
  entries.sort(
    (a, b) =>
      (a.response as unknown as BufferedMessage).ordinal -
      (b.response as unknown as BufferedMessage).ordinal
  );
  const messages = [];
  const count = await groupMessageCount(tx, delivery.round.channelId, delivery.round.rootMessageId);
  const channel = await tx.channel.findFirst({
    where: {
      id: delivery.round.channelId,
      archivedAt: null,
      members: { some: { botId: delivery.botId, bot: { status: "active" } } },
    },
  });
  const remaining = publish && channel ? Math.max(0, GROUP_MAX_MEMBER_TURNS - count) : 0;
  const createdAt = new Date();
  for (const [index, entry] of entries.entries()) {
    const buffered = entry.response as unknown as BufferedMessage;
    if (index < remaining) {
      const address = await nextMessageAddress(tx, delivery.round.channelId, "agent");
      const message = await tx.channelMessage.create({
        data: {
          id: buffered.id,
          channelId: delivery.round.channelId,
          sender: "agent",
          senderBotId: delivery.botId,
          sourceRunId: delivery.run.id,
          clientId: `tool:${buffered.callId}`,
          content: buffered.content,
          createdAt,
          metadata: json({
            ...buffered.metadata,
            address,
            groupRootMessageId: delivery.round.rootMessageId,
          }),
        },
      });
      await publishMessageNotification(tx, message);
      messages.push(message);
    }
    await tx.idempotencyRecord.update({
      where: { scope_key: { scope, key: entry.key } },
      data: { status: "completed" },
    });
  }
  if (messages.length)
    await tx.channel.update({
      where: { id: delivery.round.channelId },
      data: { updatedAt: createdAt },
    });
  return messages;
}
