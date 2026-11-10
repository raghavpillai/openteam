UPDATE "VoiceSettings"
SET "provider" = 'volcengine',
    "enabled" = false
WHERE "provider" = 'mock';

ALTER TABLE "VoiceSettings"
  ALTER COLUMN "provider" SET DEFAULT 'volcengine';

UPDATE "VoiceSession"
SET "status" = 'failed',
    "endedAt" = COALESCE("endedAt", CURRENT_TIMESTAMP),
    "closeReason" = COALESCE("closeReason", 'mock_provider_removed')
WHERE "provider" = 'mock'
  AND "status" IN ('created', 'active', 'closing');

UPDATE "VoiceSession"
SET "provider" = 'volcengine'
WHERE "provider" = 'mock';
