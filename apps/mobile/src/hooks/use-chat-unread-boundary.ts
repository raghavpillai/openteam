import type { ChannelMessageView } from "@openteam/contracts";
import { useEffect, useMemo, useState } from "react";
import { ChatUnreadBoundary } from "../chat-unread-boundary";

export function useChatUnreadBoundary(
  channelId: string,
  messages: readonly ChannelMessageView[],
  openingUnread: number,
  history?: { loading: boolean; hasNewer?: boolean }
) {
  // Capture the opening count before this screen acknowledges visible messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read receipts must not move the divider.
  const session = useMemo(() => new ChatUnreadBoundary(openingUnread), [channelId]);
  const [value, setValue] = useState<{ session: ChatUnreadBoundary; sequence: string | null }>({
    session,
    sequence: null,
  });
  const ready = history !== undefined && !history.loading;
  useEffect(() => {
    const sequence = session.observe(messages, ready, history?.hasNewer);
    setValue((current) =>
      current.session === session && current.sequence === sequence ? current : { session, sequence }
    );
  }, [session, messages, ready, history?.hasNewer]);
  return value.session === session ? value.sequence : null;
}
