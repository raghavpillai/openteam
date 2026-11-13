import {
  type AgentNotificationKind,
  truncateNotificationText,
  notificationIsRead,
  type ChannelNotificationState,
  type ChannelNotificationView,
  type NotificationSender,
  isAgentNotificationKind,
  type DesktopNotificationTarget,
  type NotificationReadState,
} from "@openteam/contracts/notification-content";

export const parseNotificationTarget = (value: unknown): DesktopNotificationTarget | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  const validId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 128;
  if (!validId(target.channelId)) return null;
  for (const key of ["messageId", "threadMessageId"] as const) {
    if (target[key] !== undefined && !validId(target[key])) return null;
  }
  if (target.messageSequence !== undefined &&
    (typeof target.messageSequence !== "string" || !/^\d{1,20}$/.test(target.messageSequence))) return null;
  return {
    channelId: target.channelId as string,
    ...(typeof target.messageId === "string" ? { messageId: target.messageId } : {}),
    ...(typeof target.messageSequence === "string" ? { messageSequence: target.messageSequence } : {}),
    ...(typeof target.threadMessageId === "string" ? { threadMessageId: target.threadMessageId } : {}),
  };
};

export type DesktopNotificationKind = AgentNotificationKind;

export const parseNotificationReadState = (value: unknown): NotificationReadState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.channelId !== "string" || !state.channelId.trim() || state.channelId.length > 128)
    return null;
  for (const key of ["lastReadSequence", "lastReadNotificationSequence"] as const) {
    if (typeof state[key] !== "string" || !/^\d{1,20}$/.test(state[key])) return null;
  }
  return {
    channelId: state.channelId,
    lastReadSequence: state.lastReadSequence as string,
    lastReadNotificationSequence: state.lastReadNotificationSequence as string,
  };
};

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
        !numeric(notification.messageSequence) ||
        (notification.messageId !== undefined &&
          (typeof notification.messageId !== "string" || notification.messageId.length > 128 || !notification.messageId)) ||
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

export interface DesktopNotificationEvent extends DesktopNotificationTarget {
  notificationId: string;
  sender?: NotificationSender;
  botId: string;
  kind: DesktopNotificationKind;
  title: string;
  body: string;
}

interface DesktopNotificationAdapter {
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
/** Let an arriving read receipt or window-focus transition settle before showing a banner. */
export const NOTIFICATION_DELIVERY_DELAY_MS = 300;

const scheduleNotification = (callback: () => void, delay: number): (() => void) => {
  const timer = setTimeout(callback, delay);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class DesktopNotificationManager {
  private readonly unreadByChannel = new Map<string, number>();
  private readonly lastAlertAt = new Map<string, number>();
  private lastCursor: bigint | null = null;
  private totalUnread = 0;
  private visibleChannelId: string | null = null;
  private lastBadge = "";
  private activityCursors = new Map<string, bigint>();
  private deliveredActivity = new Map<string, ChannelNotificationView>();
  private readonly localReads = new Map<string, NotificationReadState>();
  private readonly pendingActivity = new Map<
    string,
    { notification: ChannelNotificationView; cancel: () => void }
  >();

  constructor(
    private readonly adapter: DesktopNotificationAdapter,
    private readonly now: () => number = Date.now,
    private readonly schedule: typeof scheduleNotification = scheduleNotification
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
    // Even a brief return to the app consumes pending banners, without replay on blur.
    if (channelId !== null) {
      for (const id of this.pendingActivity.keys()) this.cancelPending(id);
    }
    if (channelId === this.visibleChannelId) return;
    this.visibleChannelId = channelId;
    this.updateBadge();
  }

  private cancelPending(channelId: string): void {
    this.pendingActivity.get(channelId)?.cancel();
    this.pendingActivity.delete(channelId);
  }

  private isLocallyRead(notification: ChannelNotificationView): boolean {
    const state = this.localReads.get(notification.channelId);
    return Boolean(state && notificationIsRead(notification, state));
  }

  /** The user has viewed these messages, even if persisting the read is slow or fails. */
  markRead(state: NotificationReadState): void {
    const previous = this.localReads.get(state.channelId);
    const max = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);
    this.localReads.set(state.channelId, {
      channelId: state.channelId,
      lastReadSequence: max(previous?.lastReadSequence ?? "0", state.lastReadSequence),
      lastReadNotificationSequence: max(
        previous?.lastReadNotificationSequence ?? "0",
        state.lastReadNotificationSequence
      ),
    });
    const pending = this.pendingActivity.get(state.channelId);
    if (pending && this.isLocallyRead(pending.notification)) this.cancelPending(state.channelId);
    for (const [id, notification] of this.deliveredActivity) {
      if (this.isLocallyRead(notification)) {
        this.adapter.dismiss?.(id);
        this.deliveredActivity.delete(id);
      }
    }
  }

  sync(snapshot: DesktopNotificationSnapshot): void {
    const cursor =
      snapshot.cursor && /^\d+$/.test(snapshot.cursor) ? BigInt(snapshot.cursor) : null;
    if (cursor !== null && this.lastCursor !== null && cursor < this.lastCursor) return;
    if (cursor !== null) this.lastCursor = cursor;
    const channels = snapshot.channels;
    const byChannel = new Map(channels.map((channel) => [channel.channelId, channel]));
    for (const [channelId, { notification }] of this.pendingActivity) {
      const state = byChannel.get(channelId);
      if (!state || notificationIsRead(notification, state) || this.isLocallyRead(notification))
        this.cancelPending(channelId);
    }
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
          notificationIsRead(notification, channel) ||
          this.isLocallyRead(notification)
        )
          continue;
        if ((pending.get(channel.channelId)?.sequence ?? -1n) > sequence) continue;
        pending.set(channel.channelId, { sequence, notification });
      }
    }
    for (const channelId of this.activityCursors.keys()) {
      if (!byChannel.has(channelId)) this.activityCursors.delete(channelId);
    }
    for (const channelId of this.localReads.keys()) {
      if (!byChannel.has(channelId)) this.localReads.delete(channelId);
    }
    const now = this.now();
    for (const [channelId, at] of this.lastAlertAt) {
      if (now - at >= NOTIFICATION_THROTTLE_MS) this.lastAlertAt.delete(channelId);
    }
    // While the window has focus, replies show in the app instead of as banners.
    if (this.adapter.isFocused()) {
      // Native focus can overtake the renderer's separate visible-channel IPC.
      for (const channelId of this.pendingActivity.keys()) this.cancelPending(channelId);
    } else if (this.adapter.isSupported()) {
      for (const [channelId, { notification }] of pending) {
        if (this.lastAlertAt.has(channelId)) continue;
        const existing = this.pendingActivity.get(channelId);
        if (existing) {
          // Coalesce a burst without extending the original delivery deadline.
          existing.notification = notification;
          continue;
        }
        const entry = { notification, cancel: () => {} };
        this.pendingActivity.set(channelId, entry);
        entry.cancel = this.schedule(() => {
          if (this.pendingActivity.get(channelId) !== entry) return;
          this.pendingActivity.delete(channelId);
          if (
            this.adapter.isFocused() ||
            !this.adapter.isSupported() ||
            this.isLocallyRead(entry.notification)
          )
            return;
          this.lastAlertAt.set(channelId, this.now());
          const event = alertEvent(entry.notification);
          this.deliveredActivity.set(event.notificationId, entry.notification);
          this.adapter.deliver(event);
        }, NOTIFICATION_DELIVERY_DELAY_MS);
      }
    }
    this.updateBadge();
  }

  clear(): void {
    for (const channelId of this.pendingActivity.keys()) this.cancelPending(channelId);
    this.localReads.clear();
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
