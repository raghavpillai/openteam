import type { Prisma } from "@openteam/db";

/** A Task must either commit before deletion takes its child snapshot, or see the retired parent. */
export const lockAgentLifecycle = (tx: Prisma.TransactionClient, botId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-lifecycle:${botId}`}))`;
