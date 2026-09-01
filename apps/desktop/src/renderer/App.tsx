import type { BotView, ChannelView, SearchResultView, UpdateBotInput } from "@openbot/contracts";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./client/openbot-api";
import { ChatPane } from "./components/openbot/chat-pane";
import { DesktopHeader } from "./components/openbot/desktop-header";
import type { SearchAction } from "./components/openbot/search-dialog";
import { HiddenAgentsDialog, Sidebar } from "./components/openbot/sidebar";
import { VersionMismatchBanner } from "./components/openbot/version-mismatch-banner";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";
import { type InspectorMode, useBotRowActions } from "./hooks/use-bot-row-actions";
import { useChannelSelection } from "./hooks/use-channel-selection";
import { useRecentChannels } from "./hooks/use-recent-channels";
import { useSidebarPreferences } from "./hooks/use-sidebar-preferences";
import {
  type A2AExchangeState,
  closeA2AExchange,
  deriveA2AExchange,
  finishA2AExchangeAnimation,
  startA2AExchange,
} from "./lib/a2a-exchange";
import {
  OPENBOT_DEEP_LINK_EVENT,
  parseOpenBotDeepLink,
  type SettingsAnchor,
} from "./lib/app-deep-links";
import { activeAsyncTaskChannelIds, activeAsyncTasksForBot } from "./lib/async-tasks";
import { BOT_TEMPLATE_SHARING_ENABLED, type TemplateBot } from "./lib/bot-template";
import { cn } from "./lib/cn";
import { deriveUnreadChannelIds, syncDesktopNotificationSnapshot } from "./lib/notifications";
import {
  COMPACT_SIDEBAR_WIDTH,
  canShowInspector,
  MIN_INSPECTOR_WIDTH,
  maxInspectorWidthForLayout,
  resizeInspector,
  shouldForceCompactSidebar,
} from "./lib/panel-resize";
import { measureUntilNextPaint, recordPerformance } from "./lib/performance";
import { enableScreenForSession } from "./lib/screen-session";
import { useSnapshotIndex } from "./lib/snapshot-index";
import { readThemePreference, setThemePreference, THEME_CHANGE_EVENT } from "./lib/theme";
import { useOpenBot } from "./state/use-openbot";

const A2AExchangeSheet = lazy(() =>
  import("./components/openbot/a2a-exchange-sheet").then((module) => ({
    default: module.A2AExchangeSheet,
  }))
);
const AsyncTasksPanel = lazy(() =>
  import("./components/openbot/async-tasks-panel").then((module) => ({
    default: module.AsyncTasksPanel,
  }))
);
const BotTemplateImportDialog = lazy(() =>
  import("./components/openbot/bot-template-share").then((module) => ({
    default: module.BotTemplateImportDialog,
  }))
);
const DesktopDialogs = lazy(() =>
  import("./components/openbot/desktop-dialogs").then((module) => ({
    default: module.DesktopDialogs,
  }))
);
const Inspector = lazy(() =>
  import("./components/openbot/inspector").then((module) => ({ default: module.Inspector }))
);
const NewBotScreen = lazy(() =>
  import("./components/openbot/new-bot-screen").then((module) => ({
    default: module.NewBotScreen,
  }))
);
const PluginDialog = lazy(() =>
  import("./components/openbot/plugin-settings").then((module) => ({
    default: module.PluginDialog,
  }))
);
const loadSearchDialog = () => import("./components/openbot/search-dialog");
const preloadSearchDialog = () => void loadSearchDialog();
const SearchDialog = lazy(() =>
  loadSearchDialog().then((module) => ({
    default: module.SearchDialog,
  }))
);
const AboutPanel = lazy(() => import("./components/openbot/settings-about"));
const SettingsPanel = lazy(async () => {
  const [module] = await Promise.all([
    import("./components/openbot/settings-panel"),
    import("./components/openbot/settings-general"),
    import("./components/openbot/settings-general-bot"),
  ]);
  return {
    default: module.SettingsPanel,
  };
});

const INSPECTOR_WIDTH_KEY = "openbot:inspector-width";
const DEFAULT_INSPECTOR_WIDTH = 320;
const DEFAULT_SIDEBAR_WIDTH = 280;
const clampInspectorWidth = (width: number, windowWidth: number, sidebarWidth: number) =>
  Math.min(
    maxInspectorWidthForLayout(windowWidth, sidebarWidth),
    Math.max(MIN_INSPECTOR_WIDTH, width)
  );
const readInspectorWidth = () => {
  const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  return clampInspectorWidth(
    Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_INSPECTOR_WIDTH,
    window.innerWidth,
    DEFAULT_SIDEBAR_WIDTH
  );
};

export default function App() {
  const {
    snapshot,
    capabilities,
    error,
    refresh,
    mutate,
    clearSearchContext,
    ensureMessageLoaded,
    reactToMessage,
    historyByChannel,
    jumpToLatest,
    loadChannel,
    loadOlder,
    loadNewer,
    setHistoryViewportAtBottom,
    threadContextMessageIdsByChannel,
    searchContextMessageIdsByChannel,
  } = useOpenBot();
  const index = useSnapshotIndex(snapshot);
  const { selectedId, setSelectedId } = useChannelSelection(snapshot, index.channelById);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreference, setThemePreferenceState] = useState(readThemePreference);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [templateImport, setTemplateImport] = useState<TemplateBot | null>(null);
  const [templateShareRequest, setTemplateShareRequest] = useState<{
    botId: string;
    nonce: number;
  } | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<{
    anchor: SettingsAnchor;
    nonce: number;
  } | null>(null);
  const [pluginTarget, setPluginTarget] = useState<{ pluginId: string; nonce: number } | null>(
    null
  );
  const [asyncTasksBotId, setAsyncTasksBotId] = useState<string | null>(null);
  const [searchMessageTarget, setSearchMessageTarget] = useState<{
    channelId: string;
    messageId: string;
    nonce: number;
  } | null>(null);
  const [routineOpenTarget, setRoutineOpenTarget] = useState<{
    channelId: string;
    routineId: string;
    nonce: number;
  } | null>(null);
  const [newBotPicker, setNewBotPicker] = useState(false);
  const [newGroupDialog, setNewGroupDialog] = useState(false);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<ChannelView | null>(null);
  const [hiddenAgentsOpen, setHiddenAgentsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [sidebarLayout, setSidebarLayout] = useState({
    compact: false,
    width: DEFAULT_SIDEBAR_WIDTH,
  });
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
  const inspectorPanelRef = useRef<HTMLDivElement | null>(null);
  const inspectorContentRef = useRef<HTMLDivElement | null>(null);
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
  const previousUnreadSnapshot = useRef(snapshot);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const readRequests = useRef(new Set<string>());
  const forcedSidebarCompact = shouldForceCompactSidebar(viewportWidth, sidebarLayout.width);
  const effectiveSidebarWidth =
    forcedSidebarCompact || sidebarLayout.compact ? COMPACT_SIDEBAR_WIDTH : sidebarLayout.width;
  const detailsDocked = canShowInspector(viewportWidth, effectiveSidebarWidth);
  const visibleDetailsOpen = detailsOpen;
  const detailsOverlay = detailsOpen && !detailsDocked;
  const inspectorMaxWidth = maxInspectorWidthForLayout(viewportWidth, effectiveSidebarWidth);
  const renderedInspectorWidth = clampInspectorWidth(
    inspectorWidth,
    viewportWidth,
    effectiveSidebarWidth
  );
  const handleSidebarLayoutChange = useCallback((layout: { compact: boolean; width: number }) => {
    setSidebarLayout((current) =>
      current.compact === layout.compact && current.width === layout.width ? current : layout
    );
  }, []);
  const searchLoadNonce = useRef(0);
  const invalidateSearchNavigation = useCallback(
    (...channelIds: Array<string | null | undefined>) => {
      searchLoadNonce.current += 1;
      setSearchMessageTarget(null);
      for (const channelId of new Set(channelIds.filter((id): id is string => Boolean(id)))) {
        clearSearchContext(channelId);
      }
    },
    [clearSearchContext]
  );
  const loadedSurfaces = useRef({
    about: false,
    dialogs: false,
    plugins: false,
    search: false,
    settings: false,
  });
  const appReady = Boolean(snapshot);

  const markChannelRead = useCallback(
    (channelId: string) => {
      sidebarPreferences.markRead(channelId);
      if (readRequests.current.has(channelId)) return;

      const channel = index.channelById.get(channelId);
      if (channel?.unreadCount === 0) return;

      const latestSequence = index.latestMessageByChannel.get(channelId)?.sequence;
      const throughSequence =
        latestSequence && /^\d+$/.test(latestSequence) ? latestSequence : undefined;

      readRequests.current.add(channelId);
      void api
        .markChannelRead(channelId, throughSequence)
        .then(() => {
          // Release the guard before publishing the authoritative read count. If a
          // message arrived during this request, the refreshed snapshot can queue
          // the newer sequence instead of leaving it unread until another event.
          readRequests.current.delete(channelId);
          return refresh(true);
        })
        .catch(() => undefined)
        .finally(() => readRequests.current.delete(channelId));
    },
    [index.channelById, index.latestMessageByChannel, refresh, sidebarPreferences.markRead]
  );

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  useEffect(() => {
    const handleDeepLink = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      const target = parseOpenBotDeepLink(url);
      if (target?.kind === "settings") {
        setSettingsTarget({ anchor: target.anchor, nonce: Date.now() });
        setSettingsOpen(true);
      }
      if (target?.kind === "plugin") {
        setPluginTarget({ pluginId: target.pluginId, nonce: Date.now() });
        setPluginsOpen(true);
      }
      if (BOT_TEMPLATE_SHARING_ENABLED && target?.kind === "template") {
        setTemplateImport(target.template);
      }
    };
    window.addEventListener(OPENBOT_DEEP_LINK_EVENT, handleDeepLink);
    return () => window.removeEventListener(OPENBOT_DEEP_LINK_EVENT, handleDeepLink);
  }, []);
  useEffect(() => {
    const unsubscribe = window.openbot?.onNotificationClick((channelId) => {
      invalidateSearchNavigation(selectedId, searchMessageTarget?.channelId);
      setA2AExchange(null);
      a2aExchangeTrigger.current = null;
      restoreA2AFocusAfterClose.current = false;
      setNewBotPicker(false);
      setSelectedId(channelId);
      setInspectorMode("summary");
      markChannelRead(channelId);
      setDetailsOpen(false);
    });
    return unsubscribe;
  }, [
    invalidateSearchNavigation,
    markChannelRead,
    searchMessageTarget?.channelId,
    selectedId,
    setSelectedId,
  ]);
  useEffect(() => {
    if (selectedId) void loadChannel(selectedId).catch(() => undefined);
  }, [loadChannel, selectedId]);
  useEffect(() => {
    syncDesktopNotificationSnapshot(
      window.openbot?.notifications,
      snapshot,
      sidebarPreferences.unreadIds
    );
  }, [
    sidebarPreferences.unreadIds,
    snapshot?.approvals,
    snapshot?.bots,
    snapshot?.channelMessages,
    snapshot?.channels,
    snapshot?.cursor,
    snapshot?.runs,
  ]);
  useEffect(() => {
    const publishVisibleChannel = () =>
      window.openbot?.notifications.setVisibleChannel(document.hasFocus() ? selectedId : null);
    publishVisibleChannel();
    window.addEventListener("focus", publishVisibleChannel);
    window.addEventListener("blur", publishVisibleChannel);
    return () => {
      window.removeEventListener("focus", publishVisibleChannel);
      window.removeEventListener("blur", publishVisibleChannel);
    };
  }, [selectedId]);
  useEffect(() => {
    if (!snapshot) return;
    const visibleChannelId = document.hasFocus() ? selectedIdRef.current : null;
    const unreadChannelIds: string[] = [];
    const readChannelIds: string[] = [];
    for (const channel of snapshot.channels) {
      if (channel.unreadCount === undefined) continue;
      if (channel.id === visibleChannelId && channel.unreadCount > 0) {
        markChannelRead(channel.id);
      } else if (channel.unreadCount > 0) {
        unreadChannelIds.push(channel.id);
      } else {
        readChannelIds.push(channel.id);
      }
    }
    sidebarPreferences.markUnreadMany(unreadChannelIds);
    sidebarPreferences.markReadMany(readChannelIds);
  }, [
    markChannelRead,
    sidebarPreferences.markReadMany,
    sidebarPreferences.markUnreadMany,
    snapshot,
  ]);
  useEffect(() => {
    const previous = previousUnreadSnapshot.current;
    previousUnreadSnapshot.current = snapshot;
    if (!previous || !snapshot || previous === snapshot) return;
    const visibleChannelId = document.hasFocus() ? selectedIdRef.current : null;
    const channelsWithServerReadState = new Set(
      snapshot.channels
        .filter((channel) => channel.unreadCount !== undefined)
        .map((channel) => channel.id)
    );
    if (channelsWithServerReadState.size === snapshot.channels.length) return;
    sidebarPreferences.markUnreadMany(
      deriveUnreadChannelIds(previous, snapshot, visibleChannelId).filter(
        (channelId) => !channelsWithServerReadState.has(channelId)
      )
    );
  }, [sidebarPreferences.markUnreadMany, snapshot]);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (!event.repeat) setSearchOpen((current) => !current);
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);
  useEffect(() => {
    const syncThemePreference = () => setThemePreferenceState(readThemePreference());
    window.addEventListener(THEME_CHANGE_EVENT, syncThemePreference);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, syncThemePreference);
  }, []);
  useEffect(() => {
    if (!appReady) return;
    // Search is frequent enough that evaluating it on the first click is visible,
    // but it should not compete with the initial shell/bootstrap paint. Warm the
    // existing lazy boundary only after React has committed and Chromium is idle.
    const idle = window.requestIdleCallback(preloadSearchDialog, { timeout: 2_000 });
    return () => window.cancelIdleCallback(idle);
  }, [appReady]);
  const shareBotAsTemplate = useCallback(
    (bot: BotView) => {
      if (!BOT_TEMPLATE_SHARING_ENABLED) return;
      setSelectedId(bot.dmChannelId);
      setTemplateShareRequest({ botId: bot.id, nonce: Date.now() });
    },
    [setSelectedId]
  );
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
    shareAsTemplate: shareBotAsTemplate,
    togglePinned: sidebarPreferences.togglePinned,
    toggleUnread: sidebarPreferences.toggleUnread,
  });
  if (aboutOpen) loadedSurfaces.current.about = true;
  if (deleteBotTarget || deleteGroupTarget || newGroupDialog || rowTranscript) {
    loadedSurfaces.current.dialogs = true;
  }
  if (pluginsOpen) loadedSurfaces.current.plugins = true;
  if (searchOpen) loadedSurfaces.current.search = true;
  if (settingsOpen) loadedSurfaces.current.settings = true;
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
  const setChannelMembers = useCallback(
    (channelId: string, botIds: string[]) =>
      mutate(() => api.setChannelMembers(channelId, botIds)).then(() => undefined),
    [mutate]
  );
  const hideGroup = useCallback(
    (channel: ChannelView) => {
      void mutate(() => api.setChannelHidden(channel.id, true)).then(() => {
        if (selectedId === channel.id) setSelectedId(null);
      });
    },
    [mutate, selectedId, setSelectedId]
  );
  const confirmDeleteGroup = useCallback(() => {
    if (!deleteGroupTarget) return;
    const channelId = deleteGroupTarget.id;
    setDeleteGroupTarget(null);
    void mutate(() => api.deleteGroup(channelId)).then(() => {
      if (selectedId === channelId) setSelectedId(null);
    });
  }, [deleteGroupTarget, mutate, selectedId, setSelectedId]);
  const unhideBot = useCallback(
    async (bot: BotView) => {
      await mutate(() => api.updateBot(bot.id, { hiddenFromSidebar: false }));
    },
    [mutate]
  );
  const unhideGroup = useCallback(
    async (channel: ChannelView) => {
      await mutate(() => api.setChannelHidden(channel.id, false));
    },
    [mutate]
  );
  const setChannelAvatar = useCallback(
    (channelId: string, pngBase64: string | null) =>
      mutate(() => api.setChannelAvatar(channelId, pngBase64)).then(() => undefined),
    [mutate]
  );
  const updateGroupProfile = useCallback(
    (channelId: string, name: string, description: string) =>
      mutate(() => api.updateChannelProfile(channelId, name, description)),
    [mutate]
  );
  const enableScreen = useCallback((botId: string) => {
    setEnabledScreenIds((current) => enableScreenForSession(current, botId));
  }, []);

  const snapshotChannels = snapshot?.channels;
  const hiddenBots = useMemo(
    () => snapshot?.bots.filter((bot) => bot.hiddenFromSidebar) ?? [],
    [snapshot?.bots]
  );
  const hiddenGroups = useMemo(
    () =>
      snapshotChannels?.filter(
        (channel) => channel.kind === "group" && channel.hiddenFromSidebar
      ) ?? [],
    [snapshotChannels]
  );
  const hiddenAgentCount = hiddenBots.length + hiddenGroups.length;
  const visibleChannels = useMemo(() => {
    if (!snapshotChannels || !snapshot) return [];
    const hiddenBotIds = new Set(
      snapshot.bots.filter((bot) => bot.hiddenFromSidebar).map((bot) => bot.id)
    );
    return snapshotChannels.filter((channel) => {
      if (channel.kind === "agent_dm" || channel.hiddenFromSidebar) return false;
      if (channel.kind !== "bot_dm") return true;
      const botId = channel.members[0]?.botId;
      return Boolean(botId && !hiddenBotIds.has(botId));
    });
  }, [snapshot, snapshotChannels]);
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
  const openHiddenAgents = useCallback(() => setHiddenAgentsOpen(true), []);
  const openSettingsTarget = useCallback((anchor: SettingsAnchor | null) => {
    setSettingsTarget(anchor ? { anchor, nonce: Date.now() } : null);
    setSettingsOpen(true);
  }, []);
  const openSettings = useCallback(() => openSettingsTarget(null), [openSettingsTarget]);
  const openPlugins = useCallback(() => {
    setPluginTarget(null);
    setPluginsOpen(true);
  }, []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const selectSidebarChannel = useCallback(
    (id: string) => {
      invalidateSearchNavigation(selectedId, searchMessageTarget?.channelId);
      setA2AExchange(null);
      a2aExchangeTrigger.current = null;
      restoreA2AFocusAfterClose.current = false;
      setNewBotPicker(false);
      markChannelRead(id);
      setSelectedId(id);
      setInspectorMode("summary");
    },
    [
      invalidateSearchNavigation,
      searchMessageTarget?.channelId,
      selectedId,
      markChannelRead,
      setSelectedId,
    ]
  );
  const editSidebarChannel = useCallback(
    (id: string) => {
      selectSidebarChannel(id);
      setInspectorMode("settings");
      setDetailsOpen(true);
    },
    [selectSidebarChannel]
  );

  const recentIds = useRecentChannels(selectedId);
  const warmIds = useMemo(
    () =>
      selectedId ? [selectedId, ...recentIds.filter((id) => id !== selectedId)].slice(0, 3) : [],
    [recentIds, selectedId]
  );
  const loadOlderHandlers = useMemo(
    () => new Map(warmIds.map((channelId) => [channelId, () => loadOlder(channelId)] as const)),
    [loadOlder, warmIds]
  );
  const loadNewerHandlers = useMemo(
    () => new Map(warmIds.map((channelId) => [channelId, () => loadNewer(channelId)] as const)),
    [loadNewer, warmIds]
  );
  const scrollNewestHandlers = useMemo(
    () =>
      new Map(
        warmIds.map((channelId) => {
          const historyStatus = historyByChannel.get(channelId);
          return [
            channelId,
            async () => {
              searchLoadNonce.current += 1;
              setSearchMessageTarget((current) =>
                current?.channelId === channelId ? null : current
              );
              if (historyStatus && (historyStatus.mode !== "latest" || historyStatus.hasNewerGap)) {
                await jumpToLatest(channelId);
              }
            },
          ] as const;
        })
      ),
    [historyByChannel, jumpToLatest, warmIds]
  );
  const viewportBottomHandlers = useMemo(
    () =>
      new Map(
        warmIds.map(
          (channelId) =>
            [
              channelId,
              (atBottom: boolean) => setHistoryViewportAtBottom(channelId, atBottom),
            ] as const
        )
      ),
    [setHistoryViewportAtBottom, warmIds]
  );
  const openRoutineHandlers = useMemo(
    () =>
      new Map(
        warmIds.map(
          (channelId) =>
            [
              channelId,
              (routineId: string) => {
                setRoutineOpenTarget({ channelId, routineId, nonce: Date.now() });
                setInspectorMode("routine");
                setDetailsOpen(true);
              },
            ] as const
        )
      ),
    [warmIds]
  );

  const updateInspectorWidth = (width: number) => {
    const next = clampInspectorWidth(width, viewportWidth, effectiveSidebarWidth);
    if (inspectorResizeSessionRef.current) inspectorResizeSessionRef.current.width = next;
    setInspectorWidth(next);
  };
  const previewInspectorWidth = (width: number) => {
    const next = clampInspectorWidth(width, viewportWidth, effectiveSidebarWidth);
    const session = inspectorResizeSessionRef.current;
    if (session) session.width = next;
    if (inspectorPanelRef.current) inspectorPanelRef.current.style.width = `${next}px`;
    if (inspectorContentRef.current) inspectorContentRef.current.style.width = `${next}px`;
    return next;
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
    setInspectorWidth(session.width);
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
  const openInspectorBot = useCallback(
    (botId: string) => {
      const target = index.botById.get(botId);
      if (!target) return;
      selectSidebarChannel(target.dmChannelId);
      setInspectorMode("summary");
    },
    [index.botById, selectSidebarChannel]
  );
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
      ...(selected
        ? [
            {
              id: "chat-details",
              title: "Chat Settings",
              subtitle: "Current chat",
              keywords: "current channel members info",
              icon: "details" as const,
              run: () => {
                setInspectorMode("settings");
                setDetailsOpen(true);
              },
            },
          ]
        : []),
      {
        id: "settings-general",
        title: "Settings: General",
        subtitle: "Settings",
        keywords: "account appearance bot defaults",
        icon: "settings",
        run: openSettings,
      },
      {
        id: "settings-computer",
        title: "Settings: Computer",
        subtitle: "Settings",
        keywords: "local execution host computers permissions",
        icon: "computer",
        run: () => openSettingsTarget("computers"),
      },
      {
        id: "settings-updates",
        title: "Settings: Updates",
        subtitle: "Settings",
        keywords: "desktop server version upgrade",
        icon: "updates",
        run: () => openSettingsTarget("update-status"),
      },
      {
        id: "plugins",
        title: "Plugins",
        subtitle: "",
        keywords: "connectors integrations tools",
        icon: "plugins",
        run: openPlugins,
      },
      ...(hiddenAgentCount > 0
        ? [
            {
              id: "hidden-bots",
              title: "Open Hidden Bots",
              subtitle: "Sidebar",
              keywords: "hidden bots agents groups unhide",
              icon: "hidden" as const,
              run: openHiddenAgents,
            },
          ]
        : []),
      ...(["system", "light", "dark"] as const).map((preference) => ({
        id: `theme-${preference}`,
        title: `Theme: ${preference === "system" ? "System" : preference === "light" ? "Light" : "Dark"}`,
        subtitle: "Settings · Appearance",
        keywords: "theme appearance color mode",
        icon: "theme" as const,
        current: themePreference === preference,
        run: () => setThemePreference(preference),
      })),
      {
        id: "check-for-updates",
        title: "Check for Updates",
        subtitle: "Updates",
        keywords: "desktop server version upgrade",
        icon: "updates",
        run: () => {
          openSettingsTarget("update-status");
          void window.openbot?.updates.check().catch(() => undefined);
        },
      },
    ],
    [
      hiddenAgentCount,
      openHiddenAgents,
      openPlugins,
      openSettings,
      openSettingsTarget,
      selected,
      themePreference,
    ]
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
        const nonce = ++searchLoadNonce.current;
        const startedAt = performance.now();
        setSearchMessageTarget(null);
        const channelId = result.channelId;
        const messageId = result.messageId;
        void ensureMessageLoaded(channelId, messageId)
          .then((found) => {
            if (!found || searchLoadNonce.current !== nonce) return;
            setSearchMessageTarget({ channelId, messageId, nonce });
            window.requestAnimationFrame(() => {
              window.setTimeout(
                () =>
                  recordPerformance(
                    "history.context.target-to-paint",
                    performance.now() - startedAt
                  ),
                0
              );
            });
          })
          .catch(() => undefined);
      }
    },
    [ensureMessageLoaded, selectSidebarChannel]
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
          forcedCompact={forcedSidebarCompact}
          hiddenAgentCount={hiddenAgentCount}
          latestMessageByChannel={index.latestMessageByChannel}
          onBotAction={handleBotRowAction}
          onDeleteChannel={setDeleteGroupTarget}
          onEditChannel={editSidebarChannel}
          onHideChannel={hideGroup}
          onLayoutChange={handleSidebarLayoutChange}
          onNewBot={openNewBot}
          onNewGroup={openNewGroup}
          onOpenAbout={openAbout}
          onOpenHiddenAgents={openHiddenAgents}
          onOpenPlugins={openPlugins}
          onOpenSettings={openSettings}
          onPreloadSearch={preloadSearchDialog}
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

        <HiddenAgentsDialog
          botById={index.botById}
          hiddenBots={hiddenBots}
          hiddenGroups={hiddenGroups}
          onOpenChange={setHiddenAgentsOpen}
          onOpenChannel={selectSidebarChannel}
          onUnhideBot={unhideBot}
          onUnhideGroup={unhideGroup}
          open={hiddenAgentsOpen}
        />

        <section className="relative flex min-w-0 flex-1 flex-col">
          {!newBotPicker && !pendingBot && (
            <DesktopHeader
              agentNameById={index.agentNameById}
              botById={index.botById}
              detailsOpen={visibleDetailsOpen}
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

          <VersionMismatchBanner />

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
            <Suspense
              fallback={
                <div className="grid min-h-0 flex-1 place-items-center" role="status">
                  <LoaderCircle aria-label="Loading new Bot" className="size-6 animate-spin" />
                </div>
              }
            >
              <NewBotScreen
                botById={index.botById}
                channels={visibleChannels}
                onCancel={() => setNewBotPicker(false)}
                onCreateBot={() => void createNewBot()}
                onSelect={selectSidebarChannel}
              />
            </Suspense>
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
                  const historyStatus = historyByChannel.get(channelId);
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
                        active={channelId === selectedId && !a2aExchangeChannel}
                        activityTruncated={
                          historyByChannel.get(channelId)?.activityTruncated ?? false
                        }
                        threadContextTruncated={
                          historyByChannel.get(channelId)?.threadContextTruncated ?? false
                        }
                        activeRun={index.activeRunByChannel.get(channelId)}
                        agentNameById={index.agentNameById}
                        approvalsByRun={index.approvalsByRun}
                        botById={index.botById}
                        channel={channel}
                        capabilities={capabilities}
                        focusMessage={
                          searchMessageTarget?.channelId === channelId ? searchMessageTarget : null
                        }
                        hasNewer={historyStatus?.hasNewer ?? false}
                        hasNewerGap={historyStatus?.hasNewerGap ?? false}
                        hasOlder={historyStatus?.hasOlder ?? false}
                        historyMode={historyStatus?.mode ?? "latest"}
                        itemsByRun={index.itemsByRun}
                        messages={index.messagesByChannel.get(channelId) ?? []}
                        loadingNewer={historyStatus?.loadingNewer ?? false}
                        loadingOlder={historyStatus?.loadingOlder ?? false}
                        mutate={mutate}
                        onLoadOlder={loadOlderHandlers.get(channelId)}
                        onLoadNewer={loadNewerHandlers.get(channelId)}
                        onReactMessage={reactToMessage}
                        onScrollToNewest={scrollNewestHandlers.get(channelId)}
                        onViewportAtBottomChange={viewportBottomHandlers.get(channelId)}
                        onCloseViewOnly={
                          channel.kind === "agent_dm" ? closeViewOnlyChat : undefined
                        }
                        onOpenA2A={channel.kind === "bot_dm" && bot ? openA2AChat : undefined}
                        onOpenRoutine={openRoutineHandlers.get(channelId)}
                        runs={index.runsByChannel.get(channelId) ?? []}
                        runtime={snapshot.runtime}
                        selectedBot={bot}
                        searchContextMessageIds={searchContextMessageIdsByChannel.get(channelId)}
                        subagents={index.subagentsByChannel.get(channelId) ?? []}
                        templateShareRequest={
                          templateShareRequest?.botId === bot?.id ? templateShareRequest : null
                        }
                        threadContextMessageIds={threadContextMessageIdsByChannel.get(channelId)}
                      />
                    </div>
                  );
                })}
                {a2aExchange && a2aExchangeChannel && (
                  <Suspense fallback={null}>
                    <A2AExchangeSheet
                      label={`${a2aExchangeChannel.name} agent exchange`}
                      onAnimationEnd={finishA2AAnimation}
                      phase={a2aExchange.phase}
                    >
                      <ChatPane
                        activeRun={undefined}
                        activityTruncated={false}
                        threadContextTruncated={false}
                        agentNameById={index.agentNameById}
                        approvalsByRun={index.approvalsByRun}
                        botById={index.botById}
                        channel={a2aExchangeChannel}
                        capabilities={capabilities}
                        focusMessage={null}
                        itemsByRun={index.itemsByRun}
                        messages={a2aExchangeView?.messages ?? []}
                        mutate={mutate}
                        onReactMessage={reactToMessage}
                        onCloseViewOnly={closeA2AChat}
                        runs={[]}
                        runtime={snapshot.runtime}
                        searchContextMessageIds={searchContextMessageIdsByChannel.get(
                          a2aExchangeChannel.id
                        )}
                        subagents={[]}
                        threadContextMessageIds={threadContextMessageIdsByChannel.get(
                          a2aExchangeChannel.id
                        )}
                      />
                    </A2AExchangeSheet>
                  </Suspense>
                )}
              </div>
              <div
                aria-label="Conversation details"
                aria-hidden={!visibleDetailsOpen}
                className={cn(
                  "shrink-0 overflow-hidden bg-inspector opacity-100",
                  detailsOverlay && "absolute inset-y-0 right-0 z-20 shadow-2xl",
                  !inspectorResizing && "transition-[width,opacity] duration-150 ease-out",
                  !visibleDetailsOpen && "pointer-events-none opacity-0"
                )}
                inert={!visibleDetailsOpen}
                ref={inspectorPanelRef}
                style={{ width: visibleDetailsOpen ? renderedInspectorWidth : 0 }}
              >
                <div
                  className="relative h-full"
                  ref={inspectorContentRef}
                  style={{ width: renderedInspectorWidth }}
                >
                  <div
                    aria-label="Resize details"
                    aria-orientation="vertical"
                    aria-valuemax={inspectorMaxWidth}
                    aria-valuemin={MIN_INSPECTOR_WIDTH}
                    aria-valuenow={renderedInspectorWidth}
                    className="electron-no-drag group absolute inset-y-0 left-0 z-40 w-2 cursor-col-resize touch-none outline-none"
                    data-inspector-resizer=""
                    data-resizing={inspectorResizing ? "true" : "false"}
                    onDoubleClick={() => {
                      updateInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
                      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(DEFAULT_INSPECTOR_WIDTH));
                    }}
                    onKeyDown={(event) => {
                      let next = renderedInspectorWidth;
                      if (event.key === "ArrowLeft") next += 16;
                      else if (event.key === "ArrowRight") next -= 16;
                      else if (event.key === "Home") next = MIN_INSPECTOR_WIDTH;
                      else if (event.key === "End") next = inspectorMaxWidth;
                      else return;
                      event.preventDefault();
                      updateInspectorWidth(next);
                      localStorage.setItem(
                        INSPECTOR_WIDTH_KEY,
                        String(clampInspectorWidth(next, viewportWidth, effectiveSidebarWidth))
                      );
                    }}
                    onPointerCancel={(event) => finishInspectorResize(event.currentTarget, true)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      inspectorResizeSessionRef.current = {
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startWidth: renderedInspectorWidth,
                        width: renderedInspectorWidth,
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
                      const width = previewInspectorWidth(next.width);
                      event.currentTarget.setAttribute("aria-valuenow", String(width));
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
                  {visibleDetailsOpen && selected && (
                    <div className="absolute inset-0">
                      <Suspense fallback={null}>
                        <Inspector
                          active
                          botById={index.botById}
                          channel={selected}
                          key={selected.id}
                          screenEnabled={Boolean(
                            selected.kind === "bot_dm" &&
                              enabledScreenIds.has(selected.members[0]?.botId ?? "")
                          )}
                          mode={inspectorMode}
                          onEnableScreen={enableScreen}
                          onModeChange={setInspectorMode}
                          onOpenBot={openInspectorBot}
                          onRetryBot={retryInspectorBot}
                          onShareAsTemplate={shareBotAsTemplate}
                          onSetGroupAvatar={setChannelAvatar}
                          onSetMembers={setChannelMembers}
                          onUpdateGroupProfile={updateGroupProfile}
                          routineOpenRequest={
                            routineOpenTarget?.channelId === selected.id ? routineOpenTarget : null
                          }
                          onUpdateBot={updateInspectorBot}
                        />
                      </Suspense>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              Create a bot to get started.
            </div>
          )}
        </section>

        {loadedSurfaces.current.dialogs && (
          <Suspense fallback={null}>
            <DesktopDialogs
              activeBots={snapshot.bots.filter((bot) => bot.status === "active")}
              deleteBotTarget={deleteBotTarget}
              deleteGroupTarget={deleteGroupTarget}
              newGroupOpen={newGroupDialog}
              onConfirmDeleteBot={confirmDeleteBot}
              onConfirmDeleteGroup={confirmDeleteGroup}
              onCreateGroup={async (name, botIds) => {
                const channel = await mutate(() => api.createGroup({ name, botIds }));
                setSelectedId(channel.id);
                setNewGroupDialog(false);
              }}
              onDeleteBotOpenChange={(open) => !open && setDeleteBotTarget(null)}
              onDeleteGroupOpenChange={(open) => !open && setDeleteGroupTarget(null)}
              onNewGroupOpenChange={setNewGroupDialog}
              onTranscriptOpenChange={(open) => !open && setRowTranscript(null)}
              rowTranscript={rowTranscript}
            />
          </Suspense>
        )}
        {loadedSurfaces.current.search && (
          <Suspense fallback={null}>
            <SearchDialog
              actions={searchActions}
              botById={index.botById}
              channelById={index.channelById}
              onOpenChange={setSearchOpen}
              onSelectResult={selectSearchResult}
              open={searchOpen}
            />
          </Suspense>
        )}
        {loadedSurfaces.current.settings && (
          <Suspense fallback={null}>
            <SettingsPanel
              onOpenChange={setSettingsOpen}
              open={settingsOpen}
              target={settingsTarget}
            />
          </Suspense>
        )}
        {loadedSurfaces.current.plugins && (
          <Suspense fallback={null}>
            <PluginDialog onOpenChange={setPluginsOpen} open={pluginsOpen} target={pluginTarget} />
          </Suspense>
        )}
        {loadedSurfaces.current.about && (
          <Suspense fallback={null}>
            <AboutPanel onOpenChange={setAboutOpen} open={aboutOpen} />
          </Suspense>
        )}
        {BOT_TEMPLATE_SHARING_ENABLED && templateImport && (
          <Suspense fallback={null}>
            <BotTemplateImportDialog
              onAdd={async (template) => {
                const bot = await mutate(() =>
                  api.createBot({
                    clientRequestId: crypto.randomUUID(),
                    name: template.name,
                    title: template.title,
                    description: template.description,
                    instructions: template.instructions,
                    icon: template.icon,
                    color: template.color,
                    notificationsEnabled: template.notificationsEnabled,
                  })
                );
                setTemplateImport(null);
                setSelectedId(bot.dmChannelId);
              }}
              onOpenChange={(open) => !open && setTemplateImport(null)}
              open
              template={templateImport}
            />
          </Suspense>
        )}
        {asyncTasksBot && (
          <Suspense fallback={null}>
            <AsyncTasksPanel
              bot={asyncTasksBot}
              onClose={() => setAsyncTasksBotId(null)}
              tasks={asyncTasks}
            />
          </Suspense>
        )}
      </main>
    </TooltipProvider>
  );
}
