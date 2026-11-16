import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export const createPrismaClient = (databaseUrl = process.env.DATABASE_URL): PrismaClient => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
};
