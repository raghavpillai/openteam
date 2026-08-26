import type { ChannelView, ClientSnapshot } from "@openbot/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { measureUntilNextPaint } from "../lib/performance";

const SELECTED_CHANNEL_KEY = "openbot:selected-channel";

export function useChannelSelection(
  snapshot: ClientSnapshot | null,
  channelById: ReadonlyMap<string, ChannelView>
) {
  const [selectedId, setSelectedIdState] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_CHANNEL_KEY)
  );
  const selectedIdRef = useRef(selectedId);

  const setSelectedId = useCallback((id: string | null) => {
    const current = selectedIdRef.current;
    if (id && current && current !== id) {
      measureUntilNextPaint("view.channel-switch", { from: current, to: id });
    }
    selectedIdRef.current = id;
    setSelectedIdState(id);
    if (id) localStorage.setItem(SELECTED_CHANNEL_KEY, id);
    else localStorage.removeItem(SELECTED_CHANNEL_KEY);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    if (selectedId && channelById.has(selectedId)) return;
    setSelectedId(
      snapshot.channels.find((channel) => channel.kind === "bot_dm")?.id ??
        snapshot.channels[0]?.id ??
        null
    );
  }, [channelById, selectedId, setSelectedId, snapshot]);

  return { selectedId, setSelectedId };
}
