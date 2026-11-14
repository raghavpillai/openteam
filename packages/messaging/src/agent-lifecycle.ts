import type { Prisma } from "@openteam/db";

/** PostgreSQL accepts several textual spellings of one UUID; locks use one key. */
export const canonicalAgentId = (value: string): string => {
  const hex = value.replace(/[{}-]/g, "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : value.toLowerCase();
};

/** New work commits before retirement takes its cancellation snapshot, or sees the retired owner. */
export const lockAgentLifecycle = (tx: Prisma.TransactionClient, botId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-lifecycle:${canonicalAgentId(botId)}`}))`;
