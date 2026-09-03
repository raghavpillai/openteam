-- >>> 20260824000100_init
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "ComputerStatus" AS ENUM ('starting', 'ready', 'unavailable', 'degraded');
CREATE TYPE "BotStatus" AS ENUM ('provisioning', 'active', 'archived', 'failed');
CREATE TYPE "ConversationContinuity" AS ENUM ('empty', 'attached', 'detached');
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system');
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'streaming', 'completed', 'failed');
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted');
CREATE TYPE "InboxStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'delivering', 'delivered', 'failed');
CREATE TYPE "RunItemKind" AS ENUM ('agent_message', 'reasoning', 'command', 'file_change', 'tool', 'compaction', 'error');
CREATE TYPE "RunItemStatus" AS ENUM ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');
CREATE TYPE "ApprovalKind" AS ENUM ('command', 'file_change', 'permissions', 'user_input');
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');
CREATE TYPE "IdempotencyStatus" AS ENUM ('processing', 'completed', 'failed');

CREATE TABLE "Computer" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'OpenTeam computer',
  "status" "ComputerStatus" NOT NULL DEFAULT 'starting',
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Computer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Bot" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "instructions" TEXT NOT NULL DEFAULT '',
  "icon" TEXT NOT NULL DEFAULT '●',
  "color" TEXT NOT NULL DEFAULT '#4f7cff',
  "defaultDirectory" TEXT NOT NULL,
  "status" "BotStatus" NOT NULL DEFAULT 'provisioning',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "codexThreadId" TEXT,
  "codexSessionId" TEXT,
  "continuity" "ConversationContinuity" NOT NULL DEFAULT 'empty',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "runId" UUID,
  "clientId" TEXT,
  "upstreamItemId" TEXT,
  "role" "MessageRole" NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "status" "MessageStatus" NOT NULL DEFAULT 'queued',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Run" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "userMessageId" UUID NOT NULL,
  "status" "RunStatus" NOT NULL DEFAULT 'queued',
  "codexTurnId" TEXT,
  "error" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxEvent" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "InboxStatus" NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotRunLease" (
  "botId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotRunLease_pkey" PRIMARY KEY ("botId")
);

CREATE TABLE "OutboxDelivery" (
  "id" UUID NOT NULL,
  "deliveryKey" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunItem" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "upstreamItemId" TEXT,
  "kind" "RunItemKind" NOT NULL,
  "status" "RunItemStatus" NOT NULL DEFAULT 'pending',
  "title" TEXT,
  "content" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RunItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Approval" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "runItemId" UUID,
  "upstreamRequestId" TEXT NOT NULL,
  "requestMethod" TEXT NOT NULL,
  "kind" "ApprovalKind" NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
  "details" JSONB NOT NULL,
  "decision" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "sequence" BIGSERIAL NOT NULL,
  "topic" TEXT NOT NULL,
  "entityId" UUID,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Event_pkey" PRIMARY KEY ("sequence")
);

CREATE TABLE "IdempotencyRecord" (
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "response" JSONB,
  "status" "IdempotencyStatus" NOT NULL DEFAULT 'processing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("scope", "key")
);

CREATE INDEX "Bot_status_updatedAt_idx" ON "Bot"("status", "updatedAt");
CREATE UNIQUE INDEX "Conversation_botId_key" ON "Conversation"("botId");
CREATE UNIQUE INDEX "Conversation_codexThreadId_key" ON "Conversation"("codexThreadId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE UNIQUE INDEX "Message_conversationId_clientId_key" ON "Message"("conversationId", "clientId");
CREATE UNIQUE INDEX "Message_conversationId_upstreamItemId_key" ON "Message"("conversationId", "upstreamItemId");
CREATE UNIQUE INDEX "Run_userMessageId_key" ON "Run"("userMessageId");
CREATE INDEX "Run_botId_status_idx" ON "Run"("botId", "status");
CREATE INDEX "Run_conversationId_createdAt_idx" ON "Run"("conversationId", "createdAt");
CREATE UNIQUE INDEX "InboxEvent_idempotencyKey_key" ON "InboxEvent"("idempotencyKey");
CREATE INDEX "InboxEvent_botId_status_priority_availableAt_createdAt_idx" ON "InboxEvent"("botId", "status", "priority", "availableAt", "createdAt");
CREATE UNIQUE INDEX "BotRunLease_runId_key" ON "BotRunLease"("runId");
CREATE UNIQUE INDEX "OutboxDelivery_deliveryKey_key" ON "OutboxDelivery"("deliveryKey");
CREATE INDEX "OutboxDelivery_status_availableAt_idx" ON "OutboxDelivery"("status", "availableAt");
CREATE INDEX "RunItem_runId_createdAt_idx" ON "RunItem"("runId", "createdAt");
CREATE UNIQUE INDEX "RunItem_runId_upstreamItemId_key" ON "RunItem"("runId", "upstreamItemId");
CREATE UNIQUE INDEX "Approval_upstreamRequestId_key" ON "Approval"("upstreamRequestId");
CREATE INDEX "Approval_runId_status_idx" ON "Approval"("runId", "status");
CREATE INDEX "Event_topic_sequence_idx" ON "Event"("topic", "sequence");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboxEvent" ADD CONSTRAINT "InboxEvent_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboxEvent" ADD CONSTRAINT "InboxEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboxEvent" ADD CONSTRAINT "InboxEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRunLease" ADD CONSTRAINT "BotRunLease_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRunLease" ADD CONSTRAINT "BotRunLease_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunItem" ADD CONSTRAINT "RunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runItemId_fkey" FOREIGN KEY ("runItemId") REFERENCES "RunItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- >>> 20260824000200_agent_channels
CREATE TYPE "ChannelKind" AS ENUM ('bot_dm', 'agent_dm', 'group');
CREATE TYPE "ChannelMessageSender" AS ENUM ('user', 'agent', 'system');
CREATE TYPE "ChannelRoundStatus" AS ENUM ('queued', 'running', 'completed', 'failed');
CREATE TYPE "ChannelDeliveryStatus" AS ENUM ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped');
CREATE TYPE "RunOrigin" AS ENUM ('user', 'agent', 'group');

CREATE TABLE "Channel" (
  "id" UUID NOT NULL,
  "kind" "ChannelKind" NOT NULL,
  "name" TEXT NOT NULL,
  "directKey" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelMember" (
  "channelId" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("channelId", "botId")
);

CREATE TABLE "ChannelMessage" (
  "id" UUID NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "channelId" UUID NOT NULL,
  "sender" "ChannelMessageSender" NOT NULL,
  "senderBotId" UUID,
  "sourceRunId" UUID,
  "clientId" TEXT,
  "content" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelRound" (
  "id" UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "triggerMessageId" UUID NOT NULL,
  "initiatorBotId" UUID,
  "status" "ChannelRoundStatus" NOT NULL DEFAULT 'queued',
  "currentOrdinal" INTEGER NOT NULL DEFAULT -1,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelRound_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelDelivery" (
  "id" UUID NOT NULL,
  "roundId" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" "ChannelDeliveryStatus" NOT NULL DEFAULT 'pending',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Run"
  ADD COLUMN "origin" "RunOrigin" NOT NULL DEFAULT 'user',
  ADD COLUMN "channelId" UUID,
  ADD COLUMN "deliveryId" UUID;

CREATE UNIQUE INDEX "Channel_directKey_key" ON "Channel"("directKey");
CREATE INDEX "Channel_kind_updatedAt_idx" ON "Channel"("kind", "updatedAt");
CREATE UNIQUE INDEX "ChannelMember_channelId_ordinal_key" ON "ChannelMember"("channelId", "ordinal");
CREATE INDEX "ChannelMember_botId_channelId_idx" ON "ChannelMember"("botId", "channelId");
CREATE UNIQUE INDEX "ChannelMessage_channelId_clientId_key" ON "ChannelMessage"("channelId", "clientId");
CREATE INDEX "ChannelMessage_channelId_sequence_idx" ON "ChannelMessage"("channelId", "sequence");
CREATE INDEX "ChannelMessage_senderBotId_createdAt_idx" ON "ChannelMessage"("senderBotId", "createdAt");
CREATE UNIQUE INDEX "ChannelRound_triggerMessageId_key" ON "ChannelRound"("triggerMessageId");
CREATE INDEX "ChannelRound_channelId_status_createdAt_idx" ON "ChannelRound"("channelId", "status", "createdAt");
CREATE UNIQUE INDEX "ChannelDelivery_roundId_botId_key" ON "ChannelDelivery"("roundId", "botId");
CREATE UNIQUE INDEX "ChannelDelivery_roundId_ordinal_key" ON "ChannelDelivery"("roundId", "ordinal");
CREATE INDEX "ChannelDelivery_botId_status_createdAt_idx" ON "ChannelDelivery"("botId", "status", "createdAt");
CREATE UNIQUE INDEX "Run_deliveryId_key" ON "Run"("deliveryId");
CREATE INDEX "Run_channelId_createdAt_idx" ON "Run"("channelId", "createdAt");

ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_senderBotId_fkey" FOREIGN KEY ("senderBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChannelRound" ADD CONSTRAINT "ChannelRound_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelRound" ADD CONSTRAINT "ChannelRound_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "ChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelRound" ADD CONSTRAINT "ChannelRound_initiatorBotId_fkey" FOREIGN KEY ("initiatorBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChannelDelivery" ADD CONSTRAINT "ChannelDelivery_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "ChannelRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelDelivery" ADD CONSTRAINT "ChannelDelivery_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "ChannelDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Channel" ("id", "kind", "name", "directKey", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'bot_dm'::"ChannelKind", "name", 'bot:' || "id"::text, "createdAt", CURRENT_TIMESTAMP
FROM "Bot";

INSERT INTO "ChannelMember" ("channelId", "botId", "ordinal")
SELECT channel."id", bot."id", 0
FROM "Bot" bot
JOIN "Channel" channel ON channel."directKey" = 'bot:' || bot."id"::text;

UPDATE "Run" run
SET "channelId" = channel."id"
FROM "Channel" channel
WHERE channel."directKey" = 'bot:' || run."botId"::text;

INSERT INTO "ChannelMessage" (
  "id", "channelId", "sender", "senderBotId", "sourceRunId", "clientId", "content", "metadata", "createdAt"
)
SELECT
  message."id",
  channel."id",
  CASE
    WHEN message."role" = 'user' THEN 'user'::"ChannelMessageSender"
    WHEN message."role" = 'assistant' THEN 'agent'::"ChannelMessageSender"
    ELSE 'system'::"ChannelMessageSender"
  END,
  CASE WHEN message."role" = 'assistant' THEN message."botId" ELSE NULL END,
  message."runId",
  message."clientId",
  message."content",
  jsonb_build_object('migratedFromMessageId', message."id"),
  message."createdAt"
FROM "Message" message
JOIN "Channel" channel ON channel."directKey" = 'bot:' || message."botId"::text;

-- >>> 20260824000300_shared_workspaces
ALTER TABLE "Channel" ADD COLUMN "workingDirectory" TEXT;

UPDATE "Channel"
SET "workingDirectory" = '/workspace/projects/group-' || substring("id"::text from 1 for 8)
WHERE "kind" = 'group';

-- >>> 20260825000100_bot_onboarding
CREATE TYPE "OnboardingStatus" AS ENUM (
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'skipped_by_user'
);

ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'bootstrap';

ALTER TABLE "Bot"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'completed',
  ADD COLUMN "onboardingVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "provisioningError" JSONB;

ALTER TABLE "Bot"
  ALTER COLUMN "onboardingStatus" SET DEFAULT 'pending';

-- >>> 20260825000200_native_tools_and_routines
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'routine';

CREATE TYPE "RoutineScheduleKind" AS ENUM ('cron', 'interval');
CREATE TYPE "RoutineExecutionKind" AS ENUM ('scheduled', 'test');
CREATE TYPE "RoutineExecutionStatus" AS ENUM ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped');

CREATE TABLE "Routine" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "scheduleText" TEXT NOT NULL,
    "scheduleKind" "RoutineScheduleKind" NOT NULL,
    "cronExpression" TEXT,
    "intervalSeconds" INTEGER,
    "timezoneMode" TEXT NOT NULL DEFAULT 'installation',
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoutineRevision" (
    "id" UUID NOT NULL,
    "routineId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "scheduleText" TEXT NOT NULL,
    "scheduleKind" "RoutineScheduleKind" NOT NULL,
    "cronExpression" TEXT,
    "intervalSeconds" INTEGER,
    "timezoneMode" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "callId" TEXT,
    "runId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoutineRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoutineExecution" (
    "id" UUID NOT NULL,
    "routineId" UUID NOT NULL,
    "routineRevisionId" UUID NOT NULL,
    "runId" UUID,
    "kind" "RoutineExecutionKind" NOT NULL,
    "status" "RoutineExecutionStatus" NOT NULL DEFAULT 'queued',
    "dedupeKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "enqueuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoutineExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Routine_enabled_nextRunAt_idx" ON "Routine"("enabled", "nextRunAt");
CREATE INDEX "Routine_botId_deletedAt_updatedAt_idx" ON "Routine"("botId", "deletedAt", "updatedAt");
CREATE UNIQUE INDEX "RoutineRevision_routineId_revision_key" ON "RoutineRevision"("routineId", "revision");
CREATE UNIQUE INDEX "RoutineExecution_runId_key" ON "RoutineExecution"("runId");
CREATE UNIQUE INDEX "RoutineExecution_dedupeKey_key" ON "RoutineExecution"("dedupeKey");
CREATE INDEX "RoutineExecution_routineId_createdAt_idx" ON "RoutineExecution"("routineId", "createdAt");
CREATE INDEX "RoutineExecution_status_createdAt_idx" ON "RoutineExecution"("status", "createdAt");

ALTER TABLE "Routine" ADD CONSTRAINT "Routine_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutineRevision" ADD CONSTRAINT "RoutineRevision_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutineExecution" ADD CONSTRAINT "RoutineExecution_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutineExecution" ADD CONSTRAINT "RoutineExecution_routineRevisionId_fkey" FOREIGN KEY ("routineRevisionId") REFERENCES "RoutineRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoutineExecution" ADD CONSTRAINT "RoutineExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- >>> 20260825000200_pi_runtime
ALTER TABLE "Bot"
ADD COLUMN "runtimeProvider" TEXT NOT NULL DEFAULT 'pi',
ADD COLUMN "runtimeSessionId" TEXT,
ADD COLUMN "runtimeSessionPath" TEXT;

CREATE UNIQUE INDEX "Bot_runtimeSessionId_key" ON "Bot"("runtimeSessionId");
CREATE UNIQUE INDEX "Bot_runtimeSessionPath_key" ON "Bot"("runtimeSessionPath");

ALTER TABLE "Run" RENAME COLUMN "codexTurnId" TO "runtimeTurnId";

-- >>> 20260825000300_durable_state
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

-- >>> 20260825000400_live_steering
CREATE TYPE "InboxDeliveryMode" AS ENUM ('turn', 'steer');

ALTER TABLE "InboxEvent"
ADD COLUMN "deliveryMode" "InboxDeliveryMode" NOT NULL DEFAULT 'turn';

CREATE INDEX "InboxEvent_botId_deliveryMode_status_idx"
ON "InboxEvent"("botId", "deliveryMode", "status");

-- >>> 20260825000500_todos_subagents
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

-- >>> 20260827000100_search_documents
-- Search is deliberately kept outside the client snapshot. This compact projection is
-- maintained transactionally by PostgreSQL and queried through one bounded endpoint.
CREATE TABLE "SearchDocument" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" UUID NOT NULL,
  "entityId" TEXT NOT NULL,
  "channelId" UUID,
  "messageId" UUID,
  "botId" UUID,
  "title" TEXT NOT NULL DEFAULT '',
  "subtitle" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "url" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "searchVector" TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("subtitle", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("content", '')), 'C')
  ) STORED,
  CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchDocument_kind_check" CHECK (
    "kind" IN ('message', 'bot', 'channel', 'file', 'link', 'routine')
  )
);

CREATE INDEX "SearchDocument_searchVector_idx"
  ON "SearchDocument" USING GIN ("searchVector");
CREATE INDEX "SearchDocument_kind_updatedAt_idx"
  ON "SearchDocument" ("kind", "updatedAt" DESC);
CREATE INDEX "SearchDocument_source_idx"
  ON "SearchDocument" ("sourceType", "sourceId");
CREATE INDEX "SearchDocument_title_prefix_idx"
  ON "SearchDocument" (lower("title") text_pattern_ops);

CREATE OR REPLACE FUNCTION openteam_refresh_bot_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'bot' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."status" <> 'archived' AND NOT NEW."hiddenFromSidebar" THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id",
      NEW."name", coalesce(NULLIF(NEW."title", ''), ''), concat_ws(' ', NEW."description", NEW."instructions"),
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openteam_refresh_channel_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."archivedAt" IS NULL AND NEW."kind" = 'group' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'channel:' || NEW."id", 'channel', 'channel', NEW."id", NEW."id"::text, NEW."id",
      NEW."name",
      CASE NEW."kind" WHEN 'group' THEN 'Channel' WHEN 'agent_dm' THEN 'Bot conversation' ELSE 'Chat' END,
      coalesce(NEW."workingDirectory", ''), NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openteam_refresh_routine_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'routine' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."deletedAt" IS NULL THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'routine:' || NEW."id", 'routine', 'routine', NEW."id", NEW."id"::text, NEW."botId",
      NEW."name", NEW."scheduleText", NEW."prompt", NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openteam_refresh_message_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  image JSONB;
  image_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel_message' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF btrim(NEW."content") <> '' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
      "title", "content", "createdAt", "updatedAt"
    ) VALUES (
      'message:' || NEW."id", 'message', 'channel_message', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."id", NEW."senderBotId", NEW."content", NEW."content",
      NEW."createdAt", NEW."createdAt"
    );

    FOR matched IN
      SELECT DISTINCT regexp_matches(NEW."content", 'https?://[^[:space:]<>"'']+', 'gi')
    LOOP
      clean_url := regexp_replace(matched[1], '[.,;:!?)}\]]+$', '');
      IF clean_url <> '' THEN
        INSERT INTO "SearchDocument" (
          "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
          "title", "subtitle", "content", "url", "createdAt", "updatedAt"
        ) VALUES (
          'link:' || NEW."id" || ':' || md5(clean_url), 'link', 'channel_message', NEW."id",
          NEW."id"::text || ':' || md5(clean_url), NEW."channelId", NEW."id", NEW."senderBotId",
          clean_url, 'Shared link', NEW."content", clean_url, NEW."createdAt", NEW."createdAt"
        ) ON CONFLICT ("id") DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(NEW."metadata"::jsonb -> 'images') = 'array' THEN
    FOR image IN SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'images')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || image_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || image_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(image ->> 'alt', ''), 'Image attachment'), 'Image',
        coalesce(image ->> 'alt', ''),
        CASE WHEN image ->> 'url' ~* '^https?://' THEN image ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      image_index := image_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Bot_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Bot"
FOR EACH ROW EXECUTE FUNCTION openteam_refresh_bot_search();

CREATE TRIGGER "Channel_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Channel"
FOR EACH ROW EXECUTE FUNCTION openteam_refresh_channel_search();

CREATE TRIGGER "Routine_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Routine"
FOR EACH ROW EXECUTE FUNCTION openteam_refresh_routine_search();

CREATE TRIGGER "ChannelMessage_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "ChannelMessage"
FOR EACH ROW EXECUTE FUNCTION openteam_refresh_message_search();

-- Backfill after the triggers exist so future concurrent writes remain covered.
INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'bot:' || "id", 'bot', 'bot', "id", "id"::text, "id",
  "name", coalesce(NULLIF("title", ''), ''), concat_ws(' ', "description", "instructions"), "createdAt", "updatedAt"
FROM "Bot"
WHERE "status" <> 'archived' AND NOT "hiddenFromSidebar"
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "channelId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'channel:' || "id", 'channel', 'channel', "id", "id"::text, "id",
  "name",
  CASE "kind" WHEN 'group' THEN 'Channel' WHEN 'agent_dm' THEN 'Bot conversation' ELSE 'Chat' END,
  coalesce("workingDirectory", ''), "createdAt", "updatedAt"
FROM "Channel"
WHERE "archivedAt" IS NULL AND "kind" = 'group'
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'routine:' || "id", 'routine', 'routine', "id", "id"::text, "botId",
  "name", "scheduleText", "prompt", "createdAt", "updatedAt"
FROM "Routine"
WHERE "deletedAt" IS NULL
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

-- Calling the trigger function through a harmless update keeps attachment/link extraction in one place.
UPDATE "ChannelMessage" SET "content" = "content";

-- >>> 20260827000200_lean_search_projection
-- Keep the full searchable text once. Message titles are already indexed at weight A,
-- so duplicating them into content doubles both heap and GIN projection work. Links
-- and attachment names likewise contain all text needed for their own result types.
CREATE OR REPLACE FUNCTION openteam_refresh_message_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  image JSONB;
  image_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  -- Reactions and unrelated metadata do not affect search. Avoid deleting and
  -- rebuilding every projection row when only those fields change.
  IF TG_OP = 'UPDATE'
    AND NEW."content" IS NOT DISTINCT FROM OLD."content"
    AND (NEW."metadata"::jsonb -> 'images')
      IS NOT DISTINCT FROM (OLD."metadata"::jsonb -> 'images') THEN
    RETURN NEW;
  END IF;

  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel_message' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF btrim(NEW."content") <> '' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
      "title", "content", "createdAt", "updatedAt"
    ) VALUES (
      'message:' || NEW."id", 'message', 'channel_message', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."id", NEW."senderBotId", NEW."content", '',
      NEW."createdAt", NEW."createdAt"
    );

    FOR matched IN
      SELECT DISTINCT regexp_matches(NEW."content", 'https?://[^[:space:]<>"'']+', 'gi')
    LOOP
      clean_url := regexp_replace(matched[1], '[.,;:!?)}\]]+$', '');
      IF clean_url <> '' THEN
        INSERT INTO "SearchDocument" (
          "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
          "title", "subtitle", "content", "url", "createdAt", "updatedAt"
        ) VALUES (
          'link:' || NEW."id" || ':' || md5(clean_url), 'link', 'channel_message', NEW."id",
          NEW."id"::text || ':' || md5(clean_url), NEW."channelId", NEW."id", NEW."senderBotId",
          clean_url, 'Shared link', '', clean_url, NEW."createdAt", NEW."createdAt"
        ) ON CONFLICT ("id") DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(NEW."metadata"::jsonb -> 'images') = 'array' THEN
    FOR image IN SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'images')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || image_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || image_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(image ->> 'alt', ''), 'Image attachment'), 'Image', '',
        CASE WHEN image ->> 'url' ~* '^https?://' THEN image ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      image_index := image_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

UPDATE "SearchDocument"
SET "content" = ''
WHERE "kind" IN ('message', 'file', 'link') AND "content" <> '';

ANALYZE "SearchDocument";

-- >>> 20260827000300_agent_data_profile
ALTER TABLE "Bot"
ADD COLUMN "namedBy" TEXT NOT NULL DEFAULT 'user';

-- >>> 20260827000400_file_native_agent_state
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

-- >>> 20260827000500_plugins
CREATE TYPE "PluginInstallStatus" AS ENUM ('installed', 'disabled', 'error');
CREATE TYPE "PluginConnectionStatus" AS ENUM ('disconnected', 'needs_auth', 'ready', 'error', 'revoked');
CREATE TYPE "PluginToolDecision" AS ENUM ('deny', 'prompt', 'allow');
CREATE TYPE "PluginInvocationStatus" AS ENUM ('running', 'completed', 'failed', 'denied');

CREATE TABLE "PluginInstallation" (
  "id" UUID NOT NULL,
  "pluginKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "publisher" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "status" "PluginInstallStatus" NOT NULL DEFAULT 'installed',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginConnection" (
  "id" UUID NOT NULL,
  "installationId" UUID NOT NULL,
  "connectorKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "alias" TEXT NOT NULL DEFAULT 'default',
  "transport" TEXT NOT NULL,
  "authType" TEXT NOT NULL,
  "endpoint" TEXT,
  "status" "PluginConnectionStatus" NOT NULL DEFAULT 'disconnected',
  "statusMessage" TEXT,
  "instructions" TEXT NOT NULL DEFAULT '',
  "toolSnapshot" JSONB NOT NULL DEFAULT '[]',
  "connectedAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotPluginEnablement" (
  "botId" UUID NOT NULL,
  "installationId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "skillsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotPluginEnablement_pkey" PRIMARY KEY ("botId", "installationId")
);

CREATE TABLE "BotPluginConnectionGrant" (
  "botId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotPluginConnectionGrant_pkey" PRIMARY KEY ("botId", "connectionId")
);

CREATE TABLE "PluginToolPolicy" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "botId" UUID,
  "toolName" TEXT NOT NULL,
  "decision" "PluginToolDecision" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginToolPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginActivity" (
  "id" UUID NOT NULL,
  "installationId" UUID,
  "connectionId" UUID,
  "botId" UUID,
  "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginInvocation" (
  "id" UUID NOT NULL,
  "callId" TEXT NOT NULL,
  "connectionId" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "runId" UUID,
  "toolName" TEXT NOT NULL,
  "decision" "PluginToolDecision" NOT NULL,
  "status" "PluginInvocationStatus" NOT NULL DEFAULT 'running',
  "arguments" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PluginInvocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PluginInstallation_pluginKey_key" ON "PluginInstallation"("pluginKey");
CREATE INDEX "PluginInstallation_status_updatedAt_idx" ON "PluginInstallation"("status", "updatedAt");
CREATE UNIQUE INDEX "PluginConnection_installationId_connectorKey_alias_key" ON "PluginConnection"("installationId", "connectorKey", "alias");
CREATE INDEX "PluginConnection_status_updatedAt_idx" ON "PluginConnection"("status", "updatedAt");
CREATE INDEX "BotPluginEnablement_installationId_enabled_idx" ON "BotPluginEnablement"("installationId", "enabled");
CREATE INDEX "BotPluginConnectionGrant_connectionId_enabled_idx" ON "BotPluginConnectionGrant"("connectionId", "enabled");
CREATE UNIQUE INDEX "PluginToolPolicy_connectionId_botId_toolName_key" ON "PluginToolPolicy"("connectionId", "botId", "toolName");
CREATE INDEX "PluginToolPolicy_botId_connectionId_idx" ON "PluginToolPolicy"("botId", "connectionId");
CREATE INDEX "PluginActivity_createdAt_idx" ON "PluginActivity"("createdAt");
CREATE INDEX "PluginActivity_connectionId_createdAt_idx" ON "PluginActivity"("connectionId", "createdAt");
CREATE INDEX "PluginActivity_botId_createdAt_idx" ON "PluginActivity"("botId", "createdAt");
CREATE UNIQUE INDEX "PluginInvocation_callId_key" ON "PluginInvocation"("callId");
CREATE INDEX "PluginInvocation_botId_startedAt_idx" ON "PluginInvocation"("botId", "startedAt");
CREATE INDEX "PluginInvocation_connectionId_startedAt_idx" ON "PluginInvocation"("connectionId", "startedAt");
CREATE INDEX "PluginInvocation_runId_startedAt_idx" ON "PluginInvocation"("runId", "startedAt");

ALTER TABLE "PluginConnection" ADD CONSTRAINT "PluginConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginEnablement" ADD CONSTRAINT "BotPluginEnablement_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginEnablement" ADD CONSTRAINT "BotPluginEnablement_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginConnectionGrant" ADD CONSTRAINT "BotPluginConnectionGrant_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotPluginConnectionGrant" ADD CONSTRAINT "BotPluginConnectionGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginToolPolicy" ADD CONSTRAINT "PluginToolPolicy_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginToolPolicy" ADD CONSTRAINT "PluginToolPolicy_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "PluginInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginActivity" ADD CONSTRAINT "PluginActivity_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PluginConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginInvocation" ADD CONSTRAINT "PluginInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- >>> 20260827000600_subagent_attempts
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

-- >>> 20260827000700_memory_lifecycle
ALTER TABLE "Bot"
ADD COLUMN "episodeTurns" JSONB NOT NULL DEFAULT '[]';

-- >>> 20260828000100_grok_group_rounds
ALTER TABLE "ChannelRound"
ADD COLUMN "rootMessageId" UUID,
ADD COLUMN "roundIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "memberTurnOffset" INTEGER NOT NULL DEFAULT 0;

UPDATE "ChannelRound"
SET "rootMessageId" = "triggerMessageId"
WHERE "rootMessageId" IS NULL;

ALTER TABLE "ChannelRound"
ALTER COLUMN "rootMessageId" SET NOT NULL;

CREATE INDEX "ChannelRound_rootMessageId_roundIndex_idx"
ON "ChannelRound"("rootMessageId", "roundIndex");

-- >>> 20260828000200_context_compaction_parity
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

-- >>> 20260828000300_context_prompt_snapshot_repair
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

-- >>> 20260829000100_grok_filesystem_runtime_parity
-- Grok Bot runs every agent, group, routine, A2A wake, and subagent in the
-- shared /workspace root. Existing OpenTeam rows are migrated in place.
UPDATE "Bot" SET "defaultDirectory" = '/workspace';
UPDATE "Channel" SET "workingDirectory" = '/workspace' WHERE "kind" = 'group';
UPDATE "Project" SET "workingDirectory" = '/workspace';

-- The computer user and model-visible data paths now match the Grok box.
UPDATE "Bot"
SET "avatarPath" = replace("avatarPath", '/home/openteam/agent-data', '/home/box/agent-data')
WHERE "avatarPath" LIKE '/home/openteam/agent-data/%';
UPDATE "Bot"
SET "runtimeSessionPath" = replace("runtimeSessionPath", '/home/openteam/.pi', '/home/box/.pi')
WHERE "runtimeSessionPath" LIKE '/home/openteam/.pi/%';
UPDATE "ContextSession"
SET "runtimeSessionPath" = replace("runtimeSessionPath", '/home/openteam/.pi', '/home/box/.pi')
WHERE "runtimeSessionPath" LIKE '/home/openteam/.pi/%';
UPDATE "AgentFileState"
SET "path" = replace("path", '/home/openteam/agent-data', '/home/box/agent-data')
WHERE "path" LIKE '/home/openteam/agent-data/%';

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

-- >>> 20260829000200_plugin_runtime_parity
ALTER TABLE "PluginConnection"
ADD COLUMN "configuration" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "credentials" JSONB NOT NULL DEFAULT '{}';

-- >>> 20260829000300_group_profiles
ALTER TABLE "Channel"
ADD COLUMN "description" TEXT NOT NULL DEFAULT '';

-- >>> 20260829000400_group_avatars
ALTER TABLE "Channel"
ADD COLUMN "avatarPath" TEXT;

-- >>> 20260829000500_group_routines
ALTER TABLE "Routine"
  ALTER COLUMN "botId" DROP NOT NULL,
  ADD COLUMN "channelId" UUID;

ALTER TABLE "RoutineExecution"
  ADD COLUMN "channelMessageId" UUID;

ALTER TABLE "Routine"
  ADD CONSTRAINT "Routine_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoutineExecution"
  ADD CONSTRAINT "RoutineExecution_channelMessageId_fkey"
  FOREIGN KEY ("channelMessageId") REFERENCES "ChannelMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Routine"
  ADD CONSTRAINT "Routine_exactly_one_owner_check"
  CHECK (("botId" IS NOT NULL) <> ("channelId" IS NOT NULL));

CREATE INDEX "Routine_channelId_deletedAt_updatedAt_idx"
  ON "Routine"("channelId", "deletedAt", "updatedAt");

CREATE UNIQUE INDEX "Routine_channelId_slug_key"
  ON "Routine"("channelId", "slug");

CREATE UNIQUE INDEX "RoutineExecution_channelMessageId_key"
  ON "RoutineExecution"("channelMessageId");

-- >>> 20260830000100_push_notifications
CREATE TYPE "PushDevicePlatform" AS ENUM ('ios', 'android');

CREATE TABLE "PushDevice" (
    "id" UUID NOT NULL,
    "installationId" TEXT NOT NULL,
    "platform" "PushDevicePlatform" NOT NULL,
    "pushToken" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeZone" TEXT,
    "locale" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDevice_installationId_key" ON "PushDevice"("installationId");
CREATE UNIQUE INDEX "PushDevice_pushToken_key" ON "PushDevice"("pushToken");
CREATE INDEX "PushDevice_enabled_platform_lastSeenAt_idx" ON "PushDevice"("enabled", "platform", "lastSeenAt");

-- >>> 20260830000200_channel_read_state
CREATE TABLE "ChannelReadState" (
    "channelId" UUID NOT NULL,
    "lastReadSequence" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelReadState_pkey" PRIMARY KEY ("channelId")
);

INSERT INTO "ChannelReadState" ("channelId", "lastReadSequence", "createdAt", "updatedAt")
SELECT
    channel_row."id",
    COALESCE(MAX(message_row."sequence"), 0),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Channel" AS channel_row
LEFT JOIN "ChannelMessage" AS message_row ON message_row."channelId" = channel_row."id"
GROUP BY channel_row."id";

ALTER TABLE "ChannelReadState"
ADD CONSTRAINT "ChannelReadState_channelId_fkey"
FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- >>> 20260831000100_better_auth
CREATE TABLE "user" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "image" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "username" TEXT,
  CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3),
  "refreshTokenExpiresAt" TIMESTAMP(3),
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");
CREATE INDEX "session_userId_idx" ON "session"("userId");
CREATE INDEX "account_userId_idx" ON "account"("userId");
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

ALTER TABLE "session"
  ADD CONSTRAINT "session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account"
  ADD CONSTRAINT "account_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- >>> 20260831000100_timeline_event_runs
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'event';

-- >>> 20260831000200_wake_source_parity
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'background_revival';
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'handoff_resume';
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'broadcast';

-- >>> 20260831000300_search_attachment_group_routines
-- Keep the bounded GIN-backed search projection aligned with canonical AssetRef
-- attachments and routines owned by either a Bot or a group channel.
CREATE OR REPLACE FUNCTION openteam_refresh_routine_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'routine' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."deletedAt" IS NULL THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'routine:' || NEW."id", 'routine', 'routine', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."botId", NEW."name", NEW."scheduleText", NEW."prompt",
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openteam_refresh_message_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attachment JSONB;
  attachment_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  -- Reactions and unrelated metadata do not affect search. A custom session
  -- setting bypasses this guard only for the bounded migration backfill below.
  IF TG_OP = 'UPDATE'
    AND coalesce(current_setting('openteam.search_reindex', true), '0') <> '1'
    AND NEW."content" IS NOT DISTINCT FROM OLD."content"
    AND (NEW."metadata"::jsonb -> 'attachments')
      IS NOT DISTINCT FROM (OLD."metadata"::jsonb -> 'attachments')
    AND (NEW."metadata"::jsonb -> 'images')
      IS NOT DISTINCT FROM (OLD."metadata"::jsonb -> 'images') THEN
    RETURN NEW;
  END IF;

  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel_message' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF btrim(NEW."content") <> '' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
      "title", "content", "createdAt", "updatedAt"
    ) VALUES (
      'message:' || NEW."id", 'message', 'channel_message', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."id", NEW."senderBotId", NEW."content", '',
      NEW."createdAt", NEW."createdAt"
    );

    FOR matched IN
      SELECT DISTINCT regexp_matches(NEW."content", 'https?://[^[:space:]<>"'']+', 'gi')
    LOOP
      clean_url := regexp_replace(matched[1], '[.,;:!?)}\]]+$', '');
      IF clean_url <> '' THEN
        INSERT INTO "SearchDocument" (
          "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
          "title", "subtitle", "content", "url", "createdAt", "updatedAt"
        ) VALUES (
          'link:' || NEW."id" || ':' || md5(clean_url), 'link', 'channel_message', NEW."id",
          NEW."id"::text || ':' || md5(clean_url), NEW."channelId", NEW."id", NEW."senderBotId",
          clean_url, 'Shared link', '', clean_url, NEW."createdAt", NEW."createdAt"
        ) ON CONFLICT ("id") DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- Canonical attachments win when both shapes are present so compatibility
  -- promotion cannot create duplicate file results.
  IF jsonb_typeof(NEW."metadata"::jsonb -> 'attachments') = 'array'
    AND jsonb_array_length(NEW."metadata"::jsonb -> 'attachments') > 0 THEN
    FOR attachment IN
      SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'attachments')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || attachment_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || attachment_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(attachment ->> 'fileName', ''), NULLIF(attachment ->> 'alt', ''), 'Attachment'),
        concat_ws(' · ', NULLIF(attachment ->> 'kind', ''), NULLIF(attachment ->> 'mimeType', '')),
        coalesce(attachment ->> 'alt', ''),
        CASE
          WHEN attachment ->> 'assetId' ~ '^[a-f0-9]{64}$'
            THEN '/api/v0/assets/' || (attachment ->> 'assetId')
          ELSE NULL
        END,
        NEW."createdAt", NEW."createdAt"
      );
      attachment_index := attachment_index + 1;
    END LOOP;
  ELSIF jsonb_typeof(NEW."metadata"::jsonb -> 'images') = 'array' THEN
    FOR attachment IN SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'images')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || attachment_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || attachment_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(attachment ->> 'alt', ''), 'Image attachment'), 'Image', '',
        CASE WHEN attachment ->> 'url' ~* '^https?://' THEN attachment ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      attachment_index := attachment_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- Existing routines predate channel ownership in the original projection.
UPDATE "Routine" SET "name" = "name";

-- Rebuild message/file/link documents once while leaving user metadata intact.
SELECT set_config('openteam.search_reindex', '1', false);
UPDATE "ChannelMessage" SET "content" = "content";
SELECT set_config('openteam.search_reindex', '0', false);

ANALYZE "SearchDocument";

-- >>> 20260831000400_event_delivery_and_search_cleanup
-- Search ranking still rewards title prefixes inside the bounded GIN candidate
-- set, but no query uses this standalone 26 MiB candidate index.
DROP INDEX IF EXISTS "SearchDocument_title_prefix_idx";

-- Wake every server-side SSE listener when a transaction publishes an event.
-- pg_notify is delivered only after commit, so consumers never race an
-- uncommitted row.
CREATE OR REPLACE FUNCTION openteam_notify_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The listener only needs a wakeup. An identical payload lets PostgreSQL
  -- coalesce many Event inserts from one transaction into one notification.
  PERFORM pg_notify('openteam_events', '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS openteam_event_notify ON "Event";
CREATE TRIGGER openteam_event_notify
AFTER INSERT ON "Event"
FOR EACH ROW EXECUTE FUNCTION openteam_notify_event();

-- >>> 20260831000500_search_exact_title_lane
-- Exact-title results must not disappear merely because they are older than
-- the bounded recent FTS ranking window. Index a fixed-size digest rather than
-- every potentially long title; the query always rechecks the complete title.
CREATE INDEX IF NOT EXISTS "SearchDocument_title_exact_hash_idx"
  ON "SearchDocument" (md5(lower("title")));

ANALYZE "SearchDocument";

-- >>> 20260831000600_connector_run_origin
ALTER TYPE "RunOrigin" ADD VALUE IF NOT EXISTS 'connector';

-- >>> 20260831000700_push_device_session_binding
-- Existing registrations default to auth-required with no session binding. This is
-- deliberately fail-closed: they resume only after the app re-registers against
-- either a live authenticated session or an explicitly auth-disabled server.
ALTER TABLE "PushDevice"
ADD COLUMN "authRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "authSessionId" TEXT;

ALTER TABLE "PushDevice"
ADD CONSTRAINT "PushDevice_authSessionId_fkey"
FOREIGN KEY ("authSessionId") REFERENCES "session"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PushDevice_enabled_authRequired_authSessionId_idx"
ON "PushDevice"("enabled", "authRequired", "authSessionId");

-- >>> 20260901000100_group_sidebar_lifecycle
ALTER TABLE "Channel"
ADD COLUMN "hiddenFromSidebar" BOOLEAN NOT NULL DEFAULT false;

-- Hidden agents remain addressable and discoverable through Cmd-K, matching
-- the desktop Hidden Bots overlay. Hiding changes sidebar presentation only.
CREATE OR REPLACE FUNCTION openteam_refresh_bot_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'bot' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."status" <> 'archived' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id",
      NEW."name", coalesce(NULLIF(NEW."title", ''), ''),
      concat_ws(' ', NEW."description", NEW."instructions"),
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'bot:' || "id", 'bot', 'bot', "id", "id"::text, "id",
  "name", coalesce(NULLIF("title", ''), ''),
  concat_ws(' ', "description", "instructions"), "createdAt", "updatedAt"
FROM "Bot"
WHERE "status" <> 'archived'
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title",
  "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content",
  "updatedAt" = EXCLUDED."updatedAt";

-- >>> 20260902000100_inference_provider_cleanup
ALTER TABLE "Bot" RENAME COLUMN "runtimeProvider" TO "runtimeEngine";

ALTER TABLE "Bot"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;

DROP INDEX IF EXISTS "Conversation_codexThreadId_key";

ALTER TABLE "Conversation"
DROP COLUMN "codexThreadId",
DROP COLUMN "codexSessionId";

ALTER TABLE "ContextSession"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;

ALTER TABLE "Run"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;

