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
const MEMORY_UUID_BODY = "([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const MEMORY_NAMESPACE_PATTERN = `^(user:)?agent:(${MEMORY_UUID_BODY}|[{]${MEMORY_UUID_BODY}[}])$`;

const RETIRE_UNUSED_STORAGE = `
DO $$
DECLARE
  memory_namespace_changed boolean := false;
BEGIN
  IF to_regclass('"MemoryFact"') IS NOT NULL THEN
    -- UUID values are case-insensitive, but namespace text was not. Preserve
    -- existing facts and history when converging legacy UUID spellings.
    WITH canonical AS MATERIALIZED (
      SELECT "id", CASE WHEN "namespace" ~* '^user:agent:' THEN 'user:agent:' ELSE 'agent:' END
        || (regexp_replace("namespace", '^(user:)?agent:', '', 'i')::uuid)::text AS value
      FROM "MemoryFact" WHERE "namespace" ~* '${MEMORY_NAMESPACE_PATTERN}'
    ), changed AS (
      UPDATE "MemoryFact" AS fact SET "namespace" = canonical.value
      FROM canonical WHERE fact."id" = canonical."id" AND fact."namespace" <> canonical.value
      RETURNING fact."id"
    ) SELECT EXISTS (SELECT 1 FROM changed) INTO memory_namespace_changed;
    IF memory_namespace_changed THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
          AND table_name = 'ContextPromptSnapshot' AND column_name = 'promptSections') THEN
        UPDATE "ContextPromptSnapshot" SET "promptSections" = "promptSections" - 'memory' WHERE "promptSections" ? 'memory';
      END IF;
      IF to_regclass('"MemoryRevision"') IS NOT NULL THEN
        INSERT INTO "MemoryRevision" ("scope", "revision") VALUES ('user', 1)
          ON CONFLICT ("scope") DO UPDATE SET "revision" = "MemoryRevision"."revision" + 1;
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
          AND table_name = 'Bot' AND column_name = 'memoryRevision') THEN
        UPDATE "Bot" SET "memoryRevision" = "memoryRevision" + 1;
      END IF;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'ContextPromptSnapshot' AND column_name = 'memoryAudienceKey') THEN
    -- Frozen memory from the old prompt layout re-renders once.
    UPDATE "ContextPromptSnapshot" SET "promptSections" = "promptSections" - 'memory';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'Bot' AND column_name = 'instructions') THEN
    -- Retire the old trigger before removing a field its function still references.
    -- applyRawSchema installs the description-only projection after db push.
    DROP TRIGGER IF EXISTS "Bot_search_refresh" ON "Bot";
    IF to_regclass('"SearchDocument"') IS NOT NULL THEN
      UPDATE "SearchDocument" AS search SET "content" = bot."description"
        FROM "Bot" AS bot WHERE search."sourceType" = 'bot' AND search."sourceId" = bot."id";
    END IF;
    ALTER TABLE "Bot" DROP COLUMN "instructions";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'ContextPromptSnapshot' AND column_name = 'promptSections') THEN
    UPDATE "ContextPromptSnapshot" SET "promptSections" = "promptSections" - 'agent_instructions'
      WHERE "promptSections" ? 'agent_instructions';
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
  IF to_regclass('"IdempotencyRecord"') IS NOT NULL THEN
    -- Receipts of the removed SendFeedback tool.
    DELETE FROM "IdempotencyRecord" WHERE "scope" = 'feedback-send';
  END IF;
  IF to_regclass('"ChannelMessage"') IS NOT NULL THEN
    -- Approval cards of the removed Auto-review.
    DELETE FROM "ChannelMessage" WHERE "metadata"->>'type' = 'approval';
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
-- Every turn runs in a context session and freezes its prompt there, so no per-bot snapshot is kept.
DROP TABLE IF EXISTS "AgentPromptSnapshot";
ALTER TABLE IF EXISTS "Bot" DROP COLUMN IF EXISTS "dreamingEnabled",
  DROP COLUMN IF EXISTS "episodePending", DROP COLUMN IF EXISTS "episodeTurns";
ALTER TABLE IF EXISTS "ContextPromptSnapshot" DROP COLUMN IF EXISTS "memoryEpoch",
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
-- Auto-review's settings and Allow / Ask first rules.
DROP TABLE IF EXISTS "AutoReviewSettings";
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
