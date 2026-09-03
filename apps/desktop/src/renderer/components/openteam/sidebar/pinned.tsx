import { useDraggable, useDroppable } from "@dnd-kit/react";
import type { BotView, ChannelView } from "@openteam/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PINNED_GROUP_ID, type SidebarSection } from "../../../hooks/use-sidebar-preferences";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { cn } from "../../../lib/cn";
import type { SidebarChannelRow as ChannelRowData } from "../../../lib/sidebar-rows";
import {
  chunkPinnedRows,
  EXPANDED_SIDEBAR_OVERSCAN,
  pinnedGridColumnCount,
  SIDEBAR_PINNED_GRID_ROW_SIZE,
  SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS,
} from "../../../lib/sidebar-virtual-layout";
import { BotAvatar, ChannelAvatar } from "../avatar";
import { StatusDot } from "../status";
import { BotContextMenu, GroupContextMenu } from "./menus";
import {
  type BotRowAction,
  ChannelPreviewTooltipContent,
  type GroupRowAction,
  PresenceAvatar,
  rowBot,
  rowPresence,
  type SidebarVirtualJumpHandler,
} from "./shared";

export function DraggablePinnedTile({
  row,
  botById,
  selected,
  unread,
  arrival,
  sections,
  onSelect,
  onBotAction,
  onGroupAction,
  onCreateSection,
  onMoveToSection,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
  selected: boolean;
  unread: boolean;
  arrival: "first" | "later" | null;
  sections: SidebarSection[];
  onSelect: (id: string) => void;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  onGroupAction: (channel: ChannelView, action: GroupRowAction) => void;
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
}) {
  const { channel } = row;
  const presence = rowPresence(row, botById);
  const needsAttention = presence === "attention";
  const bot = rowBot(row, botById);
  const { ref, handleRef, isDragging } = useDraggable({
    id: `channel:${channel.id}`,
    type: "channel",
    data: { kind: "channel", channelId: channel.id, group: PINNED_GROUP_ID },
  });
  const tile = (
    <button
      aria-label={`Open pinned ${channel.name}`}
      className={cn(
        "flex h-[106px] w-full touch-none flex-col items-center justify-start gap-1 rounded-lg px-1 pt-2 text-center outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent",
        selected ? "bg-raised shadow-card" : "hover:bg-hover"
      )}
      onClick={() => onSelect(channel.id)}
      ref={(element) => handleRef(element)}
      type="button"
    >
      <PresenceAvatar
        presence={presence}
        ringColor={selected ? "var(--raised)" : "var(--sidebar)"}
        size="pin"
      >
        {bot ? (
          <BotAvatar bot={bot} size="lg" />
        ) : (
          <ChannelAvatar botById={botById} channel={channel} size="lg" />
        )}
      </PresenceAvatar>
      <span className="mt-0.5 flex w-full min-w-0 items-center justify-center gap-1 px-1 text-[12px] leading-4">
        {needsAttention ? (
          <StatusDot label="Needs your input" presence="attention" pulse={false} size={6} />
        ) : unread ? (
          <StatusDot label="Unread" presence="starting" pulse={false} size={6} />
        ) : null}
        <span className={cn("truncate", unread ? "font-semibold" : "font-medium")}>
          {channel.name}
        </span>
      </span>
    </button>
  );

  return (
    <div
      className={cn(
        "min-w-0",
        arrival === "first" &&
          "animate-[pinned-tile-enter_260ms_cubic-bezier(0.16,1,0.3,1)_180ms_both] motion-reduce:animate-none",
        arrival === "later" &&
          "animate-[pinned-tile-enter_260ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none",
        isDragging && "relative z-20 opacity-0"
      )}
      data-arrival={arrival ?? "none"}
      data-pinned-channel-id={channel.id}
      ref={ref}
    >
      {bot ? (
        <BotContextMenu
          bot={bot}
          channelId={channel.id}
          currentSectionId={null}
          onBotAction={onBotAction}
          onCreateSection={onCreateSection}
          onMoveToSection={onMoveToSection}
          pinned
          sections={sections}
          showMove={false}
          tooltipContent={<ChannelPreviewTooltipContent botById={botById} row={row} />}
          unread={unread}
        >
          {tile}
        </BotContextMenu>
      ) : channel.kind === "group" ? (
        <GroupContextMenu
          channel={channel}
          currentSectionId={null}
          onCreateSection={onCreateSection}
          onGroupAction={onGroupAction}
          onMoveToSection={onMoveToSection}
          pinned
          sections={sections}
          showMove={false}
          tooltipContent={<ChannelPreviewTooltipContent botById={botById} row={row} />}
          unread={unread}
        >
          {tile}
        </GroupContextMenu>
      ) : (
        tile
      )}
    </div>
  );
}

export function VirtualizedPinnedTiles({
  activeChannelId,
  arrival,
  botById,
  onBotAction,
  onGroupAction,
  onCreateSection,
  onMoveToSection,
  onSelect,
  rows,
  scrollRef,
  sections,
  selectedId,
  sidebarWidth,
  unreadIds,
  onRegisterJumpHandler,
}: {
  activeChannelId?: string | null;
  arrival: { channelId: string; first: boolean } | null;
  botById: ReadonlyMap<string, BotView>;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  onGroupAction: (channel: ChannelView, action: GroupRowAction) => void;
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
  onSelect: (id: string) => void;
  rows: ChannelRowData[];
  scrollRef: React.RefObject<HTMLElement | null>;
  sections: SidebarSection[];
  selectedId: string | null;
  sidebarWidth: number;
  unreadIds: ReadonlySet<string>;
  onRegisterJumpHandler?: (key: string, handler: SidebarVirtualJumpHandler | null) => void;
}) {
  const [responsiveColumns, setResponsiveColumns] = useState(() =>
    pinnedGridColumnCount(sidebarWidth)
  );
  const columns = Math.max(1, Math.min(rows.length, responsiveColumns));
  const gridRows = useMemo(() => chunkPinnedRows(rows, columns), [columns, rows]);
  const [focusChannelId, setFocusChannelId] = useState<string | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const activeGridRow = useMemo(() => {
    const channelId = activeChannelId ?? focusChannelId;
    if (!channelId) return undefined;
    const channelIndex = rows.findIndex((row) => row.channel.id === channelId);
    return channelIndex >= 0 ? Math.floor(channelIndex / Math.max(1, columns)) : undefined;
  }, [activeChannelId, columns, focusChannelId, rows]);
  const estimateSize = useCallback(() => SIDEBAR_PINNED_GRID_ROW_SIZE, []);
  const getKey = useCallback(
    (index: number) => gridRows[index]?.[0]?.channel.id ?? `missing:${index}`,
    [gridRows]
  );
  const { measureElement, scrollToIndex, totalSize, virtualItems } = useVirtualWindow({
    activeIndex: activeGridRow,
    count: gridRows.length,
    estimateSize,
    getKey,
    maxItems: SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS,
    overscan: EXPANDED_SIDEBAR_OVERSCAN,
    scopeRef,
    scrollRef,
    suspendOutsideViewport: true,
  });

  useEffect(() => {
    if (!onRegisterJumpHandler) return;
    const handler: SidebarVirtualJumpHandler = (channelId) => {
      const index = rows.findIndex((row) => row.channel.id === channelId);
      if (index < 0) return false;
      scrollToIndex(Math.floor(index / Math.max(1, columns)), { align: "center" });
      return true;
    };
    onRegisterJumpHandler(PINNED_GROUP_ID, handler);
    return () => onRegisterJumpHandler(PINNED_GROUP_ID, null);
  }, [columns, onRegisterJumpHandler, rows, scrollToIndex]);

  useEffect(() => {
    const element = scopeRef.current;
    if (!element) return;
    let frame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = pinnedGridColumnCount(width + 24);
        setResponsiveColumns((current) => (current === next ? current : next));
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!focusChannelId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-pinned-channel-id="${CSS.escape(focusChannelId)}"] button`
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusChannelId]);

  return (
    <div
      aria-label={`${rows.length} pinned chats`}
      className="relative w-full rounded-lg p-[6px]"
      data-pinned-grid=""
      data-virtual-pinned-sidebar-count={rows.length}
      onKeyDownCapture={(event) => {
        if (
          !["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          return;
        }
        const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-pinned-channel-id]");
        const currentId = tile?.dataset.pinnedChannelId;
        const index = currentId ? rows.findIndex((row) => row.channel.id === currentId) : -1;
        if (index < 0) return;
        const delta =
          event.key === "ArrowDown"
            ? columns
            : event.key === "ArrowUp"
              ? -columns
              : event.key === "ArrowRight"
                ? 1
                : -1;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(0, Math.min(rows.length - 1, index + delta));
        if (next === index) return;
        event.preventDefault();
        scrollToIndex(Math.floor(next / Math.max(1, columns)), { align: "center" });
        setFocusChannelId(rows[next]?.channel.id ?? null);
      }}
      ref={scopeRef}
      role="list"
      style={{ height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const gridRow = gridRows[virtualItem.index];
        if (!gridRow) return null;
        return (
          <div
            className="absolute inset-x-[6px] top-[6px] grid justify-center gap-x-2"
            key={virtualItem.key}
            ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
            role="presentation"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(80px, max-content))`,
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {gridRow.map((row, rowOffset) => {
              const itemIndex = virtualItem.index * Math.max(1, columns) + rowOffset;
              return (
                <div
                  aria-posinset={itemIndex + 1}
                  aria-setsize={rows.length}
                  key={row.channel.id}
                  role="listitem"
                >
                  <DraggablePinnedTile
                    arrival={
                      arrival?.channelId === row.channel.id
                        ? arrival.first
                          ? "first"
                          : "later"
                        : null
                    }
                    botById={botById}
                    onBotAction={onBotAction}
                    onGroupAction={onGroupAction}
                    onCreateSection={onCreateSection}
                    onMoveToSection={onMoveToSection}
                    onSelect={onSelect}
                    row={row}
                    sections={sections}
                    selected={row.channel.id === selectedId}
                    unread={unreadIds.has(row.channel.id)}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function TransitionDropZone({
  visible,
  settling,
  group,
  label,
}: {
  visible: boolean;
  settling: boolean;
  group: string;
  label: string;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `channel-transition-drop:${group}`,
    type: "channel-drop",
    accept: "channel",
    disabled: !visible || settling,
    data: { kind: "channel-drop", group },
  });

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "col-start-1 row-start-1 grid transition-[grid-template-rows,opacity,padding] duration-200 ease-out motion-reduce:transition-none",
        visible
          ? "grid-rows-[1fr] pb-2 opacity-100"
          : "pointer-events-none grid-rows-[0fr] opacity-0"
      )}
      data-channel-transition-drop-zone={group}
      data-visible={visible ? "true" : "false"}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex h-[102px] items-center justify-center rounded-lg border border-dashed border-line-strong bg-raised/40 text-[12.5px] font-medium text-ink-2 transition-[border-color,background-color,color,opacity] duration-180",
            isDropTarget && "border-accent bg-accent-soft text-accent",
            settling && "border-transparent bg-transparent text-transparent opacity-0"
          )}
          data-hovered={isDropTarget ? "true" : "false"}
          data-settling={settling ? "true" : "false"}
          ref={ref}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

export function CollapsingPinnedSpacer({ phase }: { phase: "holding" | "collapsing" | null }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none col-start-1 row-start-1 overflow-hidden",
        phase === "holding" && "h-[110px]",
        phase === "collapsing" &&
          "h-0 transition-[height] duration-[170ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
        phase === null && "h-0"
      )}
      data-pinned-exit={phase ?? "none"}
    >
      <div className="h-[110px]" />
    </div>
  );
}
