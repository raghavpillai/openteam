import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import type { BotView, ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";
import {
  ArrowUp,
  ChevronsUpDown,
  EyeOff,
  PanelLeftClose,
  Plug,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAuthSession } from "../../../hooks/use-auth-session";
import {
  PINNED_GROUP_ID,
  type SidebarPreferencesController,
  type SidebarSection,
  UNASSIGNED_GROUP_ID,
} from "../../../hooks/use-sidebar-preferences";
import { accountPresentation } from "../../../lib/account";
import { cn } from "../../../lib/cn";
import {
  COMPACT_SIDEBAR_WIDTH,
  MIN_EXPANDED_SIDEBAR_WIDTH,
  moveSnappedSidebar,
  type SnappedSidebarResizeState,
} from "../../../lib/panel-resize";
import {
  type SidebarChannelRow as ChannelRowData,
  groupSidebarRows,
  reconcileSidebarRows,
  type SidebarUnreadJumpTarget,
  type SidebarUnreadJumpTargets,
  sidebarUnreadJumpTargets,
} from "../../../lib/sidebar-rows";
import {
  EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
  pinnedGridColumnCount,
  SIDEBAR_CHANNEL_ROW_SIZE,
  SIDEBAR_PINNED_GRID_ROW_SIZE,
  shouldVirtualizeExpandedSidebar,
} from "../../../lib/sidebar-virtual-layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Kbd } from "../../ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { BotGlyphIcon } from "../brand";
import { AccountMenu } from "./account-menu";
import { DraggableChannelRow, VirtualizedChannelRows } from "./channel-row";
import { CompactSidebarContent } from "./compact";
import {
  CollapsingPinnedSpacer,
  DraggablePinnedTile,
  TransitionDropZone,
  VirtualizedPinnedTiles,
} from "./pinned";
import {
  ChannelGroupSurface,
  SectionDisclosure,
  SectionGroup,
  sectionHeaderClass,
  SidebarCollapsibleContent,
  VirtualizedSections,
} from "./sections";
import {
  type BotRowAction,
  type GroupRowAction,
  isPinnableChannel,
  SidebarDragPreview,
  type SidebarVirtualJumpHandler,
  sidebarSensors,
  VIRTUAL_SECTIONS_JUMP_KEY,
} from "./shared";

function UnreadJumpPill({
  target,
  onJump,
}: {
  target: SidebarUnreadJumpTarget;
  onJump: (target: SidebarUnreadJumpTarget) => void;
}) {
  return (
    <button
      aria-label="More unread above"
      className="absolute left-1/2 top-2 z-[12] inline-flex h-7 -translate-x-1/2 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-accent pl-2 pr-3 text-[12px] font-medium text-accent-contrast shadow-pop outline-none transition-transform hover:-translate-y-px hover:translate-x-[-50%] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
      data-more-unreads="above"
      onClick={() => onJump(target)}
      title={`${target.count} unread message${target.count === 1 ? "" : "s"}`}
      type="button"
    >
      <ArrowUp className="size-3.5" strokeWidth={2} />
      More unread
    </button>
  );
}

function sameUnreadJumpTargets(left: SidebarUnreadJumpTargets, right: SidebarUnreadJumpTargets) {
  return (
    left.above?.channelId === right.above?.channelId &&
    left.above?.count === right.above?.count &&
    left.below?.channelId === right.below?.channelId &&
    left.below?.count === right.below?.count
  );
}

const SIDEBAR_WIDTH_KEY = "openteam:sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 400;
const maxSidebarWidth = () =>
  Math.max(
    DEFAULT_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(window.innerWidth * 0.45))
  );
const clampSidebarWidth = (width: number) =>
  Math.min(maxSidebarWidth(), Math.max(COMPACT_SIDEBAR_WIDTH, width));
const normalizeSidebarWidth = (width: number) =>
  width < MIN_EXPANDED_SIDEBAR_WIDTH ? COMPACT_SIDEBAR_WIDTH : clampSidebarWidth(width);
const readSidebarWidth = () => {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return normalizeSidebarWidth(
    Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH
  );
};

export const Sidebar = memo(function Sidebar({
  channels,
  botById,
  hiddenAgentCount,
  latestMessageByChannel,
  activeRunByChannel,
  activeTaskChannelIds,
  selectedId,
  creating,
  onPreloadSearch,
  onSearch,
  onSelect,
  onNewBot,
  onNewGroup,
  onOpenAbout,
  onOpenHiddenAgents,
  onOpenPlugins,
  onOpenSettings,
  onBotAction,
  onDeleteChannel,
  onEditChannel,
  onHideChannel,
  forcedCompact = false,
  onLayoutChange,
  pendingBot,
  preferences,
}: {
  channels: ChannelView[];
  botById: ReadonlyMap<string, BotView>;
  hiddenAgentCount: number;
  latestMessageByChannel: ReadonlyMap<string, ChannelMessageView>;
  activeRunByChannel: ReadonlyMap<string, RunView>;
  activeTaskChannelIds: ReadonlySet<string>;
  selectedId: string | null;
  creating?: boolean;
  onPreloadSearch: () => void;
  onSearch: () => void;
  onSelect: (id: string) => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  onOpenAbout: () => void;
  onOpenHiddenAgents: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  onDeleteChannel: (channel: ChannelView) => void;
  onEditChannel: (channelId: string) => void;
  onHideChannel: (channel: ChannelView) => void;
  forcedCompact?: boolean;
  onLayoutChange?: (layout: { compact: boolean; width: number }) => void;
  pendingBot?: { name: string } | null;
  preferences: SidebarPreferencesController;
}) {
  const auth = useAuthSession();
  const account = accountPresentation(auth.user, auth.mode);
  const keepFocusInNewBotPicker = useRef(false);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SidebarSection | null>(null);
  const deleteTargetRef = useRef<SidebarSection | null>(null);
  const [pinTargetVisible, setPinTargetVisible] = useState(false);
  const [activeDropGroup, setActiveDropGroup] = useState<string | null>(null);
  const [dragSourceGroup, setDragSourceGroup] = useState<string | null>(null);
  const [dragSourceChannelId, setDragSourceChannelId] = useState<string | null>(null);
  const [dragSourceSectionId, setDragSourceSectionId] = useState<string | null>(null);
  const [overSectionId, setOverSectionId] = useState<string | null>(null);
  const [pinArrival, setPinArrival] = useState<{ channelId: string; first: boolean } | null>(null);
  const [lastUnpinPhase, setLastUnpinPhase] = useState<"holding" | "collapsing" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarSnapping, setSidebarSnapping] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarScrollRef = useRef<HTMLElement | null>(null);
  const unreadMeasureFrameRef = useRef<number | null>(null);
  const virtualJumpHandlersRef = useRef(new Map<string, SidebarVirtualJumpHandler>());
  const [unreadJumps, setUnreadJumps] = useState<SidebarUnreadJumpTargets>({
    above: null,
    below: null,
  });
  const [sidebarTopFade, setSidebarTopFade] = useState(false);
  const sidebarResizerRef = useRef<HTMLDivElement | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const lastExpandedWidthRef = useRef(
    sidebarWidth >= MIN_EXPANDED_SIDEBAR_WIDTH ? sidebarWidth : DEFAULT_SIDEBAR_WIDTH
  );
  const sidebarSnapTimerRef = useRef<number | null>(null);
  const pinArrivalTimerRef = useRef<number | null>(null);
  const lastUnpinFrameRef = useRef<number | null>(null);
  const lastUnpinTimerRef = useRef<number | null>(null);
  const rowCacheRef = useRef<Map<string, ChannelRowData>>(new Map());
  const resizeSessionRef = useRef<
    | (SnappedSidebarResizeState & {
        pointerId: number;
        cursor: string;
        userSelect: string;
      })
    | null
  >(null);
  const dndDisabled = false;
  if (deleteTarget) deleteTargetRef.current = deleteTarget;
  const deleteDialogTarget = deleteTarget ?? deleteTargetRef.current;
  const { rows, rowByChannelId, channelById } = useMemo(() => {
    const reconciled = reconcileSidebarRows(
      rowCacheRef.current,
      channels,
      latestMessageByChannel,
      activeRunByChannel,
      activeTaskChannelIds
    );
    rowCacheRef.current = reconciled.rowByChannelId;
    return reconciled;
  }, [activeRunByChannel, activeTaskChannelIds, channels, latestMessageByChannel]);

  const groups = useMemo(
    () =>
      groupSidebarRows(
        rows,
        preferences.pinnedIds,
        preferences.sections,
        preferences.sectionByChannel
      ),
    [preferences.pinnedIds, preferences.sectionByChannel, preferences.sections, rows]
  );
  const pinnedIdsRef = useRef(preferences.pinnedIds);
  const pinnedCountRef = useRef(groups.pinned.length);
  pinnedIdsRef.current = preferences.pinnedIds;
  pinnedCountRef.current = groups.pinned.length;
  const compactGroups = useMemo(() => {
    const seen = new Set<string>();
    return [
      { id: PINNED_GROUP_ID, rows: groups.pinned },
      ...preferences.sections.map((section) => ({
        id: section.id,
        rows: groups.bySection[section.id] ?? [],
      })),
      { id: UNASSIGNED_GROUP_ID, rows: groups.unassigned },
    ]
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          if (seen.has(row.channel.id)) return false;
          seen.add(row.channel.id);
          return true;
        }),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, preferences.sections]);
  const storedCompact = sidebarWidth === COMPACT_SIDEBAR_WIDTH;
  const compact = forcedCompact || storedCompact;
  useEffect(() => {
    onLayoutChange?.({ compact: storedCompact, width: sidebarWidth });
  }, [onLayoutChange, sidebarWidth, storedCompact]);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const resizer = sidebarResizerRef.current;
    if (!sidebar || !resizer) return;
    const syncAccessibleWidth = () => {
      const visibleWidth = Math.round(sidebar.getBoundingClientRect().width);
      resizer.setAttribute("aria-valuenow", String(visibleWidth));
      resizer.setAttribute(
        "aria-valuetext",
        visibleWidth === COMPACT_SIDEBAR_WIDTH ? "Compact" : `${visibleWidth} pixels`
      );
    };
    const observer = new ResizeObserver(syncAccessibleWidth);
    observer.observe(sidebar);
    syncAccessibleWidth();
    return () => observer.disconnect();
  }, []);
  const allSidebarAgentsHidden =
    rows.length === 0 && hiddenAgentCount > 0 && !creating && !pendingBot;
  const nothingYet = rows.length === 0 && hiddenAgentCount === 0 && !creating && !pendingBot;
  const virtualizeExpanded = shouldVirtualizeExpandedSidebar(
    rows.length,
    preferences.sections.length
  );
  const channelGroupById = useMemo(() => {
    const groupsByChannel = new Map<string, string>();
    for (const row of groups.pinned) groupsByChannel.set(row.channel.id, PINNED_GROUP_ID);
    for (const section of preferences.sections) {
      for (const row of groups.bySection[section.id] ?? []) {
        groupsByChannel.set(row.channel.id, section.id);
      }
    }
    for (const row of groups.unassigned) {
      groupsByChannel.set(row.channel.id, UNASSIGNED_GROUP_ID);
    }
    return groupsByChannel;
  }, [groups, preferences.sections]);
  // A layout model of the expanded list, in pixels, used to decide whether an
  // unread row sits above the viewport. Every constant mirrors the JSX below:
  // pinned tiles 106px on a 118px grid row, section headers 30px, rows 54px on
  // a 58px pitch, empty sections 28px, a 4px pad under open headers, 10px
  // between sections, and a 30px "Other" header when sections exist.
  const unreadMetrics = useMemo(() => {
    const metrics: Array<{
      channelId: string;
      unread: boolean;
      unreadCount?: number;
      top: number;
      bottom: number;
    }> = [];
    const appendRow = (row: ChannelRowData, top: number, height: number) => {
      metrics.push({
        channelId: row.channel.id,
        unread: preferences.unreadIds.has(row.channel.id),
        unreadCount: row.channel.unreadCount,
        top,
        bottom: top + height,
      });
    };
    let top = 0;
    if (groups.pinned.length > 0) {
      const columns = Math.max(1, pinnedGridColumnCount(sidebarWidth));
      const pinnedTop = top + 14;
      groups.pinned.forEach((row, index) => {
        appendRow(row, pinnedTop + Math.floor(index / columns) * SIDEBAR_PINNED_GRID_ROW_SIZE, 106);
      });
      top += 20 + Math.ceil(groups.pinned.length / columns) * SIDEBAR_PINNED_GRID_ROW_SIZE;
    }
    if (creating) top += 53;
    if (pendingBot) top += 54;
    for (const section of preferences.sections) {
      top += 30;
      if (!section.collapsed) {
        top += 4;
        for (const row of groups.bySection[section.id] ?? []) {
          appendRow(row, top, 54);
          top += SIDEBAR_CHANNEL_ROW_SIZE;
        }
        if ((groups.bySection[section.id]?.length ?? 0) === 0) top += 28;
      }
      top += 10;
    }
    if (preferences.sections.length > 0) top += 30;
    if (!preferences.unassignedCollapsed || preferences.sections.length === 0) {
      top += preferences.sections.length > 0 ? 4 : 0;
      for (const row of groups.unassigned) {
        appendRow(row, top, 54);
        top += SIDEBAR_CHANNEL_ROW_SIZE;
      }
    }
    return metrics;
  }, [
    creating,
    groups,
    pendingBot,
    preferences.sections,
    preferences.unassignedCollapsed,
    preferences.unreadIds,
    sidebarWidth,
  ]);
  const registerVirtualJumpHandler = useCallback(
    (key: string, handler: SidebarVirtualJumpHandler | null) => {
      if (handler) virtualJumpHandlersRef.current.set(key, handler);
      else virtualJumpHandlersRef.current.delete(key);
    },
    []
  );
  const measureUnreadJumps = useCallback(() => {
    const viewport = sidebarScrollRef.current;
    if (compact || !viewport) {
      setSidebarTopFade(false);
      setUnreadJumps((current) => {
        const next = { above: null, below: null };
        return sameUnreadJumpTargets(current, next) ? current : next;
      });
      return;
    }
    setSidebarTopFade(viewport.scrollTop > 5);
    const metrics = unreadMetrics;
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + viewport.clientHeight;
    const next = sidebarUnreadJumpTargets(metrics, viewportTop, viewportBottom);
    setUnreadJumps((current) => (sameUnreadJumpTargets(current, next) ? current : next));
  }, [compact, unreadMetrics]);
  const scheduleUnreadJumpMeasure = useCallback(() => {
    if (unreadMeasureFrameRef.current !== null) return;
    unreadMeasureFrameRef.current = window.requestAnimationFrame(() => {
      unreadMeasureFrameRef.current = null;
      measureUnreadJumps();
    });
  }, [measureUnreadJumps]);
  const jumpToUnread = useCallback(
    (target: SidebarUnreadJumpTarget) => {
      const viewport = sidebarScrollRef.current;
      if (!viewport) return;
      const group = channelGroupById.get(target.channelId);
      if (group && virtualJumpHandlersRef.current.get(group)?.(target.channelId)) return;

      const metric = unreadMetrics.find((candidate) => candidate.channelId === target.channelId);
      const jumpToEstimatedPosition = () => {
        if (!metric) return;
        const top =
          metric.top < viewport.scrollTop
            ? metric.top
            : Math.max(0, metric.bottom - viewport.clientHeight);
        viewport.scrollTo({ top });
      };

      if (group && group !== PINNED_GROUP_ID && group !== UNASSIGNED_GROUP_ID) {
        const sectionJump = virtualJumpHandlersRef.current.get(VIRTUAL_SECTIONS_JUMP_KEY);
        if (sectionJump?.(group)) {
          let attempts = 0;
          const finishVirtualJump = () => {
            if (virtualJumpHandlersRef.current.get(group)?.(target.channelId)) return;
            attempts += 1;
            if (attempts < 3) window.requestAnimationFrame(finishVirtualJump);
            else jumpToEstimatedPosition();
          };
          window.requestAnimationFrame(finishVirtualJump);
          return;
        }
      }
      jumpToEstimatedPosition();
    },
    [channelGroupById, unreadMetrics]
  );
  const activeSectionDragIndex = dragSourceSectionId
    ? preferences.sections.findIndex((section) => section.id === dragSourceSectionId)
    : -1;
  const overSectionIndex = overSectionId
    ? preferences.sections.findIndex((section) => section.id === overSectionId)
    : -1;
  const sectionDropEdge =
    activeSectionDragIndex >= 0 &&
    overSectionIndex >= 0 &&
    activeSectionDragIndex !== overSectionIndex
      ? activeSectionDragIndex < overSectionIndex
        ? "after"
        : "before"
      : null;
  const beginRename = (section: SidebarSection) => {
    setSectionDraft(section.name);
    setEditingSectionId(section.id);
  };
  const finishRename = (save: boolean) => {
    if (save && editingSectionId) preferences.renameSection(editingSectionId, sectionDraft);
    setEditingSectionId(null);
  };
  const createSection = useCallback(
    (channelId: string) => {
      const sectionId = preferences.createSection(channelId);
      setSectionDraft("New section");
      setEditingSectionId(sectionId);
    },
    [preferences.createSection]
  );
  const startPinArrival = useCallback((channelId: string, first: boolean) => {
    if (pinArrivalTimerRef.current !== null) window.clearTimeout(pinArrivalTimerRef.current);
    setPinArrival({ channelId, first });
    pinArrivalTimerRef.current = window.setTimeout(
      () => {
        pinArrivalTimerRef.current = null;
        setPinArrival(null);
      },
      first ? 480 : 300
    );
  }, []);
  const startLastUnpinCollapse = useCallback(() => {
    if (lastUnpinFrameRef.current !== null) window.cancelAnimationFrame(lastUnpinFrameRef.current);
    if (lastUnpinTimerRef.current !== null) window.clearTimeout(lastUnpinTimerRef.current);
    flushSync(() => setLastUnpinPhase("holding"));
    lastUnpinFrameRef.current = window.requestAnimationFrame(() => {
      lastUnpinFrameRef.current = window.requestAnimationFrame(() => {
        lastUnpinFrameRef.current = null;
        setLastUnpinPhase("collapsing");
      });
    });
    lastUnpinTimerRef.current = window.setTimeout(() => {
      lastUnpinTimerRef.current = null;
      setLastUnpinPhase(null);
    }, 270);
  }, []);
  const applySidebarWidth = useCallback((width: number) => {
    const next = clampSidebarWidth(width);
    if (resizeSessionRef.current) resizeSessionRef.current.width = next;
    sidebarWidthRef.current = next;
    if (next >= MIN_EXPANDED_SIDEBAR_WIDTH) lastExpandedWidthRef.current = next;
    if (sidebarRef.current) sidebarRef.current.style.width = `${next}px`;
    if (sidebarResizerRef.current) {
      sidebarResizerRef.current.setAttribute("aria-valuenow", String(next));
      sidebarResizerRef.current.setAttribute(
        "aria-valuetext",
        next === COMPACT_SIDEBAR_WIDTH ? "Compact" : `${Math.round(next)} pixels`
      );
    }
    return next;
  }, []);
  const updateSidebarWidth = useCallback(
    (width: number) => {
      const next = applySidebarWidth(width);
      setSidebarWidth(next);
    },
    [applySidebarWidth]
  );
  const animateSidebarWidth = useCallback(
    (width: number) => {
      updateSidebarWidth(width);
      setSidebarSnapping(true);
      if (sidebarSnapTimerRef.current !== null) window.clearTimeout(sidebarSnapTimerRef.current);
      sidebarSnapTimerRef.current = window.setTimeout(() => {
        sidebarSnapTimerRef.current = null;
        setSidebarSnapping(false);
      }, 150);
    },
    [updateSidebarWidth]
  );
  const toggleCompactSidebar = useCallback(() => {
    const current = sidebarWidthRef.current;
    const next =
      current === COMPACT_SIDEBAR_WIDTH ? lastExpandedWidthRef.current : COMPACT_SIDEBAR_WIDTH;
    if (current >= MIN_EXPANDED_SIDEBAR_WIDTH) lastExpandedWidthRef.current = current;
    animateSidebarWidth(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }, [animateSidebarWidth]);
  const finishSidebarResize = useCallback(
    (element: HTMLDivElement) => {
      const session = resizeSessionRef.current;
      if (!session) return;
      if (element.hasPointerCapture(session.pointerId)) {
        element.releasePointerCapture(session.pointerId);
      }
      const next = applySidebarWidth(session.width);
      setSidebarWidth(next);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      document.body.style.cursor = session.cursor;
      document.body.style.userSelect = session.userSelect;
      resizeSessionRef.current = null;
      setSidebarResizing(false);
    },
    [applySidebarWidth]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleCompactSidebar();
    };
    const handleResize = () => {
      updateSidebarWidth(normalizeSidebarWidth(sidebarWidthRef.current));
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
      if (sidebarSnapTimerRef.current !== null) window.clearTimeout(sidebarSnapTimerRef.current);
      if (pinArrivalTimerRef.current !== null) window.clearTimeout(pinArrivalTimerRef.current);
      if (lastUnpinFrameRef.current !== null) {
        window.cancelAnimationFrame(lastUnpinFrameRef.current);
      }
      if (lastUnpinTimerRef.current !== null) window.clearTimeout(lastUnpinTimerRef.current);
    };
  }, [toggleCompactSidebar, updateSidebarWidth]);

  useEffect(() => {
    scheduleUnreadJumpMeasure();
    const viewport = sidebarScrollRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(scheduleUnreadJumpMeasure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scheduleUnreadJumpMeasure]);

  useEffect(
    () => () => {
      if (unreadMeasureFrameRef.current !== null) {
        window.cancelAnimationFrame(unreadMeasureFrameRef.current);
        unreadMeasureFrameRef.current = null;
      }
    },
    []
  );

  const handleSidebarBotAction = useCallback(
    (bot: BotView, action: BotRowAction) => {
      if (action === "togglePin") {
        const channelId = bot.dmChannelId;
        const pinned = pinnedIdsRef.current.has(channelId);
        if (pinned && pinnedCountRef.current === 1) startLastUnpinCollapse();
        else if (!pinned) startPinArrival(channelId, pinnedCountRef.current === 0);
      }
      onBotAction(bot, action);
    },
    [onBotAction, startLastUnpinCollapse, startPinArrival]
  );

  const handleSidebarGroupAction = useCallback(
    (channel: ChannelView, action: GroupRowAction) => {
      if (action === "togglePin") {
        const pinned = pinnedIdsRef.current.has(channel.id);
        if (pinned && pinnedCountRef.current === 1) startLastUnpinCollapse();
        else if (!pinned) startPinArrival(channel.id, pinnedCountRef.current === 0);
        preferences.togglePinned(channel.id);
        return;
      }
      if (action === "toggleUnread") {
        preferences.toggleUnread(channel.id);
        return;
      }
      if (action === "editProfile") {
        onEditChannel(channel.id);
        return;
      }
      if (action === "hide") {
        onHideChannel(channel);
        return;
      }
      if (action === "delete") {
        onDeleteChannel(channel);
        return;
      }
      void navigator.clipboard.writeText(channel.id);
    },
    [
      onDeleteChannel,
      onEditChannel,
      onHideChannel,
      preferences.togglePinned,
      preferences.toggleUnread,
      startLastUnpinCollapse,
      startPinArrival,
    ]
  );

  const renderRow = useCallback(
    (row: ChannelRowData, _index: number, group: string) => (
      <DraggableChannelRow
        botById={botById}
        currentSectionId={preferences.sectionByChannel[row.channel.id] ?? null}
        disabled={dndDisabled}
        group={group}
        key={row.channel.id}
        onBotAction={handleSidebarBotAction}
        onGroupAction={handleSidebarGroupAction}
        onCreateSection={createSection}
        onMoveToSection={preferences.moveToSection}
        onSelect={onSelect}
        pinned={preferences.pinnedIds.has(row.channel.id)}
        row={row}
        sections={preferences.sections}
        selected={row.channel.id === selectedId}
        unread={preferences.unreadIds.has(row.channel.id)}
      />
    ),
    [
      botById,
      createSection,
      handleSidebarBotAction,
      handleSidebarGroupAction,
      onSelect,
      preferences.moveToSection,
      preferences.pinnedIds,
      preferences.sectionByChannel,
      preferences.sections,
      preferences.unreadIds,
      selectedId,
    ]
  );
  const activeVirtualSectionId =
    editingSectionId ??
    dragSourceSectionId ??
    (dragSourceGroup &&
    dragSourceGroup !== PINNED_GROUP_ID &&
    dragSourceGroup !== UNASSIGNED_GROUP_ID
      ? dragSourceGroup
      : null);
  const renderSection = (section: SidebarSection, index: number) => {
    const sectionRows = groups.bySection[section.id] ?? [];
    return (
      <SectionGroup
        activeChannelId={dragSourceChannelId}
        dndDisabled={dndDisabled || dragSourceGroup === section.id}
        dropHighlighted={activeDropGroup === section.id}
        dropEdge={overSectionIndex === index ? sectionDropEdge : null}
        draft={sectionDraft}
        editing={editingSectionId === section.id}
        key={section.id}
        onDelete={() => setDeleteTarget(section)}
        onDraftChange={setSectionDraft}
        onFinishEditing={finishRename}
        onMove={(direction) => preferences.moveSection(section.id, direction)}
        onRegisterJumpHandler={registerVirtualJumpHandler}
        onRename={() => beginRename(section)}
        onToggle={() => preferences.toggleSection(section.id)}
        renderRow={renderRow}
        rows={sectionRows}
        scrollRef={sidebarScrollRef}
        section={section}
        sectionCount={preferences.sections.length}
        sectionIndex={index}
        virtualizeRows={
          virtualizeExpanded && sectionRows.length > EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS
        }
      />
    );
  };

  return (
    <aside
      className={cn(
        "relative flex min-w-0 shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar",
        (!sidebarResizing || sidebarSnapping) && "transition-[width] duration-150 ease-out",
        forcedCompact && "!w-[88px]"
      )}
      data-sidebar=""
      data-sidebar-compact={compact ? "true" : "false"}
      data-sidebar-forced-compact={forcedCompact ? "true" : "false"}
      data-sidebar-snapping={sidebarSnapping ? "true" : "false"}
      data-sidebar-virtualized={virtualizeExpanded ? "true" : "false"}
      ref={sidebarRef}
      style={{ width: sidebarWidth }}
    >
      {compact ? (
        <CompactSidebarContent
          botById={botById}
          groups={compactGroups}
          hiddenAgentCount={hiddenAgentCount}
          onNewBot={onNewBot}
          onNewGroup={onNewGroup}
          onOpenAbout={onOpenAbout}
          onOpenHiddenAgents={onOpenHiddenAgents}
          onOpenSettings={onOpenSettings}
          onSelect={onSelect}
          onToggleCompact={toggleCompactSidebar}
          selectedId={selectedId}
          unreadIds={preferences.unreadIds}
        />
      ) : (
        <>
          <div className="electron-drag flex h-[47px] shrink-0 items-center justify-end gap-0.5 px-3 pt-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Toggle compact sidebar"
                  className="electron-no-drag"
                  onClick={toggleCompactSidebar}
                  size="icon-sm"
                  variant="subtle"
                >
                  <PanelLeftClose className="size-4" strokeWidth={1.8} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Collapse sidebar{" "}
                <Kbd className="ml-1 border-surface/30 bg-surface/15 text-surface">⌘B</Kbd>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <DropdownMenu>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label="New bot or group"
                      className="electron-no-drag data-[state=open]:bg-hover data-[state=open]:text-ink"
                      size="icon-sm"
                      variant="subtle"
                    >
                      <Plus className="size-[18px]" strokeWidth={1.8} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-[196px]"
                  onCloseAutoFocus={(event) => {
                    if (!keepFocusInNewBotPicker.current) return;
                    event.preventDefault();
                    keepFocusInNewBotPicker.current = false;
                  }}
                  sideOffset={4}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      keepFocusInNewBotPicker.current = true;
                      onNewBot();
                    }}
                  >
                    <BotGlyphIcon className="size-4 text-ink-3" /> New bot
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onNewGroup}>
                    <Users /> New group
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <TooltipContent side="bottom">New bot or group</TooltipContent>
            </Tooltip>
          </div>
          <div className="px-3 pb-2">
            <button
              aria-label="Search"
              className="group flex h-8 w-full items-center gap-2 rounded-md border border-line bg-raised/70 px-2.5 text-left text-[13px] text-ink-3 outline-none transition-colors hover:border-line-strong hover:text-ink-2 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
              onClick={onSearch}
              onFocus={onPreloadSearch}
              onPointerEnter={onPreloadSearch}
              type="button"
            >
              <Search className="size-3.5 shrink-0" strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate">Search bots and messages</span>
              <Kbd className="text-ink-3 group-hover:text-ink-2">⌘K</Kbd>
            </button>
          </div>
          <DragDropProvider
            sensors={sidebarSensors}
            onDragStart={(event) => {
              setActiveDropGroup(null);
              setOverSectionId(null);
              const sourceData = event.operation.source?.data as
                | { kind?: string; channelId?: string; group?: string; sectionId?: string }
                | undefined;
              const sourceChannel = sourceData?.channelId
                ? channelById.get(sourceData.channelId)
                : undefined;
              setDragSourceGroup(
                sourceData?.kind === "channel" ? (sourceData.group ?? null) : null
              );
              setDragSourceChannelId(
                sourceData?.kind === "channel" ? (sourceData.channelId ?? null) : null
              );
              setDragSourceSectionId(
                sourceData?.kind === "section"
                  ? (sourceData.sectionId ?? null)
                  : sourceData?.kind === "channel" &&
                      sourceData.group !== PINNED_GROUP_ID &&
                      sourceData.group !== UNASSIGNED_GROUP_ID
                    ? (sourceData.group ?? null)
                    : null
              );
              setPinTargetVisible(
                sourceData?.kind === "channel" &&
                  sourceData.group !== PINNED_GROUP_ID &&
                  isPinnableChannel(sourceChannel)
              );
            }}
            onDragOver={(event) => {
              event.preventDefault();
              const targetData = event.operation.target?.data as
                | { kind?: string; group?: string; sectionId?: string }
                | undefined;
              const sourceData = event.operation.source?.data as { group?: string } | undefined;
              const group =
                targetData?.kind === "channel-drop" && targetData.group !== sourceData?.group
                  ? (targetData.group ?? null)
                  : null;
              setActiveDropGroup((current) => (current === group ? current : group));
              const nextOverSectionId =
                targetData?.kind === "section" ? (targetData.sectionId ?? null) : null;
              setOverSectionId((current) =>
                current === nextOverSectionId ? current : nextOverSectionId
              );
            }}
            onDragEnd={(event) => {
              setPinTargetVisible(false);
              setActiveDropGroup(null);
              setDragSourceGroup(null);
              setDragSourceChannelId(null);
              setDragSourceSectionId(null);
              setOverSectionId(null);
              if (event.canceled) return;
              const { source, target } = event.operation;
              if (!source || !target) return;
              const sourceData = source.data as {
                kind?: string;
                channelId?: string;
                group?: string;
                index?: number;
              };
              const targetData = target.data as { kind?: string; group?: string; index?: number };
              if (
                sourceData.kind === "section" &&
                targetData.kind === "section" &&
                isSortable(source) &&
                typeof sourceData.index === "number" &&
                typeof targetData.index === "number"
              ) {
                preferences.reorderSection(sourceData.index, targetData.index);
                return;
              }
              if (
                sourceData.kind !== "channel" ||
                !sourceData.channelId ||
                !sourceData.group ||
                targetData.kind !== "channel-drop" ||
                !targetData.group ||
                targetData.group === sourceData.group
              ) {
                return;
              }
              const sourceChannel = channelById.get(sourceData.channelId);
              if (targetData.group === PINNED_GROUP_ID && !isPinnableChannel(sourceChannel)) {
                return;
              }
              if (targetData.group === PINNED_GROUP_ID) {
                startPinArrival(sourceData.channelId, groups.pinned.length === 0);
              }
              if (
                sourceData.group === PINNED_GROUP_ID &&
                targetData.group !== PINNED_GROUP_ID &&
                groups.pinned.length === 1
              ) {
                startLastUnpinCollapse();
              }
              preferences.moveChannel({ channelId: sourceData.channelId, group: targetData.group });
            }}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="relative flex min-h-0 flex-1">
                  <nav
                    aria-label="Bots and groups"
                    className="ob-scrollbar scrollbar-none flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-3"
                    onScroll={scheduleUnreadJumpMeasure}
                    ref={sidebarScrollRef}
                    style={
                      sidebarTopFade
                        ? {
                            WebkitMaskImage:
                              "linear-gradient(to bottom, transparent 0px, black 24px, black 100%)",
                            maskImage:
                              "linear-gradient(to bottom, transparent 0px, black 24px, black 100%)",
                          }
                        : undefined
                    }
                  >
                    {!creating && (
                      <div className="grid">
                        <TransitionDropZone
                          group={PINNED_GROUP_ID}
                          label="Drop here to pin"
                          settling={pinArrival?.first === true}
                          visible={
                            (pinTargetVisible && groups.pinned.length === 0) ||
                            pinArrival?.first === true
                          }
                        />
                        <CollapsingPinnedSpacer phase={lastUnpinPhase} />
                        {groups.pinned.length > 0 && (
                          <ChannelGroupSurface
                            active={activeDropGroup === PINNED_GROUP_ID}
                            className="col-start-1 row-start-1 pb-3 pt-2"
                            disabled={dndDisabled || dragSourceGroup === PINNED_GROUP_ID}
                            group={PINNED_GROUP_ID}
                          >
                            {groups.pinned.length > EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS ? (
                              <VirtualizedPinnedTiles
                                activeChannelId={dragSourceChannelId}
                                arrival={pinArrival}
                                botById={botById}
                                onBotAction={handleSidebarBotAction}
                                onGroupAction={handleSidebarGroupAction}
                                onCreateSection={createSection}
                                onMoveToSection={preferences.moveToSection}
                                onRegisterJumpHandler={registerVirtualJumpHandler}
                                onSelect={onSelect}
                                rows={groups.pinned}
                                scrollRef={sidebarScrollRef}
                                sections={preferences.sections}
                                selectedId={selectedId}
                                sidebarWidth={sidebarWidth}
                                unreadIds={preferences.unreadIds}
                              />
                            ) : (
                              <div
                                className="grid w-full justify-center gap-x-2 gap-y-3 rounded-lg p-[6px]"
                                data-pinned-grid=""
                                style={{
                                  gridTemplateColumns:
                                    "repeat(auto-fit, minmax(80px, max-content))",
                                }}
                              >
                                {groups.pinned.map((row) => (
                                  <DraggablePinnedTile
                                    arrival={
                                      pinArrival?.channelId === row.channel.id
                                        ? pinArrival.first
                                          ? "first"
                                          : "later"
                                        : null
                                    }
                                    botById={botById}
                                    key={row.channel.id}
                                    onBotAction={handleSidebarBotAction}
                                    onGroupAction={handleSidebarGroupAction}
                                    onCreateSection={createSection}
                                    onMoveToSection={preferences.moveToSection}
                                    onSelect={onSelect}
                                    row={row}
                                    sections={preferences.sections}
                                    selected={row.channel.id === selectedId}
                                    unread={preferences.unreadIds.has(row.channel.id)}
                                  />
                                ))}
                              </div>
                            )}
                          </ChannelGroupSurface>
                        )}
                      </div>
                    )}
                    {creating && (
                      <div className="flex h-[53px] w-full items-center gap-2.5 rounded-lg bg-raised px-2.5 text-[13.5px] font-medium shadow-card">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-ink-3">
                          <Plus className="size-4" />
                        </span>
                        New bot
                      </div>
                    )}
                    {pendingBot && (
                      <div
                        aria-current="page"
                        className="flex h-[54px] w-full items-center gap-2.5 rounded-lg bg-raised px-2.5 text-left shadow-card"
                        data-pending-bot-row=""
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink/6 text-ink-3">
                          <BotGlyphIcon className="size-5 animate-pulse" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">
                            {pendingBot.name}
                          </span>
                          <span className="mt-px block text-[12.5px] leading-4 text-accent">
                            Setting up…
                          </span>
                        </span>
                      </div>
                    )}
                    {allSidebarAgentsHidden ? (
                      <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                        <span className="text-[13px] text-ink-2">Every bot is hidden.</span>
                        <Button onClick={onOpenHiddenAgents} size="sm" variant="secondary">
                          Show hidden bots
                        </Button>
                      </div>
                    ) : nothingYet ? (
                      <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                        <BotGlyphIcon className="size-8 text-ink-3/60" />
                        <span className="text-[13px] leading-5 text-ink-2">
                          No bots yet. Create one to get started.
                        </span>
                        <Button onClick={onNewBot} size="sm" variant="secondary">
                          <Plus /> New bot
                        </Button>
                      </div>
                    ) : (
                      <>
                        {virtualizeExpanded && preferences.sections.length > 0 ? (
                          <VirtualizedSections
                            activeSectionId={activeVirtualSectionId}
                            renderSection={renderSection}
                            onRegisterJumpHandler={registerVirtualJumpHandler}
                            rowsBySection={groups.bySection}
                            scrollRef={sidebarScrollRef}
                            sections={preferences.sections}
                          />
                        ) : (
                          <div
                            className={cn(
                              "flex min-h-0 flex-col",
                              preferences.sections.length > 0 && "gap-[10px]"
                            )}
                          >
                            {preferences.sections.map(renderSection)}
                          </div>
                        )}
                        <ChannelGroupSurface
                          active={activeDropGroup === UNASSIGNED_GROUP_ID}
                          className={cn(
                            "flex min-h-[36px] flex-1 flex-col",
                            preferences.sections.length > 0 && "pt-[10px]"
                          )}
                          disabled={dndDisabled || dragSourceGroup === UNASSIGNED_GROUP_ID}
                          group={UNASSIGNED_GROUP_ID}
                        >
                          <Collapsible.Root
                            onOpenChange={(open) => {
                              if (preferences.sections.length === 0) return;
                              if (open === preferences.unassignedCollapsed) {
                                preferences.toggleUnassigned();
                              }
                            }}
                            open={
                              preferences.sections.length === 0 || !preferences.unassignedCollapsed
                            }
                          >
                            {preferences.sections.length > 0 && (
                              <Collapsible.Trigger asChild>
                                <button className={sectionHeaderClass} type="button">
                                  <span className="microlabel min-w-0 flex-1 truncate text-left">
                                    Other
                                  </span>
                                  <SectionDisclosure
                                    collapsed={preferences.unassignedCollapsed}
                                    count={groups.unassigned.length}
                                  />
                                </button>
                              </Collapsible.Trigger>
                            )}
                            <SidebarCollapsibleContent
                              className={preferences.sections.length > 0 ? "pt-1" : undefined}
                            >
                              {groups.unassigned.length > EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS ? (
                                <VirtualizedChannelRows
                                  activeChannelId={dragSourceChannelId}
                                  group={UNASSIGNED_GROUP_ID}
                                  onRegisterJumpHandler={registerVirtualJumpHandler}
                                  renderRow={renderRow}
                                  rows={groups.unassigned}
                                  scrollRef={sidebarScrollRef}
                                />
                              ) : (
                                <div className="flex flex-col gap-1">
                                  {groups.unassigned.map((row, index) =>
                                    renderRow(row, index, UNASSIGNED_GROUP_ID)
                                  )}
                                </div>
                              )}
                            </SidebarCollapsibleContent>
                          </Collapsible.Root>
                        </ChannelGroupSurface>
                        {hiddenAgentCount > 0 ? (
                          <button
                            aria-haspopup="dialog"
                            className="mb-1 mt-2 flex h-9 w-full shrink-0 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                            onClick={onOpenHiddenAgents}
                            type="button"
                          >
                            <EyeOff className="size-3.5" strokeWidth={1.8} />
                            <span className="min-w-0 flex-1 truncate text-left">Hidden bots</span>
                            <span className="font-mono text-[11px] text-ink-3">
                              {hiddenAgentCount}
                            </span>
                          </button>
                        ) : null}
                      </>
                    )}
                  </nav>
                  {unreadJumps.above ? (
                    <UnreadJumpPill onJump={jumpToUnread} target={unreadJumps.above} />
                  ) : null}
                </div>
              </ContextMenuTrigger>
              {hiddenAgentCount > 0 ? (
                <ContextMenuContent aria-label="Sidebar actions" className="w-[176px]">
                  <ContextMenuItem onSelect={onOpenHiddenAgents}>
                    <EyeOff /> Hidden bots ({hiddenAgentCount})
                  </ContextMenuItem>
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
            <DragOverlay
              className="pointer-events-none z-[100] flex justify-center overflow-visible"
              dropAnimation={{ duration: 300, easing: "cubic-bezier(0.25, 1.15, 0.4, 1)" }}
            >
              {(source) => {
                const sourceData = source.data as {
                  kind?: string;
                  channelId?: string;
                  sectionId?: string;
                };
                if (sourceData.kind === "section" && sourceData.sectionId) {
                  const section = preferences.sections.find(
                    (candidate) => candidate.id === sourceData.sectionId
                  );
                  return section ? (
                    <div className="microlabel flex h-[30px] max-w-[220px] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-line bg-raised px-2.5 text-ink shadow-pop">
                      {section.name}
                    </div>
                  ) : null;
                }
                if (sourceData.kind !== "channel" || !sourceData.channelId) return null;
                const row = rowByChannelId.get(sourceData.channelId);
                return row ? <SidebarDragPreview botById={botById} row={row} /> : null;
              }}
            </DragOverlay>
          </DragDropProvider>
          <div className="flex flex-col gap-0.5 border-t border-line px-2 pb-2 pt-2">
            <button
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink-2 outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              onClick={onOpenPlugins}
              type="button"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-raised text-ink-2">
                <Plug className="size-3.5" strokeWidth={1.8} />
              </span>
              Plugins
            </button>
            <AccountMenu onOpenAbout={onOpenAbout} onOpenSettings={onOpenSettings}>
              <button
                className="group/footer-account flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-hover"
                type="button"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-raised font-mono text-[10px] font-medium text-ink-2">
                  {account.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-4">{account.name}</span>
                  <span className="block truncate text-[11.5px] leading-4 text-ink-3">
                    {account.detail}
                  </span>
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" strokeWidth={2} />
              </button>
            </AccountMenu>
          </div>
        </>
      )}

      <div
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemax={maxSidebarWidth()}
        aria-valuemin={COMPACT_SIDEBAR_WIDTH}
        className="electron-no-drag group absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize touch-none outline-none"
        data-sidebar-resizer=""
        data-resizing={sidebarResizing ? "true" : "false"}
        ref={sidebarResizerRef}
        onDoubleClick={() => {
          animateSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_SIDEBAR_WIDTH));
        }}
        onKeyDown={(event) => {
          let next = sidebarWidth;
          if (event.key === "ArrowLeft") {
            next =
              sidebarWidth <= MIN_EXPANDED_SIDEBAR_WIDTH
                ? COMPACT_SIDEBAR_WIDTH
                : Math.max(MIN_EXPANDED_SIDEBAR_WIDTH, sidebarWidth - 16);
          } else if (event.key === "ArrowRight") {
            next =
              sidebarWidth === COMPACT_SIDEBAR_WIDTH
                ? MIN_EXPANDED_SIDEBAR_WIDTH
                : sidebarWidth + 16;
          } else if (event.key === "Home") next = COMPACT_SIDEBAR_WIDTH;
          else if (event.key === "End") next = maxSidebarWidth();
          else return;
          event.preventDefault();
          if (next === COMPACT_SIDEBAR_WIDTH || sidebarWidth === COMPACT_SIDEBAR_WIDTH) {
            animateSidebarWidth(next);
          } else {
            updateSidebarWidth(next);
          }
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(next)));
        }}
        onPointerCancel={(event) => finishSidebarResize(event.currentTarget)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeSessionRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: sidebarWidthRef.current,
            width: sidebarWidthRef.current,
            mode: compact ? "compact" : "expanded",
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          setSidebarResizing(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(event) => {
          const session = resizeSessionRef.current;
          if (!session || session.pointerId !== event.pointerId) return;
          const next = moveSnappedSidebar(session, event.clientX);
          const snapped = next.mode !== session.mode;
          Object.assign(session, next);
          if (snapped && next.mode === "compact") animateSidebarWidth(next.width);
          else {
            if (next.mode === "expanded" && sidebarSnapTimerRef.current !== null) {
              window.clearTimeout(sidebarSnapTimerRef.current);
              sidebarSnapTimerRef.current = null;
              setSidebarSnapping(false);
            }
            const appliedWidth = applySidebarWidth(next.width);
            if (snapped) setSidebarWidth(appliedWidth);
          }
        }}
        onPointerUp={(event) => finishSidebarResize(event.currentTarget)}
        role="separator"
        tabIndex={0}
      >
        <span
          className={cn(
            "absolute inset-y-0 left-1 w-px bg-transparent transition-colors duration-150 ease-out group-hover:bg-line-strong group-focus-visible:bg-accent motion-reduce:transition-none",
            sidebarResizing && "!bg-accent"
          )}
        />
      </div>

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={Boolean(deleteTarget)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteDialogTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Bots in this section move back to the main list. No bots are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteDialogTarget) preferences.deleteSection(deleteDialogTarget.id);
              }}
            >
              Delete section
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
});
