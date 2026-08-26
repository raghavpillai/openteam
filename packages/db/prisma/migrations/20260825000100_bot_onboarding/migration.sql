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
