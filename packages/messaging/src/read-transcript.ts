import { ApiError } from "@openteam/contracts";
import { parseReadTranscriptInput } from "@openteam/contracts/read-transcript";
import { Prisma, type PrismaClient } from "@openteam/db";
import { redactSensitiveText } from "@openteam/product-core/redaction";

const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const unavailable = () => new ApiError(404, "transcript_unavailable", "Transcript is not available to this agent");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Never return arbitrary tool details/arguments. Browser actions below return
// page observations as well as an action receipt; preserve that evidence just
// like snapshots. Review cards and credential/form-entry payloads stay excluded.
const observations = new Set([
  "Shell", "Read", "WebFetch", "WebSearch", "Computer", "Screenshot", "browser_snapshot", "browser_take_screenshot",
  "browser_tabs", "browser_console_messages", "browser_network_requests",
  "browser_navigate", "browser_click", "browser_press_key",
  "browser_hover", "browser_wait_for", "browser_find",
]);
export function transcriptToolProjection(value: unknown) {
  const record = object(value);
  const args = object(record.arguments);
  const tool = record.type === "commandExecution" ? "Shell" : record.tool === "CallDynamicTool" ? args.toolName : record.tool;
  const name = typeof tool === "string" ? tool : "tool";
  const result = object(record.result);
  const details = object(result.details);
  return { tool: name,
    ...(name === "Shell" && typeof details.exitCode === "number" ? {exit_code: details.exitCode} : {}),
    ...(name === "Shell" && typeof record.command === "string" ? { command: record.command } : {}),
    ...(observations.has(name) && Array.isArray(result.content) ? { output: result.content.flatMap(part => {
      const p = object(part); return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
    }).join("\n") } : { output_omitted: true }),
  };
}
export function boundTranscriptValue(value: unknown, limit = 2000) {
  // Redact actual text before JSON escaping: escaped newlines otherwise look
  // like part of an unquoted credential and can swallow the rest of a result.
  const text = typeof value === "string" ? redactSensitiveText(value) : JSON.stringify(value, (key, item) =>
    /^(?:password|passwd|secret|token|api[_-]?key|authorization)$/i.test(key) ? "[REDACTED]" :
      typeof item === "string" ? redactSensitiveText(item) : item);
  if (text.length <= limit) return text;
  const head = Math.ceil(limit / 2), tail = Math.floor(limit / 2);
  return `${text.slice(0, head)}\n[truncated: ${text.length - limit} characters omitted from middle]\n${tail ? text.slice(-tail) : ""}`;
}

/** Reads the persisted visible projection, never runtime/Pi session files. */
export async function readTranscript(db: PrismaClient, context: {botId: string; channelId: string | null}, raw: unknown) {
  const input = parseReadTranscriptInput(raw);
  return db.$transaction(async tx => {
    // Workers get the facts they need in their task; they never read transcripts.
    if (await tx.subagent.count({where: {childBotId: context.botId}})) throw unavailable();
    let botId = context.botId;
    let channelIds: string[] = [];
    let worker = false;
    // An id is tried as a dispatched subagent, then one of this agent's conversations, then an owned agent.
    const id = input.in === "session" ? undefined : input.in.replace(/^sand-subagent-/, "");
    if (id !== undefined && !uuid.test(id)) throw unavailable();
    const child = id && await tx.subagent.findFirst({where: {id, parentBotId: context.botId}, select: {childBotId: true}});
    if (child) {
      botId = child.childBotId;
      worker = true;
    } else {
      const session = id && await tx.contextSession.findFirst({where: {id, botId, scope: "channel"}, select: {scopeId: true}});
      const agent = id && !session ? await tx.bot.findFirst({where: {id, status: "active", subagentIdentity: {is: null}}, select: {id: true}}) : null;
      if (id && !session && !agent) throw unavailable();
      if (agent) botId = agent.id;
      const channelId = agent ? undefined : session ? session.scopeId : context.channelId;
      if (!agent && !channelId) throw unavailable();
      const channels = await tx.channel.findMany({where: {
        ...(channelId ? {id: channelId} : {}), archivedAt: null,
        kind: {not: "agent_dm"}, members: {some: {botId}},
      }, select: {id: true}});
      channelIds = channels.map(c => c.id);
      if (!channelIds.length) throw unavailable();
    }
    // Only the agent's own execution records accompany conversation messages.
    // Peer agent access follows the existing visible transcript policy: messages
    // only, never that peer's tool payloads or private agent-to-agent channels.
    const includeTools = worker || botId === context.botId;
    const messageQuery = worker ? Prisma.sql`
      SELECT id::text, "createdAt" AS at, role::text AS kind, to_jsonb(content) AS body, status::text
      FROM "Message" WHERE "botId" = ${botId}::uuid AND role::text IN ('user', 'assistant')`
      : Prisma.sql`
      SELECT id::text, "createdAt" AS at, sender::text AS kind, to_jsonb(content) AS body, 'completed'::text AS status
      FROM "ChannelMessage" WHERE "channelId" IN (${Prisma.join(channelIds.map(id => Prisma.sql`${id}::uuid`))}) AND sender::text IN ('user', 'agent')`;
    const toolQuery = includeTools ? Prisma.sql` UNION ALL
      SELECT i.id::text, i."createdAt" AS at, i.kind::text, i.content AS body, i.status::text
      FROM "RunItem" i JOIN "Run" r ON r.id = i."runId"
      WHERE r."botId" = ${botId}::uuid AND i.kind::text IN ('command', 'tool', 'file_change')
      AND (i.title IS NULL OR i.title <> 'promptFingerprint')
      ${worker ? Prisma.empty : Prisma.sql`AND r."channelId" IN (${Prisma.join(channelIds.map(id => Prisma.sql`${id}::uuid`))})`}` : Prisma.empty;
    const query = Prisma.sql`${messageQuery}${toolQuery}`;
    const counts = await tx.$queryRaw<Array<{count: bigint}>>(Prisma.sql`SELECT count(*) AS count FROM (${query}) rows`);
    const total = Number(counts[0]?.count ?? 0);
    const end = Math.min(input.before ?? total, total);
    const start = Math.max(0, end - input.limit);
    const rows = await tx.$queryRaw<Array<{id: string; at: Date; kind: string; body: unknown; status: string}>>(Prisma.sql`
      SELECT * FROM (${query}) rows ORDER BY at ASC, id ASC OFFSET ${start} LIMIT ${end - start}`);
    return {
      total, next_before: start > 0 ? start : null,
      note: "Observable history only. Tool arguments, non-observation results, reasoning and private instructions are excluded. Text is redacted and bounded, preserving the beginning and end. Smaller pages allow more text per row (up to 20,000 characters; 60,000 total). Positions apply while history is retained; new rows normally append.",
      rows: rows.map((row, index) => ({position: start + index, id: row.id, at: row.at.toISOString(), role: row.kind, status: row.status,
        content: boundTranscriptValue(["command", "tool", "file_change"].includes(row.kind) ? transcriptToolProjection(row.body) : row.body, Math.min(20_000, Math.floor(60_000 / Math.max(1, rows.length))))})),
    };
  }, {isolationLevel: "RepeatableRead"});
}
