import type { ChannelView, RunView } from "@openteam/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { BotAvatarMode } from "@openteam/contracts/robot-avatar";
import { resolveBotAvatarMode } from "@openteam/product-core/bot-avatar";

type AvatarActivity = { channel: ChannelView | null; run?: RunView };
const AvatarActivityContext = createContext<AvatarActivity>({ channel: null });
export const AvatarChannelContext = createContext<string | null>(null);

export function BotAvatarActivityProvider({
  channel,
  run,
  children,
}: AvatarActivity & { children: ReactNode }) {
  const value = useMemo(() => ({ channel, run }), [channel, run]);
  return <AvatarActivityContext.Provider value={value}>{children}</AvatarActivityContext.Provider>;
}

export function useBotAvatarMode(botId?: string, channelId?: string): BotAvatarMode {
  const { channel, run } = useContext(AvatarActivityContext);
  const scopedChannelId = useContext(AvatarChannelContext);
  return resolveBotAvatarMode({
    activeChannel: channel,
    run,
    botId,
    channelId: channelId ?? scopedChannelId,
  });
}
