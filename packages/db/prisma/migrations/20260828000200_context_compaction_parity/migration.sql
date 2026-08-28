CREATE TABLE "ContextSession" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" UUID NOT NULL,
  "runtimeSessionId" TEXT,
  "runtimeSessionPath" TEXT,
  "compactionEpoch" INTEGER NOT NULL DEFAULT 0,
  "lastArchiveId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContextSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContextCompaction" (
  "id" UUID NOT NULL,
  "contextSessionId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "prefixDigest" TEXT NOT NULL,
  "summaryDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'adopted',
  "tokensBefore" INTEGER,
  "tokensAfter" INTEGER,
  "imageCount" INTEGER NOT NULL DEFAULT 0,
  "turnCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContextCompaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContextPromptSnapshot" (
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

CREATE UNIQUE INDEX "ContextSession_runtimeSessionId_key" ON "ContextSession"("runtimeSessionId");
CREATE UNIQUE INDEX "ContextSession_runtimeSessionPath_key" ON "ContextSession"("runtimeSessionPath");
CREATE UNIQUE INDEX "ContextSession_botId_scope_scopeId_key" ON "ContextSession"("botId", "scope", "scopeId");
CREATE INDEX "ContextSession_botId_scope_idx" ON "ContextSession"("botId", "scope");
CREATE UNIQUE INDEX "ContextCompaction_contextSessionId_sequence_key" ON "ContextCompaction"("contextSessionId", "sequence");
CREATE INDEX "ContextCompaction_contextSessionId_status_idx" ON "ContextCompaction"("contextSessionId", "status");

ALTER TABLE "ContextSession"
ADD CONSTRAINT "ContextSession_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContextCompaction"
ADD CONSTRAINT "ContextCompaction_contextSessionId_fkey"
FOREIGN KEY ("contextSessionId") REFERENCES "ContextSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContextPromptSnapshot"
ADD CONSTRAINT "ContextPromptSnapshot_contextSessionId_fkey"
FOREIGN KEY ("contextSessionId") REFERENCES "ContextSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ContextSession" (
  "id", "botId", "scope", "scopeId", "runtimeSessionId", "runtimeSessionPath",
  "compactionEpoch", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), b."id", 'home', c."id", b."runtimeSessionId", b."runtimeSessionPath",
  c."compactionEpoch", LEAST(b."createdAt", c."createdAt"), CURRENT_TIMESTAMP
FROM "Bot" b
JOIN "Conversation" c ON c."botId" = b."id"
ON CONFLICT ("botId", "scope", "scopeId") DO NOTHING;

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
