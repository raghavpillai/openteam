import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Apply the database objects Prisma's schema language cannot express.
 *
 * `prisma db push` owns everything declared in schema.prisma; this adds the search
 * projection, its trigger functions, and the constraints Prisma does not model. The
 * SQL is idempotent, so this runs after every push and is a no-op once applied.
 */
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://openteam:openteam@127.0.0.1:5432/openteam";

const sql = await readFile(
  join(import.meta.dirname, "..", "prisma", "sql", "raw-schema.sql"),
  "utf8"
);

export const applyRawSchema = async (): Promise<void> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Applied raw schema objects");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
};

if (import.meta.main) await applyRawSchema();
