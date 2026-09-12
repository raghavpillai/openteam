import type { PrismaClient } from "@openteam/db";
export const clientBots = (prisma: PrismaClient) =>
  prisma.bot.findMany({
    where: {
      status: { not: "archived" },
      subagentIdentity: { is: null },
    },
    include: {
      conversation: true,
      channelMemberships: {
        where: { channel: { archivedAt: null } },
        include: { channel: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

export const clientChannels = (prisma: PrismaClient) =>
  prisma.channel.findMany({
    where: {
      archivedAt: null,
      members: {
        some: {
          bot: { status: { not: "archived" }, subagentIdentity: { is: null } },
        },
      },
    },
    include: { members: { orderBy: { ordinal: "asc" } } },
    orderBy: { updatedAt: "desc" },
  });
