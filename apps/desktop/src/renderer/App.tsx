import type { SearchResultView, UpdateBotInput } from "@openbot/contracts";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./client/openbot-api";
import { A2AExchangeSheet } from "./components/openbot/a2a-exchange-sheet";
import { AsyncTasksPanel } from "./components/openbot/async-tasks-panel";
import { ChatPane } from "./components/openbot/chat-pane";
import { DesktopDialogs } from "./components/openbot/desktop-dialogs";
import { DesktopHeader } from "./components/openbot/desktop-header";
import { Inspector } from "./components/openbot/inspector";
import { NewBotScreen } from "./components/openbot/new-bot-screen";
import { PluginDialog } from "./components/openbot/plugin-settings";
import { type SearchAction, SearchDialog } from "./components/openbot/search-dialog";
import { AboutPanel, SettingsPanel } from "./components/openbot/settings-panel";
import { Sidebar } from "./components/openbot/sidebar";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";
import { type InspectorMode, useBotRowActions } from "./hooks/use-bot-row-actions";
import { useChannelSelection } from "./hooks/use-channel-selection";
import { useRecentChannels } from "./hooks/use-recent-channels";
import { useSidebarPreferences } from "./hooks/use-sidebar-preferences";
import { activeAsyncTaskChannelIds, activeAsyncTasksForBot } from "./lib/async-tasks";
import {
  closeA2AExchange,
  deriveA2AExchange,
  finishA2AExchangeAnimation,
  startA2AExchange,
  type A2AExchangeState,
} from "./lib/a2a-exchange";
import { cn } from "./lib/cn";
import { MIN_INSPECTOR_WIDTH, resizeInspector } from "./lib/panel-resize";
import { measureUntilNextPaint } from "./lib/performance";
import { deriveAgentNotifications, deriveUnreadChannelIds } from "./lib/notifications";
import { enableScreenForSession } from "./lib/screen-session";
import { useSnapshotIndex } from "./lib/snapshot-index";
import { useOpenBot } from "./state/use-openbot";

const INSPECTOR_WIDTH_KEY = "openbot:inspector-width";
const DEFAULT_INSPECTOR_WIDTH = 280;
const maxInspectorWidth = () =>
  Math.max(DEFAULT_INSPECTOR_WIDTH, Math.min(560, Math.round(window.innerWidth * 0.48)));
const clampInspectorWidth = (width: number) =>
  Math.min(maxInspectorWidth(), Math.max(MIN_INSPECTOR_WIDTH, width));
const readInspectorWidth = () => {
  const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  return clampInspectorWidth(
    Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_INSPECTOR_WIDTH
  );
};

export default function App() {
  const { snapshot, error, refresh, mutate } = useOpenBot();
  const index = useSnapshotIndex(snapshot);
  const { selectedId, setSelectedId } = useChannelSelection(snapshot, index.channelById);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [asyncTasksBotId, setAsyncTasksBotId] = useState<string | null>(null);
  const [searchMessageTarget, setSearchMessageTarget] = useState<{
    channelId: string;
    messageId: string;
    nonce: number;
  } | null>(null);
  const [newBotPicker, setNewBotPicker] = useState(false);
  const [newGroupDialog, setNewGroupDialog] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(readInspectorWidth);
  const [inspectorResizing, setInspectorResizing] = useState(false);
  const inspectorResizeSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    shouldClose: boolean;
    cursor: string;
    userSelect: string;
  } | null>(null);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("summary");
  const [enabledScreenIds, setEnabledScreenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [a2aExchange, setA2AExchange] = useState<A2AExchangeState | null>(null);
  const a2aExchangeTrigger = useRef<HTMLElement | null>(null);
  const restoreA2AFocusAfterClose = useRef(false);
  const lastWritableChannelId = useRef<string | null>(null);
  const a2aPerspectiveBotId = useRef<string | null>(null);
  const [pendingBot, setPendingBot] = useState<{
    name: string;
    dmChannelId?: string;
  } | null>(null);
  const creatingBot = useRef(false);
  const sidebarPreferences = useSidebarPreferences();
  const previousNotificationSnapshot = useRef(snapshot);
  const previousUnreadSnapshot = useRef(snapshot);
  const notificationThrottle = useRef(new Map<string, number>());

  useEffect(() => {
    const handleResize = () => setInspectorWidth((width) => clampInspectorWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  useEffect(() => {
    const unsubscribe = window.openbot?.onNotificationClick((channelId) => {
      setSelectedId(channelId);
      setDetailsOpen(false);
    });
    return unsubscribe;
  }, [setSelectedId]);
  useEffect(() => {
    const previous = previousNotificationSnapshot.current;
    previousNotificationSnapshot.current = snapshot;
    if (!previous || !snapshot || previous === snapshot || document.hasFocus()) return;
    const botById = new Map(snapshot.bots.map((bot) => [bot.id, bot] as const));
    for (const event of deriveAgentNotifications(previous, snapshot)) {
      const bot = botById.get(event.botId);
      if (!bot?.notificationsEnabled || bot.hiddenFromSidebar) continue;
      const throttleKey = `${event.botId}:${event.kind}`;
      const now = Date.now();
      if (now - (notificationThrottle.current.get(throttleKey) ?? 0) < 5_000) continue;
      notificationThrottle.current.set(throttleKey, now);
      window.openbot?.showNotification(event);
    }
  }, [snapshot]);
  useEffect(() => {
    const previous = previousUnreadSnapshot.current;
    previousUnreadSnapshot.current = snapshot;
    if (!previous || !snapshot || previous === snapshot) return;
    const visibleChannelId = document.hasFocus() ? selectedId : null;
    for (const channelId of deriveUnreadChannelIds(previous, snapshot, visibleChannelId)) {
      sidebarPreferences.markUnread(channelId);
    }
  }, [selectedId, sidebarPreferences.markUnread, snapshot]);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);
  const {
    confirmDeleteBot,
    deleteBotTarget,
    handleBotRowAction: handleStandardBotRowAction,
    rowTranscript,
    setDeleteBotTarget,
    setRowTranscript,
  } = useBotRowActions({
    mutate,
    setSelectedId,
    setDetailsOpen,
    setInspectorMode,
    togglePinned: sidebarPreferences.togglePinned,
    toggleUnread: sidebarPreferences.toggleUnread,
  });
  const handleBotRowAction = useCallback(
    (
      bot: Parameters<typeof handleStandardBotRowAction>[0],
      action: Parameters<typeof handleStandardBotRowAction>[1]
    ) => {
      if (action === "showAsyncTasks") {
        setAsyncTasksBotId(bot.id);
        return;
      }
      handleStandardBotRowAction(bot, action);
    },
    [handleStandardBotRowAction]
  );

  const createNewBot = useCallback(async () => {
    if (creatingBot.current) return;
    creatingBot.current = true;
    setNewBotPicker(false);
    setPendingBot({ name: "New Bot" });
    try {
      const bot = await mutate(() =>
        api.createBot({ clientRequestId: crypto.randomUUID(), name: "New Bot" })
      );
      setInspectorMode("summary");
      setDetailsOpen(false);
      setPendingBot({ name: bot.name, dmChannelId: bot.dmChannelId });
    } catch {
      // useOpenBot exposes mutation failures in the app-level error banner.
      setPendingBot(null);
    } finally {
      creatingBot.current = false;
    }
  }, [mutate]);

  useEffect(() => {
    if (!pendingBot?.dmChannelId || !index.channelById.has(pendingBot.dmChannelId)) return;
    setSelectedId(pendingBot.dmChannelId);
    setPendingBot(null);
  }, [index.channelById, pendingBot, setSelectedId]);

  const retryInspectorBot = useCallback(
    async (botId: string) => {
      await mutate(() => api.retryBot(botId));
    },
    [mutate]
  );
  const updateInspectorBot = useCallback(
    async (botId: string, input: UpdateBotInput) => {
      const current = index.botById.get(botId);
      const { name, ...profile } = input;
      const nextName = name?.replace(/\s+/g, " ").trim();
      if (current && nextName && nextName !== current.name) {
        await mutate(() => api.renameChannel(current.dmChannelId, nextName));
      }
      return mutate(() => api.updateBot(botId, profile));
    },
    [index.botById, mutate]
  );
  const renameChannel = useCallback(
    async (channelId: string, name: string) => {
      await mutate(() => api.renameChannel(channelId, name));
    },
    [mutate]
  );
  const enableScreen = useCallback((botId: string) => {
    setEnabledScreenIds((current) => enableScreenForSession(current, botId));
  }, []);

  const snapshotChannels = snapshot?.channels;
  const visibleChannels = useMemo(() => {
    if (!snapshotChannels) return [];
    return snapshotChannels
      .filter((channel) => channel.kind !== "agent_dm")
      .sort((a, b) => {
        const aLatest = index.latestMessageByChannel.get(a.id)?.createdAt ?? a.updatedAt;
        const bLatest = index.latestMessageByChannel.get(b.id)?.createdAt ?? b.updatedAt;
        return bLatest.localeCompare(aLatest);
      });
  }, [index.latestMessageByChannel, snapshotChannels]);
  const activeTaskChannelIds = useMemo(
    () => activeAsyncTaskChannelIds(snapshot?.subagents ?? []),
    [snapshot?.subagents]
  );

  const openNewBot = useCallback(() => {
    measureUntilNextPaint("view.new-bot-open");
    setNewBotPicker(true);
  }, []);
  const openNewGroup = useCallback(() => {
    measureUntilNextPaint("view.dialog-open", { dialog: "new-group" });
    setNewGroupDialog(true);
  }, []);
  const openAbout = useCallback(() => setAboutOpen(true), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openPlugins = useCallback(() => setPluginsOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const selectSidebarChannel = useCallback(
    (id: string) => {
      setA2AExchange(null);
      a2aExchangeTrigger.current = null;
      restoreA2AFocusAfterClose.current = false;
      setNewBotPicker(false);
      sidebarPreferences.markRead(id);
      setSelectedId(id);
    },
    [setSelectedId, sidebarPreferences.markRead]
  );

  const recentIds = useRecentChannels(selectedId);
  const warmIds = useMemo(
    () =>
      selectedId ? [selectedId, ...recentIds.filter((id) => id !== selectedId)].slice(0, 3) : [],
    [recentIds, selectedId]
  );

  const updateInspectorWidth = (width: number) => {
    const next = clampInspectorWidth(width);
    if (inspectorResizeSessionRef.current) inspectorResizeSessionRef.current.width = next;
    setInspectorWidth(next);
  };
  const finishInspectorResize = (element: HTMLDivElement, canceled = false) => {
    const session = inspectorResizeSessionRef.current;
    if (!session) return;
    if (element.hasPointerCapture(session.pointerId)) {
      element.releasePointerCapture(session.pointerId);
    }
    localStorage.setItem(INSPECTOR_WIDTH_KEY, String(session.width));
    document.body.style.cursor = session.cursor;
    document.body.style.userSelect = session.userSelect;
    inspectorResizeSessionRef.current = null;
    setInspectorResizing(false);
    if (!canceled && session.shouldClose) setDetailsOpen(false);
  };

  const selected = index.channelById.get(selectedId ?? "") ?? null;
  const a2aExchangeView = useMemo(() => {
    if (!a2aExchange) return undefined;
    const source = index.botById.get(a2aExchange.sourceBotId);
    const peer = index.botById.get(a2aExchange.peerId);
    const sourceChannel = index.channelById.get(a2aExchange.sourceChannelId);
    if (!source || !peer || sourceChannel?.kind !== "bot_dm") return undefined;
    return deriveA2AExchange({
      source,
      peer,
      sourceChannel,
      sourceMessages: index.messagesByChannel.get(sourceChannel.id) ?? [],
    });
  }, [a2aExchange, index.botById, index.channelById, index.messagesByChannel]);
  const a2aExchangeChannel = a2aExchangeView?.channel;
  const selectedBot =
    selected?.kind === "bot_dm" ? index.botById.get(selected.members[0]?.botId ?? "") : undefined;
  const asyncTasksBot = asyncTasksBotId ? (index.botById.get(asyncTasksBotId) ?? null) : null;
  const asyncTasks = useMemo(
    () =>
      asyncTasksBotId && snapshot
        ? activeAsyncTasksForBot(snapshot.subagents, asyncTasksBotId)
        : [],
    [asyncTasksBotId, snapshot]
  );
  useEffect(() => {
    if (selected && selected.kind !== "agent_dm") lastWritableChannelId.current = selected.id;
  }, [selected]);
  useEffect(() => {
    if (!a2aExchange || a2aExchangeChannel) return;
    setA2AExchange(null);
    a2aExchangeTrigger.current = null;
  }, [a2aExchange, a2aExchangeChannel]);
  const closeViewOnlyChat = useCallback(() => {
    const previous = lastWritableChannelId.current;
    a2aPerspectiveBotId.current = null;
    if (previous && index.channelById.has(previous)) {
      selectSidebarChannel(previous);
      return;
    }
    const memberHome = selected?.members
      .map((member) => index.botById.get(member.botId)?.dmChannelId)
      .find((channelId): channelId is string => Boolean(channelId));
    const fallback =
      memberHome ?? snapshotChannels?.find((channel) => channel.kind === "bot_dm")?.id;
    if (fallback) selectSidebarChannel(fallback);
  }, [index.botById, index.channelById, selectSidebarChannel, selected, snapshotChannels]);
  const openA2AChat = useCallback(
    (sourceBotId: string, peerId: string, trigger: HTMLButtonElement) => {
      const group = index.channelById.get(peerId);
      if (group?.kind === "group") {
        selectSidebarChannel(group.id);
        return;
      }
      const source = index.botById.get(sourceBotId);
      if (source?.dmChannelId && index.botById.has(peerId)) {
        a2aExchangeTrigger.current = trigger;
        setA2AExchange(startA2AExchange(source.dmChannelId, sourceBotId, peerId));
      }
    },
    [index.botById, index.channelById, selectSidebarChannel]
  );
  const closeA2AChat = useCallback(() => {
    setA2AExchange((current) => (current ? closeA2AExchange(current) : current));
  }, []);
  const finishA2AAnimation = useCallback(() => {
    setA2AExchange((current) => {
      if (!current) return current;
      const next = finishA2AExchangeAnimation(current);
      if (!next) {
        restoreA2AFocusAfterClose.current = true;
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (a2aExchange || !restoreA2AFocusAfterClose.current) return;
    const trigger = a2aExchangeTrigger.current;
    const frame = window.requestAnimationFrame(() => {
      if (!restoreA2AFocusAfterClose.current) return;
      restoreA2AFocusAfterClose.current = false;
      a2aExchangeTrigger.current = null;
      trigger?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [a2aExchange]);
  useEffect(() => {
    if (!a2aExchange) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeA2AChat();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [a2aExchange, closeA2AChat]);
  const directPerspectiveBotId =
    selected?.kind === "agent_dm"
      ? (a2aPerspectiveBotId.current ??
        (lastWritableChannelId.current
          ? index.channelById.get(lastWritableChannelId.current)?.members[0]?.botId
          : undefined))
      : undefined;
  const searchActions = useMemo<SearchAction[]>(
    () => [
      {
        id: "new-bot",
        title: "New Bot",
        subtitle: "Create a persistent assistant",
        keywords: "create assistant agent",
        icon: "bot",
        run: () => setNewBotPicker(true),
      },
      {
        id: "new-channel",
        title: "New Channel",
        subtitle: "Start a group conversation",
        keywords: "create group chat",
        icon: "channel",
        run: () => setNewGroupDialog(true),
      },
      ...(selected
        ? [
            {
              id: "chat-details",
              title: "Chat Details",
              subtitle: selected.name,
              keywords: "current channel members info",
              icon: "details" as const,
              run: () => {
                setInspectorMode("summary");
                setDetailsOpen(true);
              },
            },
          ]
        : []),
      ...(selectedBot
        ? [
            {
              id: "bot-settings",
              title: "Bot Settings",
              subtitle: selectedBot.name,
              keywords: "profile instructions notifications",
              icon: "settings" as const,
              run: () => {
                setInspectorMode("settings");
                setDetailsOpen(true);
              },
            },
          ]
        : []),
    ],
    [selected, selectedBot]
  );

  const selectSearchResult = useCallback(
    (result: SearchResultView) => {
      if (result.kind === "link" && result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (!result.channelId) return;
      selectSidebarChannel(result.channelId);
      if (result.messageId) {
        setSearchMessageTarget({
          channelId: result.channelId,
          messageId: result.messageId,
          nonce: Date.now(),
        });
      }
    },
    [selectSidebarChannel]
  );

  if (!snapshot) {
    return (
      <main className="grid h-screen place-items-center bg-background text-foreground">
        <div className="text-center">
          <LoaderCircle className="mx-auto size-7 animate-spin" />
          <p className="mt-3 text-sm">Connecting to OpenBot…</p>
          {error && <p className="mt-2 max-w-sm text-xs text-destructive">{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <TooltipProvider>
      <main className="flex h-screen overflow-hidden bg-background text-foreground">
        <div aria-hidden="true" className="electron-window-drag-strip" />
        <Sidebar
          activeRunByChannel={index.activeRunByChannel}
          activeTaskChannelIds={activeTaskChannelIds}
          botById={index.botById}
          channels={visibleChannels}
          creating={newBotPicker}
          latestMessageByChannel={index.latestMessageByChannel}
          onBotAction={handleBotRowAction}
          onNewBot={openNewBot}
          onNewGroup={openNewGroup}
          onOpenAbout={openAbout}
          onOpenPlugins={openPlugins}
          onOpenSettings={openSettings}
          onSearch={openSearch}
          onSelect={selectSidebarChannel}
          pendingBot={pendingBot}
          preferences={sidebarPreferences}
          selectedId={
            newBotPicker || pendingBot
              ? null
              : selected?.kind === "agent_dm"
                ? lastWritableChannelId.current
                : selectedId
          }
        />

        <section className="relative flex min-w-0 flex-1 flex-col">
          {!newBotPicker && !pendingBot && (
            <DesktopHeader
              agentNameById={index.agentNameById}
              botById={index.botById}
              detailsOpen={detailsOpen}
              directPerspectiveBotId={directPerspectiveBotId}
              inspectorResizing={inspectorResizing}
              inspectorWidth={inspectorWidth}
              inspectorMode={inspectorMode}
              onDetailsOpenChange={(open) => {
                if (open) setInspectorMode("summary");
                setDetailsOpen(open);
              }}
              onShowSettings={() => setInspectorMode("settings")}
              onShowSummary={() => setInspectorMode("summary")}
              onRename={renameChannel}
              exchange={
                a2aExchange && a2aExchangeChannel
                  ? {
                      channel: a2aExchangeChannel,
                      perspectiveBotId: a2aExchange.sourceBotId,
                      phase: a2aExchange.phase,
                    }
                  : undefined
              }
              selected={selected}
              selectedBot={selectedBot}
            />
          )}

          {error && (
            <div className="flex items-center gap-2 border-b border-destructive/15 bg-destructive/8 px-4 py-2 text-xs text-destructive">
              <CircleAlert className="size-3.5" />
              <span className="flex-1">{error}</span>
              <Button onClick={() => void refresh()} size="sm" variant="ghost">
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          )}

          {newBotPicker ? (
            <NewBotScreen
              botById={index.botById}
              channels={visibleChannels}
              onCancel={() => setNewBotPicker(false)}
              onCreateBot={() => void createNewBot()}
              onSelect={selectSidebarChannel}
            />
          ) : pendingBot ? (
            <div
              aria-label={`Creating ${pendingBot.name}`}
              aria-live="polite"
              className="grid min-h-0 flex-1 place-items-center bg-background text-muted-foreground"
              data-new-bot-state="creating"
              role="status"
            >
              <LoaderCircle className="size-8 animate-spin" strokeWidth={1.5} />
            </div>
          ) : selected ? (
            <div className="flex min-h-0 flex-1">
              <div className="relative min-w-0 flex-1">
                {warmIds.map((channelId) => {
                  const channel = index.channelById.get(channelId);
                  if (!channel) return null;
                  const bot =
                    channel.kind === "bot_dm"
                      ? index.botById.get(channel.members[0]?.botId ?? "")
                      : undefined;
                  return (
                    <div
                      aria-hidden={channelId !== selectedId || Boolean(a2aExchangeChannel)}
                      className={channelId === selectedId ? "absolute inset-0" : "hidden"}
                      inert={channelId === selectedId && Boolean(a2aExchangeChannel)}
                      key={channelId}
                    >
                      <ChatPane
                        activeRun={index.activeRunByChannel.get(channelId)}
                        agentNameById={index.agentNameById}
                        approvalsByRun={index.approvalsByRun}
                        botById={index.botById}
                        channel={channel}
                        focusMessage={
                          searchMessageTarget?.channelId === channelId ? searchMessageTarget : null
                        }
                        itemsByRun={index.itemsByRun}
                        messages={index.messagesByChannel.get(channelId) ?? []}
                        mutate={mutate}
                        onCloseViewOnly={
                          channel.kind === "agent_dm" ? closeViewOnlyChat : undefined
                        }
                        onOpenA2A={
                          channel.kind === "bot_dm" && bot
                            ? (peerId, trigger) => openA2AChat(bot.id, peerId, trigger)
                            : undefined
                        }
                        runs={index.runsByChannel.get(channelId) ?? []}
                        runtime={snapshot.runtime}
                        selectedBot={bot}
                        subagents={index.subagentsByChannel.get(channelId) ?? []}
                      />
                    </div>
                  );
                })}
                {a2aExchange && a2aExchangeChannel && (
                  <A2AExchangeSheet
                    label={`${a2aExchangeChannel.name} agent exchange`}
                    onAnimationEnd={finishA2AAnimation}
                    phase={a2aExchange.phase}
                  >
                    <ChatPane
                      activeRun={undefined}
                      agentNameById={index.agentNameById}
                      approvalsByRun={index.approvalsByRun}
                      botById={index.botById}
                      channel={a2aExchangeChannel}
                      focusMessage={null}
                      itemsByRun={index.itemsByRun}
                      messages={a2aExchangeView?.messages ?? []}
                      mutate={mutate}
                      onCloseViewOnly={closeA2AChat}
                      runs={[]}
                      runtime={snapshot.runtime}
                      subagents={[]}
                    />
                  </A2AExchangeSheet>
                )}
              </div>
              <div
                aria-hidden={!detailsOpen}
                className={cn(
                  "shrink-0 overflow-hidden bg-inspector opacity-100",
                  !inspectorResizing && "transition-[width,opacity] duration-150 ease-out",
                  !detailsOpen && "pointer-events-none opacity-0"
                )}
                inert={!detailsOpen}
                style={{ width: detailsOpen ? inspectorWidth : 0 }}
              >
                <div className="relative h-full" style={{ width: inspectorWidth }}>
                  <div
                    aria-label="Resize details sidebar"
                    aria-orientation="vertical"
                    aria-valuemax={maxInspectorWidth()}
                    aria-valuemin={MIN_INSPECTOR_WIDTH}
                    aria-valuenow={inspectorWidth}
                    className="electron-no-drag group absolute inset-y-0 left-0 z-40 w-2 cursor-col-resize touch-none outline-none"
                    data-inspector-resizer=""
                    data-resizing={inspectorResizing ? "true" : "false"}
                    onDoubleClick={() => {
                      updateInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
                      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(DEFAULT_INSPECTOR_WIDTH));
                    }}
                    onKeyDown={(event) => {
                      let next = inspectorWidth;
                      if (event.key === "ArrowLeft") next += 16;
                      else if (event.key === "ArrowRight") next -= 16;
                      else if (event.key === "Home") next = MIN_INSPECTOR_WIDTH;
                      else if (event.key === "End") next = maxInspectorWidth();
                      else return;
                      event.preventDefault();
                      updateInspectorWidth(next);
                      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clampInspectorWidth(next)));
                    }}
                    onPointerCancel={(event) => finishInspectorResize(event.currentTarget, true)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      inspectorResizeSessionRef.current = {
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startWidth: inspectorWidth,
                        width: inspectorWidth,
                        shouldClose: false,
                        cursor: document.body.style.cursor,
                        userSelect: document.body.style.userSelect,
                      };
                      setInspectorResizing(true);
                      document.body.style.cursor = "col-resize";
                      document.body.style.userSelect = "none";
                    }}
                    onPointerMove={(event) => {
                      const session = inspectorResizeSessionRef.current;
                      if (!session || session.pointerId !== event.pointerId) return;
                      const next = resizeInspector(
                        session.startWidth,
                        session.startX,
                        event.clientX
                      );
                      session.shouldClose = next.shouldClose;
                      updateInspectorWidth(next.width);
                    }}
                    onPointerUp={(event) => finishInspectorResize(event.currentTarget)}
                    role="separator"
                    tabIndex={0}
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 w-[0.5px] bg-divider transition-colors duration-150 ease-out group-hover:bg-divider-hover group-focus-visible:bg-divider-hover motion-reduce:transition-none",
                        inspectorResizing && "!bg-divider-active"
                      )}
                    />
                  </div>
                  {warmIds.map((channelId) => {
                    const channel = index.channelById.get(channelId);
                    if (!channel) return null;
                    return (
                      <div
                        aria-hidden={channelId !== selectedId}
                        className={channelId === selectedId ? "absolute inset-0" : "hidden"}
                        key={channelId}
                      >
                        <Inspector
                          active={detailsOpen && channelId === selectedId}
                          botById={index.botById}
                          channel={channel}
                          screenEnabled={Boolean(
                            channel.kind === "bot_dm" &&
                              enabledScreenIds.has(channel.members[0]?.botId ?? "")
                          )}
                          mode={channelId === selectedId ? inspectorMode : "summary"}
                          onEnableScreen={enableScreen}
                          onModeChange={setInspectorMode}
                          onRetryBot={retryInspectorBot}
                          onSetMembers={(channelId, botIds) =>
                            mutate(() => api.setChannelMembers(channelId, botIds)).then(
                              () => undefined
                            )
                          }
                          onUpdateBot={updateInspectorBot}
                          rounds={index.roundsByChannel.get(channelId) ?? []}
                          workspaceRoot={snapshot.workspace.root}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              Create a bot to get started.
            </div>
          )}
        </section>

        <DesktopDialogs
          activeBots={snapshot.bots.filter((bot) => bot.status === "active")}
          deleteBotTarget={deleteBotTarget}
          newGroupOpen={newGroupDialog}
          onConfirmDeleteBot={confirmDeleteBot}
          onCreateGroup={async (name, botIds) => {
            const channel = await mutate(() => api.createGroup({ name, botIds }));
            setSelectedId(channel.id);
            setNewGroupDialog(false);
          }}
          onDeleteBotOpenChange={(open) => !open && setDeleteBotTarget(null)}
          onNewGroupOpenChange={setNewGroupDialog}
          onTranscriptOpenChange={(open) => !open && setRowTranscript(null)}
          rowTranscript={rowTranscript}
        />
        <SearchDialog
          actions={searchActions}
          botById={index.botById}
          channelById={index.channelById}
          onOpenChange={setSearchOpen}
          onSelectResult={selectSearchResult}
          open={searchOpen}
        />
        <SettingsPanel
          botName={selectedBot?.name ?? "OpenBot"}
          onOpenChange={setSettingsOpen}
          open={settingsOpen}
        />
        <PluginDialog onOpenChange={setPluginsOpen} open={pluginsOpen} />
        <AboutPanel onOpenChange={setAboutOpen} open={aboutOpen} />
        {asyncTasksBot && (
          <AsyncTasksPanel
            bot={asyncTasksBot}
            onClose={() => setAsyncTasksBotId(null)}
            tasks={asyncTasks}
          />
        )}
      </main>
    </TooltipProvider>
  );
}
