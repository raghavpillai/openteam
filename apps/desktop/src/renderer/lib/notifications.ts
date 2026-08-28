import type { ClientSnapshot, RunView } from "@openbot/contracts";

const ACTIVE = new Set(["queued", "running", "waiting_approval"]);

export interface AgentNotificationEvent {
  botId: string;
  channelId: string;
  kind: "agent-needs-input" | "agent-done";
  title: string;
  body: string;
}

const activeRunsByChannel = (snapshot: ClientSnapshot) => {
  const active = new Map<string, RunView>();
  for (const run of snapshot.runs) {
    if (!run.channelId || !ACTIVE.has(run.status)) continue;
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
