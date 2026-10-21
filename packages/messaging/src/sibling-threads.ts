import type { PrismaClient } from "@openteam/db";

/** Recently active conversations, newest first, that ReadTranscript can open by their session_id. */
const ACTIVE_CONVERSATION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const ACTIVE_CONVERSATIONS_LISTED = 8;

export interface SiblingThread {
  sessionId: string;
  channelId: string;
  name: string;
  kind: "direct chat" | "group chat";
  lastActivityAt: Date;
}

/** Only visible conversations of this agent, never the model tape or private agent-to-agent channels. */
export async function listSiblingThreads(db: PrismaClient, botId: string, currentSessionId?: string): Promise<SiblingThread[]> {
  const sessions = await db.contextSession.findMany({
    where: { botId, scope: "channel", ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  if (!sessions.length) return [];
  const channels = await db.channel.findMany({
    where: { id: { in: sessions.map(s => s.scopeId) }, archivedAt: null, kind: { not: "agent_dm" }, members: { some: { botId } } },
    select: { id: true, name: true, kind: true },
  });
  const byId = new Map(channels.map(c => [c.id, c]));
  return sessions.flatMap(s => {
    const channel = byId.get(s.scopeId);
    return channel ? [{ sessionId: s.id, channelId: s.scopeId, name: channel.name, kind: channel.kind === "group" ? "group chat" as const : "direct chat" as const, lastActivityAt: s.updatedAt }] : [];
  });
}

/** The system prompt's digest of this agent's other conversations, readable with ReadTranscript. */
export function renderOtherActiveConversations(threads: readonly SiblingThread[], now = Date.now()): string {
  const active = threads.filter(thread => now - thread.lastActivityAt.getTime() <= ACTIVE_CONVERSATION_MAX_AGE_MS);
  if (!active.length) return "";
  const listed = [...active]
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || (a.sessionId < b.sessionId ? -1 : 1))
    .slice(0, ACTIVE_CONVERSATIONS_LISTED)
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  const omitted = active.length - listed.length;
  return [
    "## Other active conversations",
    "Other active conversations: this agent also has separate conversations running in parallel.",
    "Use ReadTranscript with in=<session_id> to inspect another conversation's transcript when you need cross-conversation context.",
    ...listed.map(thread => `- ${thread.name}, session_id: ${thread.sessionId} (${thread.kind}, last active ${thread.lastActivityAt.toISOString().slice(0, 10)})`),
    ...(omitted > 0 ? [`(${omitted} older conversation${omitted === 1 ? "" : "s"} not listed.)`] : []),
  ].join("\n");
}
