-- Grok Bot runs every agent, group, routine, A2A wake, and subagent in the
-- shared /workspace root. Existing OpenBot rows are migrated in place.
UPDATE "Bot" SET "defaultDirectory" = '/workspace';
UPDATE "Channel" SET "workingDirectory" = '/workspace' WHERE "kind" = 'group';
UPDATE "Project" SET "workingDirectory" = '/workspace';

-- The computer user and model-visible data paths now match the Grok box.
UPDATE "Bot"
SET "avatarPath" = replace("avatarPath", '/home/openbot/agent-data', '/home/box/agent-data')
WHERE "avatarPath" LIKE '/home/openbot/agent-data/%';
UPDATE "Bot"
SET "runtimeSessionPath" = replace("runtimeSessionPath", '/home/openbot/.pi', '/home/box/.pi')
WHERE "runtimeSessionPath" LIKE '/home/openbot/.pi/%';
UPDATE "ContextSession"
SET "runtimeSessionPath" = replace("runtimeSessionPath", '/home/openbot/.pi', '/home/box/.pi')
WHERE "runtimeSessionPath" LIKE '/home/openbot/.pi/%';
UPDATE "AgentFileState"
SET "path" = replace("path", '/home/openbot/agent-data', '/home/box/agent-data')
WHERE "path" LIKE '/home/openbot/agent-data/%';

-- Saved workflows are installation-global in Grok. If legacy per-Bot skill
-- slugs collide, retain the most recently updated row; the filesystem
-- migration gives colliding legacy folders deterministic -2…-999 suffixes.
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "slug" ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
  ) AS position
  FROM "SavedSkill"
)
DELETE FROM "SavedSkill"
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);

ALTER TABLE "SavedSkill" DROP CONSTRAINT IF EXISTS "SavedSkill_botId_fkey";
ALTER TABLE "SavedSkill" ALTER COLUMN "botId" DROP NOT NULL;
DROP INDEX IF EXISTS "SavedSkill_botId_slug_key";
DROP INDEX IF EXISTS "SavedSkill_botId_name_idx";
DROP INDEX IF EXISTS "SavedSkill_botId_updatedAt_idx";
CREATE UNIQUE INDEX "SavedSkill_slug_key" ON "SavedSkill"("slug");
CREATE INDEX "SavedSkill_name_idx" ON "SavedSkill"("name");
CREATE INDEX "SavedSkill_updatedAt_idx" ON "SavedSkill"("updatedAt");
ALTER TABLE "SavedSkill" ADD CONSTRAINT "SavedSkill_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
