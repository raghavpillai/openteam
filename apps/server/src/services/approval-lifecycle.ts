import { type Prisma, type PrismaClient } from "@openbot/db";

export const APPROVAL_ASK_TTL_MS = 10 * 60_000;

export const approvalAskExpiryCutoff = (now: Date): Date =>
  new Date(now.getTime() - APPROVAL_ASK_TTL_MS);

type ApprovalDatabase = PrismaClient | Prisma.TransactionClient;

/** A restart destroys the in-memory waiter, but keeps the historical card. */
export const expirePendingApprovalsAfterRestart = (database: ApprovalDatabase, resolvedAt: Date) =>
  database.approval.updateMany({
    where: {
      status: "pending",
      requestMethod: { not: "plugin/tool" },
    },
    data: { status: "expired", resolvedAt },
  });

/** GrokBot's ask cards settle after ten minutes instead of disappearing. */
export const expireTimedOutApprovals = (database: ApprovalDatabase, resolvedAt: Date) =>
  database.approval.updateMany({
    where: {
      status: "pending",
      requestMethod: { not: "plugin/tool" },
      createdAt: { lt: approvalAskExpiryCutoff(resolvedAt) },
    },
    data: { status: "expired", resolvedAt },
  });
