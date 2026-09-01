ALTER TABLE "Channel"
ADD COLUMN "hiddenFromSidebar" BOOLEAN NOT NULL DEFAULT false;

-- Hidden agents remain addressable and discoverable through Cmd-K, matching
-- the desktop Hidden Bots overlay. Hiding changes sidebar presentation only.
CREATE OR REPLACE FUNCTION openbot_refresh_bot_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'bot' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."status" <> 'archived' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id",
      NEW."name", coalesce(NULLIF(NEW."title", ''), ''),
      concat_ws(' ', NEW."description", NEW."instructions"),
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'bot:' || "id", 'bot', 'bot', "id", "id"::text, "id",
  "name", coalesce(NULLIF("title", ''), ''),
  concat_ws(' ', "description", "instructions"), "createdAt", "updatedAt"
FROM "Bot"
WHERE "status" <> 'archived'
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title",
  "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content",
  "updatedAt" = EXCLUDED."updatedAt";
