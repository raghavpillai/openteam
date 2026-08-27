import type { ChannelView, ClientSnapshot } from "@openbot/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client/openbot-api";
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
  const restoredActiveAgent = useRef(false);

  const setSelectedId = useCallback(
    (id: string | null) => {
      const current = selectedIdRef.current;
      if (id && current && current !== id) {
        measureUntilNextPaint("view.channel-switch", { from: current, to: id });
      }
      selectedIdRef.current = id;
      setSelectedIdState(id);
      if (id) localStorage.setItem(SELECTED_CHANNEL_KEY, id);
      else localStorage.removeItem(SELECTED_CHANNEL_KEY);
      const botId = id ? channelById.get(id)?.directKey?.match(/^bot:(.+)$/)?.[1] : undefined;
      if (restoredActiveAgent.current && botId) {
        void api.setActiveAgent(botId).catch(() => undefined);
      }
    },
    [channelById]
  );

  useEffect(() => {
    if (!snapshot || restoredActiveAgent.current) return;
    let cancelled = false;
    void api
      .activeAgent()
      .then(({ activeAgentId }) => {
        if (cancelled) return;
        restoredActiveAgent.current = true;
        const activeChannel = activeAgentId
          ? snapshot.channels.find((channel) => channel.directKey === `bot:${activeAgentId}`)
          : null;
        setSelectedId(activeChannel?.id ?? selectedIdRef.current);
      })
      .catch(() => {
        restoredActiveAgent.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [setSelectedId, snapshot]);

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
