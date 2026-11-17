import { PrismaPg } from "@prisma/adapter-pg";
import { Context, Effect, Layer } from "effect";
import { PrismaClient } from "./generated/prisma/client";

export interface DatabaseService {
  readonly client: PrismaClient;
}

export class Database extends Context.Tag("@openteam/Database")<Database, DatabaseService>() {}

/**
 * Prisma's defaults give an interactive transaction 5 s to finish and 2 s to get a
 * connection. A busy host (a burst of routines, a shared Docker VM, a stalled database)
 * exceeds that without anything being wrong, and the transaction that settles a turn
 * which already ran fails, losing its result. These bounds still end a wedged transaction.
 */
export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export const createPrismaClient = (databaseUrl = process.env.DATABASE_URL): PrismaClient => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter, transactionOptions: TRANSACTION_OPTIONS });
};

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.acquireRelease(
    Effect.sync(() => ({ client: createPrismaClient() })),
    ({ client }) => Effect.promise(() => client.$disconnect())
  )
);
