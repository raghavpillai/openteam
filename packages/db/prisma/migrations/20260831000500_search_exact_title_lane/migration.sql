-- Exact-title results must not disappear merely because they are older than
-- the bounded recent FTS ranking window. Index a fixed-size digest rather than
-- every potentially long title; the query always rechecks the complete title.
CREATE INDEX IF NOT EXISTS "SearchDocument_title_exact_hash_idx"
  ON "SearchDocument" (md5(lower("title")));

ANALYZE "SearchDocument";
