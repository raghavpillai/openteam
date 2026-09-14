import type { Snapshot, ChannelNotificationState } from "@openteam/contracts";
import { resolve } from "node:path";
import { toChannelMessageView } from "../view-mappers";

export function workspaceView(workspaceRoot: string) {
  return {
    root: workspaceRoot,
    sharedDirectory: resolve(workspaceRoot, "shared"),
    botsDirectory: resolve(workspaceRoot, "bots"),
    projectsDirectory: resolve(workspaceRoot, "projects"),
  };
}

export function channelViews<
  T extends Array<{
    id: string;
    kind: string;
    name: string;
    description: string;
    avatarPath: string | null;
    directKey: string | null;
    workingDirectory: string | null;
    hiddenFromSidebar: boolean;
    members: Array<{ botId: string; ordinal: number }>;
    createdAt: Date;
    updatedAt: Date;
  }>,
>(
  channels: T,
  unreadCounts: ReadonlyMap<string, number>,
  notificationStates?: ReadonlyMap<string, ChannelNotificationState>
) {
  return channels.map((channel) => ({
    id: channel.id,
    kind: channel.kind as Snapshot["channels"][number]["kind"],
    name: channel.name,
    description: channel.description,
    hasAvatar: Boolean(channel.avatarPath),
    directKey: channel.directKey,
    workingDirectory: channel.workingDirectory,
    hiddenFromSidebar: channel.hiddenFromSidebar,
    members: channel.members.map((member) => ({ botId: member.botId, ordinal: member.ordinal })),
    unreadCount:
      (unreadCounts.get(channel.id) ?? 0) +
      (notificationStates?.get(channel.id)?.activityUnreadCount ?? 0),
    notificationState: notificationStates?.get(channel.id),
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  }));
}

export const messageViews = (messages: Parameters<typeof toChannelMessageView>[0][]) =>
  messages.map(toChannelMessageView);

export function roundViews<
  T extends Array<{
    id: string;
    channelId: string;
    triggerMessageId: string;
    rootMessageId: string;
    roundIndex: number;
    memberTurnOffset: number;
    initiatorBotId: string | null;
    status: string;
    currentOrdinal: number;
    createdAt: Date;
    completedAt: Date | null;
  }>,
>(rounds: T) {
  return rounds.map((round) => ({
    id: round.id,
    channelId: round.channelId,
    triggerMessageId: round.triggerMessageId,
    rootMessageId: round.rootMessageId,
    roundIndex: round.roundIndex,
    memberTurnOffset: round.memberTurnOffset,
    initiatorBotId: round.initiatorBotId,
    status: round.status as Snapshot["channelRounds"][number]["status"],
    currentOrdinal: round.currentOrdinal,
    createdAt: round.createdAt.toISOString(),
    completedAt: round.completedAt?.toISOString() ?? null,
  }));
}

export function runViews<T extends Array<{ createdAt: Date; updatedAt: Date }>>(
  runs: T
): Snapshot["runs"] {
  return runs.map((run) => ({
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  })) as Snapshot["runs"];
}
