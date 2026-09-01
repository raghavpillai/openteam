import {
  type AgentNotificationKind,
  type AgentNotificationPresentation,
  agentNotificationPresentation,
  truncateNotificationText,
} from "@openbot/contracts/notification-content";

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
}

export interface DesktopNotificationEvent {
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
        if (agent.lastMessageId && agent.lastMessageId !== accounted) {
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

  clear(): void {
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
