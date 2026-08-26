CREATE TYPE "TodoStatus" AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');
CREATE TYPE "SubagentStatus" AS ENUM ('provisioning', 'queued', 'running', 'completed', 'failed', 'stopped');

CREATE TABLE "TodoItem" (
  "botId" UUID NOT NULL,
  "id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "TodoStatus" NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TodoItem_pkey" PRIMARY KEY ("botId", "id")
);

CREATE TABLE "Subagent" (
  "id" UUID NOT NULL,
  "parentBotId" UUID NOT NULL,
  "childBotId" UUID NOT NULL,
  "parentRunId" UUID NOT NULL,
  "parentChannelId" UUID NOT NULL,
  "currentRunId" UUID,
  "launchCallId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "subagentType" TEXT NOT NULL,
  "model" TEXT,
  "fileAttachments" JSONB NOT NULL DEFAULT '[]',
  "runInBackground" BOOLEAN NOT NULL DEFAULT true,
  "status" "SubagentStatus" NOT NULL DEFAULT 'provisioning',
  "result" TEXT,
  "error" JSONB,
  "outputPath" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "stoppedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subagent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TodoItem_botId_position_key" ON "TodoItem"("botId", "position");
CREATE INDEX "TodoItem_botId_status_position_idx" ON "TodoItem"("botId", "status", "position");
CREATE UNIQUE INDEX "Subagent_childBotId_key" ON "Subagent"("childBotId");
CREATE UNIQUE INDEX "Subagent_currentRunId_key" ON "Subagent"("currentRunId");
CREATE UNIQUE INDEX "Subagent_parentBotId_launchCallId_key" ON "Subagent"("parentBotId", "launchCallId");
CREATE INDEX "Subagent_parentBotId_status_createdAt_idx" ON "Subagent"("parentBotId", "status", "createdAt");
CREATE INDEX "Subagent_childBotId_status_idx" ON "Subagent"("childBotId", "status");

ALTER TABLE "TodoItem" ADD CONSTRAINT "TodoItem_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subagent" ADD CONSTRAINT "Subagent_parentBotId_fkey"
FOREIGN KEY ("parentBotId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subagent" ADD CONSTRAINT "Subagent_childBotId_fkey"
FOREIGN KEY ("childBotId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
