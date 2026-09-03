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
import {
  createSnapshotIndex,
  indexA2AAgentNames,
  type SnapshotIndex,
  selectActiveRun,
} from "@openteam/product-core/snapshot";
import { ACTIVE_RUN_STATUSES } from "@openteam/product-core/statuses";
import { useMemo, useRef } from "react";

export { ACTIVE_RUN_STATUSES, createSnapshotIndex, type SnapshotIndex };

const append = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
};

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
const subagentChannel = (subagent: SubagentActivityView) => subagent.parentChannelId;
const roundChannel = (round: ChannelRoundView) => round.channelId;
const EMPTY_BOTS: BotView[] = [];
const EMPTY_CHANNELS: ChannelView[] = [];
const EMPTY_MESSAGES: ChannelMessageView[] = [];
const EMPTY_RUNS: RunView[] = [];
const EMPTY_ITEMS: RunItemView[] = [];
const EMPTY_APPROVALS: ApprovalView[] = [];
const EMPTY_SUBAGENTS: SubagentActivityView[] = [];
const EMPTY_ROUNDS: ChannelRoundView[] = [];

export function useSnapshotIndex(snapshot: ClientSnapshot | null): SnapshotIndex {
  const bots = snapshot?.bots ?? EMPTY_BOTS;
  const channels = snapshot?.channels ?? EMPTY_CHANNELS;
  const channelMessages = snapshot?.channelMessages ?? EMPTY_MESSAGES;
  const runs = snapshot?.runs ?? EMPTY_RUNS;
  const runItems = snapshot?.runItems ?? EMPTY_ITEMS;
  const approvals = snapshot?.approvals ?? EMPTY_APPROVALS;
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENTS;
  const channelRounds = snapshot?.channelRounds ?? EMPTY_ROUNDS;
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const previousAgentNames = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const agentNameById = useMemo(() => {
    const next = indexA2AAgentNames(channelMessages);
    const previous = previousAgentNames.current;
    if (
      previous?.size === next.size &&
      [...next].every(([id, name]) => previous.get(id) === name)
    ) {
      return previous;
    }
    previousAgentNames.current = next;
    return next;
  }, [channelMessages]);
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels]
  );
  const messagesByChannel = useStableGrouped(channelMessages, messageChannel);
  const runsByChannel = useStableGrouped(runs, runChannel);
  const itemsByRun = useStableGrouped(runItems, itemRun);
  const approvalsByRun = useStableGrouped(approvals, approvalRun);
  const subagentsByChannel = useStableGrouped(subagents, subagentChannel);
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
      agentNameById,
      channelById,
      messagesByChannel,
      runsByChannel,
      itemsByRun,
      approvalsByRun,
      subagentsByChannel,
      roundsByChannel,
      latestMessageByChannel,
      activeRunByChannel,
    }),
    [
      activeRunByChannel,
      agentNameById,
      approvalsByRun,
      subagentsByChannel,
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
