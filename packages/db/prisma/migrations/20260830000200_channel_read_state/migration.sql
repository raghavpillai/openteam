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
