import type {
  SearchCategory,
  SearchResponse,
  SearchResultKind,
  SearchResultView,
} from "@openteam/contracts";
import { Prisma, type PrismaClient } from "@openteam/db";
import { Effect } from "effect";

const RESULT_LIMIT = 24;
export const SEARCH_CANDIDATE_LIMIT = 512;
export const SEARCH_RESULT_URL_MAX_LENGTH = 8_192;
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

        // Keep the full-text predicate directly on SearchDocument. A materialized
        // search-input CTE turns this into a join filter and prevents PostgreSQL
        // from using SearchDocument_searchVector_idx.
        const fullTextPredicate = tsQuery
          ? Prisma.sql`AND document."searchVector" @@ to_tsquery('simple', ${tsQuery})`
          : Prisma.empty;
        const fullTextScore = tsQuery
          ? Prisma.sql`ts_rank_cd(document."searchVector", to_tsquery('simple', ${tsQuery}), 32)`
          : Prisma.sql`0`;
        const candidateColumns = Prisma.sql`
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
          document."searchVector"
        `;
        const eligibleDocumentPredicate = Prisma.sql`
          WHERE (${kind}::text IS NULL OR document."kind" = ${kind})
            AND (
              ${normalized} <> '' OR ${category} <> 'all' OR
              document."kind" IN ('bot', 'channel', 'routine')
            )
            ${fullTextPredicate}
            AND (
              (
                document."kind" IN ('message', 'channel', 'file', 'link')
                AND document."channelId" IN (SELECT channel."id" FROM visible_channels AS channel)
              ) OR (
                document."kind" = 'bot'
                AND document."botId" IN (SELECT bot."id" FROM visible_bots AS bot)
              ) OR (
                document."kind" = 'routine'
                AND (
                  document."botId" IN (SELECT bot."id" FROM visible_bots AS bot)
                  OR document."channelId" IN (
                    SELECT channel."id" FROM visible_channels AS channel
                  )
                )
              )
            )
        `;

        const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
          WITH visible_bots AS MATERIALIZED (
            SELECT bot."id"
            FROM "Bot" AS bot
            WHERE bot."status" <> 'archived'
              AND NOT EXISTS (
                SELECT 1 FROM "Subagent" AS subagent
                WHERE subagent."childBotId" = bot."id"
              )
          ),
          visible_channels AS MATERIALIZED (
            SELECT DISTINCT channel."id"
            FROM "Channel" AS channel
            INNER JOIN "ChannelMember" AS member ON member."channelId" = channel."id"
            INNER JOIN visible_bots AS bot ON bot."id" = member."botId"
            WHERE channel."archivedAt" IS NULL
          ),
          recent_documents AS MATERIALIZED (
            SELECT
              ${candidateColumns}
            FROM "SearchDocument" AS document
            ${eligibleDocumentPredicate}
            -- A common prefix can match tens of thousands of rows. Rank only a
            -- bounded, recent candidate window.
            ORDER BY document."updatedAt" DESC, document."id" ASC
            LIMIT ${SEARCH_CANDIDATE_LIMIT}
          ),
          exact_title_documents AS MATERIALIZED (
            SELECT
              ${candidateColumns}
            FROM "SearchDocument" AS document
            ${eligibleDocumentPredicate}
              -- The hash expression has a compact B-tree index. Rechecking the
              -- complete lowercase title makes collisions harmless.
              AND ${normalized} <> ''
              AND md5(lower(document."title")) = md5(lower(${normalized}))
              AND lower(document."title") = lower(${normalized})
            ORDER BY document."updatedAt" DESC, document."id" ASC
            LIMIT ${RESULT_LIMIT}
          ),
          candidate_documents AS MATERIALIZED (
            SELECT * FROM recent_documents
            UNION ALL
            SELECT exact_document.*
            FROM exact_title_documents AS exact_document
            WHERE NOT EXISTS (
              SELECT 1 FROM recent_documents AS recent
              WHERE recent."id" = exact_document."id"
            )
          ),
          ranked AS (
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
              ${fullTextScore} +
              CASE
                WHEN lower(document."title") = lower(${normalized})
                  AND ${normalized} <> '' THEN 4
                WHEN lower(document."title") LIKE lower(${normalized}) || '%'
                  AND ${normalized} <> '' THEN 1.5
                ELSE 0
              END AS score
            FROM candidate_documents AS document
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
                WHEN 'routine' THEN
                  concat_ws(' · ', coalesce(bot."name", channel."name"), document."subtitle")
                ELSE document."subtitle"
              END,
              180
            ) AS "subtitle",
            CASE
              WHEN document."kind" = 'bot' THEN direct_channel."channelId"
              WHEN document."kind" = 'routine' THEN
                coalesce(document."channelId", direct_channel."channelId")
              ELSE document."channelId"
            END AS "channelId",
            document."messageId",
            document."botId",
            CASE
              WHEN char_length(document."url") <= ${SEARCH_RESULT_URL_MAX_LENGTH}
                THEN document."url"
              ELSE NULL
            END AS "url",
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
        `);

        const results: SearchResultView[] = rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }));
        return { query: normalized, results };
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
}
