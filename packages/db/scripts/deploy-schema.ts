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

// db push without --accept-data-loss refuses to drop storage that still holds values, so
// storage the app no longer has is dropped here first. Every statement is a no-op once done.
const RETIRE_UNUSED_STORAGE = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'ContextPromptSnapshot' AND column_name = 'memoryAudienceKey') THEN
    -- Frozen memory from the old prompt layout re-renders once.
    UPDATE "ContextPromptSnapshot" SET "promptSections" = "promptSections" - 'memory';
    UPDATE "AgentPromptSnapshot" SET "promptSections" = "promptSections" - 'memory';
  END IF;
  IF to_regclass('"Subagent"') IS NOT NULL THEN
    UPDATE "Subagent" SET "subagentType" = 'computerUse' WHERE "subagentType" = 'browserUse';
    UPDATE "Subagent" SET "taskConfiguration" = "taskConfiguration" - 'combinedComputerUse'
      WHERE "taskConfiguration" ? 'combinedComputerUse';
  END IF;
  IF to_regclass('"Run"') IS NOT NULL THEN
    UPDATE "Run" SET "taskConfiguration" = "taskConfiguration" - 'combinedComputerUse'
      WHERE "taskConfiguration" ? 'combinedComputerUse';
  END IF;
  IF to_regclass('"TaskSettings"') IS NOT NULL THEN
    UPDATE "TaskSettings" SET "configuration" = "configuration" - 'combinedComputerUse'
      WHERE "configuration" ? 'combinedComputerUse';
  END IF;
  IF to_regclass('"PluginInstallation"') IS NOT NULL THEN
    -- An installed package that named browserUse becomes the rollback target after its update,
    -- and rollback validates skill agents.
    UPDATE "PluginInstallation" SET "manifest" = jsonb_set("manifest", '{skills}', (
      SELECT jsonb_agg(CASE WHEN skill->'agents' ? 'browserUse'
        THEN jsonb_set(skill, '{agents}', ((skill->'agents') - 'browserUse')
          || CASE WHEN skill->'agents' ? 'computerUse' THEN '[]'::jsonb ELSE '["computerUse"]'::jsonb END)
        ELSE skill END ORDER BY position)
      FROM jsonb_array_elements("manifest"->'skills') WITH ORDINALITY AS skills(skill, position)))
    WHERE "manifest" @> '{"skills":[{"agents":["browserUse"]}]}';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typnamespace = current_schema()::regnamespace AND t.typname = 'MemoryScope'
        AND e.enumlabel NOT IN ('agent', 'user')) THEN
    DELETE FROM "MemoryFact" WHERE "scope"::text NOT IN ('agent', 'user');
    ALTER TYPE "MemoryScope" RENAME TO "MemoryScope_retired";
    CREATE TYPE "MemoryScope" AS ENUM ('agent', 'user');
    ALTER TABLE "MemoryFact" ALTER COLUMN "scope" TYPE "MemoryScope" USING "scope"::text::"MemoryScope";
    DROP TYPE "MemoryScope_retired";
  END IF;
END $$;
ALTER TABLE IF EXISTS "MemoryFact" DROP COLUMN IF EXISTS "memoryConversationId",
  DROP COLUMN IF EXISTS "sourcePath", DROP COLUMN IF EXISTS "sourceLine", DROP COLUMN IF EXISTS "projectSlug";
ALTER TABLE IF EXISTS "Run" DROP COLUMN IF EXISTS "memoryConversationId";
DROP TABLE IF EXISTS "MemoryConversation";
DROP TABLE IF EXISTS "ProjectMember";
DROP TABLE IF EXISTS "Project";
ALTER TABLE IF EXISTS "Bot" DROP COLUMN IF EXISTS "dreamingEnabled",
  DROP COLUMN IF EXISTS "episodePending", DROP COLUMN IF EXISTS "episodeTurns";
ALTER TABLE IF EXISTS "ContextPromptSnapshot" DROP COLUMN IF EXISTS "memoryEpoch",
  DROP COLUMN IF EXISTS "memoryRender", DROP COLUMN IF EXISTS "memoryHasFacts",
  DROP COLUMN IF EXISTS "memoryAudienceKey";
ALTER TABLE IF EXISTS "AgentPromptSnapshot" DROP COLUMN IF EXISTS "memoryEpoch",
  DROP COLUMN IF EXISTS "memoryRender", DROP COLUMN IF EXISTS "memoryHasFacts",
  DROP COLUMN IF EXISTS "memoryAudienceKey";
ALTER TABLE IF EXISTS "Subagent" DROP COLUMN IF EXISTS "combinedComputerUse";
-- Every Task runs in the background, and typed or parent messages start new turns instead of
-- steering a running one, so neither the foreground flag nor the steer inbox is stored anymore.
ALTER TABLE IF EXISTS "Subagent" DROP COLUMN IF EXISTS "runInBackground";
ALTER TABLE IF EXISTS "SubagentAttempt" DROP COLUMN IF EXISTS "runInBackground";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'InboxEvent' AND column_name = 'deliveryMode') THEN
    DELETE FROM "InboxEvent" WHERE "deliveryMode"::text = 'steer';
    ALTER TABLE "InboxEvent" DROP COLUMN "deliveryMode";
  END IF;
END $$;
DROP TYPE IF EXISTS "InboxDeliveryMode";
`;

const retireUnusedStorage = async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(RETIRE_UNUSED_STORAGE);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
};

await retireUnusedStorage();
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
