import type { SearchResultView, UpdateBotInput } from "@openbot/contracts";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./client/openbot-api";
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
import { cn } from "./lib/cn";
import { MIN_INSPECTOR_WIDTH, resizeInspector } from "./lib/panel-resize";
import { measureUntilNextPaint } from "./lib/performance";
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
  const [pendingBot, setPendingBot] = useState<{
    name: string;
    dmChannelId?: string;
  } | null>(null);
  const creatingBot = useRef(false);
  const sidebarPreferences = useSidebarPreferences();

  useEffect(() => {
    const handleResize = () => setInspectorWidth((width) => clampInspectorWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
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
    handleBotRowAction,
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
    (botId: string, input: UpdateBotInput) => api.updateBot(botId, input),
    []
  );
  const enableScreen = useCallback((botId: string) => {
    setEnabledScreenIds((current) => enableScreenForSession(current, botId));
  }, []);

  const snapshotChannels = snapshot?.channels;
  const visibleChannels = useMemo(() => {
    if (!snapshotChannels) return [];
    return snapshotChannels.slice().sort((a, b) => {
      const aLatest = index.latestMessageByChannel.get(a.id)?.createdAt ?? a.updatedAt;
      const bLatest = index.latestMessageByChannel.get(b.id)?.createdAt ?? b.updatedAt;
      return bLatest.localeCompare(aLatest);
    });
  }, [index.latestMessageByChannel, snapshotChannels]);

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
  const selectedBot =
    selected?.kind === "bot_dm" ? index.botById.get(selected.members[0]?.botId ?? "") : undefined;
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
          selectedId={newBotPicker || pendingBot ? null : selectedId}
        />

        <section className="relative flex min-w-0 flex-1 flex-col">
          {!newBotPicker && !pendingBot && (
            <DesktopHeader
              botById={index.botById}
              detailsOpen={detailsOpen}
              inspectorResizing={inspectorResizing}
              inspectorWidth={inspectorWidth}
              inspectorMode={inspectorMode}
              onDetailsOpenChange={(open) => {
                if (open) setInspectorMode("summary");
                setDetailsOpen(open);
              }}
              onShowSettings={() => setInspectorMode("settings")}
              onShowSummary={() => setInspectorMode("summary")}
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
                      aria-hidden={channelId !== selectedId}
                      className={channelId === selectedId ? "absolute inset-0" : "hidden"}
                      key={channelId}
                    >
                      <ChatPane
                        activeRun={index.activeRunByChannel.get(channelId)}
                        approvalsByRun={index.approvalsByRun}
                        botById={index.botById}
                        channel={channel}
                        focusMessage={
                          searchMessageTarget?.channelId === channelId ? searchMessageTarget : null
                        }
                        itemsByRun={index.itemsByRun}
                        messages={index.messagesByChannel.get(channelId) ?? []}
                        mutate={mutate}
                        runs={index.runsByChannel.get(channelId) ?? []}
                        runtime={snapshot.runtime}
                        selectedBot={bot}
                      />
                    </div>
                  );
                })}
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
                        "absolute inset-y-0 left-0 w-px bg-divider transition-colors duration-150 ease-out group-hover:bg-divider-hover group-focus-visible:bg-divider-hover motion-reduce:transition-none",
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
      </main>
    </TooltipProvider>
  );
}
