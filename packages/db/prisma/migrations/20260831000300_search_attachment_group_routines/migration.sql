-- Keep the bounded GIN-backed search projection aligned with canonical AssetRef
-- attachments and routines owned by either a Bot or a group channel.
CREATE OR REPLACE FUNCTION openbot_refresh_routine_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'routine' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."deletedAt" IS NULL THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'routine:' || NEW."id", 'routine', 'routine', NEW."id", NEW."id"::text,
      NEW."channelId", NEW."botId", NEW."name", NEW."scheduleText", NEW."prompt",
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openbot_refresh_message_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attachment JSONB;
  attachment_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  -- Reactions and unrelated metadata do not affect search. A custom session
  -- setting bypasses this guard only for the bounded migration backfill below.
  IF TG_OP = 'UPDATE'
    AND coalesce(current_setting('openbot.search_reindex', true), '0') <> '1'
    AND NEW."content" IS NOT DISTINCT FROM OLD."content"
    AND (NEW."metadata"::jsonb -> 'attachments')
      IS NOT DISTINCT FROM (OLD."metadata"::jsonb -> 'attachments')
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

  -- Canonical attachments win when both shapes are present so compatibility
  -- promotion cannot create duplicate file results.
  IF jsonb_typeof(NEW."metadata"::jsonb -> 'attachments') = 'array'
    AND jsonb_array_length(NEW."metadata"::jsonb -> 'attachments') > 0 THEN
    FOR attachment IN
      SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'attachments')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || attachment_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || attachment_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(attachment ->> 'fileName', ''), NULLIF(attachment ->> 'alt', ''), 'Attachment'),
        concat_ws(' · ', NULLIF(attachment ->> 'kind', ''), NULLIF(attachment ->> 'mimeType', '')),
        coalesce(attachment ->> 'alt', ''),
        CASE
          WHEN attachment ->> 'assetId' ~ '^[a-f0-9]{64}$'
            THEN '/api/v0/assets/' || (attachment ->> 'assetId')
          ELSE NULL
        END,
        NEW."createdAt", NEW."createdAt"
      );
      attachment_index := attachment_index + 1;
    END LOOP;
  ELSIF jsonb_typeof(NEW."metadata"::jsonb -> 'images') = 'array' THEN
    FOR attachment IN SELECT value FROM jsonb_array_elements(NEW."metadata"::jsonb -> 'images')
    LOOP
      INSERT INTO "SearchDocument" (
        "id", "kind", "sourceType", "sourceId", "entityId", "channelId", "messageId", "botId",
        "title", "subtitle", "content", "url", "createdAt", "updatedAt"
      ) VALUES (
        'file:' || NEW."id" || ':' || attachment_index, 'file', 'channel_message', NEW."id",
        NEW."id"::text || ':' || attachment_index, NEW."channelId", NEW."id", NEW."senderBotId",
        coalesce(NULLIF(attachment ->> 'alt', ''), 'Image attachment'), 'Image', '',
        CASE WHEN attachment ->> 'url' ~* '^https?://' THEN attachment ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      attachment_index := attachment_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- Existing routines predate channel ownership in the original projection.
UPDATE "Routine" SET "name" = "name";

-- Rebuild message/file/link documents once while leaving user metadata intact.
SELECT set_config('openbot.search_reindex', '1', false);
UPDATE "ChannelMessage" SET "content" = "content";
SELECT set_config('openbot.search_reindex', '0', false);

ANALYZE "SearchDocument";
