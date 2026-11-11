import type { Prisma } from "@openteam/db";

/** New work commits before retirement takes its cancellation snapshot, or sees the retired owner. */
export const lockAgentLifecycle = (tx: Prisma.TransactionClient, botId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-lifecycle:${botId}`}))`;
