import type { BotView, ChannelView } from "@openteam/contracts";
import {
  BellDot,
  Check,
  Clock3,
  Copy,
  CopyPlus,
  EyeOff,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarSection } from "../../../hooks/use-sidebar-preferences";
import { BOT_TEMPLATE_SHARING_ENABLED } from "../../../lib/bot-template";
import { cn } from "../../../lib/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import { Tooltip, TooltipTrigger } from "../../ui/tooltip";
import { type BotRowAction, type GroupRowAction, SHOW_INTERNAL_ASYNC_TASKS } from "./shared";

function MoveMenu({
  channelId,
  currentSectionId,
  sections,
  onCreateSection,
  onMoveToSection,
}: {
  channelId: string;
  currentSectionId: string | null;
  sections: SidebarSection[];
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
}) {
  if (sections.length === 0) {
    return (
      <ContextMenuItem onSelect={() => onCreateSection(channelId)}>
        <FolderPlus /> Move to a new section
      </ContextMenuItem>
    );
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Folder /> Move to
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-[188px]">
        {sections.map((section) => (
          <ContextMenuItem key={section.id} onSelect={() => onMoveToSection(channelId, section.id)}>
            <Check
              className={cn(
                "size-4",
                currentSectionId === section.id ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="truncate">{section.name}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuItem onSelect={() => onMoveToSection(channelId, null)}>
          <Check
            className={cn("size-4", currentSectionId === null ? "opacity-100" : "opacity-0")}
          />
          Other
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCreateSection(channelId)}>
          <FolderPlus /> New section…
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function withOptionalTooltip(
  children: ReactNode,
  menuContent: ReactNode,
  tooltipContent: ReactNode | undefined
) {
  if (tooltipContent) {
    return (
      <Tooltip>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          </TooltipTrigger>
          {menuContent}
        </ContextMenu>
        {tooltipContent}
      </Tooltip>
    );
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {menuContent}
    </ContextMenu>
  );
}

export function BotContextMenu({
  bot,
  channelId,
  currentSectionId,
  pinned,
  unread,
  sections,
  showMove = true,
  onBotAction,
  onCreateSection,
  onMoveToSection,
  tooltipContent,
  children,
}: {
  bot: BotView;
  channelId: string;
  currentSectionId: string | null;
  pinned: boolean;
  unread: boolean;
  sections: SidebarSection[];
  showMove?: boolean;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
  tooltipContent?: ReactNode;
  children: ReactNode;
}) {
  const menuContent = (
    <ContextMenuContent className="w-[212px]">
      <ContextMenuItem onSelect={() => onBotAction(bot, "togglePin")}>
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin to top"}
      </ContextMenuItem>
      {showMove && (
        <MoveMenu
          channelId={channelId}
          currentSectionId={currentSectionId}
          onCreateSection={onCreateSection}
          onMoveToSection={onMoveToSection}
          sections={sections}
        />
      )}
      <ContextMenuItem onSelect={() => onBotAction(bot, "toggleUnread")}>
        <BellDot /> {unread ? "Mark as read" : "Mark as unread"}
      </ContextMenuItem>
      {bot.status === "failed" && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "retry")}>
          <RotateCw /> Retry setup
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "editProfile")}>
        <Pencil /> Edit bot
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onBotAction(bot, "duplicate")}>
        <CopyPlus /> Duplicate
      </ContextMenuItem>
      {BOT_TEMPLATE_SHARING_ENABLED && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "shareAsTemplate")}>
          <Upload /> Share as template
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "copyConversationId")}>
        <Copy /> Copy conversation ID
      </ContextMenuItem>
      {SHOW_INTERNAL_ASYNC_TASKS && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "showAsyncTasks")}>
          <Clock3 /> Show background tasks
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "hide")}>
        <EyeOff /> Hide from sidebar
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onBotAction(bot, "delete")} variant="destructive">
        <Trash2 /> Delete bot…
      </ContextMenuItem>
    </ContextMenuContent>
  );

  return withOptionalTooltip(children, menuContent, tooltipContent);
}

export function GroupContextMenu({
  channel,
  currentSectionId,
  pinned,
  unread,
  sections,
  showMove = true,
  onGroupAction,
  onCreateSection,
  onMoveToSection,
  tooltipContent,
  children,
}: {
  channel: ChannelView;
  currentSectionId: string | null;
  pinned: boolean;
  unread: boolean;
  sections: SidebarSection[];
  showMove?: boolean;
  onGroupAction: (channel: ChannelView, action: GroupRowAction) => void;
  onCreateSection: (channelId: string) => void;
  onMoveToSection: (channelId: string, sectionId: string | null) => void;
  tooltipContent?: ReactNode;
  children: ReactNode;
}) {
  const menuContent = (
    <ContextMenuContent className="w-[212px]">
      <ContextMenuItem onSelect={() => onGroupAction(channel, "togglePin")}>
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin to top"}
      </ContextMenuItem>
      {showMove && (
        <MoveMenu
          channelId={channel.id}
          currentSectionId={currentSectionId}
          onCreateSection={onCreateSection}
          onMoveToSection={onMoveToSection}
          sections={sections}
        />
      )}
      <ContextMenuItem onSelect={() => onGroupAction(channel, "toggleUnread")}>
        <BellDot /> {unread ? "Mark as read" : "Mark as unread"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onGroupAction(channel, "editProfile")}>
        <Pencil /> Edit group
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onGroupAction(channel, "copyConversationId")}>
        <Copy /> Copy conversation ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onGroupAction(channel, "hide")}>
        <EyeOff /> Hide from sidebar
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onGroupAction(channel, "delete")} variant="destructive">
        <Trash2 /> Delete group…
      </ContextMenuItem>
    </ContextMenuContent>
  );

  return withOptionalTooltip(children, menuContent, tooltipContent);
}
