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
