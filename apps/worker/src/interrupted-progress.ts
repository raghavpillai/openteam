import type { Prisma } from "@openteam/db";

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export async function finalizeInterruptedItems(tx: Prisma.TransactionClient, runId: string, cancelled: boolean): Promise<void> {
  const items = await tx.runItem.findMany({ where: { runId, OR: [
    { status: { in: ["pending", "running"] } },
    // turn.completed may have finalized the row before the worker observed the
    // failure, while its streamed content still says inProgress.
    { status: { in: ["failed", "cancelled"] }, content: { path: ["status"], equals: "inProgress" } },
  ] } });
  for (const item of items) {
    const status = cancelled ? "cancelled" : "failed";
    const content = { ...object(item.content), status, interruption: "Run ended before this item returned; its outcome is unverified." };
    await tx.runItem.update({ where: { id: item.id }, data: { status, completedAt: new Date(), content } });
    await tx.event.create({ data: { topic: "run_item.completed", entityId: runId, payload: { runId, upstreamItemId: item.upstreamItemId, item: content } } });
  }
}
