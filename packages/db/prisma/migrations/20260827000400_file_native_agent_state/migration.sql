ALTER TYPE "RoutineScheduleKind" ADD VALUE IF NOT EXISTS 'event';

ALTER TABLE "Conversation"
ADD COLUMN "compactionEpoch" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Bot"
ADD COLUMN "dreamingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "episodePending" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "MemoryFact_namespace_factHash_key";

ALTER TABLE "MemoryFact"
ADD COLUMN "logicalId" TEXT NOT NULL DEFAULT '',
ADD COLUMN "sourcePath" TEXT NOT NULL DEFAULT '',
ADD COLUMN "sourceOrdinal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sourceLine" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "importance" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'legacy';

UPDATE "MemoryFact"
SET
  "logicalId" = left("factHash", 16),
  "sourcePath" = 'legacy/' || "id"::text || '.md',
  "sourceOrdinal" = 0,
  "sourceLine" = 0,
  "importance" = CASE WHEN "tier" = 'note' THEN 0.5 ELSE 1 END;

CREATE UNIQUE INDEX "MemoryFact_namespace_sourcePath_sourceOrdinal_key"
ON "MemoryFact"("namespace", "sourcePath", "sourceOrdinal");

CREATE INDEX "MemoryFact_namespace_logicalId_createdAt_idx"
ON "MemoryFact"("namespace", "logicalId", "createdAt");

ALTER TABLE "SavedSkill"
ADD COLUMN "slug" TEXT,
ADD COLUMN "frontmatter" JSONB NOT NULL DEFAULT '{}';

UPDATE "SavedSkill" SET "slug" = "id"::text WHERE "slug" IS NULL;
ALTER TABLE "SavedSkill" ALTER COLUMN "slug" SET NOT NULL;
DROP INDEX IF EXISTS "SavedSkill_botId_name_key";
CREATE UNIQUE INDEX "SavedSkill_botId_slug_key" ON "SavedSkill"("botId", "slug");
CREATE INDEX "SavedSkill_botId_name_idx" ON "SavedSkill"("botId", "name");

ALTER TABLE "Routine"
ADD COLUMN "slug" TEXT,
ADD COLUMN "trigger" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "triggerPresentation" JSONB,
ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'untrusted',
ADD COLUMN "lastRunAt" TIMESTAMP(3),
ADD COLUMN "pendingNotices" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "raisedNotices" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "runLedger" JSONB NOT NULL DEFAULT '[]';

UPDATE "Routine"
SET
  "slug" = "id"::text,
  "trigger" = jsonb_build_object('type', 'cron', 'schedule', "scheduleText")
WHERE "slug" IS NULL;

ALTER TABLE "Routine" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "Routine_botId_slug_key" ON "Routine"("botId", "slug");

CREATE TABLE "AgentPromptSnapshot" (
  "botId" UUID NOT NULL,
  "profileEpoch" INTEGER NOT NULL DEFAULT -1,
  "profileSection" TEXT NOT NULL DEFAULT '',
  "systemName" TEXT NOT NULL DEFAULT '',
  "systemDescription" TEXT NOT NULL DEFAULT '',
  "announcedName" TEXT NOT NULL DEFAULT '',
  "announcedDescription" TEXT NOT NULL DEFAULT '',
  "memoryEpoch" INTEGER NOT NULL DEFAULT -1,
  "memoryRender" TEXT NOT NULL DEFAULT '',
  "memoryHasFacts" BOOLEAN NOT NULL DEFAULT false,
  "skillEpoch" INTEGER NOT NULL DEFAULT -1,
  "skillRender" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentPromptSnapshot_pkey" PRIMARY KEY ("botId")
);

CREATE TABLE "AgentFileState" (
  "path" TEXT NOT NULL,
  "botId" UUID,
  "kind" TEXT NOT NULL,
  "digest" TEXT,
  "validDigest" TEXT,
  "exists" BOOLEAN NOT NULL DEFAULT true,
  "error" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentFileState_pkey" PRIMARY KEY ("path")
);

CREATE INDEX "AgentFileState_botId_kind_idx" ON "AgentFileState"("botId", "kind");
CREATE INDEX "AgentFileState_kind_lastSeenAt_idx" ON "AgentFileState"("kind", "lastSeenAt");

ALTER TABLE "AgentPromptSnapshot" ADD CONSTRAINT "AgentPromptSnapshot_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentFileState" ADD CONSTRAINT "AgentFileState_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
