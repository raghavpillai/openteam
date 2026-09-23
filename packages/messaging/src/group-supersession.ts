import type { Prisma } from "@openteam/db";
import { settleGroupOutbox } from "./group-outbox";

// Use the same lock before advancing, publishing, or accepting a new room turn.
// In particular, acquire it before the transcript-address and delivery locks.
export async function lockGroupExecution(tx: Prisma.TransactionClient, channelId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-execution:${channelId}`}))`;
}

export async function lockGroupRound(tx: Prisma.TransactionClient, roundId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('group-execution:' || "channelId"::text))
    FROM "ChannelRound" WHERE id = ${roundId}::uuid`;
}

export async function lockGroupDelivery(tx: Prisma.TransactionClient, deliveryId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('group-execution:' || r."channelId"::text))
    FROM "ChannelDelivery" d JOIN "ChannelRound" r ON r.id = d."roundId"
    WHERE d.id = ${deliveryId}::uuid`;
}

/** A newer user message replaces unfinished user turns, retaining their input history. */
export async function supersedeGroupUserTurns(
  tx: Prisma.TransactionClient,
  channelId: string,
  replacementMessageId: string
) {
  await lockGroupExecution(tx, channelId);
  const replacement = await tx.channelMessage.findUniqueOrThrow({
    where: { id: replacementMessageId },
    select: { sequence: true },
  });
  const rounds = await tx.channelRound.findMany({
    where: { channelId, status: { in: ["queued", "running"] } },
    include: { deliveries: { include: { run: true } } },
  });
  const roots = await tx.channelMessage.findMany({
    where: {
      channelId,
      id: { in: rounds.map((round) => round.rootMessageId) },
      sender: "user",
      sequence: { lt: replacement.sequence },
      routineExecution: { is: null },
    },
    select: { id: true },
  });
  const replacedRoots = new Set(roots.map((root) => root.id));
  const runIds: string[] = [];
  const completedAt = new Date();
  const error = {
    code: "group_user_superseded",
    message: "A newer user message replaced this room turn",
    replacementMessageId,
  };
  for (const round of rounds) {
    if (!replacedRoots.has(round.rootMessageId)) continue;
    for (const delivery of round.deliveries) {
      if (!["pending", "queued", "processing"].includes(delivery.status)) continue;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`delivery:${delivery.id}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`group-outbox:${delivery.id}`}))`;
      await settleGroupOutbox(tx, delivery.id, false);
      if (delivery.run) {
        await tx.run.update({
          where: { id: delivery.run.id },
          data: { status: "cancelled", completedAt, error },
        });
        await tx.inboxEvent.updateMany({
          where: { runId: delivery.run.id, status: { in: ["pending", "processing"] } },
          data: { status: "completed", completedAt, error },
        });
        await tx.approval.updateMany({
          where: { runId: delivery.run.id, status: "pending" },
          data: { status: "expired", resolvedAt: completedAt },
        });
        runIds.push(delivery.run.id);
      }
      await tx.channelDelivery.update({
        where: { id: delivery.id },
        data: { status: "skipped", completedAt, error },
      });
    }
    await tx.channelRound.update({
      where: { id: round.id },
      data: { status: "completed", completedAt },
    });
    await tx.event.create({
      data: {
        topic: "channel.round.superseded",
        entityId: round.id,
        payload: { channelId, roundId: round.id, replacementMessageId },
      },
    });
  }
  return runIds;
}
