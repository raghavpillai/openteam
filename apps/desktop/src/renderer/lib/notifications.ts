import type { ClientSnapshot, RunView } from "@openbot/contracts";
import {
  notificationApprovalReason,
  notificationMessageInputReason,
  notificationMessagePreview,
} from "@openbot/contracts/notification-content";
import { isActiveRunStatus } from "@openbot/product-core/statuses";

export interface AgentNotificationEvent {
  botId: string;
  channelId: string;
  kind: "agent-needs-input" | "agent-done";
  title: string;
  body: string;
}

export interface DesktopAgentNotificationState {
  botId: string;
  channelId: string;
  name: string;
  notificationsEnabled: boolean;
  hiddenFromSidebar: boolean;
  isRunning: boolean;
  awaitingReason: string | null;
  lastMessageId: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

export const desktopNotificationSnapshot = (
  snapshot: ClientSnapshot,
  unreadIds: ReadonlySet<string>,
  visibleChannelId: string | null = null
): { cursor: string; agents: DesktopAgentNotificationState[] } => {
  const activeRuns = activeRunsByBot(snapshot);
  const latestByChannel = new Map<
    string,
    { id: string; content: string; createdAt: string; senderBotId: string | null }
  >();
  for (const message of snapshot.channelMessages) {
    const prior = latestByChannel.get(message.channelId);
    if (!prior || message.createdAt >= prior.createdAt)
      latestByChannel.set(message.channelId, message);
  }
  const pendingApprovalByRun = new Map(
    snapshot.approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => [approval.runId, approval] as const)
  );
  const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot] as const));
  return {
    cursor: snapshot.cursor,
    agents: snapshot.channels.flatMap((channel) => {
      if (channel.kind !== "bot_dm") return [];
      const bot = botById.get(channel.members[0]?.botId ?? "");
      if (!bot) return [];
      const run = activeRuns.get(bot.id);
      const approval = run ? pendingApprovalByRun.get(run.id) : undefined;
      const latest = latestByChannel.get(channel.id);
      const latestIsBot = latest?.senderBotId === bot.id;
      return [
        {
          botId: bot.id,
          channelId: channel.id,
          name: bot.name,
          notificationsEnabled: bot.notificationsEnabled,
          hiddenFromSidebar: bot.hiddenFromSidebar,
          isRunning: Boolean(run),
          awaitingReason:
            run?.status === "waiting_approval"
              ? notificationApprovalReason(approval?.details)
              : latestIsBot
                ? notificationMessageInputReason(latest)
                : null,
          lastMessageId: latestIsBot ? latest.id : null,
          lastMessagePreview: latestIsBot ? notificationMessagePreview(latest) : null,
          unreadCount:
            channel.id === visibleChannelId
              ? 0
              : (channel.unreadCount ?? (unreadIds.has(channel.id) ? 1 : 0)),
        },
      ];
    }),
  };
};

export interface DesktopNotificationSyncTarget {
  sync: (snapshot: ReturnType<typeof desktopNotificationSnapshot>) => void;
}

/**
 * Build the native-notification projection only while publishing it. Keeping
 * the large derived roster out of a React render binding prevents unrelated
 * event-handler closures from retaining an old copy of it.
 */
export const syncDesktopNotificationSnapshot = (
  target: DesktopNotificationSyncTarget | undefined,
  snapshot: ClientSnapshot | null,
  unreadIds: ReadonlySet<string>
): boolean => {
  if (!target || !snapshot) return false;
  target.sync(desktopNotificationSnapshot(snapshot, unreadIds));
  return true;
};

const activeRunsByBot = (snapshot: ClientSnapshot) => {
  const active = new Map<string, RunView>();
  for (const run of snapshot.runs) {
    if (!isActiveRunStatus(run.status)) continue;
    const prior = active.get(run.botId);
    if (!prior || run.updatedAt >= prior.updatedAt) active.set(run.botId, run);
  }
  return active;
};

const activeRunsByChannel = (snapshot: ClientSnapshot) => {
  const active = new Map<string, RunView>();
  for (const run of snapshot.runs) {
    if (!run.channelId || !isActiveRunStatus(run.status)) continue;
    const prior = active.get(run.channelId);
    if (!prior || run.updatedAt >= prior.updatedAt) active.set(run.channelId, run);
  }
  return active;
};

const latestMessageIds = (snapshot: ClientSnapshot) => {
  const latest = new Map<string, { id: string; createdAt: string }>();
  for (const message of snapshot.channelMessages) {
    const prior = latest.get(message.channelId);
    if (!prior || message.createdAt >= prior.createdAt) {
      latest.set(message.channelId, { id: message.id, createdAt: message.createdAt });
    }
  }
  return latest;
};

const agentPeerMessage = (metadata: unknown): boolean =>
  Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      ("fromAgent" in metadata || "toAgent" in metadata)
  );

export const deriveUnreadChannelIds = (
  previous: ClientSnapshot,
  current: ClientSnapshot,
  visibleChannelId: string | null
): string[] => {
  const previousLatest = latestMessageIds(previous);
  const latest = new Map<string, (typeof current.channelMessages)[number]>();
  for (const message of current.channelMessages) {
    const prior = latest.get(message.channelId);
    if (!prior || message.createdAt >= prior.createdAt) latest.set(message.channelId, message);
  }
  return [...latest]
    .filter(
      ([channelId, message]) =>
        channelId !== visibleChannelId &&
        previousLatest.get(channelId)?.id !== message.id &&
        !agentPeerMessage(message.metadata)
    )
    .map(([channelId]) => channelId);
};

export const deriveAgentNotifications = (
  previous: ClientSnapshot,
  current: ClientSnapshot
): AgentNotificationEvent[] => {
  const previousChannels = new Set(previous.channels.map((channel) => channel.id));
  const channelById = new Map(current.channels.map((channel) => [channel.id, channel] as const));
  const botById = new Map(current.bots.map((bot) => [bot.id, bot] as const));
  const previousRuns = activeRunsByChannel(previous);
  const currentRuns = activeRunsByChannel(current);
  const previousMessages = latestMessageIds(previous);
  const currentMessages = latestMessageIds(current);
  const events: AgentNotificationEvent[] = [];

  for (const [channelId, run] of currentRuns) {
    if (!previousChannels.has(channelId) || run.status !== "waiting_approval") continue;
    if (previousRuns.get(channelId)?.status === "waiting_approval") continue;
    const channel = channelById.get(channelId);
    const bot = botById.get(run.botId);
    if (!channel || !bot) continue;
    events.push({
      botId: bot.id,
      channelId,
      kind: "agent-needs-input",
      title: bot.name,
      body: `${channel.name} needs your input`,
    });
  }

  for (const [channelId, run] of previousRuns) {
    if (!previousChannels.has(channelId) || currentRuns.has(channelId)) continue;
    const channel = channelById.get(channelId);
    const bot = botById.get(run.botId);
    const previousMessageId = previousMessages.get(channelId)?.id;
    const currentMessageId = currentMessages.get(channelId)?.id;
    if (!channel || !bot || !currentMessageId || currentMessageId === previousMessageId) continue;
    events.push({
      botId: bot.id,
      channelId,
      kind: "agent-done",
      title: bot.name,
      body: `${channel.name} finished`,
    });
  }
  return events;
};
