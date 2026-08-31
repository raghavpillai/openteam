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
    },
    data: { status: "expired", resolvedAt },
  });

/** Background/non-interactive asks expire; approvals parked in a live user turn have no TTL. */
export const expireTimedOutApprovals = (database: ApprovalDatabase, resolvedAt: Date) =>
  database.approval.updateMany({
    where: {
      status: "pending",
      createdAt: { lt: approvalAskExpiryCutoff(resolvedAt) },
      run: {
        origin: {
          in: [
            "routine",
            "group",
            "bootstrap",
            "event",
            "background_revival",
            "handoff_resume",
            "broadcast",
          ],
        },
      },
    },
    data: { status: "expired", resolvedAt },
  });
