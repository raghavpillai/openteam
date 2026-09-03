import { useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { Collapsible } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidebarSection } from "../../../hooks/use-sidebar-preferences";
import { useVirtualWindow } from "../../../hooks/use-virtual-window";
import { cn } from "../../../lib/cn";
import type { SidebarChannelRow as ChannelRowData } from "../../../lib/sidebar-rows";
import {
  EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
  EXPANDED_SIDEBAR_OVERSCAN,
  estimateSidebarSectionSize,
} from "../../../lib/sidebar-virtual-layout";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import { VirtualizedChannelRows } from "./channel-row";
import { type SidebarVirtualJumpHandler, VIRTUAL_SECTIONS_JUMP_KEY } from "./shared";

export function ChannelGroupSurface({
  group,
  active,
  disabled = false,
  className,
  children,
}: {
  group: string;
  active: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { ref } = useDroppable({
    id: `channel-group-surface:${group}`,
    type: "channel-drop",
    accept: "channel",
    disabled,
    data: { kind: "channel-drop", group },
  });

  return (
    <div
      className={cn(
        "rounded-lg transition-colors duration-150 ease-out",
        active && "bg-accent-soft ring-1 ring-accent/30",
        className
      )}
      data-channel-group={group}
      data-drop-target={active ? "true" : "false"}
      ref={ref}
    >
      {children}
    </div>
  );
}

/** Section header text: mono uppercase label with a count that turns into a chevron on hover. */
export const sectionHeaderClass =
  "group flex h-[30px] w-full items-center gap-1 rounded-md px-2 outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent";

export function SectionDisclosure({ collapsed, count }: { collapsed: boolean; count: number }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center font-mono text-[10.5px] text-ink-3">
      <span
        className={cn(
          "transition-opacity duration-[120ms] ease-out group-hover:opacity-0 group-focus-visible:opacity-0 motion-reduce:transition-none",
          !collapsed && "opacity-0"
        )}
      >
        {count}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "absolute size-3 opacity-0 transition-[opacity,transform] duration-[120ms] ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none",
          !collapsed && "rotate-90"
        )}
        strokeWidth={2}
      />
    </span>
  );
}

export function SidebarCollapsibleContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Content
      className={cn(
        "overflow-hidden data-[state=closed]:animate-[sidebar-collapsible-close_200ms_cubic-bezier(0.165,0.84,0.44,1)] data-[state=open]:animate-[sidebar-collapsible-open_200ms_cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:animate-none",
        className
      )}
    >
      {children}
    </Collapsible.Content>
  );
}

export function SectionGroup({
  activeChannelId,
  section,
  sectionIndex,
  sectionCount,
  rows,
  editing,
  draft,
  dndDisabled,
  dropHighlighted,
  dropEdge,
  renderRow,
  scrollRef,
  virtualizeRows,
  onRegisterJumpHandler,
  onDraftChange,
  onFinishEditing,
  onRename,
  onMove,
  onDelete,
  onToggle,
}: {
  activeChannelId?: string | null;
  section: SidebarSection;
  sectionIndex: number;
  sectionCount: number;
  rows: ChannelRowData[];
  editing: boolean;
  draft: string;
  dndDisabled: boolean;
  dropHighlighted: boolean;
  dropEdge: "before" | "after" | null;
  renderRow: (row: ChannelRowData, index: number, group: string) => ReactNode;
  scrollRef: React.RefObject<HTMLElement | null>;
  virtualizeRows: boolean;
  onRegisterJumpHandler?: (key: string, handler: SidebarVirtualJumpHandler | null) => void;
  onDraftChange: (value: string) => void;
  onFinishEditing: (save: boolean) => void;
  onRename: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const { ref, isDragging } = useSortable({
    id: `section:${section.id}`,
    index: sectionIndex,
    group: "section-order",
    type: "section",
    accept: "section",
    disabled: dndDisabled || editing,
    data: { kind: "section", sectionId: section.id, index: sectionIndex },
  });

  return (
    <ChannelGroupSurface
      active={dropHighlighted}
      className={cn("relative", isDragging && "opacity-40")}
      disabled={dndDisabled}
      group={section.id}
    >
      {dropEdge && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent",
            dropEdge === "before" ? "top-0" : "bottom-0"
          )}
          data-section-drop-edge={dropEdge}
        />
      )}
      <Collapsible.Root
        onOpenChange={(open) => {
          if (open === section.collapsed) onToggle();
        }}
        open={!section.collapsed}
      >
        <div>
          {editing ? (
            <div
              className={cn(sectionHeaderClass, "hover:bg-transparent")}
              data-section-id={section.id}
            >
              <input
                aria-label="Section name"
                autoFocus
                className="microlabel h-[30px] flex-1 bg-transparent p-0 text-ink outline-none placeholder:text-ink-3"
                maxLength={48}
                onBlur={() => onFinishEditing(true)}
                onChange={(event) => onDraftChange(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onFinishEditing(true);
                  if (event.key === "Escape") onFinishEditing(false);
                }}
                placeholder="Section name"
                value={draft}
              />
              <SectionDisclosure collapsed={section.collapsed} count={rows.length} />
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Collapsible.Trigger asChild>
                  <button
                    className={cn(sectionHeaderClass, "touch-none")}
                    data-section-id={section.id}
                    ref={ref}
                    type="button"
                  >
                    <span className="microlabel min-w-0 flex-1 truncate text-left">
                      {section.name}
                    </span>
                    <SectionDisclosure collapsed={section.collapsed} count={rows.length} />
                  </button>
                </Collapsible.Trigger>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[184px]">
                <ContextMenuItem onSelect={onRename}>
                  <Pencil /> Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={sectionIndex === 0} onSelect={() => onMove(-1)}>
                  <ArrowUp /> Move up
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={sectionIndex === sectionCount - 1}
                  onSelect={() => onMove(1)}
                >
                  <ArrowDown /> Move down
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onDelete} variant="destructive">
                  <Trash2 /> Delete section…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}
        </div>
        <SidebarCollapsibleContent className="pt-1">
          <div className={rows.length > 0 && !virtualizeRows ? "flex flex-col gap-1" : undefined}>
            {rows.length > 0 ? (
              virtualizeRows ? (
                <VirtualizedChannelRows
                  activeChannelId={activeChannelId}
                  group={section.id}
                  onRegisterJumpHandler={onRegisterJumpHandler}
                  renderRow={renderRow}
                  rows={rows}
                  scrollRef={scrollRef}
                />
              ) : (
                rows.map((row, index) => renderRow(row, index, section.id))
              )
            ) : (
              <div
                className="flex h-7 items-center px-2 text-[12px] text-ink-3"
                data-empty-section={section.id}
              >
                Drag bots here
              </div>
            )}
          </div>
        </SidebarCollapsibleContent>
      </Collapsible.Root>
    </ChannelGroupSurface>
  );
}

export function VirtualizedSections({
  activeSectionId,
  renderSection,
  rowsBySection,
  scrollRef,
  sections,
  onRegisterJumpHandler,
}: {
  activeSectionId?: string | null;
  renderSection: (section: SidebarSection, index: number) => ReactNode;
  rowsBySection: Readonly<Record<string, ChannelRowData[]>>;
  scrollRef: React.RefObject<HTMLElement | null>;
  sections: SidebarSection[];
  onRegisterJumpHandler?: (key: string, handler: SidebarVirtualJumpHandler | null) => void;
}) {
  const [focusSectionId, setFocusSectionId] = useState<string | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const activeIndex = useMemo(() => {
    const sectionId = activeSectionId ?? focusSectionId;
    if (!sectionId) return undefined;
    const index = sections.findIndex((section) => section.id === sectionId);
    return index >= 0 ? index : undefined;
  }, [activeSectionId, focusSectionId, sections]);
  const estimateSize = useCallback(
    (index: number) => {
      const section = sections[index];
      return section
        ? estimateSidebarSectionSize(section, rowsBySection[section.id]?.length ?? 0)
        : 40;
    },
    [rowsBySection, sections]
  );
  const getKey = useCallback(
    (index: number) => {
      const section = sections[index];
      return section
        ? `${section.id}:${rowsBySection[section.id]?.length ?? 0}`
        : `missing:${index}`;
    },
    [rowsBySection, sections]
  );
  const { measureElement, scrollToIndex, totalSize, virtualItems } = useVirtualWindow({
    activeIndex,
    count: sections.length,
    estimateSize,
    getKey,
    maxItems: EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
    overscan: EXPANDED_SIDEBAR_OVERSCAN,
    scopeRef,
    scrollRef,
    suspendOutsideViewport: true,
  });

  useEffect(() => {
    if (!onRegisterJumpHandler) return;
    const handler: SidebarVirtualJumpHandler = (sectionId) => {
      const index = sections.findIndex((section) => section.id === sectionId);
      if (index < 0) return false;
      scrollToIndex(index, { align: "center" });
      return true;
    };
    onRegisterJumpHandler(VIRTUAL_SECTIONS_JUMP_KEY, handler);
    return () => onRegisterJumpHandler(VIRTUAL_SECTIONS_JUMP_KEY, null);
  }, [onRegisterJumpHandler, scrollToIndex, sections]);

  useEffect(() => {
    if (!focusSectionId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-section-id="${CSS.escape(focusSectionId)}"]`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSectionId]);

  return (
    <div
      aria-label={`${sections.length} chat sections`}
      className="relative w-full shrink-0"
      data-virtual-sidebar-sections={sections.length}
      onKeyDownCapture={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const sectionHeader = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-section-id]"
        );
        const currentId = sectionHeader?.dataset.sectionId;
        const index = currentId ? sections.findIndex((section) => section.id === currentId) : -1;
        if (index < 0) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? sections.length - 1
              : Math.max(
                  0,
                  Math.min(sections.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))
                );
        if (next === index) return;
        event.preventDefault();
        scrollToIndex(next, { align: "center" });
        setFocusSectionId(sections[next]?.id ?? null);
      }}
      ref={scopeRef}
      role="list"
      style={{ height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const section = sections[virtualItem.index];
        if (!section) return null;
        return (
          <div
            aria-posinset={virtualItem.index + 1}
            aria-setsize={sections.length}
            className="absolute inset-x-0 top-0 pb-[10px]"
            key={section.id}
            ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
            role="listitem"
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            {renderSection(section, virtualItem.index)}
          </div>
        );
      })}
    </div>
  );
}
