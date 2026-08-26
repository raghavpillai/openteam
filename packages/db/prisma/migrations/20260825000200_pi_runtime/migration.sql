ALTER TABLE "Bot"
ADD COLUMN "runtimeProvider" TEXT NOT NULL DEFAULT 'pi',
ADD COLUMN "runtimeSessionId" TEXT,
ADD COLUMN "runtimeSessionPath" TEXT;

CREATE UNIQUE INDEX "Bot_runtimeSessionId_key" ON "Bot"("runtimeSessionId");
CREATE UNIQUE INDEX "Bot_runtimeSessionPath_key" ON "Bot"("runtimeSessionPath");

ALTER TABLE "Run" RENAME COLUMN "codexTurnId" TO "runtimeTurnId";
