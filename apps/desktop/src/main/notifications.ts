import {
  agentNotificationPresentation,
  truncateNotificationText,
  type AgentNotificationKind,
  type AgentNotificationPresentation,
} from "@openbot/contracts";

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
  private lastCursor: bigint | null = null;

  constructor(
    private readonly adapter: DesktopNotificationAdapter,
    private readonly now: () => number = Date.now
  ) {}

  sync(snapshot: DesktopNotificationSnapshot): void {
    const cursor =
      snapshot.cursor && /^\d+$/.test(snapshot.cursor) ? BigInt(snapshot.cursor) : null;
    if (cursor !== null && this.lastCursor !== null && cursor < this.lastCursor) return;
    if (cursor !== null) this.lastCursor = cursor;
    const badge = snapshot.agents.reduce(
      (count, agent) =>
        count +
        (agent.hiddenFromSidebar || agent.unreadCount <= 0
          ? 0
          : Math.max(1, Math.floor(agent.unreadCount))),
      0
    );
    this.adapter.setBadge(badge > 0 ? String(badge) : "");

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
    this.lastCursor = null;
    this.adapter.setBadge("");
  }
}
