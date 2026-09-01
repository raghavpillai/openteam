import type { BotTranscriptView, BotView } from "@openbot/contracts";
import { useCallback, useState } from "react";
import { api } from "../client/openbot-api";
import type { BotRowAction } from "../components/openbot/sidebar";
import type { OpenBotMutation } from "../state/use-openbot";

export type InspectorMode = "summary" | "settings" | "routine";
type SupportedBotRowAction = BotRowAction | "shareAsTemplate";

export function useBotRowActions(options: {
  mutate: OpenBotMutation;
  setSelectedId: (id: string | null) => void;
  setDetailsOpen: (open: boolean) => void;
  setInspectorMode: (mode: InspectorMode) => void;
  shareAsTemplate: (bot: BotView) => void;
  togglePinned: (channelId: string) => void;
  toggleUnread: (channelId: string) => void;
}) {
  const [deleteBotTarget, setDeleteBotTarget] = useState<BotView | null>(null);
  const [rowTranscript, setRowTranscript] = useState<{
    bot: BotView;
    transcript: BotTranscriptView | null;
  } | null>(null);

  const handleBotRowAction = useCallback(
    (bot: BotView, action: SupportedBotRowAction) => {
      if (action === "togglePin") {
        options.togglePinned(bot.dmChannelId);
        return;
      }
      if (action === "toggleUnread") {
        options.toggleUnread(bot.dmChannelId);
        return;
      }
      if (action === "copyConversationId") {
        void navigator.clipboard.writeText(bot.conversationId);
        return;
      }
      if (action === "shareAsTemplate") {
        options.shareAsTemplate(bot);
        return;
      }
      if (action === "retry") {
        void options.mutate(() => api.retryBot(bot.id));
        return;
      }
      if (action === "delete") {
        setDeleteBotTarget(bot);
        return;
      }
      if (action === "hide") {
        void options
          .mutate(() => api.updateBot(bot.id, { hiddenFromSidebar: true }))
          .then(() => options.setSelectedId(null));
        return;
      }
      if (action === "duplicate") {
        const suffix = " copy";
        const name = `${bot.name.slice(0, 80 - suffix.length)}${suffix}`;
        void options
          .mutate(() =>
            api.createBot({
              clientRequestId: crypto.randomUUID(),
              name,
              title: bot.title,
              description: bot.description,
              instructions: bot.instructions,
              icon: bot.icon,
              color: bot.color,
              notificationsEnabled: bot.notificationsEnabled,
            })
          )
          .then((duplicate) => options.setSelectedId(duplicate.dmChannelId));
        return;
      }
      options.setSelectedId(bot.dmChannelId);
      options.setDetailsOpen(true);
      options.setInspectorMode("settings");
    },
    [
      options.mutate,
      options.setDetailsOpen,
      options.setInspectorMode,
      options.setSelectedId,
      options.shareAsTemplate,
      options.togglePinned,
      options.toggleUnread,
    ]
  );

  const confirmDeleteBot = useCallback(() => {
    if (!deleteBotTarget) return;
    const botId = deleteBotTarget.id;
    setDeleteBotTarget(null);
    void options.mutate(() => api.archiveBot(botId)).then(() => options.setSelectedId(null));
  }, [deleteBotTarget, options.mutate, options.setSelectedId]);

  return {
    confirmDeleteBot,
    deleteBotTarget,
    handleBotRowAction,
    rowTranscript,
    setDeleteBotTarget,
    setRowTranscript,
  };
}
