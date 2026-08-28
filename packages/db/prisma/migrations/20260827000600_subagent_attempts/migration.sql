CREATE TABLE "SubagentAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subagentId" UUID NOT NULL,
  "parentRunId" UUID NOT NULL,
  "parentChannelId" UUID NOT NULL,
  "parentToolCallId" TEXT NOT NULL,
  "childRunId" UUID,
  "description" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "fileAttachments" JSONB NOT NULL DEFAULT '[]',
  "runInBackground" BOOLEAN NOT NULL DEFAULT true,
  "status" "SubagentStatus" NOT NULL DEFAULT 'provisioning',
  "result" TEXT,
  "error" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "stoppedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubagentAttempt_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SubagentAttempt" (
  "subagentId",
  "parentRunId",
  "parentChannelId",
  "parentToolCallId",
  "childRunId",
  "description",
  "prompt",
  "fileAttachments",
  "runInBackground",
  "status",
  "result",
  "error",
  "startedAt",
  "completedAt",
  "stoppedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  "id",
  "parentRunId",
  "parentChannelId",
  "launchCallId",
  "currentRunId",
  "description",
  "prompt",
  "fileAttachments",
  "runInBackground",
  "status",
  "result",
  "error",
  "startedAt",
  "completedAt",
  "stoppedAt",
  "createdAt",
  "updatedAt"
FROM "Subagent";

CREATE UNIQUE INDEX "SubagentAttempt_childRunId_key" ON "SubagentAttempt"("childRunId");
CREATE UNIQUE INDEX "SubagentAttempt_subagentId_parentToolCallId_key" ON "SubagentAttempt"("subagentId", "parentToolCallId");
CREATE INDEX "SubagentAttempt_parentChannelId_createdAt_idx" ON "SubagentAttempt"("parentChannelId", "createdAt");
CREATE INDEX "SubagentAttempt_subagentId_status_createdAt_idx" ON "SubagentAttempt"("subagentId", "status", "createdAt");

ALTER TABLE "SubagentAttempt"
ADD CONSTRAINT "SubagentAttempt_subagentId_fkey"
FOREIGN KEY ("subagentId") REFERENCES "Subagent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
