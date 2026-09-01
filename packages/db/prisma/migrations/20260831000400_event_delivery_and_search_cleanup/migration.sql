-- Search ranking still rewards title prefixes inside the bounded GIN candidate
-- set, but no query uses this standalone 26 MiB candidate index.
DROP INDEX IF EXISTS "SearchDocument_title_prefix_idx";

-- Wake every server-side SSE listener when a transaction publishes an event.
-- pg_notify is delivered only after commit, so consumers never race an
-- uncommitted row.
CREATE OR REPLACE FUNCTION openbot_notify_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The listener only needs a wakeup. An identical payload lets PostgreSQL
  -- coalesce many Event inserts from one transaction into one notification.
  PERFORM pg_notify('openbot_events', '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS openbot_event_notify ON "Event";
CREATE TRIGGER openbot_event_notify
AFTER INSERT ON "Event"
FOR EACH ROW EXECUTE FUNCTION openbot_notify_event();
