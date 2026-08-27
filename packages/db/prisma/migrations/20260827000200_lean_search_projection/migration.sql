-- Keep the full searchable text once. Message titles are already indexed at weight A,
-- so duplicating them into content doubles both heap and GIN projection work. Links
-- and attachment names likewise contain all text needed for their own result types.
CREATE OR REPLACE FUNCTION openbot_refresh_message_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  image JSONB;
  image_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  -- Reactions and unrelated metadata do not affect search. Avoid deleting and
  -- rebuilding every projection row when only those fields change.
  IF TG_OP = 'UPDATE'
    AND NEW."content" IS NOT DISTINCT FROM OLD."content"
    AND (NEW."metadata"::jsonb -> 'images')
      IS NOT DISTINCT FROM (OLD."metadata"::jsonb -> 'images') THEN
    RETURN NEW;
  END IF;

  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel_message' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF btrim(NEW."content") <> '' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
      "title", "content", "createdAt", "updatedAt"
    ) VALUES (
      'message:' || NEW."id", 'message', 'channel_message', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."id", NEW."senderBotId", NEW."content", '',
      NEW."createdAt", NEW."createdAt"
    );

    FOR matched IN
      SELECT DISTINCT regexp_matches(NEW."content", 'https?://[^[:space:]<>"'']+', 'gi')
    LOOP
      clean_url := regexp_replace(matched[1], '[.,;:!?)}\]]+$', '');
      IF clean_url <> '' THEN
        INSERT INTO "SearchDocument" (
          "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
          "title", "subtitle", "content", "url", "createdAt", "updatedAt"
        ) VALUES (
          'link:' || NEW."id" || ':' || md5(clean_url), 'link', 'channel_message', NEW."id",
          NEW."id"::text || ':' || md5(clean_url), NEW."channelId", NEW."id", NEW."senderBotId",
          clean_url, 'Shared link', '', clean_url, NEW."createdAt", NEW."createdAt"
        ) ON CONFLICT ("id") DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(NEW."metadata"::jsonb -> 'images') = 'array' THEN
    FOR image IN SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'images')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || image_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || image_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(image ->> 'alt', ''), 'Image attachment'), 'Image', '',
        CASE WHEN image ->> 'url' ~* '^https?://' THEN image ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      image_index := image_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

UPDATE "SearchDocument"
SET "content" = ''
WHERE "kind" IN ('message', 'file', 'link') AND "content" <> '';

ANALYZE "SearchDocument";
