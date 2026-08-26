import type { UpdateBotInput } from "@openbot/contracts";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "./client/openbot-api";
import { ChatPane } from "./components/openbot/chat-pane";
import { DesktopDialogs, preloadDesktopForms } from "./components/openbot/desktop-dialogs";
import { DesktopHeader } from "./components/openbot/desktop-header";
import { Inspector } from "./components/openbot/inspector";
import { NewChannelScreen } from "./components/openbot/new-channel-screen";
import { Sidebar } from "./components/openbot/sidebar";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";
import { useBotRowActions, type InspectorMode } from "./hooks/use-bot-row-actions";
import { useChannelSelection } from "./hooks/use-channel-selection";
import { useRecentChannels } from "./hooks/use-recent-channels";
import { measureUntilNextPaint } from "./lib/performance";
import { useSnapshotIndex } from "./lib/snapshot-index";
import { useOpenBot } from "./state/use-openbot";

export default function App() {
  const { snapshot, error, refresh, mutate } = useOpenBot();
  const index = useSnapshotIndex(snapshot);
  const { selectedId, setSelectedId } = useChannelSelection(snapshot, index.channelById);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [newBot, setNewBot] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("summary");
  const [pendingBot, setPendingBot] = useState<{ name: string; color: string } | null>(null);
  const { handleBotRowAction, rowTranscript, setRowTranscript } = useBotRowActions({
    mutate,
    setSelectedId,
    setDetailsOpen,
    setInspectorMode,
  });

  useEffect(() => {
    const idleId = window.requestIdleCallback(preloadDesktopForms, { timeout: 2_000 });
    return () => window.cancelIdleCallback(idleId);
  }, []);

  const visibleChannels = useMemo(() => {
    if (!snapshot) return [];
    const query = deferredSearch.trim().toLowerCase();
    return snapshot.channels
      .filter((channel) => {
        const bot =
          channel.kind === "bot_dm"
            ? index.botById.get(channel.members[0]?.botId ?? "")
            : undefined;
        if (bot?.hiddenFromSidebar && !query && channel.id !== selectedId) return false;
        return !query || channel.name.toLowerCase().includes(query);
      })
      .slice()
      .sort((a, b) => {
        const aLatest = index.latestMessageByChannel.get(a.id)?.createdAt ?? a.updatedAt;
        const bLatest = index.latestMessageByChannel.get(b.id)?.createdAt ?? b.updatedAt;
        return bLatest.localeCompare(aLatest);
      });
  }, [deferredSearch, index.botById, index.latestMessageByChannel, selectedId, snapshot]);

  const recentIds = useRecentChannels(selectedId);
  const warmIds = useMemo(
    () =>
      selectedId ? [selectedId, ...recentIds.filter((id) => id !== selectedId)].slice(0, 3) : [],
    [recentIds, selectedId]
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

  const selected = index.channelById.get(selectedId ?? "") ?? null;
  const selectedBot =
    selected?.kind === "bot_dm" ? index.botById.get(selected.members[0]?.botId ?? "") : undefined;

  return (
    <TooltipProvider delayDuration={350}>
      <main className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar
          activeRunByChannel={index.activeRunByChannel}
          botById={index.botById}
          channels={visibleChannels}
          creating={newGroup}
          latestMessageByChannel={index.latestMessageByChannel}
          onBotAction={handleBotRowAction}
          onNewBot={() => {
            measureUntilNextPaint("view.dialog-open", { dialog: "new-bot" });
            setNewBot(true);
          }}
          onNewGroup={() => {
            measureUntilNextPaint("view.dialog-open", { dialog: "new-group" });
            setNewGroup(true);
          }}
          onSearch={setSearch}
          onSelect={(id) => {
            setNewGroup(false);
            setSelectedId(id);
          }}
          pendingBot={pendingBot}
          search={search}
          selectedId={newGroup ? null : selectedId}
        />

        <section className="flex min-w-0 flex-1 flex-col">
          {!newGroup && (
            <DesktopHeader
              botById={index.botById}
              detailsOpen={detailsOpen}
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

          {newGroup ? (
            <NewChannelScreen
              botById={index.botById}
              channels={visibleChannels}
              onCreateBot={() => {
                setNewGroup(false);
                setNewBot(true);
              }}
              onSelect={(id) => {
                setNewGroup(false);
                setSelectedId(id);
              }}
            />
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
              {detailsOpen && (
                <div className="relative w-80 shrink-0">
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
                          active={channelId === selectedId}
                          botById={index.botById}
                          channel={channel}
                          mode={channelId === selectedId ? inspectorMode : "summary"}
                          onModeChange={setInspectorMode}
                          onRetryBot={async (botId) => {
                            await mutate(() => api.retryBot(botId));
                          }}
                          onUpdateBot={(botId: string, input: UpdateBotInput) =>
                            api.updateBot(botId, input)
                          }
                          rounds={index.roundsByChannel.get(channelId) ?? []}
                          workspaceRoot={snapshot.workspace.root}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              Create a bot to get started.
            </div>
          )}
        </section>

        <DesktopDialogs
          activeBots={snapshot.bots.filter((bot) => bot.status === "active")}
          newBotOpen={newBot}
          newGroupOpen={false}
          onCreateBot={async (value) => {
            setPendingBot({
              name: value.name ?? "New Bot",
              color: value.color ?? "#ff7a1a",
            });
            try {
              const bot = await mutate(() => api.createBot(value));
              setInspectorMode("summary");
              setDetailsOpen(true);
              setSelectedId(bot.dmChannelId);
              setNewBot(false);
            } finally {
              setPendingBot(null);
            }
          }}
          onCreateGroup={async (name, botIds) => {
            const channel = await mutate(() => api.createGroup({ name, botIds }));
            setSelectedId(channel.id);
            setNewGroup(false);
          }}
          onNewBotOpenChange={setNewBot}
          onNewGroupOpenChange={setNewGroup}
          onTranscriptOpenChange={(open) => !open && setRowTranscript(null)}
          rowTranscript={rowTranscript}
        />
      </main>
    </TooltipProvider>
  );
}
