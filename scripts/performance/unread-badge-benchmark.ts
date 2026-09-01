import { Client } from "../../packages/db/node_modules/pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

const visibleChannelsSql = `
  SELECT channel."id", coalesce(read_state."lastReadSequence", 0) AS "lastReadSequence"
  FROM "Channel" AS channel
  LEFT JOIN "ChannelReadState" AS read_state ON read_state."channelId" = channel."id"
  WHERE channel."archivedAt" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "ChannelMember" AS membership
      INNER JOIN "Bot" AS bot ON bot."id" = membership."botId"
      LEFT JOIN "Subagent" AS subagent ON subagent."childBotId" = bot."id"
      WHERE membership."channelId" = channel."id"
        AND bot."hiddenFromSidebar" = false
        AND subagent."id" IS NULL
    )
`;

const unreadSql = `
  SELECT count(*)::bigint AS "count"
  FROM "ChannelMessage" AS message
  INNER JOIN "Channel" AS channel ON channel."id" = message."channelId"
  LEFT JOIN "ChannelReadState" AS read_state ON read_state."channelId" = channel."id"
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
`;

const legacyCount = async () => {
  const channels = await client.query<{ id: string; lastReadSequence: string }>(visibleChannelsSql);
  const readByChannel = new Map(
    channels.rows.map((channel) => [channel.id, BigInt(channel.lastReadSequence)] as const)
  );
  const messages = await client.query<{
    channelId: string;
    sequence: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT "channelId", "sequence", "metadata"
     FROM "ChannelMessage"
     WHERE "sender" = 'agent' AND "channelId" = ANY($1::uuid[])`,
    [channels.rows.map((channel) => channel.id)]
  );
  const count = messages.rows.filter((message) => {
    if (BigInt(message.sequence) <= (readByChannel.get(message.channelId) ?? 0n)) return false;
    const metadata = message.metadata ?? {};
    return !("fromAgent" in metadata) && !("toAgent" in metadata);
  }).length;
  return { count, materializedMessages: messages.rowCount ?? messages.rows.length };
};

const aggregateCount = async () => {
  const result = await client.query<{ count: string }>(unreadSql);
  return Number(result.rows[0]?.count ?? 0);
};

const samples = Math.max(1, Math.min(100, Number(process.env.SAMPLES ?? 25)));
const warmups = Math.max(0, Math.min(20, Number(process.env.WARMUPS ?? 5)));
const legacyDurations: number[] = [];
const aggregateDurations: number[] = [];
let legacyResult = await legacyCount();
let aggregateResult = await aggregateCount();
if (legacyResult.count !== aggregateResult) throw new Error("Unread count mismatch");

for (let index = 0; index < warmups + samples; index += 1) {
  const legacyStarted = performance.now();
  legacyResult = await legacyCount();
  const legacyDuration = performance.now() - legacyStarted;
  const aggregateStarted = performance.now();
  aggregateResult = await aggregateCount();
  const aggregateDuration = performance.now() - aggregateStarted;
  if (legacyResult.count !== aggregateResult) throw new Error("Unread count mismatch");
  if (index >= warmups) {
    legacyDurations.push(legacyDuration);
    aggregateDurations.push(aggregateDuration);
  }
}

const percentile = (values: number[], percentileValue: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
};

console.log(
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      samples,
      count: aggregateResult,
      legacy: {
        materializedMessages: legacyResult.materializedMessages,
        p50Ms: percentile(legacyDurations, 0.5),
        p95Ms: percentile(legacyDurations, 0.95),
      },
      aggregate: {
        rowsReturned: 1,
        p50Ms: percentile(aggregateDurations, 0.5),
        p95Ms: percentile(aggregateDurations, 0.95),
      },
    },
    null,
    2
  )
);

await client.end();
