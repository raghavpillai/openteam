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

export type DesktopNotificationKind = AgentNotificationKind;

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

export interface DesktopNotificationSnapshot {
  cursor?: string;
  agents: DesktopAgentNotificationState[];
  channels?: Array<ChannelNotificationState & { unreadCount: number }>;
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

const byBotId = (snapshot: DesktopNotificationSnapshot) =>
  new Map(snapshot.agents.map((agent) => [agent.botId, agent] as const));

export class DesktopNotificationManager {
  private previous: DesktopNotificationSnapshot | null = null;
  private readonly accountedMessageByBot = new Map<string, string>();
  private readonly lastDeliveredAt = new Map<string, number>();
  private readonly unreadByChannel = new Map<string, number>();
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
    if (snapshot.channels) {
      this.syncActivity(snapshot.channels);
      this.previous = snapshot;
      return;
    }
    const currentBotIds = new Set(snapshot.agents.map((agent) => agent.botId));
    for (const botId of this.accountedMessageByBot.keys()) {
      if (!currentBotIds.has(botId)) this.accountedMessageByBot.delete(botId);
    }
    for (const key of this.lastDeliveredAt.keys()) {
      const separator = key.lastIndexOf(":");
      const botId = separator < 0 ? key : key.slice(0, separator);
      if (!currentBotIds.has(botId)) this.lastDeliveredAt.delete(key);
    }
    this.unreadByChannel.clear();
    this.totalUnread = 0;
    for (const agent of snapshot.agents) {
      if (agent.hiddenFromSidebar || agent.unreadCount <= 0) continue;
      const unread = Math.max(1, Math.floor(agent.unreadCount));
      this.unreadByChannel.set(
        agent.channelId,
        (this.unreadByChannel.get(agent.channelId) ?? 0) + unread
      );
      this.totalUnread += unread;
    }
    this.updateBadge();

    if (!this.previous) {
      this.previous = snapshot;
      for (const agent of snapshot.agents) {
        if (agent.lastMessageId) this.accountedMessageByBot.set(agent.botId, agent.lastMessageId);
      }
      return;
    }

    const previous = byBotId(this.previous);
    this.previous = snapshot;
    for (const agent of snapshot.agents) {
      const prior = previous.get(agent.botId);
      if (!prior) {
        if (agent.lastMessageId) this.accountedMessageByBot.set(agent.botId, agent.lastMessageId);
        continue;
      }

      let event: DesktopNotificationEvent | null = null;
      if (!prior.awaitingReason && agent.awaitingReason) {
        const presentation = agentNotificationPresentation({
          kind: "agent-needs-input",
          botName: agent.name,
          body: agent.awaitingReason,
        });
        event = {
          botId: agent.botId,
          channelId: agent.channelId,
          kind: "agent-needs-input",
          ...presentation,
        };
      } else if (prior.isRunning && !agent.isRunning && !agent.awaitingReason) {
        const accounted = this.accountedMessageByBot.get(agent.botId);
        if (agent.unreadCount > 0 && agent.lastMessageId && agent.lastMessageId !== accounted) {
          const presentation = agentNotificationPresentation({
            kind: "agent-done",
            botName: agent.name,
            body: agent.lastMessagePreview,
          });
          event = {
            botId: agent.botId,
            channelId: agent.channelId,
            kind: "agent-done",
            ...presentation,
          };
        }
        if (agent.lastMessageId) {
          this.accountedMessageByBot.set(agent.botId, agent.lastMessageId);
        }
      }

      if (!event) continue;
      if (
        !agent.notificationsEnabled ||
        agent.hiddenFromSidebar ||
        this.adapter.isFocused() ||
        !this.adapter.isSupported()
      ) {
        continue;
      }
      const throttleKey = `${agent.botId}:${event.kind}`;
      const now = this.now();
      if (now - (this.lastDeliveredAt.get(throttleKey) ?? 0) < 5_000) continue;
      this.lastDeliveredAt.set(throttleKey, now);
      this.adapter.deliver(event);
    }
  }

  private syncActivity(channels: NonNullable<DesktopNotificationSnapshot["channels"]>): void {
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
    for (const channel of channels) {
      this.unreadByChannel.set(channel.channelId, channel.unreadCount);
      this.totalUnread += channel.unreadCount;
      const previousCursor = this.activityCursors.get(channel.channelId);
      const cursor = BigInt(channel.notificationCursor);
      if (previousCursor !== undefined && cursor < previousCursor) continue;
      this.activityCursors.set(channel.channelId, cursor);
      if (previousCursor === undefined) continue;
      for (const notification of [...channel.notifications].sort((a, b) =>
        BigInt(a.notificationSequence) < BigInt(b.notificationSequence) ? -1 : 1
      )) {
        if (
          BigInt(notification.notificationSequence) <= previousCursor ||
          notificationIsRead(notification, channel)
        )
          continue;
        if (
          (this.adapter.isFocused() && this.visibleChannelId === channel.channelId) ||
          !this.adapter.isSupported()
        )
          continue;
        const id = `${channel.channelId}:${notification.notificationSequence}`;
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
          sound: presentation.sound,
          urgency: presentation.urgency,
        });
      }
    }
    for (const channelId of this.activityCursors.keys()) {
      if (!byChannel.has(channelId)) this.activityCursors.delete(channelId);
    }
    this.updateBadge();
  }

  clear(): void {
    for (const id of this.deliveredActivity.keys()) this.adapter.dismiss?.(id);
    this.deliveredActivity.clear();
    this.activityCursors.clear();
    this.previous = null;
    this.accountedMessageByBot.clear();
    this.lastDeliveredAt.clear();
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
