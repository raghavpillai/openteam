ALTER TABLE "Channel" ADD COLUMN "workingDirectory" TEXT;

UPDATE "Channel"
SET "workingDirectory" = '/workspace/projects/group-' || substring("id"::text from 1 for 8)
WHERE "kind" = 'group';
