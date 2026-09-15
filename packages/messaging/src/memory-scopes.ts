import { createHash } from "node:crypto";
import { ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";

export type MemoryWriteScope = "agent" | "user" | "project" | "conversation";
export type MemoryScopeStory = {
  defaultScope: "agent" | "conversation";
  userScope: "owner" | "refused" | "sender" | "none";
  teamShared: boolean;
};
export type MemoryConversationContext = MemoryScopeStory & {
  id: string;
  botId: string;
  address: string;
  audienceKey: string;
};
type Database = PrismaClient | Prisma.TransactionClient;

// OpenTeam has one account owner and bot participants, not Grok's team/user
// membership graph. Never accept audience or user-scope claims from tool arguments.
export async function resolveMemoryConversation(
  db: Database,
  botId: string,
  channelId?: string | null
): Promise<MemoryConversationContext> {
  const channel = channelId
    ? await db.channel.findFirst({
        where: { id: channelId, members: { some: { botId } } },
        include: { members: { select: { botId: true } } },
      })
    : null;
  if (channelId && !channel)
    throw new ApiError(
      403,
      "memory_context_unavailable",
      "Bot is not a member of this conversation"
    );
  const group = channel?.kind === "group";
  const participants = [
    ...new Set(channel?.members.map((member) => member.botId) ?? [botId]),
  ].sort();
  const audienceKey = createHash("sha256")
    .update(JSON.stringify(["account-owner", group ? "group" : "personal", participants]))
    .digest("hex");
  const address = channelId ?? "home";
  const story: MemoryScopeStory = {
    defaultScope: "agent",
    userScope: group ? "refused" : "owner",
    teamShared:
      (await db.channelMember.count({ where: { botId, channel: { kind: "group" } } })) > 0,
  };
  const row = await db.memoryConversation.upsert({
    where: { botId_address_audienceKey: { botId, address, audienceKey } },
    create: { botId, address, audienceKey, ...story },
    update: story,
  });
  return { ...row, ...story };
}

export async function getMemoryConversation(
  db: Database,
  botId: string,
  id: string
): Promise<MemoryConversationContext> {
  const row = await db.memoryConversation.findFirst({ where: { id, botId } });
  if (!row)
    throw new ApiError(
      403,
      "memory_context_unavailable",
      "Memory conversation does not belong to this bot"
    );
  return {
    ...row,
    // Older rows retain their audience for reads, but never redirect new writes.
    defaultScope: "agent",
    userScope: row.userScope === "owner" ? "owner" : "refused",
  };
}

export function assertMemoryWriteScope(
  scope: MemoryWriteScope,
  context?: MemoryConversationContext
) {
  if (scope === "conversation" && !context)
    throw new ApiError(
      400,
      "memory_context_required",
      "Conversation memory requires an active conversation"
    );
  if (scope === "user" && context && !["owner", "sender"].includes(context.userScope))
    throw new ApiError(
      403,
      "memory_user_scope_refused",
      'scope "user" is the owner\'s memory across their agents and cannot be written from this conversation.'
    );
}

// Wording is the inspected sand-memory.ts conversation contract.
export function renderMemoryConversationScopeStory({
  defaultScope,
  userScope,
  teamShared,
}: MemoryScopeStory): string {
  const userStory = {
    owner:
      'scope "user" is durable facts about the agent\'s owner, shared across everything they run.',
    refused:
      'scope "user" is the owner\'s memory across their agents and cannot be written from this conversation.',
    sender:
      'scope "user" is durable facts about the person you are talking with, shared across everything they run; what their other assistants have learned about them is visible here.',
    none: 'scope "user" is not available in this conversation.',
  }[userScope];
  const label =
    defaultScope === "conversation"
      ? "this conversation's own memory"
      : "your memory in every conversation";
  const base = `scope "conversation" is this conversation's own memory: things only this thread cares about (its decisions, its context, the people in it). scope "agent" is what you should know in every conversation: who you are, team-wide facts, how you do your job. ${userStory} A save or forget with no scope goes to ${label} (scope "${defaultScope}"). Unless a fact clearly applies to every conversation, keep it in this conversation.`;
  return teamShared
    ? `${base} This assistant is shared with the team, so scope "agent" is team-wide memory everyone who talks to it sees: whenever you save or forget a team-wide fact, tell the user you have done so in your reply (one short sentence is enough). Conversation- and user-scoped saves need no announcement.`
    : base;
}
