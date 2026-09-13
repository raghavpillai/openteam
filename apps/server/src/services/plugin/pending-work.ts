import type { Prisma } from "@openteam/db";

/** Removal and policy changes invalidate queued approvals before their accounts disappear. */
export async function cancelPendingPluginWork(
  tx: Prisma.TransactionClient,
  connectionIds: string[]
): Promise<void> {
  if (!connectionIds.length) return;
  const pending = await tx.pluginInvocation.findMany({
    where: { connectionId: { in: connectionIds }, status: "running", error: "Approval required" },
    select: { callId: true },
  });
  if (!pending.length) return;
  await tx.approval.updateMany({
    where: {
      status: "pending",
      upstreamRequestId: { in: pending.map(({ callId }) => `plugin:${callId}`) },
    },
    data: { status: "cancelled", decision: "cancel", resolvedAt: new Date() },
  });
  await tx.pluginInvocation.updateMany({
    where: {
      callId: { in: pending.map(({ callId }) => callId) },
      status: "running",
      error: "Approval required",
    },
    data: {
      status: "denied",
      error: "Connection access changed before approval",
      completedAt: new Date(),
    },
  });
}
