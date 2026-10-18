import type { ChannelMessageView, ClientSnapshot } from "@openteam/contracts";
import {
  compareEntitySequence as compareSequence,
  type LoadedChannelHistory,
  mergeBootstrapActivityStates,
  uniqueEntitiesById as mergeEntities,
} from "@openteam/product-core/history";
import type { ChannelClientState, ClientBootstrapView } from "../client/openteam-api";
import {
  type ChannelMessageWindowState,
  emptyChannelMessageWindow,
  visibleChannelHistoryMessages,
} from "./message-history-window";

/**
 * Projects bootstrap plus the loaded channel histories into one snapshot.
 * `detachedMessageIds` lists bootstrap's newest messages that a loaded
 * transcript does not contain yet; they stay in the snapshot for previews and
 * unread state, and transcripts omit them until a history read places them.
 */
export const bootstrapSnapshot = (
  bootstrap: ClientBootstrapView,
  histories: ReadonlyMap<string, LoadedChannelHistory>,
  windows: ReadonlyMap<string, ChannelMessageWindowState>,
  channelStates: ReadonlyMap<string, ChannelClientState>
): { snapshot: ClientSnapshot; detachedMessageIds: Set<string> } => {
  const latestByChannel = new Map(
    bootstrap.latestMessages.map((message) => [message.channelId, message] as const)
  );
  const detachedMessageIds = new Set<string>();
  const channelMessages = bootstrap.channels.flatMap((channel) => {
    const latest = latestByChannel.get(channel.id);
    const loaded = histories.get(channel.id);
    if (!loaded) return latest ? [latest] : [];
    const window = windows.get(channel.id) ?? emptyChannelMessageWindow();
    const visible = visibleChannelHistoryMessages(loaded, window);
    const mayMergeLatest = !window.context && !window.primaryHasNewerGap;
    if (mayMergeLatest && latest && !visible.some((message) => message.id === latest.id)) {
      const newest = visible.reduce<ChannelMessageView | undefined>(
        (current, message) =>
          !current || compareSequence(message, current) > 0 ? message : current,
        undefined
      );
      // Bootstrap carries only each channel's newest message. Until a history
      // read contains it, the messages between it and this transcript are
      // unknown. Previews and unread state still use it; the transcript does
      // not, so earlier messages never appear above an already visible newer one.
      if (loaded.loadedAt === 0 || !newest || compareSequence(latest, newest) > 0) {
        detachedMessageIds.add(latest.id);
      }
    }
    return mergeEntities(visible, mayMergeLatest && latest ? [latest] : []).sort(compareSequence);
  });
  const states = [...channelStates.values()];
  const activity = mergeBootstrapActivityStates(bootstrap, states);
  return {
    snapshot: {
      notificationRouting: bootstrap.notificationRouting,
      cursor: bootstrap.cursor,
      workspace: bootstrap.workspace,
      bots: bootstrap.bots,
      channels: bootstrap.channels,
      channelMessages,
      ...activity,
      runtime: bootstrap.runtime,
    },
    detachedMessageIds,
  };
};

/**
 * Whether a chat that is not open needs its newest page read in the background:
 * its loaded transcript withholds bootstrap's newest message ("refresh"), or it
 * was never loaded and has unread messages ("load").
 */
export const backgroundHistoryNeed = ({
  bootstrap,
  channelId,
  activeChannelId,
  history,
  detachedMessageIds,
}: {
  bootstrap: ClientBootstrapView;
  channelId: string;
  activeChannelId: string | undefined;
  history: LoadedChannelHistory | undefined;
  detachedMessageIds: ReadonlySet<string>;
}): "refresh" | "load" | null => {
  if (channelId === activeChannelId) return null;
  const channel = bootstrap.channels.find((candidate) => candidate.id === channelId);
  const latest = bootstrap.latestMessages.find((message) => message.channelId === channelId);
  if (!channel || channel.hiddenFromSidebar || !latest) return null;
  if (!history) return (channel.unreadCount ?? 0) > 0 ? "load" : null;
  if (history.loading || history.loadedAt === 0) return null;
  return detachedMessageIds.has(latest.id) ? "refresh" : null;
};
