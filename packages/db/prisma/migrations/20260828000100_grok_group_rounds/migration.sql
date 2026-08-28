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
