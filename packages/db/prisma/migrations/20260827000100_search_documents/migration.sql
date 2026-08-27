-- Search is deliberately kept outside the client snapshot. This compact projection is
-- maintained transactionally by PostgreSQL and queried through one bounded endpoint.
CREATE TABLE "SearchDocument" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" UUID NOT NULL,
  "entityId" TEXT NOT NULL,
  "channelId" UUID,
  "messageId" UUID,
  "botId" UUID,
  "title" TEXT NOT NULL DEFAULT '',
  "subtitle" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "url" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "searchVector" TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("subtitle", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("content", '')), 'C')
  ) STORED,
  CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchDocument_kind_check" CHECK (
    "kind" IN ('message', 'bot', 'channel', 'file', 'link', 'routine')
  )
);

CREATE INDEX "SearchDocument_searchVector_idx"
  ON "SearchDocument" USING GIN ("searchVector");
CREATE INDEX "SearchDocument_kind_updatedAt_idx"
  ON "SearchDocument" ("kind", "updatedAt" DESC);
CREATE INDEX "SearchDocument_source_idx"
  ON "SearchDocument" ("sourceType", "sourceId");
CREATE INDEX "SearchDocument_title_prefix_idx"
  ON "SearchDocument" (lower("title") text_pattern_ops);

CREATE OR REPLACE FUNCTION openbot_refresh_bot_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'bot' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."status" <> 'archived' AND NOT NEW."hiddenFromSidebar" THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id",
      NEW."name", coalesce(NULLIF(NEW."title", ''), ''), concat_ws(' ', NEW."description", NEW."instructions"),
      NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openbot_refresh_channel_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'channel' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."archivedAt" IS NULL AND NEW."kind" = 'group' THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "channelId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'channel:' || NEW."id", 'channel', 'channel', NEW."id", NEW."id"::text, NEW."id",
      NEW."name",
      CASE NEW."kind" WHEN 'group' THEN 'Channel' WHEN 'agent_dm' THEN 'Bot conversation' ELSE 'Chat' END,
      coalesce(NEW."workingDirectory", ''), NEW."createdAt", NEW."updatedAt"
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION openbot_refresh_routine_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "SearchDocument"
  WHERE "sourceType" = 'routine' AND "sourceId" = COALESCE(NEW."id", OLD."id");

  IF TG_OP <> 'DELETE' AND NEW."deletedAt" IS NULL THEN
    INSERT INTO "SearchDocument" (
      "id", "kind", "sourceType", "sourceId", "entityId", "botId",
      "title", "subtitle", "content", "createdAt", "updatedAt"
    ) VALUES (
      'routine:' || NEW."id", 'routine', 'routine', NEW."id", NEW."id"::text, NEW."botId",
      NEW."name", NEW."scheduleText", NEW."prompt", NEW."createdAt", NEW."updatedAt"
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
  image JSONB;
  image_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
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
      NEW."channelId", NEW."id", NEW."senderBotId", NEW."content", NEW."content",
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
          clean_url, 'Shared link', NEW."content", clean_url, NEW."createdAt", NEW."createdAt"
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
        coalesce(NULLIF(image ->> 'alt', ''), 'Image attachment'), 'Image',
        coalesce(image ->> 'alt', ''),
        CASE WHEN image ->> 'url' ~* '^https?://' THEN image ->> 'url' ELSE NULL END,
        NEW."createdAt", NEW."createdAt"
      );
      image_index := image_index + 1;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Bot_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Bot"
FOR EACH ROW EXECUTE FUNCTION openbot_refresh_bot_search();

CREATE TRIGGER "Channel_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Channel"
FOR EACH ROW EXECUTE FUNCTION openbot_refresh_channel_search();

CREATE TRIGGER "Routine_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "Routine"
FOR EACH ROW EXECUTE FUNCTION openbot_refresh_routine_search();

CREATE TRIGGER "ChannelMessage_search_refresh"
AFTER INSERT OR UPDATE OR DELETE ON "ChannelMessage"
FOR EACH ROW EXECUTE FUNCTION openbot_refresh_message_search();

-- Backfill after the triggers exist so future concurrent writes remain covered.
INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'bot:' || "id", 'bot', 'bot', "id", "id"::text, "id",
  "name", coalesce(NULLIF("title", ''), ''), concat_ws(' ', "description", "instructions"), "createdAt", "updatedAt"
FROM "Bot"
WHERE "status" <> 'archived' AND NOT "hiddenFromSidebar"
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "channelId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'channel:' || "id", 'channel', 'channel', "id", "id"::text, "id",
  "name",
  CASE "kind" WHEN 'group' THEN 'Channel' WHEN 'agent_dm' THEN 'Bot conversation' ELSE 'Chat' END,
  coalesce("workingDirectory", ''), "createdAt", "updatedAt"
FROM "Channel"
WHERE "archivedAt" IS NULL AND "kind" = 'group'
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "SearchDocument" (
  "id", "kind", "sourceType", "sourceId", "entityId", "botId",
  "title", "subtitle", "content", "createdAt", "updatedAt"
)
SELECT
  'routine:' || "id", 'routine', 'routine', "id", "id"::text, "botId",
  "name", "scheduleText", "prompt", "createdAt", "updatedAt"
FROM "Routine"
WHERE "deletedAt" IS NULL
ON CONFLICT ("id") DO UPDATE SET
  "title" = EXCLUDED."title", "subtitle" = EXCLUDED."subtitle",
  "content" = EXCLUDED."content", "updatedAt" = EXCLUDED."updatedAt";

-- Calling the trigger function through a harmless update keeps attachment/link extraction in one place.
UPDATE "ChannelMessage" SET "content" = "content";
