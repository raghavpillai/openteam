import type {
  ApprovalView,
  BotView,
  ChannelMessageView,
  ChannelRoundView,
  ChannelView,
  ClientSnapshot,
  RunItemView,
  RunView,
  SubagentActivityView,
} from "@openbot/contracts";

export const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"]);

/**
 * Older or interrupted servers can return a partial snapshot while reconnecting.
 * Keep list consumers total so the mobile launch gate never crashes on `.length`,
 * `.map`, or iteration before the next reconciliation succeeds.
 */
export const normalizeClientSnapshot = (snapshot: ClientSnapshot): ClientSnapshot => ({
  ...snapshot,
  bots: Array.isArray(snapshot.bots) ? snapshot.bots : [],
  channels: Array.isArray(snapshot.channels) ? snapshot.channels : [],
  channelMessages: Array.isArray(snapshot.channelMessages) ? snapshot.channelMessages : [],
  channelRounds: Array.isArray(snapshot.channelRounds) ? snapshot.channelRounds : [],
  runs: Array.isArray(snapshot.runs) ? snapshot.runs : [],
  runItems: Array.isArray(snapshot.runItems) ? snapshot.runItems : [],
  approvals: Array.isArray(snapshot.approvals) ? snapshot.approvals : [],
  subagents: Array.isArray(snapshot.subagents) ? snapshot.subagents : [],
});

export interface SnapshotIndex {
  botById: ReadonlyMap<string, BotView>;
  channelById: ReadonlyMap<string, ChannelView>;
  messagesByChannel: ReadonlyMap<string, ChannelMessageView[]>;
  runsByChannel: ReadonlyMap<string, RunView[]>;
  itemsByRun: ReadonlyMap<string, RunItemView[]>;
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  subagentsByChannel: ReadonlyMap<string, SubagentActivityView[]>;
  roundsByChannel: ReadonlyMap<string, ChannelRoundView[]>;
  latestMessageByChannel: ReadonlyMap<string, ChannelMessageView>;
  activeRunByChannel: ReadonlyMap<string, RunView>;
}

const append = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
};

const activeRunRank = (run: RunView): number => (run.status === "queued" ? 1 : 2);

export const createSnapshotIndex = (snapshot: ClientSnapshot): SnapshotIndex => {
  const normalized = normalizeClientSnapshot(snapshot);
  const messagesByChannel = new Map<string, ChannelMessageView[]>();
  const runsByChannel = new Map<string, RunView[]>();
  const itemsByRun = new Map<string, RunItemView[]>();
  const approvalsByRun = new Map<string, ApprovalView[]>();
  const subagentsByChannel = new Map<string, SubagentActivityView[]>();
  const roundsByChannel = new Map<string, ChannelRoundView[]>();
  const latestMessageByChannel = new Map<string, ChannelMessageView>();
  const activeRunByChannel = new Map<string, RunView>();

  for (const message of normalized.channelMessages) {
    append(messagesByChannel, message.channelId, message);
    latestMessageByChannel.set(message.channelId, message);
  }
  for (const run of normalized.runs) {
    if (!run.channelId) continue;
    append(runsByChannel, run.channelId, run);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const current = activeRunByChannel.get(run.channelId);
    if (!current || activeRunRank(run) >= activeRunRank(current)) {
      activeRunByChannel.set(run.channelId, run);
    }
  }
  for (const item of normalized.runItems) append(itemsByRun, item.runId, item);
  for (const approval of normalized.approvals) append(approvalsByRun, approval.runId, approval);
  for (const subagent of normalized.subagents) {
    append(subagentsByChannel, subagent.parentChannelId, subagent);
  }
  for (const round of normalized.channelRounds) append(roundsByChannel, round.channelId, round);

  return {
    botById: new Map(normalized.bots.map((bot) => [bot.id, bot])),
    channelById: new Map(normalized.channels.map((channel) => [channel.id, channel])),
    messagesByChannel,
    runsByChannel,
    itemsByRun,
    approvalsByRun,
    subagentsByChannel,
    roundsByChannel,
    latestMessageByChannel,
    activeRunByChannel,
  };
};

export interface MobileChannelRow {
  channel: ChannelView;
  bot: BotView | null;
  latest: ChannelMessageView | null;
  activeRun: RunView | null;
  hasApproval: boolean;
}

export const selectMobileChannelRows = (
  snapshot: ClientSnapshot,
  options: { includeHiddenBots?: boolean } = {}
): MobileChannelRow[] => {
  const normalized = normalizeClientSnapshot(snapshot);
  const index = createSnapshotIndex(normalized);
  return normalized.channels
    .flatMap((channel) => {
      const botId = channel.kind === "bot_dm" ? channel.members[0]?.botId : undefined;
      const bot = botId ? (index.botById.get(botId) ?? null) : null;
      if (!options.includeHiddenBots && bot?.hiddenFromSidebar) return [];
      const activeRun = index.activeRunByChannel.get(channel.id) ?? null;
      return [
        {
          channel,
          bot,
          latest: index.latestMessageByChannel.get(channel.id) ?? null,
          activeRun,
          hasApproval: Boolean(
            activeRun &&
              (index.approvalsByRun.get(activeRun.id) ?? []).some(
                (item) => item.status === "pending"
              )
          ),
        },
      ];
    })
    .sort((left, right) => {
      const leftAt = left.latest?.createdAt ?? left.channel.createdAt;
      const rightAt = right.latest?.createdAt ?? right.channel.createdAt;
      return rightAt.localeCompare(leftAt) || left.channel.id.localeCompare(right.channel.id);
    });
};
