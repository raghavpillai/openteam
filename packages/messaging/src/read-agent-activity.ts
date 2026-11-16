import { type AgentActivityBounds, parseReadAgentActivityInput } from "@openteam/contracts/read-agent-activity";
import type { PrismaClient } from "@openteam/db";
import { redactSensitiveText } from "@openteam/product-core/redaction";

interface AgentActivitySummary {
  agentId: string;
  name: string;
  description: string;
  lastUserMessageAt: Date | null;
  lastAssistantMessageAt: Date | null;
  openTodos: Array<{ status: string; content: string }>;
  pendingQuestions: Array<{ askedAt: Date; text: string }>;
  recentExcerpt: string;
}

type AgentActivityResult =
  | { kind: "unavailable" }
  | { kind: "read"; agents: AgentActivitySummary[]; truncated: boolean };

const EXCERPT_MESSAGES = 12;
const QUESTION_CHARS = 300;

// The questions in the bot's messages since the user last spoke: those still wait on a reply.
const questionsIn = (text: string) =>
  text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.endsWith("?"));

/** What the user's other bots did lately, from each bot's main chat; nothing is marked read. */
async function readOwnedAgentActivity(db: PrismaClient, botId: string, bounds: AgentActivityBounds, now = new Date()): Promise<AgentActivityResult> {
  const bots = await db.bot.findMany({
    where: { id: { not: botId }, status: "active", subagentIdentity: { is: null } },
    select: { id: true, name: true, description: true },
  });
  if (!bots.length) return { kind: "unavailable" };
  const since = new Date(now.getTime() - bounds.sinceHours * 3_600_000);
  const active: Array<{ bot: (typeof bots)[number]; channelId: string; lastUser: Date | null; lastAgent: Date | null; lastAt: Date }> = [];
  for (const bot of bots) {
    const channel = await db.channel.findFirst({ where: { kind: "bot_dm", directKey: `bot:${bot.id}`, archivedAt: null }, select: { id: true } });
    if (!channel) continue;
    const [lastUser, lastAgent] = await Promise.all((["user", "agent"] as const).map((sender) =>
      db.channelMessage.findFirst({ where: { channelId: channel.id, sender }, orderBy: { sequence: "desc" }, select: { createdAt: true } })));
    const lastAt = [lastUser?.createdAt, lastAgent?.createdAt].filter((at): at is Date => !!at).sort((a, b) => b.getTime() - a.getTime())[0];
    if (!lastAt || lastAt < since) continue;
    active.push({ bot, channelId: channel.id, lastUser: lastUser?.createdAt ?? null, lastAgent: lastAgent?.createdAt ?? null, lastAt });
  }
  active.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  const shown = active.slice(0, bounds.maxAgents);
  const agents = await Promise.all(shown.map(async ({ bot, channelId, lastUser, lastAgent }) => {
    const [todos, recent, unanswered] = await Promise.all([
      db.todoItem.findMany({ where: { botId: bot.id, status: { in: ["pending", "in_progress"] } }, orderBy: { position: "asc" }, select: { status: true, content: true } }),
      db.channelMessage.findMany({ where: { channelId, sender: { in: ["user", "agent"] } }, orderBy: { sequence: "desc" }, take: EXCERPT_MESSAGES, select: { sender: true, content: true } }),
      db.channelMessage.findMany({ where: { channelId, sender: "agent", ...(lastUser ? { createdAt: { gt: lastUser } } : {}) }, orderBy: { sequence: "asc" }, select: { content: true, createdAt: true } }),
    ]);
    const lines = recent.reverse().map((message) => `${message.sender === "user" ? "User" : bot.name}: ${message.content.replace(/\s+/g, " ").trim()}`);
    const excerpt = redactSensitiveText(lines.join("\n"));
    return {
      agentId: bot.id,
      name: bot.name,
      description: bot.description,
      lastUserMessageAt: lastUser,
      lastAssistantMessageAt: lastAgent,
      openTodos: todos.map((todo) => ({ status: todo.status, content: todo.content })),
      pendingQuestions: unanswered.flatMap((message) => questionsIn(message.content).map((text) => ({
        askedAt: message.createdAt,
        text: redactSensitiveText(text.length > QUESTION_CHARS ? `${text.slice(0, QUESTION_CHARS - 1)}…` : text),
      }))),
      recentExcerpt: excerpt.length > bounds.excerptChars ? `…${excerpt.slice(excerpt.length - bounds.excerptChars + 1)}` : excerpt,
    };
  }));
  return { kind: "read", agents, truncated: active.length > shown.length };
}

// Same buckets as the host's duration formatter: minutes keep seconds, hours keep minutes, days keep hours.
const age = (at: Date, now: Date) => {
  const elapsed = now.getTime() - at.getTime();
  if (elapsed < 60_000) return "just now";
  const total = Math.round(elapsed / 1000);
  const [days, hours, minutes, seconds] = [Math.floor(total / 86_400), Math.floor((total % 86_400) / 3_600), Math.floor((total % 3_600) / 60), total % 60];
  const text = total < 3_600 ? (seconds ? `${minutes}m ${seconds}s` : `${minutes}m`)
    : total < 86_400 ? (minutes ? `${hours}h ${minutes}m` : `${hours}h`)
    : hours ? `${days}d ${hours}h` : `${days}d`;
  return `${text} ago`;
};

function renderAgentActivity(result: AgentActivityResult, bounds: AgentActivityBounds, now = new Date()): string {
  if (result.kind === "unavailable") return "This user owns no other bots to read.";
  const scope = `last ${bounds.sinceHours}h, up to ${bounds.maxAgents} bots, ${bounds.excerptChars} excerpt chars each`;
  if (!result.agents.length) {
    return result.truncated
      ? `No activity on the ${bounds.maxAgents} bots read (${scope}). Truncated: more bots were left unread; raise max_agents (up to 20) to read them.`
      : `No activity on the user's other bots (${scope}).`;
  }
  const header = `Other bots' recent activity, ${result.agents.length} bot${result.agents.length === 1 ? "" : "s"} (${scope}). ${result.truncated ? "Truncated: more qualifying activity than shown." : "Complete."}`;
  return [header, ...result.agents.map((summary) => {
    const lines = [`## ${summary.name} (agent ${summary.agentId})`];
    if (summary.description.trim()) lines.push(summary.description.trim());
    lines.push(`Last user message: ${summary.lastUserMessageAt ? age(summary.lastUserMessageAt, now) : "none"}. Last assistant message: ${summary.lastAssistantMessageAt ? age(summary.lastAssistantMessageAt, now) : "none"}.`);
    if (summary.openTodos.length) lines.push(`Open todos (${summary.openTodos.length}):`, ...summary.openTodos.map((todo) => `- [${todo.status}] ${todo.content}`));
    if (summary.pendingQuestions.length) lines.push(`Pending questions (${summary.pendingQuestions.length}):`, ...summary.pendingQuestions.map((question) => `- ${age(question.askedAt, now)}: ${question.text}`));
    lines.push("Recent excerpt:", summary.recentExcerpt || "(no recent messages)");
    return lines.join("\n");
  })].join("\n\n");
}

export async function readAgentActivity(db: PrismaClient, context: { botId: string }, raw: unknown) {
  const bounds = parseReadAgentActivityInput(raw);
  return renderAgentActivity(await readOwnedAgentActivity(db, context.botId, bounds), bounds);
}
