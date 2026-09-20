import { Prisma, type PrismaClient } from "@openteam/db";

export const MAX_THREAD_CONTEXT_MESSAGES = 100;

export type StoredChannelMessage = {
  id: string;
  clientId?: string | null;
  sequence: bigint;
  channelId: string;
  sender: string;
  senderBotId: string | null;
  sourceRunId: string | null;
  content: string;
  metadata: unknown;
  createdAt: Date;
};

export type StoredThreadContextMessage = StoredChannelMessage & {
  traversalDepth: number;
  seedOrder: number;
};

export async function threadContextFor(
  prisma: PrismaClient,
  channelId: string,
  messages: readonly StoredChannelMessage[]
): Promise<{ messages: StoredChannelMessage[]; truncated: boolean }> {
  const replyTarget = (message: StoredChannelMessage): string | null => {
    if (
      !message.metadata ||
      typeof message.metadata !== "object" ||
      Array.isArray(message.metadata)
    ) {
      return null;
    }
    const metadata = message.metadata as Record<string, unknown>;
    return metadata.branched === true && typeof metadata.replyTo === "string"
      ? metadata.replyTo
      : null;
  };

  const knownIds = new Set(messages.map((message) => message.id));
  const pendingIds = new Set(
    messages.flatMap((message) => {
      const targetId = replyTarget(message);
      return targetId && !knownIds.has(targetId) ? [targetId] : [];
    })
  );
  if (pendingIds.size === 0) return { messages: [], truncated: false };

  // Every seed has at most one parent. Capping each path therefore bounds
  // the complete walk to page-size * limit, while the extra returned row is
  // only a truncation probe. Keeping the walk in PostgreSQL eliminates up to
  // 100 sequential round trips for a deep branch.
  const rows = await prisma.$queryRaw<StoredThreadContextMessage[]>(Prisma.sql`
      WITH RECURSIVE
      input AS (
        SELECT
          ${channelId}::uuid AS "channelId",
          ${[...knownIds]}::uuid[] AS "knownIds"
      ),
      seed("id", "seedOrder") AS (
        SELECT
          CASE
            WHEN seed."id" ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN seed."id"::uuid
            ELSE NULL::uuid
          END,
          seed."ordinality"::int
        FROM unnest(${[...pendingIds]}::text[]) WITH ORDINALITY AS seed("id", "ordinality")
      ),
      ancestor AS (
        SELECT
          message."id",
          message."clientId",
          message."sequence",
          message."channelId",
          message."sender",
          message."senderBotId",
          message."sourceRunId",
          message."content",
          message."metadata",
          message."createdAt",
          1 AS "traversalDepth",
          seed."seedOrder",
          CASE
            WHEN message."metadata" -> 'branched' = 'true'::jsonb
              AND jsonb_typeof(message."metadata" -> 'replyTo') = 'string'
              AND message."metadata" ->> 'replyTo'
                ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN (message."metadata" ->> 'replyTo')::uuid
            ELSE NULL::uuid
          END AS "replyToId",
          ARRAY[message."id"] AS path
        FROM seed
        CROSS JOIN input
        INNER JOIN "ChannelMessage" AS message
          ON message."channelId" = input."channelId"
          AND message."id" = seed."id"
        WHERE NOT (message."id" = ANY(input."knownIds"))

        UNION ALL

        SELECT
          parent."id",
          parent."clientId",
          parent."sequence",
          parent."channelId",
          parent."sender",
          parent."senderBotId",
          parent."sourceRunId",
          parent."content",
          parent."metadata",
          parent."createdAt",
          current."traversalDepth" + 1,
          current."seedOrder",
          CASE
            WHEN parent."metadata" -> 'branched' = 'true'::jsonb
              AND jsonb_typeof(parent."metadata" -> 'replyTo') = 'string'
              AND parent."metadata" ->> 'replyTo'
                ~ '^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
              THEN (parent."metadata" ->> 'replyTo')::uuid
            ELSE NULL::uuid
          END,
          current.path || parent."id"
        FROM ancestor AS current
        CROSS JOIN input
        INNER JOIN "ChannelMessage" AS parent
          ON parent."channelId" = input."channelId"
          AND parent."id" = current."replyToId"
        WHERE current."traversalDepth" < ${MAX_THREAD_CONTEXT_MESSAGES + 1}
          AND NOT (parent."id" = ANY(input."knownIds"))
          AND NOT (parent."id" = ANY(current.path))
      ),
      ranked AS (
        SELECT
          ancestor.*,
          row_number() OVER (
            PARTITION BY ancestor."id"
            ORDER BY ancestor."traversalDepth" ASC, ancestor."seedOrder" ASC
          ) AS "duplicateRank"
        FROM ancestor
      )
      SELECT
        ranked."id",
        ranked."clientId",
        ranked."sequence",
        ranked."channelId",
        ranked."sender",
        ranked."senderBotId",
        ranked."sourceRunId",
        ranked."content",
        ranked."metadata",
        ranked."createdAt",
        ranked."traversalDepth",
        ranked."seedOrder"
      FROM ranked
      WHERE ranked."duplicateRank" = 1
      ORDER BY
        ranked."traversalDepth" ASC,
        ranked."seedOrder" ASC,
        ranked."sequence" ASC,
        ranked."id" ASC
      LIMIT ${MAX_THREAD_CONTEXT_MESSAGES + 1}
    `);
  const context = rows.slice(0, MAX_THREAD_CONTEXT_MESSAGES);

  return {
    messages: context.sort((left, right) =>
      left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0
    ),
    truncated: rows.length > MAX_THREAD_CONTEXT_MESSAGES,
  };
}

export async function channelUnreadCounts(
  prisma: PrismaClient,
  channelIds: readonly string[]
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ channelId: string; unreadCount: number }>>(
    Prisma.sql`
        SELECT
          message."channelId" AS "channelId",
          COUNT(*)::int AS "unreadCount"
        FROM "ChannelMessage" AS message
        LEFT JOIN "ChannelReadState" AS state
          ON state."channelId" = message."channelId"
        WHERE message."channelId" = ANY(${channelIds}::uuid[])
          AND message."sender" = 'agent'
          AND message."sequence" > COALESCE(state."lastReadSequence", 0)
          AND NOT (COALESCE(message."metadata", '{}'::jsonb) ? 'fromAgent')
          AND NOT (COALESCE(message."metadata", '{}'::jsonb) ? 'toAgent')
        GROUP BY message."channelId"
      `
  );
  return new Map(rows.map((row) => [row.channelId, Number(row.unreadCount)]));
}
