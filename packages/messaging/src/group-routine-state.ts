import type { Prisma } from "@openteam/db";

/** Include late worker continuations and the peer rounds their results start. */
export async function groupRoutineState(tx: Prisma.TransactionClient, rootMessageId: string) {
  const root = await tx.channelMessage.findUnique({
    where: { id: rootMessageId },
    select: { channelId: true },
  });
  if (!root) return { active: false, failed: true, completedAt: null };
  const resultRoots = await tx.channelMessage.findMany({
    where: {
      channelId: root.channelId,
      metadata: { path: ["routineRootMessageId"], equals: rootMessageId },
    },
    select: { id: true },
  });
  const roots = [rootMessageId, ...resultRoots.map((message) => message.id)];
  const rounds = await tx.channelRound.findMany({
    where: { rootMessageId: { in: roots } },
    include: { deliveries: { include: { run: { select: { id: true } } } } },
  });
  const currentSourceIds = rounds.flatMap((round) =>
    round.deliveries.flatMap((delivery) => (delivery.run ? [delivery.run.id] : []))
  );
  const deliveryIds = rounds.flatMap(round => round.deliveries.map(delivery => delivery.id));
  const priorAttempts = deliveryIds.length ? await tx.run.findMany({ where: { channelId: root.channelId, origin: "group",
    inboxEvents: { some: { OR: deliveryIds.map(id => ({ payload: { path: ["deliveryId"], equals: id } })) } } }, select: { id: true } }) : [];
  const sourceIds = [...new Set([...currentSourceIds, ...priorAttempts.map(run => run.id)])];
  const continuations = sourceIds.length
    ? await tx.run.findMany({
        where: {
          channelId: root.channelId,
          inboxEvents: {
            some: {
              OR: sourceIds.map((id) => ({ payload: { path: ["taskContextRunId"], equals: id } })),
            },
          },
        },
        select: { id: true, status: true, completedAt: true },
      })
    : [];
  const family = [...sourceIds, ...continuations.map((run) => run.id)];
  const children = family.length
    ? await tx.subagentAttempt.findMany({
        where: { parentRunId: { in: family } },
        orderBy: { createdAt: "desc" },
        distinct: ["subagentId"],
        select: { status: true, completedAt: true },
      })
    : [];
  const deliveries = rounds.flatMap((round) => round.deliveries);
  const completedTimes = [...rounds, ...continuations, ...children].flatMap(item => item.completedAt ? [item.completedAt.getTime()] : []);
  return {
    completedAt: completedTimes.length ? new Date(Math.max(...completedTimes)) : null,
    active:
      rounds.some((round) => ["queued", "running"].includes(round.status)) ||
      continuations.some((run) => ["queued", "running", "waiting_approval"].includes(run.status)) ||
      children.some((child) => ["provisioning", "queued", "running"].includes(child.status)),
    failed:
      rounds.some((round) => round.status === "failed") ||
      deliveries.some((delivery) => delivery.status === "failed") ||
      (deliveries.length > 0 && deliveries.every((delivery) => delivery.status === "skipped")) ||
      continuations.some((run) => ["failed", "cancelled"].includes(run.status)) ||
      children.some((child) => ["failed", "stopped"].includes(child.status)),
  };
}
