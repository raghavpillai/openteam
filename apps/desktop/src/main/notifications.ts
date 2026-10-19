import {
  type AgentNotificationKind,
  truncateNotificationText,
  notificationIsRead,
  type ChannelNotificationState,
  type ChannelNotificationView,
  type NotificationSender,
  isAgentNotificationKind,
} from "@openteam/contracts/notification-content";

export type DesktopNotificationKind = AgentNotificationKind;

export interface DesktopNotificationSnapshot {
  cursor?: string;
  channels: Array<ChannelNotificationState & { unreadCount: number }>;
}

export const parseNotificationChannels = (
  value: unknown
): NonNullable<DesktopNotificationSnapshot["channels"]> | null => {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const numeric = (field: unknown) => typeof field === "string" && /^\d{1,20}$/.test(field);
  for (const channel of value) {
    if (
      !channel ||
      typeof channel !== "object" ||
      typeof channel.channelId !== "string" ||
      !numeric(channel.lastReadSequence) ||
      !numeric(channel.lastReadNotificationSequence) ||
      !numeric(channel.notificationCursor) ||
      typeof channel.unreadCount !== "number" ||
      !Number.isFinite(channel.unreadCount) ||
      channel.unreadCount < 0 ||
      !Array.isArray(channel.notifications) ||
      channel.notifications.length > 100
    )
      return null;
    for (const notification of channel.notifications) {
      if (
        !notification ||
        notification.channelId !== channel.channelId ||
        typeof notification.botId !== "string" ||
        !isAgentNotificationKind(notification.kind) ||
        !numeric(notification.notificationSequence) ||
        (notification.messageSequence !== undefined && !numeric(notification.messageSequence)) ||
        (notification.threadMessageId !== undefined &&
          (typeof notification.threadMessageId !== "string" ||
            notification.threadMessageId.length > 64)) ||
        typeof notification.title !== "string" ||
        typeof notification.body !== "string" ||
        notification.title.length > 1000 ||
        notification.body.length > 4000 ||
        (notification.sender !== undefined &&
          (!notification.sender ||
            typeof notification.sender !== "object" ||
            typeof notification.sender.name !== "string" ||
            notification.sender.name.length > 1000 ||
            typeof notification.sender.icon !== "string" ||
            notification.sender.icon.length > 64 ||
            typeof notification.sender.color !== "string" ||
            !/^#[0-9a-f]{6}$/i.test(notification.sender.color) ||
            (notification.sender.avatarDataUrl !== undefined &&
              (typeof notification.sender.avatarDataUrl !== "string" ||
                notification.sender.avatarDataUrl.length > 100_000 ||
                !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(
                  notification.sender.avatarDataUrl
                )))))
      )
        return null;
    }
  }
  return value;
};

export interface DesktopNotificationEvent {
  notificationId: string;
  sender?: NotificationSender;
  botId: string;
  channelId: string;
  threadMessageId?: string;
  kind: DesktopNotificationKind;
  title: string;
  body: string;
}

export interface DesktopNotificationAdapter {
  isFocused: () => boolean;
  isSupported: () => boolean;
  /** Banners are silent. */
  deliver: (event: DesktopNotificationEvent) => void;
  /** Closes a delivered banner once its message is read on any device. */
  dismiss?: (notificationId: string) => void;
  setBadge: (label: string) => void;
}

export { truncateNotificationText };

/**
 * Each conversation gets one banner in this window (a DM is its Bot, a group is
 * the whole room). Messages that land inside it are consumed, not replayed, so a
 * burst of replies produces a single banner.
 */
export const NOTIFICATION_THROTTLE_MS = 5_000;

export class DesktopNotificationManager {
  private readonly unreadByChannel = new Map<string, number>();
  private readonly lastAlertAt = new Map<string, number>();
  private lastCursor: bigint | null = null;
  private totalUnread = 0;
  private visibleChannelId: string | null = null;
  private lastBadge = "";
  private activityCursors = new Map<string, bigint>();
  private deliveredActivity = new Map<string, ChannelNotificationView>();

  constructor(
    private readonly adapter: DesktopNotificationAdapter,
    private readonly now: () => number = Date.now
  ) {}

  private updateBadge(): void {
    const visibleUnread = this.visibleChannelId
      ? (this.unreadByChannel.get(this.visibleChannelId) ?? 0)
      : 0;
    const badge = Math.max(0, this.totalUnread - visibleUnread);
    const label = badge > 0 ? String(badge) : "";
    if (label === this.lastBadge) return;
    this.lastBadge = label;
    this.adapter.setBadge(label);
  }

  setVisibleChannel(channelId: string | null): void {
    if (channelId === this.visibleChannelId) return;
    this.visibleChannelId = channelId;
    this.updateBadge();
  }

  sync(snapshot: DesktopNotificationSnapshot): void {
    const cursor =
      snapshot.cursor && /^\d+$/.test(snapshot.cursor) ? BigInt(snapshot.cursor) : null;
    if (cursor !== null && this.lastCursor !== null && cursor < this.lastCursor) return;
    if (cursor !== null) this.lastCursor = cursor;
    const channels = snapshot.channels;
    const byChannel = new Map(channels.map((channel) => [channel.channelId, channel]));
    // Read on this Mac or on the iPhone: either way the banner has done its job.
    for (const [id, notification] of this.deliveredActivity) {
      const state = byChannel.get(notification.channelId);
      if (!state || notificationIsRead(notification, state)) {
        this.adapter.dismiss?.(id);
        this.deliveredActivity.delete(id);
      }
    }
    this.unreadByChannel.clear();
    this.totalUnread = 0;
    // Newest unread message per conversation; older ones in this sync are superseded.
    const pending = new Map<string, { sequence: bigint; notification: ChannelNotificationView }>();
    for (const channel of channels) {
      this.unreadByChannel.set(channel.channelId, channel.unreadCount);
      this.totalUnread += channel.unreadCount;
      const previousCursor = this.activityCursors.get(channel.channelId);
      const channelCursor = BigInt(channel.notificationCursor);
      if (previousCursor !== undefined && channelCursor < previousCursor) continue;
      this.activityCursors.set(channel.channelId, channelCursor);
      if (previousCursor === undefined) continue;
      for (const notification of channel.notifications) {
        const sequence = BigInt(notification.notificationSequence);
        if (
          sequence <= previousCursor ||
          notification.kind === "reaction" ||
          notificationIsRead(notification, channel)
        )
          continue;
        if ((pending.get(channel.channelId)?.sequence ?? -1n) > sequence) continue;
        pending.set(channel.channelId, { sequence, notification });
      }
    }
    for (const channelId of this.activityCursors.keys()) {
      if (!byChannel.has(channelId)) this.activityCursors.delete(channelId);
    }
    const now = this.now();
    for (const [channelId, at] of this.lastAlertAt) {
      if (now - at >= NOTIFICATION_THROTTLE_MS) this.lastAlertAt.delete(channelId);
    }
    // While the window has focus, new replies show in the app instead of as banners.
    if (!this.adapter.isFocused() && this.adapter.isSupported()) {
      for (const [channelId, { notification }] of pending) {
        if (this.lastAlertAt.has(channelId)) continue;
        this.lastAlertAt.set(channelId, now);
        const event = alertEvent(notification);
        this.deliveredActivity.set(event.notificationId, notification);
        this.adapter.deliver(event);
      }
    }
    this.updateBadge();
  }

  clear(): void {
    for (const id of this.deliveredActivity.keys()) this.adapter.dismiss?.(id);
    this.deliveredActivity.clear();
    this.activityCursors.clear();
    this.lastAlertAt.clear();
    this.unreadByChannel.clear();
    this.lastCursor = null;
    this.totalUnread = 0;
    this.visibleChannelId = null;
    if (this.lastBadge) {
      this.lastBadge = "";
      this.adapter.setBadge("");
    }
  }
}

const alertEvent = (notification: ChannelNotificationView): DesktopNotificationEvent => ({
  ...notification,
  notificationId: `${notification.channelId}:${notification.notificationSequence}`,
  // The server has already formatted the title and plain-text body.
  title: notification.title,
  body: truncateNotificationText(notification.body),
});
