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
