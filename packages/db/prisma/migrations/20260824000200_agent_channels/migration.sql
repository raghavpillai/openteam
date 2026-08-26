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
