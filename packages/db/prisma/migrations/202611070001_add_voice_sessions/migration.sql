CREATE TYPE "VoiceSessionStatus" AS ENUM ('created', 'active', 'closing', 'ended', 'failed');
CREATE TYPE "VoiceTurnStatus" AS ENUM ('listening', 'processing', 'speaking', 'output_paused', 'completed', 'superseded', 'interrupted', 'cancelled', 'failed');

CREATE TABLE "VoiceSession" (
  "id" UUID NOT NULL,
  "botId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "ownerSessionId" TEXT,
  "clientPlatform" TEXT NOT NULL,
  "clientInstanceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" "VoiceSessionStatus" NOT NULL DEFAULT 'created',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "closeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VoiceTurn" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "runId" UUID,
  "userMessageId" TEXT,
  "status" "VoiceTurnStatus" NOT NULL DEFAULT 'listening',
  "transcript" TEXT,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "language" TEXT,
  "providerMetadata" JSONB,
  "assistantMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "generation" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceTurn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VoiceTurn_runId_key" ON "VoiceTurn"("runId");
CREATE INDEX "VoiceSession_ownerSessionId_status_expiresAt_idx" ON "VoiceSession"("ownerSessionId", "status", "expiresAt");
CREATE INDEX "VoiceSession_botId_status_expiresAt_idx" ON "VoiceSession"("botId", "status", "expiresAt");
CREATE INDEX "VoiceSession_channelId_createdAt_idx" ON "VoiceSession"("channelId", "createdAt");
CREATE INDEX "VoiceTurn_sessionId_createdAt_idx" ON "VoiceTurn"("sessionId", "createdAt");
CREATE INDEX "VoiceTurn_sessionId_status_idx" ON "VoiceTurn"("sessionId", "status");
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_ownerSessionId_fkey" FOREIGN KEY ("ownerSessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceTurn" ADD CONSTRAINT "VoiceTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VoiceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceTurn" ADD CONSTRAINT "VoiceTurn_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
