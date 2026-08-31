import type { ChannelView, ClientSnapshot } from "@openbot/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client/openbot-api";
import { activeAgentIdForChannel, restoredActiveChannelId } from "../lib/channel-selection";
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
  const selectionRevision = useRef(0);
  const restoredActiveAgent = useRef(false);

  const applySelectedId = useCallback(
    (id: string | null, syncActiveAgent: boolean) => {
      const current = selectedIdRef.current;
      if (id && current && current !== id) {
        measureUntilNextPaint("view.channel-switch", { from: current, to: id });
      }
      selectedIdRef.current = id;
      setSelectedIdState(id);
      if (id) localStorage.setItem(SELECTED_CHANNEL_KEY, id);
      else localStorage.removeItem(SELECTED_CHANNEL_KEY);
      const activeAgentId = activeAgentIdForChannel(id ? channelById.get(id) : undefined);
      if (syncActiveAgent && activeAgentId) {
        void api.setActiveAgent(activeAgentId).catch(() => undefined);
      }
    },
    [channelById]
  );
  const setSelectedId = useCallback(
    (id: string | null) => {
      selectionRevision.current += 1;
      applySelectedId(id, true);
    },
    [applySelectedId]
  );

  useEffect(() => {
    if (!snapshot || restoredActiveAgent.current) return;
    let cancelled = false;
    const selectionRevisionAtRequest = selectionRevision.current;
    void api
      .activeAgent()
      .then(({ activeAgentId }) => {
        if (cancelled) return;
        restoredActiveAgent.current = true;
        applySelectedId(
          restoredActiveChannelId({
            activeAgentId,
            channels: snapshot.channels,
            currentSelectedId: selectedIdRef.current,
            selectionRevisionAtRequest,
            currentSelectionRevision: selectionRevision.current,
          }),
          false
        );
      })
      .catch(() => {
        restoredActiveAgent.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [applySelectedId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (selectedId && channelById.has(selectedId)) return;
    applySelectedId(
      snapshot.channels.find((channel) => channel.kind === "bot_dm")?.id ??
        snapshot.channels[0]?.id ??
        null,
      restoredActiveAgent.current
    );
  }, [applySelectedId, channelById, selectedId, snapshot]);

  return { selectedId, setSelectedId };
}
