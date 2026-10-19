import {
  type AgentNotificationKind,
  type AgentNotificationPresentation,
  agentNotificationPresentation,
  truncateNotificationText,
  notificationIsRead,
  type ChannelNotificationState,
  type ChannelNotificationView,
  type NotificationSender,
  isAgentNotificationKind,
} from "@openteam/contracts/notification-content";
import { desktopNotificationQuietMs, type NotificationRouting } from "@openteam/contracts/notification-presence";

export type DesktopNotificationKind = AgentNotificationKind;

export interface DesktopNotificationSnapshot {
  notificationRouting?: NotificationRouting;
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
  notificationId?: string;
  sender?: NotificationSender;
  botId: string;
  channelId: string;
  kind: DesktopNotificationKind;
  title: string;
  body: string;
  sound: AgentNotificationPresentation["sound"];
  urgency: AgentNotificationPresentation["urgency"];
}

export interface DesktopNotificationAdapter {
  isFocused: () => boolean;
  isSupported: () => boolean;
  deliver: (event: DesktopNotificationEvent) => void;
  dismiss?: (notificationId: string) => void;
  setBadge: (label: string) => void;
}

export { truncateNotificationText };

/**
 * Each conversation gets one alert per kind in this window (a DM is its Bot, a
 * group is the whole room). Alerts that land inside it are consumed, not
 * replayed, so a burst of replies produces a single banner.
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
  private quietUntil = 0;
  private routingTime = -1;

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
    const routing = snapshot.notificationRouting;
    if (routing && routing.serverTime > this.routingTime) {
      this.routingTime = routing.serverTime;
      this.quietUntil = this.now() + desktopNotificationQuietMs(routing);
    }
    const channels = snapshot.channels;
    const byChannel = new Map(channels.map((channel) => [channel.channelId, channel]));
    for (const [id, notification] of this.deliveredActivity) {
      const state = byChannel.get(notification.channelId);
      if (!state || notificationIsRead(notification, state)) {
        this.adapter.dismiss?.(id);
        this.deliveredActivity.delete(id);
      }
    }
    this.unreadByChannel.clear();
    this.totalUnread = 0;
    // Newest unread alert per conversation and kind; older ones in this sync are superseded.
    const pending = new Map<string, { id: string; notification: ChannelNotificationView }>();
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
        const key = `${channel.channelId}:${notification.kind}`;
        const prior = pending.get(key);
        if (prior && BigInt(prior.notification.notificationSequence) > sequence) continue;
        pending.set(key, {
          id: `${channel.channelId}:${notification.notificationSequence}`,
          notification,
        });
      }
    }
    for (const channelId of this.activityCursors.keys()) {
      if (!byChannel.has(channelId)) this.activityCursors.delete(channelId);
    }
    const now = this.now();
    for (const [key, at] of this.lastAlertAt) {
      if (now - at >= NOTIFICATION_THROTTLE_MS) this.lastAlertAt.delete(key);
    }
    // While the window has focus, new replies show in the app instead of as banners.
    const suppressed =
      this.adapter.isFocused() || now < this.quietUntil || !this.adapter.isSupported();
    for (const [key, { id, notification }] of pending) {
      if (suppressed || this.lastAlertAt.has(key)) continue;
      this.lastAlertAt.set(key, now);
      this.deliveredActivity.set(id, notification);
      const presentation = agentNotificationPresentation({
        kind: notification.kind,
        botName: notification.title,
        body: notification.body,
      });
      this.adapter.deliver({
        ...notification,
        notificationId: id,
        // The server has already formatted the title (including needs-input).
        title: notification.title,
        body: truncateNotificationText(notification.body),
        // Message banners are silent on the Mac; only a Bot blocked on the user plays a sound.
        sound: notification.kind === "agent-needs-input" ? presentation.sound : null,
        urgency: presentation.urgency,
      });
    }
    this.updateBadge();
  }

  clear(): void {
    this.quietUntil = 0;
    this.routingTime = -1;
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
