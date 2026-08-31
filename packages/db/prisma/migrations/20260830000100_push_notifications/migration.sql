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
