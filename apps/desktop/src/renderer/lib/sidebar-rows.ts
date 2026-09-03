import type { ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";

export type SidebarChannelRow = {
  channel: ChannelView;
  latest?: ChannelMessageView;
  running?: RunView;
  hasActiveTask?: boolean;
};

export function sidebarRowIsWorking(row: SidebarChannelRow) {
  const needsAttention = row.running?.status === "waiting_approval";
  return Boolean((row.running && !needsAttention) || row.hasActiveTask);
}

export type SidebarUnreadRowMetric = {
  channelId: string;
  unread: boolean;
  unreadCount?: number;
  top: number;
  bottom: number;
};

export type SidebarUnreadJumpTarget = {
  channelId: string;
  count: number;
};

export type SidebarUnreadJumpTargets = {
  above: SidebarUnreadJumpTarget | null;
  below: SidebarUnreadJumpTarget | null;
};

export function sidebarUnreadJumpTargets(
  rows: SidebarUnreadRowMetric[],
  viewportTop: number,
  viewportBottom: number
): SidebarUnreadJumpTargets {
  let aboveChannelId: string | null = null;
  let aboveCount = 0;
  let belowChannelId: string | null = null;
  let belowCount = 0;

  for (const row of rows) {
    if (!row.unread) continue;
    const count = Math.max(row.unreadCount ?? 1, 1);
    if (row.bottom <= viewportTop) {
      aboveChannelId = row.channelId;
      aboveCount += count;
      continue;
    }
    if (row.top >= viewportBottom) {
      belowChannelId ??= row.channelId;
      belowCount += count;
    }
  }

  return {
    above: aboveChannelId ? { channelId: aboveChannelId, count: aboveCount } : null,
    below: belowChannelId ? { channelId: belowChannelId, count: belowCount } : null,
  };
}

const rowActivityAt = (row: SidebarChannelRow) => row.latest?.createdAt ?? row.channel.createdAt;

const compareRowsByRecency = (a: SidebarChannelRow, b: SidebarChannelRow) => {
  const activityOrder = rowActivityAt(b).localeCompare(rowActivityAt(a));
  return activityOrder || a.channel.id.localeCompare(b.channel.id);
};

const sortRowsByRecency = (rows: SidebarChannelRow[]) => rows.sort(compareRowsByRecency);

export function reconcileSidebarRows(
  previousRows: ReadonlyMap<string, SidebarChannelRow>,
  channels: ChannelView[],
  latestMessageByChannel: ReadonlyMap<string, ChannelMessageView>,
  activeRunByChannel: ReadonlyMap<string, RunView>,
  activeTaskChannelIds: ReadonlySet<string> = new Set()
) {
  const rowByChannelId = new Map<string, SidebarChannelRow>();
  const channelById = new Map<string, ChannelView>();
  const rows = channels.map((channel) => {
    const latest = latestMessageByChannel.get(channel.id);
    const running = activeRunByChannel.get(channel.id);
    const hasActiveTask = activeTaskChannelIds.has(channel.id);
    const previous = previousRows.get(channel.id);
    const row =
      previous?.channel === channel &&
      previous.latest === latest &&
      previous.running === running &&
      previous.hasActiveTask === hasActiveTask
        ? previous
        : { channel, latest, running, hasActiveTask };
    rowByChannelId.set(channel.id, row);
    channelById.set(channel.id, channel);
    return row;
  });

  return { rows, rowByChannelId, channelById };
}

export function groupSidebarRows(
  rows: SidebarChannelRow[],
  pinnedIds: ReadonlySet<string>,
  sections: ReadonlyArray<{ id: string }>,
  sectionByChannel: Readonly<Record<string, string>>
) {
  const pinned: SidebarChannelRow[] = [];
  const unassigned: SidebarChannelRow[] = [];
  const bySection = Object.fromEntries(
    sections.map((section) => [section.id, [] as SidebarChannelRow[]])
  );

  for (const row of rows) {
    const channelId = row.channel.id;
    if (pinnedIds.has(channelId)) {
      pinned.push(row);
      continue;
    }

    const sectionRows = bySection[sectionByChannel[channelId] ?? ""];
    if (sectionRows) sectionRows.push(row);
    else unassigned.push(row);
  }

  for (const sectionRows of Object.values(bySection)) sortRowsByRecency(sectionRows);

  return {
    pinned: sortRowsByRecency(pinned),
    bySection,
    unassigned: sortRowsByRecency(unassigned),
  };
}
