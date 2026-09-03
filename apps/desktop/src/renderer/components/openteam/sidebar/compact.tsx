import type { BotView } from "@openteam/contracts";
import { EyeOff, PanelLeft, Plus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthSession } from "../../../hooks/use-auth-session";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { accountPresentation } from "../../../lib/account";
import { cn } from "../../../lib/cn";
import type { SidebarChannelRow as ChannelRowData } from "../../../lib/sidebar-rows";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { ChannelAvatar } from "../avatar";
import { BotGlyphIcon } from "../brand";
import { StatusDot } from "../status";
import { AccountMenu } from "./account-menu";
import { ChannelPreviewTooltipContent, PresenceAvatar, rowPresence } from "./shared";

export function CompactChannelTile({
  row,
  botById,
  selected,
  unread,
  onSelect,
  onFocus,
  tabIndex,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
  selected: boolean;
  unread: boolean;
  onSelect: (id: string) => void;
  onFocus?: () => void;
  tabIndex?: number;
}) {
  const { channel } = row;
  const presence = rowPresence(row, botById);
  const needsAttention = presence === "attention";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={selected ? "page" : undefined}
          aria-label={`Open ${channel.name}${needsAttention ? ", needs your input" : unread ? ", unread" : ""}`}
          className={cn(
            "relative flex size-[54px] shrink-0 items-center justify-center rounded-lg p-0 outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent",
            selected ? "bg-raised shadow-card" : "hover:bg-hover"
          )}
          data-compact-channel-id={channel.id}
          onClick={() => onSelect(channel.id)}
          onFocus={onFocus}
          tabIndex={tabIndex}
          type="button"
        >
          <PresenceAvatar
            presence={needsAttention || unread ? "idle" : presence}
            ringColor={selected ? "var(--raised)" : "var(--sidebar)"}
            size="md"
          >
            <ChannelAvatar botById={botById} channel={channel} />
          </PresenceAvatar>
          {(needsAttention || unread) && (
            <StatusDot
              className="pointer-events-none absolute bottom-[8px] right-[8px] z-20"
              data-unread-indicator={unread && !needsAttention ? "true" : undefined}
              presence={needsAttention ? "attention" : "starting"}
              pulse={false}
              size={9}
              style={{ boxShadow: `0 0 0 2px ${selected ? "var(--raised)" : "var(--sidebar)"}` }}
            />
          )}
        </button>
      </TooltipTrigger>
      <ChannelPreviewTooltipContent botById={botById} row={row} />
    </Tooltip>
  );
}

type CompactVirtualEntry =
  | { type: "separator"; id: string }
  | { type: "channel"; id: string; row: ChannelRowData };

export function VirtualizedCompactChannels({
  groups,
  botById,
  unreadIds,
  selectedId,
  onSelect,
  scrollRef,
}: {
  groups: Array<{ id: string; rows: ChannelRowData[] }>;
  botById: ReadonlyMap<string, BotView>;
  unreadIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const entries = useMemo<CompactVirtualEntry[]>(
    () =>
      groups.flatMap((group, groupIndex) => [
        ...(groupIndex > 0 ? [{ type: "separator" as const, id: `separator:${group.id}` }] : []),
        ...group.rows.map((row) => ({ type: "channel" as const, id: row.channel.id, row })),
      ]),
    [groups]
  );
  const estimateSize = useCallback(
    (index: number) => (entries[index]?.type === "separator" ? 17 : 55),
    [entries]
  );
  const getKey = useCallback(
    (index: number) => entries[index]?.id ?? `missing:${index}`,
    [entries]
  );
  const channelIds = useMemo(
    () => entries.flatMap((entry) => (entry.type === "channel" ? [entry.row.channel.id] : [])),
    [entries]
  );
  const channelOrderById = useMemo(
    () => new Map(channelIds.map((channelId, index) => [channelId, index])),
    [channelIds]
  );
  const entryIndexByChannelId = useMemo(() => {
    const indexes = new Map<string, number>();
    entries.forEach((entry, index) => {
      if (entry.type === "channel") indexes.set(entry.row.channel.id, index);
    });
    return indexes;
  }, [entries]);
  const [focusChannelId, setFocusChannelId] = useState<string | null>(null);
  const pendingKeyboardFocus = useRef<string | null>(null);
  const previousSelectedId = useRef(selectedId);
  const scopeRef = useRef<HTMLUListElement>(null);
  const rovingChannelId =
    (focusChannelId && entryIndexByChannelId.has(focusChannelId) ? focusChannelId : null) ??
    (selectedId && entryIndexByChannelId.has(selectedId) ? selectedId : null) ??
    channelIds[0] ??
    null;
  const activeIndex = rovingChannelId ? entryIndexByChannelId.get(rovingChannelId) : undefined;
  const { measureElement, scrollToIndex, totalSize, virtualItems } = useVirtualWindow({
    activeIndex,
    count: entries.length,
    estimateSize,
    getKey,
    initialViewportSize: 900,
    maxItems: 48,
    overscan: 220,
    scrollRef,
  });

  useEffect(() => {
    if (previousSelectedId.current === selectedId) return;
    previousSelectedId.current = selectedId;
    if (selectedId && entryIndexByChannelId.has(selectedId)) setFocusChannelId(selectedId);
  }, [entryIndexByChannelId, selectedId]);

  useEffect(() => {
    const channelId = pendingKeyboardFocus.current;
    if (!channelId || channelId !== rovingChannelId) return;
    const frame = window.requestAnimationFrame(() => {
      scopeRef.current
        ?.querySelector<HTMLElement>(`[data-compact-channel-id="${CSS.escape(channelId)}"]`)
        ?.focus();
      pendingKeyboardFocus.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rovingChannelId]);

  return (
    <ul
      aria-label={`${channelIds.length} chats`}
      className="relative w-full"
      data-virtual-compact-sidebar-count={entries.length}
      onKeyDownCapture={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const tile = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-compact-channel-id]"
        );
        const currentId = tile?.dataset.compactChannelId;
        const currentIndex = currentId ? channelOrderById.get(currentId) : undefined;
        if (currentIndex === undefined) return;
        event.preventDefault();
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? channelIds.length - 1
              : Math.max(
                  0,
                  Math.min(
                    channelIds.length - 1,
                    currentIndex + (event.key === "ArrowDown" ? 1 : -1)
                  )
                );
        if (nextIndex === currentIndex) return;
        const nextId = channelIds[nextIndex];
        const nextEntryIndex = nextId ? entryIndexByChannelId.get(nextId) : undefined;
        if (!nextId || nextEntryIndex === undefined) return;
        pendingKeyboardFocus.current = nextId;
        scrollToIndex(nextEntryIndex, { align: "center" });
        setFocusChannelId(nextId);
      }}
      ref={scopeRef}
      style={{ height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const entry = entries[virtualItem.index];
        if (!entry) return null;
        return (
          <li
            aria-hidden={entry.type === "separator" ? "true" : undefined}
            aria-posinset={
              entry.type === "channel"
                ? (channelOrderById.get(entry.row.channel.id) ?? 0) + 1
                : undefined
            }
            aria-setsize={entry.type === "channel" ? channelIds.length : undefined}
            className="absolute inset-x-0 top-0"
            key={virtualItem.key}
            ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            {entry.type === "separator" ? (
              <div aria-hidden="true" className="mx-auto my-2 h-px w-[40px] bg-line-strong" />
            ) : (
              <div className="flex justify-center py-0.5">
                <CompactChannelTile
                  botById={botById}
                  onFocus={() => setFocusChannelId(entry.row.channel.id)}
                  onSelect={onSelect}
                  row={entry.row}
                  selected={entry.row.channel.id === selectedId}
                  tabIndex={entry.row.channel.id === rovingChannelId ? 0 : -1}
                  unread={unreadIds.has(entry.row.channel.id)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CompactSidebarContent({
  groups,
  botById,
  hiddenAgentCount,
  unreadIds,
  selectedId,
  onSelect,
  onNewBot,
  onNewGroup,
  onOpenAbout,
  onOpenHiddenAgents,
  onOpenSettings,
  onToggleCompact,
}: {
  groups: Array<{ id: string; rows: ChannelRowData[] }>;
  botById: ReadonlyMap<string, BotView>;
  hiddenAgentCount: number;
  unreadIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  onOpenAbout: () => void;
  onOpenHiddenAgents: () => void;
  onOpenSettings: () => void;
  onToggleCompact: () => void;
}) {
  const auth = useAuthSession();
  const account = accountPresentation(auth.user, auth.mode);
  const scrollRef = useRef<HTMLElement>(null);
  const channelCount = groups.reduce((count, group) => count + group.rows.length, 0);
  return (
    <>
      <div className="electron-drag flex h-[61px] shrink-0 items-end justify-center pb-1.5">
        <div
          aria-hidden="true"
          className="h-px w-[40px] bg-line-strong"
          data-compact-header-divider=""
        />
      </div>
      <nav
        aria-label="Bots and groups"
        className="ob-scrollbar scrollbar-none flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-2 pt-1"
        ref={scrollRef}
      >
        {channelCount > 180 ? (
          <VirtualizedCompactChannels
            botById={botById}
            groups={groups}
            onSelect={onSelect}
            scrollRef={scrollRef}
            selectedId={selectedId}
            unreadIds={unreadIds}
          />
        ) : (
          groups.map((group, groupIndex) => (
            <div className="w-full" data-compact-group={group.id} key={group.id}>
              {groupIndex > 0 && (
                <div aria-hidden="true" className="mx-auto my-2 h-px w-[40px] bg-line-strong" />
              )}
              {group.rows.map((row) => (
                <div className="flex justify-center py-0.5" key={row.channel.id}>
                  <CompactChannelTile
                    botById={botById}
                    onSelect={onSelect}
                    row={row}
                    selected={row.channel.id === selectedId}
                    unread={unreadIds.has(row.channel.id)}
                  />
                </div>
              ))}
            </div>
          ))
        )}
        {hiddenAgentCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={`Hidden bots (${hiddenAgentCount})`}
                className="relative mt-2 grid size-[54px] shrink-0 place-items-center rounded-lg text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                onClick={onOpenHiddenAgents}
                type="button"
              >
                <EyeOff className="size-4" strokeWidth={1.8} />
                <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-ink px-1 font-mono text-[9px] leading-4 text-surface">
                  {hiddenAgentCount}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Hidden bots</TooltipContent>
          </Tooltip>
        ) : null}
      </nav>
      <div className="flex shrink-0 flex-col items-center gap-0.5 border-t border-line pb-2 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Expand sidebar"
              onClick={onToggleCompact}
              size="icon-sm"
              variant="subtle"
            >
              <PanelLeft className="size-4" strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Expand sidebar</TooltipContent>
        </Tooltip>
        <Tooltip>
          <DropdownMenu>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button aria-label="New bot or group" size="icon-sm" variant="subtle">
                  <Plus className="size-[18px]" strokeWidth={1.8} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <DropdownMenuContent align="start" className="w-[188px]" side="right">
              <DropdownMenuItem onSelect={onNewBot}>
                <BotGlyphIcon className="size-4" /> New bot
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onNewGroup}>
                <Users /> New group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipContent side="right">New bot or group</TooltipContent>
        </Tooltip>
        <AccountMenu compact onOpenAbout={onOpenAbout} onOpenSettings={onOpenSettings}>
          <button
            aria-label={`Account: ${account.name}`}
            className="mt-1 grid size-[54px] place-items-center rounded-lg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-hover"
            type="button"
          >
            <span className="grid size-8 place-items-center rounded-full border border-line-strong bg-raised font-mono text-[11px] font-medium text-ink-2">
              {account.initials}
            </span>
          </button>
        </AccountMenu>
      </div>
    </>
  );
}
