import { Prisma } from "@openteam/db";

type QueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Count unread user-visible agent messages without materializing channel
 * history in the server or worker process.
 */
export const unreadBadgeCount = async (client: QueryClient): Promise<number> => {
  const [result] = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT ((SELECT count(*)
    FROM "ChannelMessage" AS message
    INNER JOIN "Channel" AS channel ON channel."id" = message."channelId"
    LEFT JOIN "ChannelReadState" AS read_state
      ON read_state."channelId" = channel."id"
    WHERE channel."archivedAt" IS NULL
      AND message."sender" = 'agent'
      AND message."sequence" > coalesce(read_state."lastReadSequence", 0)
      AND NOT (message."metadata" ? 'fromAgent')
      AND NOT (message."metadata" ? 'toAgent')
      AND EXISTS (
        SELECT 1
        FROM "ChannelMember" AS membership
        INNER JOIN "Bot" AS bot ON bot."id" = membership."botId"
        LEFT JOIN "Subagent" AS subagent ON subagent."childBotId" = bot."id"
        WHERE membership."channelId" = channel."id"
          AND bot."hiddenFromSidebar" = false
          AND subagent."id" IS NULL
      )
    ) + (SELECT count(*) FROM "ChannelNotification" n
      JOIN "Channel" c ON c.id = n."channelId"
      JOIN "Bot" b ON b.id = n."botId"
      LEFT JOIN "ChannelReadState" s ON s."channelId" = n."channelId"
      WHERE NOT n.revoked AND c."archivedAt" IS NULL AND NOT c."hiddenFromSidebar"
        AND b."notificationsEnabled" AND NOT b."hiddenFromSidebar"
        AND (n.kind = 'reaction' OR n."messageSequence" IS NULL)
        AND n.sequence > COALESCE(s."lastReadNotificationSequence", 0)
    ))::bigint AS "count"
  `);
  return Number(result?.count ?? 0n);
};

export const unreadChannelCount = async (
  client: QueryClient,
  channelId: string,
  afterSequence: bigint
): Promise<number> => {
  const [result] = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS "count"
    FROM "ChannelMessage" AS message
    WHERE message."channelId" = ${channelId}::uuid
      AND message."sender" = 'agent'
      AND message."sequence" > ${afterSequence}
      AND NOT (message."metadata" ? 'fromAgent')
      AND NOT (message."metadata" ? 'toAgent')
  `);
  return Number(result?.count ?? 0n);
};
