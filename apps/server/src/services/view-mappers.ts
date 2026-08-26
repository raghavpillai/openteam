import type { BotView } from "@openbot/contracts";
import { Prisma } from "@openbot/db";

export const serialize = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested
    )
  ) as T;

export type BotWithConversation = Prisma.BotGetPayload<{
  include: {
    conversation: true;
    channelMemberships: { include: { channel: true } };
  };
}>;

export const toBotView = (bot: BotWithConversation): BotView => ({
  id: bot.id,
  name: bot.name,
  title: bot.title,
  description: bot.description,
  instructions: bot.instructions,
  icon: bot.icon,
  color: bot.color,
  hasAvatar: Boolean(bot.avatarPath),
  notificationsEnabled: bot.notificationsEnabled,
  hiddenFromSidebar: bot.hiddenFromSidebar,
  defaultDirectory: bot.defaultDirectory,
  status: bot.status,
  onboardingStatus: bot.onboardingStatus,
  onboardingVersion: bot.onboardingVersion,
  onboardingCompletedAt: bot.onboardingCompletedAt?.toISOString() ?? null,
  provisioningError: bot.provisioningError,
  createdAt: bot.createdAt.toISOString(),
  updatedAt: bot.updatedAt.toISOString(),
  conversationId: bot.conversation!.id,
  dmChannelId: bot.channelMemberships.find((membership) => membership.channel.kind === "bot_dm")!
    .channelId,
});
