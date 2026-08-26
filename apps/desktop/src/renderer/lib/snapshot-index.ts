import type {
  ApprovalView,
  BotView,
  ChannelMessageView,
  ChannelRoundView,
  ChannelView,
  ClientSnapshot,
  RunItemView,
  RunView,
} from "@openbot/contracts";
import { useMemo, useRef } from "react";

export const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"]);

const activeRunRank = (run: RunView): number => (run.status === "queued" ? 1 : 2);

const selectActiveRun = (active: Map<string, RunView>, run: RunView): void => {
  if (!run.channelId || !ACTIVE_RUN_STATUSES.has(run.status)) return;
  const current = active.get(run.channelId);
  if (!current || activeRunRank(run) >= activeRunRank(current)) {
    active.set(run.channelId, run);
  }
};

export interface SnapshotIndex {
  botById: ReadonlyMap<string, BotView>;
  channelById: ReadonlyMap<string, ChannelView>;
  messagesByChannel: ReadonlyMap<string, ChannelMessageView[]>;
  runsByChannel: ReadonlyMap<string, RunView[]>;
  itemsByRun: ReadonlyMap<string, RunItemView[]>;
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>;
  roundsByChannel: ReadonlyMap<string, ChannelRoundView[]>;
  latestMessageByChannel: ReadonlyMap<string, ChannelMessageView>;
  activeRunByChannel: ReadonlyMap<string, RunView>;
}

const append = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
};

export function createSnapshotIndex(snapshot: ClientSnapshot): SnapshotIndex {
  const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const channelById = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const messagesByChannel = new Map<string, ChannelMessageView[]>();
  const runsByChannel = new Map<string, RunView[]>();
  const itemsByRun = new Map<string, RunItemView[]>();
  const approvalsByRun = new Map<string, ApprovalView[]>();
  const roundsByChannel = new Map<string, ChannelRoundView[]>();
  const latestMessageByChannel = new Map<string, ChannelMessageView>();
  const activeRunByChannel = new Map<string, RunView>();

  for (const message of snapshot.channelMessages) {
    append(messagesByChannel, message.channelId, message);
    latestMessageByChannel.set(message.channelId, message);
  }
  for (const run of snapshot.runs) {
    if (!run.channelId) continue;
    append(runsByChannel, run.channelId, run);
    selectActiveRun(activeRunByChannel, run);
  }
  for (const item of snapshot.runItems) append(itemsByRun, item.runId, item);
  for (const approval of snapshot.approvals) append(approvalsByRun, approval.runId, approval);
  for (const round of snapshot.channelRounds) append(roundsByChannel, round.channelId, round);

  return {
    botById,
    channelById,
    messagesByChannel,
    runsByChannel,
    itemsByRun,
    approvalsByRun,
    roundsByChannel,
    latestMessageByChannel,
    activeRunByChannel,
  };
}

function stableGrouped<T extends { id: string }>(
  values: T[],
  keyOf: (value: T) => string,
  previous: ReadonlyMap<string, T[]> | undefined
): ReadonlyMap<string, T[]> {
  const next = new Map<string, T[]>();
  for (const value of values) append(next, keyOf(value), value);
  let allStable = next.size === previous?.size;
  for (const [key, group] of next) {
    const old = previous?.get(key);
    if (old?.length === group.length && group.every((value, index) => value === old[index])) {
      next.set(key, old);
    } else {
      allStable = false;
    }
  }
  return allStable && previous ? previous : next;
}

function useStableGrouped<T extends { id: string }>(values: T[], keyOf: (value: T) => string) {
  const previous = useRef<ReadonlyMap<string, T[]> | undefined>(undefined);
  return useMemo(() => {
    const next = stableGrouped(values, keyOf, previous.current);
    previous.current = next;
    return next;
  }, [keyOf, values]);
}

const messageChannel = (message: ChannelMessageView) => message.channelId;
const runChannel = (run: RunView) => run.channelId ?? "";
const itemRun = (item: RunItemView) => item.runId;
const approvalRun = (approval: ApprovalView) => approval.runId;
const roundChannel = (round: ChannelRoundView) => round.channelId;
const EMPTY_BOTS: BotView[] = [];
const EMPTY_CHANNELS: ChannelView[] = [];
const EMPTY_MESSAGES: ChannelMessageView[] = [];
const EMPTY_RUNS: RunView[] = [];
const EMPTY_ITEMS: RunItemView[] = [];
const EMPTY_APPROVALS: ApprovalView[] = [];
const EMPTY_ROUNDS: ChannelRoundView[] = [];

export function useSnapshotIndex(snapshot: ClientSnapshot | null): SnapshotIndex {
  const bots = snapshot?.bots ?? EMPTY_BOTS;
  const channels = snapshot?.channels ?? EMPTY_CHANNELS;
  const channelMessages = snapshot?.channelMessages ?? EMPTY_MESSAGES;
  const runs = snapshot?.runs ?? EMPTY_RUNS;
  const runItems = snapshot?.runItems ?? EMPTY_ITEMS;
  const approvals = snapshot?.approvals ?? EMPTY_APPROVALS;
  const channelRounds = snapshot?.channelRounds ?? EMPTY_ROUNDS;
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels]
  );
  const messagesByChannel = useStableGrouped(channelMessages, messageChannel);
  const runsByChannel = useStableGrouped(runs, runChannel);
  const itemsByRun = useStableGrouped(runItems, itemRun);
  const approvalsByRun = useStableGrouped(approvals, approvalRun);
  const roundsByChannel = useStableGrouped(channelRounds, roundChannel);
  const latestMessageByChannel = useMemo(
    () =>
      new Map(
        [...messagesByChannel].flatMap(([channelId, messages]) => {
          const latest = messages.at(-1);
          return latest ? [[channelId, latest] as const] : [];
        })
      ),
    [messagesByChannel]
  );
  const activeRunByChannel = useMemo(() => {
    const active = new Map<string, RunView>();
    for (const run of runs) selectActiveRun(active, run);
    return active;
  }, [runs]);
  return useMemo(
    () => ({
      botById,
      channelById,
      messagesByChannel,
      runsByChannel,
      itemsByRun,
      approvalsByRun,
      roundsByChannel,
      latestMessageByChannel,
      activeRunByChannel,
    }),
    [
      activeRunByChannel,
      approvalsByRun,
      botById,
      channelById,
      itemsByRun,
      latestMessageByChannel,
      messagesByChannel,
      roundsByChannel,
      runsByChannel,
    ]
  );
}
