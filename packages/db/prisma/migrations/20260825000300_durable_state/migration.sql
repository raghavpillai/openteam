CREATE TYPE "MemoryScope" AS ENUM ('agent', 'user', 'project');
CREATE TYPE "MemoryTier" AS ENUM ('profile', 'log', 'note');

ALTER TABLE "Bot"
ADD COLUMN "hiddenFromSidebar" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "avatarPath" TEXT;

CREATE TABLE "MemoryFact" (
  "id" UUID NOT NULL,
  "namespace" TEXT NOT NULL,
  "scope" "MemoryScope" NOT NULL,
  "tier" "MemoryTier" NOT NULL DEFAULT 'log',
  "projectSlug" TEXT,
  "fact" TEXT NOT NULL,
  "factHash" TEXT NOT NULL,
  "writtenByBotId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedSkill" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedSkill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "workingDirectory" TEXT NOT NULL,
  "createdByBotId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("slug")
);

CREATE TABLE "ProjectMember" (
  "projectSlug" TEXT NOT NULL,
  "botId" UUID NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectSlug", "botId")
);

CREATE TABLE "BotConnectorState" (
  "botId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "connected" BOOLEAN NOT NULL DEFAULT true,
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotConnectorState_pkey" PRIMARY KEY ("botId", "platform")
);

CREATE UNIQUE INDEX "MemoryFact_namespace_factHash_key" ON "MemoryFact"("namespace", "factHash");
CREATE INDEX "MemoryFact_namespace_tier_updatedAt_idx" ON "MemoryFact"("namespace", "tier", "updatedAt");
CREATE INDEX "MemoryFact_writtenByBotId_updatedAt_idx" ON "MemoryFact"("writtenByBotId", "updatedAt");
CREATE UNIQUE INDEX "SavedSkill_botId_name_key" ON "SavedSkill"("botId", "name");
CREATE INDEX "SavedSkill_botId_updatedAt_idx" ON "SavedSkill"("botId", "updatedAt");
CREATE INDEX "ProjectMember_botId_joinedAt_idx" ON "ProjectMember"("botId", "joinedAt");
CREATE INDEX "BotConnectorState_platform_connected_idx" ON "BotConnectorState"("platform", "connected");

ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_writtenByBotId_fkey"
FOREIGN KEY ("writtenByBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SavedSkill" ADD CONSTRAINT "SavedSkill_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Project" ADD CONSTRAINT "Project_createdByBotId_fkey"
FOREIGN KEY ("createdByBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectSlug_fkey"
FOREIGN KEY ("projectSlug") REFERENCES "Project"("slug") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BotConnectorState" ADD CONSTRAINT "BotConnectorState_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
