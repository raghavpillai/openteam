import type {
  SearchCategory,
  SearchResponse,
  SearchResultKind,
  SearchResultView,
} from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import { Effect } from "effect";

const RESULT_LIMIT = 24;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TERMS = 8;

type SearchRow = {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  channelId: string | null;
  messageId: string | null;
  botId: string | null;
  url: string | null;
  createdAt: Date;
};

const categoryKind = (category: SearchCategory): SearchResultKind | null => {
  switch (category) {
    case "messages":
      return "message";
    case "bots":
      return "bot";
    case "channels":
      return "channel";
    case "files":
      return "file";
    case "links":
      return "link";
    case "routines":
      return "routine";
    default:
      return null;
  }
};

/** Keep parsing deterministic and safe for PostgreSQL's to_tsquery syntax. */
export const normalizeSearchQuery = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);

export const prefixTsQuery = (value: string) =>
  (normalizeSearchQuery(value).match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, MAX_QUERY_TERMS)
    // A one-character prefix can expand to most of the lexicon. Exact matching keeps
    // that first keystroke cheap; normal prefix matching starts at two characters.
    .map((term) => (term.length === 1 ? term : `${term}:*`))
    .join(" & ");

export class SearchService {
  constructor(private readonly prisma: PrismaClient) {}

  search = (query: string, category: SearchCategory) =>
    Effect.tryPromise({
      try: async (): Promise<SearchResponse> => {
        const normalized = normalizeSearchQuery(query);
        const tsQuery = prefixTsQuery(normalized);
        const kind = categoryKind(category);

        // An empty Messages view is intentionally a prompt, not a dump of the transcript.
        if (category === "messages" && !normalized) return { query: normalized, results: [] };
        if (normalized && !tsQuery) return { query: normalized, results: [] };

        const rows = await this.prisma.$queryRaw<SearchRow[]>`
          WITH search_input AS MATERIALIZED (
            SELECT
              to_tsquery('simple', NULLIF(${tsQuery}, '')) AS query,
              ${normalized}::text AS normalized
          ),
          ranked AS MATERIALIZED (
            SELECT
              document."id",
              document."kind",
              document."title",
              document."subtitle",
              document."channelId",
              document."messageId",
              document."botId",
              document."url",
              document."createdAt",
              document."updatedAt",
              CASE WHEN search_input.query IS NULL THEN 0 ELSE
                ts_rank_cd(document."searchVector", search_input.query, 32)
              END +
              CASE
                WHEN lower(document."title") = lower(search_input.normalized)
                  AND search_input.normalized <> '' THEN 4
                WHEN lower(document."title") LIKE lower(search_input.normalized) || '%'
                  AND search_input.normalized <> '' THEN 1.5
                ELSE 0
              END AS score
            FROM "SearchDocument" AS document
            CROSS JOIN search_input
            WHERE (${kind}::text IS NULL OR document."kind" = ${kind})
              AND (
                search_input.normalized <> '' OR ${category} <> 'all' OR
                document."kind" IN ('bot', 'channel', 'routine')
              )
              AND (
                search_input.query IS NULL OR
                document."searchVector" @@ search_input.query
              )
              AND (
                document."kind" NOT IN ('message', 'channel', 'file', 'link') OR
                EXISTS (
                  SELECT 1
                  FROM "Channel" AS visible_channel
                  INNER JOIN "ChannelMember" AS visible_member
                    ON visible_member."channelId" = visible_channel."id"
                  INNER JOIN "Bot" AS visible_bot ON visible_bot."id" = visible_member."botId"
                  WHERE visible_channel."id" = document."channelId"
                    AND visible_channel."archivedAt" IS NULL
                    AND visible_bot."status" <> 'archived'
                    AND NOT visible_bot."hiddenFromSidebar"
                    AND NOT EXISTS (
                      SELECT 1 FROM "Subagent" AS visible_subagent
                      WHERE visible_subagent."childBotId" = visible_bot."id"
                    )
                )
              )
              AND (
                document."kind" NOT IN ('bot', 'routine') OR
                EXISTS (
                  SELECT 1
                  FROM "Bot" AS visible_owner
                  WHERE visible_owner."id" = document."botId"
                    AND visible_owner."status" <> 'archived'
                    AND NOT visible_owner."hiddenFromSidebar"
                    AND NOT EXISTS (
                      SELECT 1 FROM "Subagent" AS owner_subagent
                      WHERE owner_subagent."childBotId" = visible_owner."id"
                    )
                )
              )
            ORDER BY score DESC, document."updatedAt" DESC, document."id" ASC
            LIMIT ${RESULT_LIMIT}
          )
          SELECT
            document."id",
            document."kind",
            left(regexp_replace(document."title", '\\s+', ' ', 'g'), 280) AS "title",
            left(
              CASE document."kind"
                WHEN 'message' THEN
                  CASE channel."kind"
                    WHEN 'bot_dm' THEN
                      CASE
                        WHEN document."botId" IS NOT NULL THEN coalesce(bot."name", 'Bot') || ' to you'
                        ELSE 'You to ' || channel."name"
                      END
                    ELSE concat_ws(' in ',
                      CASE
                        WHEN document."botId" IS NOT NULL THEN coalesce(bot."name", 'Bot')
                        ELSE 'You'
                      END,
                      channel."name"
                    )
                  END
                WHEN 'file' THEN concat_ws(' · ', channel."name", document."subtitle")
                WHEN 'link' THEN concat_ws(' · ', channel."name", document."subtitle")
                WHEN 'routine' THEN concat_ws(' · ', bot."name", document."subtitle")
                ELSE document."subtitle"
              END,
              180
            ) AS "subtitle",
            CASE
              WHEN document."kind" IN ('bot', 'routine') THEN direct_channel."channelId"
              ELSE document."channelId"
            END AS "channelId",
            document."messageId",
            document."botId",
            document."url",
            document."createdAt"
          FROM ranked AS document
          LEFT JOIN "Channel" AS channel ON channel."id" = document."channelId"
          LEFT JOIN "Bot" AS bot ON bot."id" = document."botId"
          LEFT JOIN LATERAL (
            SELECT member."channelId"
            FROM "ChannelMember" AS member
            INNER JOIN "Channel" AS candidate ON candidate."id" = member."channelId"
            WHERE member."botId" = document."botId"
              AND candidate."kind" = 'bot_dm'
              AND candidate."archivedAt" IS NULL
            LIMIT 1
          ) AS direct_channel ON document."kind" IN ('bot', 'routine')
          ORDER BY document.score DESC, document."updatedAt" DESC, document."id" ASC
        `;

        const results: SearchResultView[] = rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }));
        return { query: normalized, results };
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
}
