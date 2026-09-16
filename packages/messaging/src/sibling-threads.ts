import { ApiError } from "@openteam/contracts";
import { parseSiblingThreadInput } from "@openteam/contracts/sibling-threads";
import type { PrismaClient } from "@openteam/db";

/** Only visible conversation rows, never the model tape, review payloads or held form values. */
export async function listSiblingThreads(db: PrismaClient, botId: string, currentSessionId?: string) {
  const sessions = await db.contextSession.findMany({
    where: { botId, scope: "channel", ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  if (!sessions.length) return [];
  const channels = await db.channel.findMany({
    where: { id: { in: sessions.map(s => s.scopeId) }, archivedAt: null, members: { some: { botId } } },
    select: { id: true, name: true },
  });
  const names = new Map(channels.map(c => [c.id, c.name]));
  return sessions.filter(s => names.has(s.scopeId)).map(s => ({ sessionId: s.id, channelId: s.scopeId, name: names.get(s.scopeId)! }));
}

export async function readSiblingThread(db: PrismaClient, context: { botId: string; channelId: string | null }, raw: unknown) {
  const { session_id, limit } = parseSiblingThreadInput(raw);
  // UUID validation keeps malformed/foreign ids indistinguishable from unavailable sessions.
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(session_id)) throw new ApiError(404, "sibling_unavailable", "Conversation is not readable by this agent");
  return db.$transaction(async tx => {
    const session = await tx.contextSession.findFirst({ where: { id: session_id, botId: context.botId, scope: "channel" } });
    if (!session) throw new ApiError(404, "sibling_unavailable", "Conversation is not readable by this agent");
    if (session.scopeId === context.channelId) throw new ApiError(400, "sibling_is_current", "session_id is the current conversation — read the live transcript instead.");
    const channel = await tx.channel.findFirst({ where: { id: session.scopeId, archivedAt: null, members: { some: { botId: context.botId } } } });
    if (!channel) throw new ApiError(404, "sibling_unavailable", "Conversation is not readable by this agent");
    const rows = await tx.channelMessage.findMany({
      where: { channelId: channel.id, sender: { in: ["user", "agent"] }, content: { not: "" } }, orderBy: { sequence: "desc" }, take: limit,
      select: { sequence: true, sender: true, content: true },
    });
    if (!rows.length) return `No readable transcript rows for session ${session_id}.`;
    return [`Sibling conversation ${session_id} (most recent ${rows.length} rows):`, "",
      ...rows.reverse().map(row => `[${row.sequence}] ${row.sender === "user" ? "user" : "assistant"}: ${row.content.trim() ? row.content : "(empty)"}`),
    ].join("\n");
  }, { isolationLevel: "RepeatableRead" });
}
