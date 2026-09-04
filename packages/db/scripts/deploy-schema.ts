import { join } from "node:path";
import { Client } from "pg";
import { applyRawSchema } from "./apply-raw-schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://openteam:openteam@127.0.0.1:5432/openteam";

const prepareSearchProjection = async (): Promise<boolean> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ is_generated: string }>(`
      SELECT is_generated
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'SearchDocument'
        AND column_name = 'searchVector'
    `);
    if (result.rows[0]?.is_generated !== "ALWAYS") return false;
    await client.query('ALTER TABLE "SearchDocument" ALTER COLUMN "searchVector" DROP EXPRESSION');
    return true;
  } finally {
    await client.end();
  }
};

const schemaWasPrepared = await prepareSearchProjection();
const prisma = Bun.spawn(
  [
    join(import.meta.dirname, "..", "node_modules", ".bin", "prisma"),
    "db",
    "push",
    "--config",
    "prisma.config.ts",
  ],
  {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }
);
const prismaStatus = await prisma.exited;

if (prismaStatus === 0 || schemaWasPrepared) await applyRawSchema();
if (prismaStatus !== 0) process.exit(prismaStatus);
