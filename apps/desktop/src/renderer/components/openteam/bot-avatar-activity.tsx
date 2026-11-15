import type { ChannelMessageView, ChannelView, RunItemView, RunView } from "@openteam/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";
import {
  BOT_AVATAR_DONE_MS,
  BOT_AVATAR_FAILED_MS,
  createWatchedBotRuns,
  observeSettledRuns,
  resolveBotAvatarMode,
  settledRunKey,
  type SettledBotRun,
} from "@openteam/product-core/bot-avatar";

type AvatarActivity = {
  channel: ChannelView | null;
  run?: RunView;
  runsByChannel?: ReadonlyMap<string, readonly RunView[]>;
  itemsByRun?: ReadonlyMap<string, readonly RunItemView[]>;
  latestMessageByChannel?: ReadonlyMap<string, ChannelMessageView>;
};
type AvatarActivityValue = AvatarActivity & {
  settled: ReadonlyMap<string, SettledBotRun>;
  now: number;
};
const NO_SETTLED: ReadonlyMap<string, SettledBotRun> = new Map();
const AvatarActivityContext = createContext<AvatarActivityValue>({
  channel: null,
  settled: NO_SETTLED,
  now: 0,
});
export const AvatarChannelContext = createContext<string | null>(null);

/**
 * Remembers runs this client saw finish, so an avatar can react to the finish once.
 * Runs that were already over when the app loaded never celebrate.
 */
function useSettledRuns(
  runsByChannel?: ReadonlyMap<string, readonly RunView[]>,
  latestMessageByChannel?: ReadonlyMap<string, ChannelMessageView>
) {
  const watched = useRef(createWatchedBotRuns());
  const settled = watched.current.settled;
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!runsByChannel) return;
    const at = performance.now();
    if (!observeSettledRuns(watched.current, runsByChannel, at, latestMessageByChannel)) return;
    setNow(at);
    setVersion((value) => value + 1);
  }, [runsByChannel, latestMessageByChannel]);
  // Wake once when the newest reaction ends, then forget expired records.
  useEffect(() => {
    let next = Infinity;
    const current = performance.now();
    for (const [key, entry] of settled) {
      const ends = entry.at + (entry.status === "completed" ? BOT_AVATAR_DONE_MS : BOT_AVATAR_FAILED_MS);
      if (ends <= current) settled.delete(key);
      else next = Math.min(next, ends);
    }
    if (next === Infinity) return;
    const timer = window.setTimeout(() => setNow(performance.now()), next - current + 16);
    return () => window.clearTimeout(timer);
  }, [version, now]);
  return { settled, now, version };
}

export function BotAvatarActivityProvider({
  channel,
  run,
  runsByChannel,
  itemsByRun,
  latestMessageByChannel,
  children,
}: AvatarActivity & { children: ReactNode }) {
  const { settled, now, version } = useSettledRuns(runsByChannel, latestMessageByChannel);
  const value = useMemo(
    () => ({ channel, run, runsByChannel, itemsByRun, latestMessageByChannel, settled, now }),
    // `version` marks a change inside the settled map.
    [channel, run, runsByChannel, itemsByRun, latestMessageByChannel, settled, now, version]
  );
  return <AvatarActivityContext.Provider value={value}>{children}</AvatarActivityContext.Provider>;
}

export function useBotAvatarMode(botId?: string, channelId?: string): BotAvatarMode {
  const { channel, run, runsByChannel, itemsByRun, latestMessageByChannel, settled, now } =
    useContext(AvatarActivityContext);
  const scopedChannelId = useContext(AvatarChannelContext);
  const scope = channelId ?? scopedChannelId ?? channel?.id;
  return resolveBotAvatarMode({
    activeChannel: channel,
    run,
    runsByChannel,
    itemsByRun,
    botId,
    channelId: channelId ?? scopedChannelId,
    latestMessage: scope ? latestMessageByChannel?.get(scope) : undefined,
    settled: scope && botId ? settled.get(settledRunKey(scope, botId)) : undefined,
    now,
  });
}
