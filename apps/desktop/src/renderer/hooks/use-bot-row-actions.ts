import type { BotTranscriptView, BotView } from "@openbot/contracts";
import { useCallback, useState } from "react";
import { api } from "../client/openbot-api";
import type { BotRowAction } from "../components/openbot/sidebar";
import type { OpenBotMutation } from "../state/use-openbot";

export type InspectorMode = "summary" | "settings";

export function useBotRowActions(options: {
  mutate: OpenBotMutation;
  setSelectedId: (id: string | null) => void;
  setDetailsOpen: (open: boolean) => void;
  setInspectorMode: (mode: InspectorMode) => void;
}) {
  const [rowTranscript, setRowTranscript] = useState<{
    bot: BotView;
    transcript: BotTranscriptView | null;
  } | null>(null);

  const handleBotRowAction = useCallback(
    (bot: BotView, action: BotRowAction) => {
      if (action === "retry") {
        void options.mutate(() => api.retryBot(bot.id));
        return;
      }
      if (action === "archive") {
        void options.mutate(() => api.archiveBot(bot.id)).then(() => options.setSelectedId(null));
        return;
      }
      options.setSelectedId(bot.dmChannelId);
      if (action === "transcript") {
        setRowTranscript({ bot, transcript: null });
        void api
          .botTranscript(bot.id)
          .then((transcript) => setRowTranscript({ bot, transcript }))
          .catch(() => setRowTranscript(null));
        return;
      }
      options.setDetailsOpen(true);
      options.setInspectorMode(action === "settings" ? "settings" : "summary");
    },
    [options.mutate, options.setDetailsOpen, options.setInspectorMode, options.setSelectedId]
  );

  return { handleBotRowAction, rowTranscript, setRowTranscript };
}
