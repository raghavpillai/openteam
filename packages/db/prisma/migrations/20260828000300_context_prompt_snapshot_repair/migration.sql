-- The context-compaction migration was exercised against an earlier development
-- build before ContextPromptSnapshot was added to it. Keep this repair
-- idempotent so databases created from the final migration and those upgraded
-- from that development build converge on the same schema.
CREATE TABLE IF NOT EXISTS "ContextPromptSnapshot" (
  "contextSessionId" UUID NOT NULL,
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
  CONSTRAINT "ContextPromptSnapshot_pkey" PRIMARY KEY ("contextSessionId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ContextPromptSnapshot_contextSessionId_fkey'
  ) THEN
    ALTER TABLE "ContextPromptSnapshot"
    ADD CONSTRAINT "ContextPromptSnapshot_contextSessionId_fkey"
    FOREIGN KEY ("contextSessionId") REFERENCES "ContextSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "ContextPromptSnapshot" (
  "contextSessionId", "profileEpoch", "profileSection", "systemName",
  "systemDescription", "announcedName", "announcedDescription", "memoryEpoch",
  "memoryRender", "memoryHasFacts", "skillEpoch", "skillRender", "createdAt", "updatedAt"
)
SELECT
  cs."id", aps."profileEpoch", aps."profileSection", aps."systemName",
  aps."systemDescription", aps."announcedName", aps."announcedDescription", aps."memoryEpoch",
  aps."memoryRender", aps."memoryHasFacts", aps."skillEpoch", aps."skillRender",
  aps."createdAt", aps."updatedAt"
FROM "AgentPromptSnapshot" aps
JOIN "ContextSession" cs ON cs."botId" = aps."botId" AND cs."scope" = 'home'
ON CONFLICT ("contextSessionId") DO NOTHING;
