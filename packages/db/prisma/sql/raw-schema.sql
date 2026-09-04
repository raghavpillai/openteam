-- Database objects Prisma's schema language cannot express.
--
-- `prisma db push` creates everything declared in schema.prisma. This file adds the
-- rest: the search projection table and its trigger-maintained refresh functions, the
-- event wakeup notifier, and the check constraints and defaults Prisma does not model.
--
-- It runs after every `db push` (see packages/db/scripts/apply-raw-schema.ts) and must
-- stay idempotent: re-running it on an up-to-date database is a no-op.

-- Search projection -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "SearchDocument" (
    "id" text NOT NULL,
    "kind" text NOT NULL,
    "sourceType" text NOT NULL,
    "sourceId" uuid NOT NULL,
    "entityId" text NOT NULL,
    "channelId" uuid,
    "messageId" uuid,
    "botId" uuid,
    "title" text DEFAULT ''::text NOT NULL,
    "subtitle" text DEFAULT ''::text NOT NULL,
    "content" text DEFAULT ''::text NOT NULL,
    "url" text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple'::regconfig, COALESCE("title", ''::text)), 'A'::"char") ||
      setweight(to_tsvector('simple'::regconfig, COALESCE("subtitle", ''::text)), 'B'::"char") ||
      setweight(to_tsvector('simple'::regconfig, COALESCE("content", ''::text)), 'C'::"char")
    ) STORED,
    CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id")
);

-- Prisma creates this table on fresh databases now that its introspected shape
-- is declared in schema.prisma, but it cannot express the generated tsvector
-- column or the kind constraint.
DO $openteam$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'SearchDocument'
      AND column_name = 'searchVector'
      AND is_generated <> 'ALWAYS'
  ) THEN
    ALTER TABLE "SearchDocument" DROP COLUMN "searchVector";
  END IF;
END
$openteam$;

ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, COALESCE("title", ''::text)), 'A'::"char") ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("subtitle", ''::text)), 'B'::"char") ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("content", ''::text)), 'C'::"char")
  ) STORED;

ALTER TABLE "SearchDocument" DROP CONSTRAINT IF EXISTS "SearchDocument_kind_check";
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_kind_check" CHECK (
  "kind" = ANY (ARRAY['message'::text, 'bot'::text, 'channel'::text, 'file'::text, 'link'::text, 'routine'::text])
);

CREATE INDEX IF NOT EXISTS "SearchDocument_kind_updatedAt_idx" ON "SearchDocument" USING btree ("kind", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "SearchDocument_searchVector_idx" ON "SearchDocument" USING gin ("searchVector");
CREATE INDEX IF NOT EXISTS "SearchDocument_source_idx" ON "SearchDocument" USING btree ("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "SearchDocument_title_exact_hash_idx" ON "SearchDocument" USING btree (md5(lower("title")));

-- Constraints and defaults Prisma does not model -------------------------------------

-- A routine belongs to exactly one owner: a bot or a channel, never both or neither.
ALTER TABLE "Routine" DROP CONSTRAINT IF EXISTS "Routine_exactly_one_owner_check";
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_exactly_one_owner_check"
  CHECK (("botId" IS NOT NULL) <> ("channelId" IS NOT NULL));

ALTER TABLE "SubagentAttempt" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- Trigger functions ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.openteam_notify_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The listener only needs a wakeup. An identical payload lets PostgreSQL
  -- coalesce many Event inserts from one transaction into one notification.
  PERFORM pg_notify('openteam_events', '');
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.openteam_refresh_bot_search()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.openteam_refresh_channel_search()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.openteam_refresh_message_search()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  attachment JSONB;
  attachment_index INTEGER := 0;
  matched TEXT[];
  clean_url TEXT;
BEGIN
  -- Reactions and unrelated metadata do not affect search. A custom session
  -- setting bypasses this guard only for the bounded migration backfill below.
  IF TG_OP = 'UPDATE'
    AND coalesce(current_setting('openteam.search_reindex', true), '0') <> '1'
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
$function$
;
CREATE OR REPLACE FUNCTION public.openteam_refresh_routine_search()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

-- Triggers ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS "Bot_search_refresh" ON "Bot";
CREATE TRIGGER "Bot_search_refresh" AFTER INSERT OR DELETE OR UPDATE ON "Bot"
  FOR EACH ROW EXECUTE FUNCTION openteam_refresh_bot_search();

DROP TRIGGER IF EXISTS "Channel_search_refresh" ON "Channel";
CREATE TRIGGER "Channel_search_refresh" AFTER INSERT OR DELETE OR UPDATE ON "Channel"
  FOR EACH ROW EXECUTE FUNCTION openteam_refresh_channel_search();

DROP TRIGGER IF EXISTS "Routine_search_refresh" ON "Routine";
CREATE TRIGGER "Routine_search_refresh" AFTER INSERT OR DELETE OR UPDATE ON "Routine"
  FOR EACH ROW EXECUTE FUNCTION openteam_refresh_routine_search();

DROP TRIGGER IF EXISTS "ChannelMessage_search_refresh" ON "ChannelMessage";
CREATE TRIGGER "ChannelMessage_search_refresh" AFTER INSERT OR DELETE OR UPDATE ON "ChannelMessage"
  FOR EACH ROW EXECUTE FUNCTION openteam_refresh_message_search();

DROP TRIGGER IF EXISTS openteam_event_notify ON "Event";
CREATE TRIGGER openteam_event_notify AFTER INSERT ON "Event"
  FOR EACH ROW EXECUTE FUNCTION openteam_notify_event();
