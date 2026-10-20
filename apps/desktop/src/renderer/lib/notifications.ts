import { notificationAvatarDataUrl } from "./notification-avatar";
import type { ClientSnapshot } from "@openteam/contracts";
import type { ChannelNotificationState } from "@openteam/contracts/notification-content";

export const desktopNotificationSnapshot = (
  snapshot: ClientSnapshot
): {
  cursor: string;
  channels: Array<ChannelNotificationState & { unreadCount: number }>;
} => {
  const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot] as const));
  return {
    cursor: snapshot.cursor,
    channels: snapshot.channels.flatMap((channel) =>
      channel.notificationState &&
      !channel.hiddenFromSidebar &&
      channel.members.some((member) => !botById.get(member.botId)?.hiddenFromSidebar)
        ? [
            {
              ...channel.notificationState,
              notifications: channel.notificationState.notifications.map((alert) => ({
                ...alert,
              })),
              // Muted Bots stay out of the Dock badge.
              unreadCount:
                channel.kind === "bot_dm" &&
                botById.get(channel.members[0]?.botId ?? "")?.notificationsEnabled === false
                  ? 0
                  : (channel.unreadCount ?? 0),
            },
          ]
        : []
    ),
  };
};

export interface DesktopNotificationSyncTarget {
  sync: (snapshot: ReturnType<typeof desktopNotificationSnapshot>) => void;
  clear?: () => void;
}

/**
 * Build the native-notification projection only while publishing it. Keeping
 * the large derived roster out of a React render binding prevents unrelated
 * event-handler closures from retaining an old copy of it.
 */
const pendingAvatarSync = new WeakMap<DesktopNotificationSyncTarget, object>();

export const syncDesktopNotificationSnapshot = (
  target: DesktopNotificationSyncTarget | undefined,
  snapshot: ClientSnapshot | null
): boolean => {
  if (!target) return false;
  if (!snapshot) {
    pendingAvatarSync.delete(target);
    target.clear?.();
    return false;
  }
  const projection = desktopNotificationSnapshot(snapshot);
  const generation = {};
  pendingAvatarSync.set(target, generation);
  const alerts = projection.channels.flatMap((channel) => channel.notifications);
  if (typeof Image === "undefined" || !alerts.some((alert) => alert.sender)) {
    target.sync(projection);
  } else {
    void Promise.all(
      alerts.map(async (alert) => {
        if (alert.sender)
          alert.sender = {
            ...alert.sender,
            avatarDataUrl: await notificationAvatarDataUrl(alert.sender),
          };
      })
    ).then(() => {
      if (pendingAvatarSync.get(target) === generation) target.sync(projection);
    });
  }
  return true;
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
