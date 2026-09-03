import { useDraggable } from "@dnd-kit/react";
import type { BotView, ChannelView } from "@openteam/contracts";
import { Pin } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidebarSection } from "../../../hooks/use-sidebar-preferences";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { cn } from "../../../lib/cn";
import type { SidebarChannelRow as ChannelRowData } from "../../../lib/sidebar-rows";
import {
  EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
  EXPANDED_SIDEBAR_OVERSCAN,
  SIDEBAR_CHANNEL_ROW_SIZE,
} from "../../../lib/sidebar-virtual-layout";
import { ChannelAvatar } from "../avatar";
import { StatusDot } from "../status";
import { BotContextMenu, GroupContextMenu } from "./menus";
import {
  type BotRowAction,
  type GroupRowAction,
  PresenceAvatar,
  rowBot,
  rowPresence,
  rowPreview,
  type SidebarVirtualJumpHandler,
  timeLabel,
} from "./shared";

const presenceTextClass = {
  working: "text-live",
  attention: "text-attention",
  starting: "text-accent",
  failed: "text-danger",
  idle: "text-ink-2",
} as const;

export const ChannelRow = memo(function ChannelRow({
  row,
  botById,
  selected,
  pinned,
  unread,
  sections,
  currentSectionId,
  onSelect,
  onBotAction,
  onGroupAction,
  onCreateSection,
  onMoveToSection,
  dragHandleRef,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
  selected: boolean;
  pinned: boolean;
  unread: boolean;
  sections: SidebarSection[];
  currentSectionId: string | null;
  onSelect: (id: string) => void;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  onGroupAction: (channel: ChannelView, action: GroupRowAction) => void;
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
  dragHandleRef?: (element: HTMLButtonElement | null) => void;
}) {
  const { channel, latest } = row;
  const bot = rowBot(row, botById);
  const presence = rowPresence(row, botById);
  const needsAttention = presence === "attention";
  const preview = rowPreview(row, botById);
  const roomColor = bot?.color ?? "var(--accent)";

  const content = (
    <button
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group relative flex h-[54px] w-full items-center gap-2.5 rounded-lg pl-2.5 pr-2 text-left outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent",
        selected ? "bg-raised shadow-card" : "hover:bg-hover"
      )}
      onClick={() => onSelect(channel.id)}
      ref={dragHandleRef}
      type="button"
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full"
          style={{ background: roomColor }}
        />
      )}
      <PresenceAvatar
        presence={presence}
        ringColor={selected ? "var(--raised)" : "var(--sidebar)"}
        size="md"
      >
        <ChannelAvatar botById={botById} channel={channel} />
      </PresenceAvatar>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-[13.5px] leading-[18px]",
              unread ? "font-semibold text-ink" : "font-medium text-ink"
            )}
          >
            {channel.name}
          </span>
          {bot?.title ? (
            <span className="max-w-[88px] shrink-0 truncate rounded-[4px] bg-ink/7 px-1 py-px font-mono text-[10px] leading-[14px] text-ink-2">
              {bot.title}
            </span>
          ) : null}
          {pinned && <Pin aria-label="Pinned" className="size-2.5 shrink-0 text-ink-3" />}
          <span
            className={cn(
              "ml-auto shrink-0 font-mono text-[10.5px] tabular-nums leading-[18px]",
              needsAttention ? "text-attention" : unread ? "text-accent" : "text-ink-3"
            )}
          >
            {timeLabel(latest?.createdAt ?? channel.createdAt)}
          </span>
        </span>
        <span className="mt-px flex min-w-0 items-center gap-1.5">
          {needsAttention ? (
            <StatusDot label="Needs your input" presence="attention" pulse={false} size={6} />
          ) : unread ? (
            <StatusDot label="Unread" presence="starting" pulse={false} size={6} />
          ) : preview.presence ? (
            <StatusDot presence={preview.presence} size={6} />
          ) : null}
          <span
            className={cn(
              "block min-w-0 truncate text-[12.5px] leading-4",
              preview.presence ? presenceTextClass[preview.presence] : "text-ink-2",
              preview.presence && "font-medium"
            )}
          >
            {preview.text}
          </span>
        </span>
      </span>
    </button>
  );

  if (bot) {
    return (
      <BotContextMenu
        bot={bot}
        channelId={channel.id}
        currentSectionId={currentSectionId}
        onBotAction={onBotAction}
        onCreateSection={onCreateSection}
        onMoveToSection={onMoveToSection}
        pinned={pinned}
        sections={sections}
        unread={unread}
      >
        {content}
      </BotContextMenu>
    );
  }
  if (channel.kind === "group") {
    return (
      <GroupContextMenu
        channel={channel}
        currentSectionId={currentSectionId}
        onCreateSection={onCreateSection}
        onGroupAction={onGroupAction}
        onMoveToSection={onMoveToSection}
        pinned={pinned}
        sections={sections}
        unread={unread}
      >
        {content}
      </GroupContextMenu>
    );
  }
  return content;
});

export const DraggableChannelRow = memo(function DraggableChannelRow({
  row,
  group,
  disabled,
  ...props
}: {
  row: ChannelRowData;
  group: string;
  disabled: boolean;
} & Omit<React.ComponentProps<typeof ChannelRow>, "row">) {
  const { ref, handleRef, isDragging } = useDraggable({
    id: `channel:${row.channel.id}`,
    type: "channel",
    disabled,
    data: { kind: "channel", channelId: row.channel.id, group },
  });
  return (
    <div
      className={cn("touch-none", isDragging && "relative z-10 opacity-0")}
      data-channel-id={row.channel.id}
      data-selected={props.selected || undefined}
      ref={ref}
    >
      <ChannelRow {...props} dragHandleRef={handleRef} row={row} />
    </div>
  );
});

export function VirtualizedChannelRows({
  activeChannelId,
  group,
  rows,
  scrollRef,
  renderRow,
  onRegisterJumpHandler,
}: {
  activeChannelId?: string | null;
  group: string;
  rows: ChannelRowData[];
  scrollRef: React.RefObject<HTMLElement | null>;
  renderRow: (row: ChannelRowData, index: number, group: string) => React.ReactNode;
  onRegisterJumpHandler?: (key: string, handler: SidebarVirtualJumpHandler | null) => void;
}) {
  const [focusChannelId, setFocusChannelId] = useState<string | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const activeIndex = useMemo(() => {
    const channelId = activeChannelId ?? focusChannelId;
    if (!channelId) return undefined;
    const index = rows.findIndex((row) => row.channel.id === channelId);
    return index >= 0 ? index : undefined;
  }, [activeChannelId, focusChannelId, rows]);
  const estimateSize = useCallback(() => SIDEBAR_CHANNEL_ROW_SIZE, []);
  const getKey = useCallback(
    (index: number) => rows[index]?.channel.id ?? `missing:${index}`,
    [rows]
  );
  const { measureElement, scrollToIndex, totalSize, virtualItems } = useVirtualWindow({
    activeIndex,
    count: rows.length,
    estimateSize,
    getKey,
    initialViewportSize: 900,
    maxItems: EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
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
      scrollToIndex(index, { align: "center" });
      return true;
    };
    onRegisterJumpHandler(group, handler);
    return () => onRegisterJumpHandler(group, null);
  }, [group, onRegisterJumpHandler, rows, scrollToIndex]);

  useEffect(() => {
    const channelId = focusChannelId;
    if (!channelId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"] button`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusChannelId]);

  return (
    <div
      aria-label={`${rows.length} chats`}
      className="relative w-full"
      data-virtual-sidebar-count={rows.length}
      onKeyDownCapture={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const channelElement = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-channel-id]"
        );
        const current = channelElement?.dataset.channelId;
        const index = current ? rows.findIndex((row) => row.channel.id === current) : -1;
        if (index < 0) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
                );
        if (next === index) return;
        event.preventDefault();
        scrollToIndex(next, { align: "center" });
        setFocusChannelId(rows[next]?.channel.id ?? null);
      }}
      ref={scopeRef}
      role="list"
      style={{ height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) return null;
        return (
          <div
            aria-posinset={virtualItem.index + 1}
            aria-setsize={rows.length}
            className="absolute inset-x-0 top-0 pb-1"
            key={virtualItem.key}
            ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
            role="listitem"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            {renderRow(row, virtualItem.index, group)}
          </div>
        );
      })}
    </div>
  );
}
