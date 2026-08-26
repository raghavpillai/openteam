CREATE TYPE "InboxDeliveryMode" AS ENUM ('turn', 'steer');

ALTER TABLE "InboxEvent"
ADD COLUMN "deliveryMode" "InboxDeliveryMode" NOT NULL DEFAULT 'turn';

CREATE INDEX "InboxEvent_botId_deliveryMode_status_idx"
ON "InboxEvent"("botId", "deliveryMode", "status");
