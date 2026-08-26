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
  "name" TEXT NOT NULL DEFAULT 'OpenBot computer',
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
