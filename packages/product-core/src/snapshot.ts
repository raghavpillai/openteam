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
} from "@openteam/contracts";
import { a2aProjectionFor } from "./messages";
import { ACTIVE_RUN_STATUSES, isActiveRunStatus } from "./statuses";

export { ACTIVE_RUN_STATUSES };

export interface SnapshotIndex {
  botById: ReadonlyMap<string, BotView>;
  agentNameById: ReadonlyMap<string, string>;
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

export const selectActiveRun = (active: Map<string, RunView>, run: RunView): void => {
  if (!run.channelId || !isActiveRunStatus(run.status)) return;
  const current = active.get(run.channelId);
  if (!current || activeRunRank(run) >= activeRunRank(current)) active.set(run.channelId, run);
};

export const indexA2AAgentNames = (
  messages: readonly ChannelMessageView[]
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const message of messages) {
    const projection = a2aProjectionFor(message);
    if (projection?.peerId && projection.peerName) {
      names.set(projection.peerId, projection.peerName);
    }
  }
  return names;
};

export const createSnapshotIndex = (snapshot: ClientSnapshot): SnapshotIndex => {
  const agentNameById = indexA2AAgentNames(snapshot.channelMessages);
  const messagesByChannel = new Map<string, ChannelMessageView[]>();
  const runsByChannel = new Map<string, RunView[]>();
  const itemsByRun = new Map<string, RunItemView[]>();
  const approvalsByRun = new Map<string, ApprovalView[]>();
  const subagentsByChannel = new Map<string, SubagentActivityView[]>();
  const roundsByChannel = new Map<string, ChannelRoundView[]>();
  const latestMessageByChannel = new Map<string, ChannelMessageView>();
  const activeRunByChannel = new Map<string, RunView>();
  for (const message of snapshot.channelMessages) {
    append(messagesByChannel, message.channelId, message);
    latestMessageByChannel.set(message.channelId, message);
  }
  for (const run of snapshot.runs) {
    if (run.channelId) append(runsByChannel, run.channelId, run);
    selectActiveRun(activeRunByChannel, run);
  }
  for (const item of snapshot.runItems) append(itemsByRun, item.runId, item);
  for (const approval of snapshot.approvals) append(approvalsByRun, approval.runId, approval);
  for (const subagent of snapshot.subagents ?? []) {
    append(subagentsByChannel, subagent.parentChannelId, subagent);
  }
  for (const round of snapshot.channelRounds) append(roundsByChannel, round.channelId, round);
  return {
    botById: new Map(snapshot.bots.map((bot) => [bot.id, bot])),
    agentNameById,
    channelById: new Map(snapshot.channels.map((channel) => [channel.id, channel])),
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

export interface ChannelRowProjection {
  channel: ChannelView;
  bot: BotView | null;
  latest: ChannelMessageView | null;
  activeRun: RunView | null;
  hasApproval: boolean;
}

export const selectChannelRows = (
  snapshot: ClientSnapshot,
  options: { includeHiddenBots?: boolean } = {}
): ChannelRowProjection[] => {
  const index = createSnapshotIndex(snapshot);
  return snapshot.channels
    .flatMap((channel) => {
      if (channel.kind === "group" && channel.hiddenFromSidebar) return [];
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
                (approval) => approval.status === "pending"
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

/** @deprecated Use the platform-neutral ChannelRowProjection name. */
export type MobileChannelRow = ChannelRowProjection;
/** @deprecated Use selectChannelRows. */
export const selectMobileChannelRows = selectChannelRows;
