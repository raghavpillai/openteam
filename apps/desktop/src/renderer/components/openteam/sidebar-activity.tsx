import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RunItemView, RunView } from "@openteam/contracts";
import { thinkingActivity } from "../../lib/thinking-activity";
const ComposingChannels = createContext<ReadonlySet<string>>(new Set());
export function SidebarActivityProvider({
  runs,
  items,
  children,
}: {
  runs: ReadonlyMap<string, RunView>;
  items?: ReadonlyMap<string, RunItemView[]>;
  children: ReactNode;
}) {
  const composing = useMemo(
    () =>
      new Set(
        [...runs]
          .filter(([, run]) => thinkingActivity(items?.get(run.id)) === "Typing")
          .map(([id]) => id)
      ),
    [runs, items]
  );
  return <ComposingChannels.Provider value={composing}>{children}</ComposingChannels.Provider>;
}
export function useSidebarComposing(channelId?: string) {
  return useContext(ComposingChannels).has(channelId ?? "");
}
