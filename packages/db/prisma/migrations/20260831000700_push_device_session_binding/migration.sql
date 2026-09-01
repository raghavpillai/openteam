-- Existing registrations default to auth-required with no session binding. This is
-- deliberately fail-closed: they resume only after the app re-registers against
-- either a live authenticated session or an explicitly auth-disabled server.
ALTER TABLE "PushDevice"
ADD COLUMN "authRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "authSessionId" TEXT;

ALTER TABLE "PushDevice"
ADD CONSTRAINT "PushDevice_authSessionId_fkey"
FOREIGN KEY ("authSessionId") REFERENCES "session"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PushDevice_enabled_authRequired_authSessionId_idx"
ON "PushDevice"("enabled", "authRequired", "authSessionId");
