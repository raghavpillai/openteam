ALTER TABLE "Bot" RENAME COLUMN "runtimeProvider" TO "runtimeEngine";

ALTER TABLE "Bot"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;

DROP INDEX IF EXISTS "Conversation_codexThreadId_key";

ALTER TABLE "Conversation"
DROP COLUMN "codexThreadId",
DROP COLUMN "codexSessionId";

ALTER TABLE "ContextSession"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;

ALTER TABLE "Run"
ADD COLUMN "inferenceProvider" TEXT,
ADD COLUMN "inferenceModel" TEXT;
