import { PrismaPg } from "@prisma/adapter-pg";
import { Context, Effect, Layer } from "effect";
import { PrismaClient } from "./generated/prisma/client";

export interface DatabaseService {
  readonly client: PrismaClient;
}

export class Database extends Context.Tag("@openbot/Database")<Database, DatabaseService>() {}

export const createPrismaClient = (databaseUrl = process.env.DATABASE_URL): PrismaClient => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
};

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.acquireRelease(
    Effect.sync(() => ({ client: createPrismaClient() })),
    ({ client }) => Effect.promise(() => client.$disconnect())
  )
);
