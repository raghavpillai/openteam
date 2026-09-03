import { PointerActivationConstraints } from "@dnd-kit/dom";
import {
  DragDropProvider,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { BotView, ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";
import {
  ArrowDown,
  ArrowUp,
  BellDot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  CopyPlus,
  EyeOff,
  Folder,
  FolderPlus,
  Hash,
  Info,
  LogOut,
  Megaphone,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  RotateCw,
  Search,
  Settings,
  Smartphone,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { signOut } from "../../client/auth";
import { useAuthSession } from "../../hooks/use-auth-session";
import type {
  SidebarPreferencesController,
  SidebarSection,
} from "../../hooks/use-sidebar-preferences";
import { PINNED_GROUP_ID, UNASSIGNED_GROUP_ID } from "../../hooks/use-sidebar-preferences";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { accountPresentation } from "../../lib/account";
import { BOT_TEMPLATE_SHARING_ENABLED } from "../../lib/bot-template";
import { channelMessageSummary } from "../../lib/channel-events";
import { cn } from "../../lib/cn";
import {
  COMPACT_SIDEBAR_WIDTH,
  MIN_EXPANDED_SIDEBAR_WIDTH,
  moveSnappedSidebar,
  type SnappedSidebarResizeState,
} from "../../lib/panel-resize";
import {
  type SidebarChannelRow as ChannelRowData,
  groupSidebarRows,
  reconcileSidebarRows,
  type SidebarUnreadJumpTarget,
  type SidebarUnreadJumpTargets,
  sidebarRowIsWorking,
  sidebarUnreadJumpTargets,
} from "../../lib/sidebar-rows";
import {
  chunkPinnedRows,
  EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS,
  EXPANDED_SIDEBAR_OVERSCAN,
  estimateSidebarSectionSize,
  pinnedGridColumnCount,
  SIDEBAR_CHANNEL_ROW_SIZE,
  SIDEBAR_PINNED_GRID_ROW_SIZE,
  SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS,
  shouldVirtualizeExpandedSidebar,
} from "../../lib/sidebar-virtual-layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, ChannelAvatar } from "./avatar";

function WorkingAvatar({
  active,
  children,
  ringColor,
  size,
}: {
  active: boolean;
  children: React.ReactNode;
  ringColor: string;
  size: "sm" | "md" | "pin";
}) {
  return (
    <span
      className="relative grid shrink-0"
      style={{ "--working-dot-ring": ringColor } as React.CSSProperties}
    >
      {children}
      {active ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-10 rounded-full bg-[#5bc67a]",
            size === "sm" &&
              "bottom-0 right-0 size-1.5 shadow-[0_0_0_2.5px_var(--working-dot-ring,var(--sidebar))]",
            size === "md" &&
              "bottom-0.5 right-0.5 size-2 shadow-[0_0_0_2px_var(--working-dot-ring,var(--sidebar))]",
            size === "pin" &&
              "bottom-0.5 right-0.5 size-2.5 shadow-[0_0_0_3.333px_var(--working-dot-ring,var(--sidebar))]"
          )}
          data-working-indicator=""
        />
      ) : null}
    </span>
  );
}

function UnreadJumpPill({
  target,
  onJump,
}: {
  target: SidebarUnreadJumpTarget;
  onJump: (target: SidebarUnreadJumpTarget) => void;
}) {
  return (
    <button
      aria-label="More unreads above"
      className="absolute left-1/2 top-2 z-[12] inline-flex -translate-x-1/2 cursor-pointer items-center gap-0.5 whitespace-nowrap rounded-full border-0 bg-[#2d63bb] py-1 pl-1 pr-2 font-[inherit] text-[13px] font-normal leading-[18px] text-[#fcfcfc] shadow-[inset_0_0_0_1px_rgba(20,20,20,0.05),0_2px_8px_rgba(0,0,0,0.12)] outline-none"
      data-more-unreads="above"
      onClick={() => onJump(target)}
      title={`${target.count} unread message${target.count === 1 ? "" : "s"}`}
      type="button"
    >
      <span className="inline-flex size-5 shrink-0 items-center justify-center">
        <ArrowUp className="size-4" strokeWidth={1.7} />
      </span>
      <span className="inline pr-0.5">More unreads</span>
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

type SidebarVirtualJumpHandler = (id: string) => boolean;
const VIRTUAL_SECTIONS_JUMP_KEY = "virtual-sections";

function AccountMenu({
  children,
  compact = false,
  onOpenAbout,
  onOpenSettings,
}: {
  children: React.ReactNode;
  compact?: boolean;
  onOpenAbout: () => void;
  onOpenSettings: () => void;
}) {
  const auth = useAuthSession();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [includeConversationId, setIncludeConversationId] = useState(false);
  const [wantsFeedbackResponse, setWantsFeedbackResponse] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [update, setUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  useEffect(() => window.openteam?.updates.onClientProgress(setUpdate), []);
  const menuItem = "h-8 gap-2 rounded-[8px] px-2 text-[13px] font-normal leading-[19.5px]";
  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const submitFeedback = () => {
    const body = feedback.trim();
    if (!body) return;
    const selectedConversationId = includeConversationId
      ? document.querySelector<HTMLElement>('[data-channel-id][data-selected="true"]')?.dataset
          .channelId
      : undefined;
    const url = new URL("https://github.com/raghavpillai/openteam/issues/new");
    url.searchParams.set("title", "OpenTeam feedback");
    url.searchParams.set(
      "body",
      [
        body,
        selectedConversationId ? `Conversation ID: ${selectedConversationId}` : null,
        wantsFeedbackResponse ? "Response requested: yes" : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    openExternal(url.toString());
    setFeedback("");
    setIncludeConversationId(false);
    setWantsFeedbackResponse(false);
    setFeedbackOpen(false);
  };

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          void window.openteam?.updates.status().then((value) => {
            setUpdate(value);
            if (value.status === "idle") void window.openteam?.updates.check().then(setUpdate);
          });
        }}
      >
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align={compact ? "end" : "start"}
          aria-label="Account"
          className="w-[228px] rounded-[16px] border-[0.5px] border-[#d9d9d9] bg-[#fcfcfc] p-1 shadow-[0_8px_22px_rgba(0,0,0,0.10),0_2px_6px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-popover"
          side={compact ? "right" : "top"}
          sideOffset={8}
        >
          {["available", "downloading", "downloaded", "installing"].includes(
            update?.status ?? ""
          ) ? (
            <div className="mb-1 flex h-10 items-center gap-2 rounded-[10px] bg-black/[0.035] px-2 dark:bg-white/[0.055]">
              <span className="min-w-0 flex-1 truncate text-[12px]">New update available</span>
              <button
                className="h-7 rounded-full bg-black px-3 text-[11.5px] font-medium text-white hover:opacity-80 dark:bg-white dark:text-black"
                disabled={["downloading", "installing"].includes(update?.status ?? "")}
                onClick={() =>
                  void (update?.status === "downloaded"
                    ? window.openteam?.updates.installClient()
                    : window.openteam?.updates.openDownload())
                }
                type="button"
              >
                {update?.status === "downloaded"
                  ? "Restart"
                  : update?.status === "downloading"
                    ? `${Math.round(update.progress ?? 0)}%`
                    : update?.status === "installing"
                      ? "Restarting"
                      : "Install"}
              </button>
            </div>
          ) : null}
          <DropdownMenuItem
            className={menuItem}
            onSelect={() =>
              openExternal("https://github.com/raghavpillai/openteam/tree/main/apps/mobile")
            }
          >
            <Smartphone className="size-4" strokeWidth={1.85} />
            Get OpenTeam for iOS
          </DropdownMenuItem>
          <DropdownMenuItem className={menuItem} onSelect={onOpenSettings}>
            <Settings className="size-4" strokeWidth={1.85} />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem className={menuItem} onSelect={onOpenAbout}>
            <Info className="size-4" strokeWidth={1.85} />
            About
          </DropdownMenuItem>
          <DropdownMenuItem
            className={menuItem}
            onSelect={() => openExternal("https://github.com/raghavpillai/openteam#readme")}
          >
            <CircleHelp className="size-4" strokeWidth={1.85} />
            Help Center
          </DropdownMenuItem>
          <DropdownMenuItem className={menuItem} onSelect={() => setFeedbackOpen(true)}>
            <Megaphone className="size-4" strokeWidth={1.85} />
            Send Feedback
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={menuItem} onSelect={() => setSignOutOpen(true)}>
            <LogOut className="size-4" strokeWidth={1.85} />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setFeedbackOpen} open={feedbackOpen}>
        <DialogContent
          className="w-[460px] max-w-[calc(100vw-32px)] gap-0 rounded-[16px] border-black/10 bg-background p-0 shadow-[0_24px_72px_rgba(0,0,0,0.24)]"
          showCloseButton={false}
        >
          <div className="border-b border-black/[0.07] px-4 py-4 dark:border-white/[0.08]">
            <DialogTitle className="text-[14px] font-medium">Send Feedback</DialogTitle>
          </div>
          <div className="px-4 pb-4 pt-4">
            <DialogDescription className="text-[13px] leading-[18px]">
              Tell the OpenTeam team what happened or what you want changed. Reports go straight to
              the team.
            </DialogDescription>
            <textarea
              autoFocus
              className="mt-3 h-[140px] w-full resize-none rounded-[5px] border border-black/[0.09] bg-black/[0.025] px-2.5 py-2 text-[13px] leading-[18px] outline-none placeholder:text-foreground-tertiary focus:border-black/20 dark:border-white/[0.1] dark:bg-transparent"
              maxLength={8_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What happened? What did you expect?"
              value={feedback}
            />
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                <input
                  checked={includeConversationId}
                  className="size-4 rounded-[4px] accent-white"
                  onChange={(event) => setIncludeConversationId(event.target.checked)}
                  type="checkbox"
                />
                Include current conversation ID
              </label>
              <label className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                <input
                  checked={wantsFeedbackResponse}
                  className="size-4 rounded-[4px] accent-white"
                  onChange={(event) => setWantsFeedbackResponse(event.target.checked)}
                  type="checkbox"
                />
                I would like a response to my feedback
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-black/[0.07] py-3 pl-4 pr-3 dark:border-white/[0.08]">
            <button
              className="h-8 rounded-[9px] px-3 text-[12.5px] hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              onClick={() => setFeedbackOpen(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="h-8 rounded-[9px] bg-black px-3.5 text-[12.5px] font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              disabled={!feedback.trim()}
              onClick={submitFeedback}
              type="button"
            >
              Send Feedback
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setSignOutOpen} open={signOutOpen}>
        <AlertDialogContent className="max-w-[430px] rounded-[16px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {auth.mode === "required" ? "Log out?" : "Authentication is off"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {auth.mode === "required"
                ? "You can sign back in with your OpenTeam username and password. Your Bots and chats stay on this server."
                : "This server is running in trusted no-auth mode, so there is no account session to remove."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSignOutOpen(false);
                if (auth.mode === "required") void signOut();
              }}
            >
              {auth.mode === "required" ? "Log out" : "Done"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function HiddenAgentsDialog({
  botById,
  hiddenBots,
  hiddenGroups,
  onOpenChange,
  onOpenChannel,
  onUnhideBot,
  onUnhideGroup,
  open,
}: {
  botById: ReadonlyMap<string, BotView>;
  hiddenBots: BotView[];
  hiddenGroups: ChannelView[];
  onOpenChange: (open: boolean) => void;
  onOpenChannel: (channelId: string) => void;
  onUnhideBot: (bot: BotView) => Promise<void>;
  onUnhideGroup: (group: ChannelView) => Promise<void>;
  open: boolean;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const hiddenAgentCount = hiddenBots.length + hiddenGroups.length;
  const unhide = async (id: string, request: () => Promise<void>) => {
    setPendingId(id);
    setError(false);
    try {
      await request();
    } catch {
      setError(true);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setError(false);
      }}
      open={open}
    >
      <DialogContent
        className="w-[420px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-[16px] border-black/10 bg-background p-0 shadow-[0_24px_72px_rgba(0,0,0,0.24)]"
        showCloseButton={false}
      >
        <div className="border-b border-black/[0.07] px-4 py-4 dark:border-white/[0.08]">
          <DialogTitle className="text-[14px] font-medium">Hidden Bots</DialogTitle>
          <DialogDescription className="mt-1 text-[12.5px] leading-[18px] text-foreground-secondary">
            Hidden Bots stay active and keep their history, they're just not visible in the sidebar.
          </DialogDescription>
        </div>
        <div className="grok-scrollbar max-h-[420px] min-h-[96px] overflow-y-auto p-2">
          {error ? (
            <div className="px-3 py-3 text-center text-[13px] text-destructive">
              Check your connection and try again.
            </div>
          ) : null}
          {hiddenAgentCount === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-foreground-secondary">
              No hidden bots
            </div>
          ) : (
            <div className="space-y-0.5">
              {hiddenBots.map((bot) => (
                <div
                  className="flex h-11 items-center gap-2 rounded-[10px] px-2 hover:bg-accent"
                  key={bot.id}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenChannel(bot.dmChannelId);
                    }}
                    type="button"
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{bot.name}</span>
                  </button>
                  <button
                    className="rounded-[8px] bg-black/[0.055] px-2.5 py-1.5 text-[12px] hover:bg-black/[0.09] disabled:opacity-50 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"
                    disabled={pendingId !== null}
                    onClick={() => void unhide(bot.id, () => onUnhideBot(bot))}
                    type="button"
                  >
                    Unhide
                  </button>
                </div>
              ))}
              {hiddenGroups.map((group) => (
                <div
                  className="flex h-11 items-center gap-2 rounded-[10px] px-2 hover:bg-accent"
                  key={group.id}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenChannel(group.id);
                    }}
                    type="button"
                  >
                    <ChannelAvatar botById={botById} channel={group} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{group.name}</span>
                  </button>
                  <button
                    className="rounded-[8px] bg-black/[0.055] px-2.5 py-1.5 text-[12px] hover:bg-black/[0.09] disabled:opacity-50 dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"
                    disabled={pendingId !== null}
                    onClick={() => void unhide(group.id, () => onUnhideGroup(group))}
                    type="button"
                  >
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type BotRowAction =
  | "togglePin"
  | "toggleUnread"
  | "editProfile"
  | "duplicate"
  | "shareAsTemplate"
  | "copyConversationId"
  | "showAsyncTasks"
  | "hide"
  | "retry"
  | "delete";

export type GroupRowAction =
  | "togglePin"
  | "toggleUnread"
  | "editProfile"
  | "copyConversationId"
  | "hide"
  | "delete";

const SHOW_INTERNAL_ASYNC_TASKS = import.meta.env.VITE_OPENTEAM_INTERNAL_ASYNC_TASKS === "true";

function isPinnableChannel(channel: ChannelView | undefined) {
  return channel?.kind === "bot_dm" || channel?.kind === "group";
}

const sidebarSensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [
            new PointerActivationConstraints.Delay({
              value: 250,
              tolerance: 5,
            }),
          ]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
  KeyboardSensor,
];

function timeLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startValue === startToday - 86_400_000) return "Yesterday";
  if (startValue !== startToday) {
    return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function compactTimeLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startToday - startValue) / 86_400_000);
  if (dayDifference === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (dayDifference === 1) return "Yesterday";
  if (dayDifference > 1 && dayDifference < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function ChannelPreviewTooltipContent({
  row,
  botById,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
}) {
  const { channel, latest } = row;
  const working = sidebarRowIsWorking(row);
  const bot = channel.kind === "bot_dm" ? botById.get(channel.members[0]?.botId ?? "") : undefined;
  const description = working
    ? "Working…"
    : bot?.status === "provisioning"
      ? "Starting up…"
      : bot?.status === "failed"
        ? "Setup needs attention"
        : (latest ? channelMessageSummary(latest) : "") ||
          (channel.kind === "agent_dm" ? "Private bot exchange" : "No messages yet");

  return (
    <TooltipContent
      align="start"
      className="w-[260px] rounded-[12px] border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-[0_10px_28px_rgba(0,0,0,0.16)]"
      collisionPadding={8}
      side="right"
      sideOffset={8}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WorkingAvatar active={working} ringColor="var(--popover)" size="sm">
          <ChannelAvatar botById={botById} channel={channel} size="sm" />
        </WorkingAvatar>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{channel.name}</span>
        <span className="shrink-0 text-[12px] font-normal text-foreground-secondary">
          {compactTimeLabel(latest?.createdAt ?? channel.createdAt)}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] font-normal leading-[18px] text-foreground-secondary">
        {description}
      </p>
    </TooltipContent>
  );
}

function SidebarDragPreview({
  row,
  botById,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
}) {
  const { channel } = row;
  const working = sidebarRowIsWorking(row);
  const bot = channel.kind === "bot_dm" ? botById.get(channel.members[0]?.botId ?? "") : undefined;
  const groupBots =
    channel.kind === "bot_dm"
      ? []
      : channel.members.slice(0, 2).map((member) => botById.get(member.botId));

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex -translate-y-2 flex-col items-center rounded-[10px] bg-popover/90 px-1.5 py-1.5 text-popover-foreground shadow-[0_7px_20px_rgba(0,0,0,0.14),0_1px_4px_rgba(0,0,0,0.06)] ring-1 ring-foreground/[0.05] backdrop-blur-xl",
        bot ? "h-[94px] w-[84px] gap-0.5" : "min-h-[112px] w-[116px] justify-center gap-2"
      )}
      data-sidebar-drag-preview=""
    >
      <WorkingAvatar active={working} ringColor="var(--popover)" size="pin">
        {bot ? (
          <BotAvatar bot={bot} size="lg" />
        ) : (
          <div className="relative h-[68px] w-[86px] shrink-0">
            {groupBots.map((groupBot, index) => (
              <div
                className={cn("absolute", index === 0 ? "left-0 top-0" : "bottom-0 right-0")}
                key={groupBot?.id ?? index}
              >
                <BotAvatar bot={groupBot} size="lg" />
              </div>
            ))}
          </div>
        )}
      </WorkingAvatar>
      <span
        className={cn(
          "w-full truncate text-center font-medium leading-4",
          bot ? "px-0.5 text-[12px]" : "px-1 text-[13px]"
        )}
      >
        {channel.name}
      </span>
    </div>
  );
}

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
        <FolderPlus className="size-4" /> Move to new section
      </ContextMenuItem>
    );
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Folder className="size-4" /> Move to
        <ChevronRight className="ml-auto size-3.5" />
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-[180px]">
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
          Unassigned
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCreateSection(channelId)}>
          <FolderPlus className="size-4" /> New section
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function BotContextMenu({
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
  tooltipContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  const menuContent = (
    <ContextMenuContent className="w-[202px]">
      <ContextMenuItem onSelect={() => onBotAction(bot, "togglePin")}>
        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {pinned ? "Unpin" : "Pin"}
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
        <BellDot className="size-4" /> {unread ? "Mark as Read" : "Mark as Unread"}
      </ContextMenuItem>
      {bot.status === "failed" && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "retry")}>
          <RotateCw className="size-4" /> Retry setup
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "editProfile")}>
        <Pencil className="size-4" /> Edit Profile
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onBotAction(bot, "duplicate")}>
        <CopyPlus className="size-4" /> Duplicate
      </ContextMenuItem>
      {BOT_TEMPLATE_SHARING_ENABLED && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "shareAsTemplate")}>
          <Upload className="size-4" /> Share as template
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "copyConversationId")}>
        <Copy className="size-4" /> Copy conversation ID
      </ContextMenuItem>
      {SHOW_INTERNAL_ASYNC_TASKS && (
        <ContextMenuItem onSelect={() => onBotAction(bot, "showAsyncTasks")}>
          <Clock3 className="size-4" /> Show async tasks
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onBotAction(bot, "hide")}>
        <EyeOff className="size-4" /> Hide from sidebar
      </ContextMenuItem>
      <ContextMenuItem
        className="text-destructive data-[highlighted]:text-destructive [&_svg]:text-destructive"
        onSelect={() => onBotAction(bot, "delete")}
      >
        <Trash2 className="size-4" /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );

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

function GroupContextMenu({
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
  tooltipContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  const menuContent = (
    <ContextMenuContent className="w-[202px]">
      <ContextMenuItem onSelect={() => onGroupAction(channel, "togglePin")}>
        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {pinned ? "Unpin" : "Pin"}
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
        <BellDot className="size-4" /> {unread ? "Mark as Read" : "Mark as Unread"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onGroupAction(channel, "editProfile")}>
        <Pencil className="size-4" /> Edit Profile
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onGroupAction(channel, "copyConversationId")}>
        <Copy className="size-4" /> Copy conversation ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onGroupAction(channel, "hide")}>
        <EyeOff className="size-4" /> Hide from sidebar
      </ContextMenuItem>
      <ContextMenuItem
        className="text-destructive data-[highlighted]:text-destructive [&_svg]:text-destructive"
        onSelect={() => onGroupAction(channel, "delete")}
      >
        <Trash2 className="size-4" /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );

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

const ChannelRow = memo(function ChannelRow({
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
  const { channel, latest, running } = row;
  const needsAttention = running?.status === "waiting_approval";
  const working = sidebarRowIsWorking(row);
  const author = latest?.senderBotId ? botById.get(latest.senderBotId)?.name : null;
  const bot = channel.kind === "bot_dm" ? botById.get(channel.members[0]?.botId ?? "") : undefined;
  const onboardingInProgress = Boolean(
    bot && ["pending", "queued", "running"].includes(bot.onboardingStatus)
  );
  const latestPreview = latest
    ? `${author && channel.kind !== "bot_dm" ? `${author}: ` : ""}${channelMessageSummary(latest)}`
    : "";
  const preview = onboardingInProgress
    ? latestPreview
    : needsAttention
      ? "Needs your input"
      : working
        ? "Working…"
        : bot?.status === "provisioning"
          ? "Starting up…"
          : bot?.status === "failed"
            ? "Setup needs attention"
            : latestPreview ||
              (channel.kind === "agent_dm" ? "Private bot exchange" : "No messages yet");
  const content = (
    <Button
      className={cn(
        "group flex h-[54px] w-full items-center gap-2 rounded-[10px] px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
        selected ? "bg-selected hover:bg-selected" : "hover:bg-hover"
      )}
      onClick={() => onSelect(channel.id)}
      ref={dragHandleRef}
      type="button"
      variant="ghost"
    >
      <WorkingAvatar
        active={working}
        ringColor={selected ? "var(--selected)" : "var(--sidebar)"}
        size="md"
      >
        <ChannelAvatar botById={botById} channel={channel} />
      </WorkingAvatar>
      <span className="min-w-0 flex-1 -translate-y-[0.5px]">
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate text-[14px]",
                unread ? "font-semibold" : "font-medium"
              )}
            >
              {channel.name}
            </span>
            {bot?.title ? (
              <span className="max-w-24 shrink-0 truncate rounded-[4px] bg-black/[0.07] px-1.5 py-px text-[11px] font-normal leading-[15px] text-foreground-secondary dark:bg-white/[0.1] dark:text-[#ababab]">
                {bot.title}
              </span>
            ) : null}
            {pinned && (
              <Pin aria-label="Pinned" className="size-2.5 shrink-0 text-foreground-tertiary" />
            )}
          </span>
          <span
            className={cn(
              "shrink-0 text-[12px] font-normal tabular-nums",
              needsAttention
                ? "text-amber-500"
                : unread
                  ? "text-blue-500"
                  : selected
                    ? "text-foreground-secondary dark:text-[#ababab]"
                    : "text-foreground-secondary dark:text-foreground-tertiary"
            )}
          >
            {timeLabel(latest?.createdAt ?? channel.createdAt)}
          </span>
        </span>
        <span className="mt-px flex min-w-0 items-center gap-1.5">
          {needsAttention ? (
            <span
              aria-label="Needs your input"
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              role="img"
            />
          ) : unread ? (
            <span
              aria-label="Unread"
              className="size-1.5 shrink-0 rounded-full bg-blue-600"
              role="img"
            />
          ) : null}
          {preview && (
            <span
              className={cn(
                "block min-w-0 truncate text-[13px] font-normal leading-4 text-foreground-secondary",
                selected && "dark:text-[#ababab]"
              )}
            >
              {preview}
            </span>
          )}
        </span>
      </span>
    </Button>
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

const DraggableChannelRow = memo(function DraggableChannelRow({
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

function VirtualizedChannelRows({
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

function DraggablePinnedTile({
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
  const needsAttention = row.running?.status === "waiting_approval";
  const working = sidebarRowIsWorking(row);
  const bot = channel.kind === "bot_dm" ? botById.get(channel.members[0]?.botId ?? "") : undefined;
  const { ref, handleRef, isDragging } = useDraggable({
    id: `channel:${channel.id}`,
    type: "channel",
    data: { kind: "channel", channelId: channel.id, group: PINNED_GROUP_ID },
  });
  const tile = (
    <Button
      aria-label={`Open pinned ${channel.name}`}
      className={cn(
        "flex h-[106px] w-full touch-none flex-col justify-start gap-1 rounded-[10px] px-1 pt-2 text-center font-normal transition-[background-color,transform]",
        selected ? "bg-selected hover:bg-selected" : "hover:bg-hover"
      )}
      onClick={() => onSelect(channel.id)}
      ref={(element) => handleRef(element)}
      type="button"
      variant="ghost"
    >
      <WorkingAvatar
        active={working}
        ringColor={selected ? "var(--selected)" : "var(--sidebar)"}
        size="pin"
      >
        {bot ? (
          <BotAvatar bot={bot} size="lg" />
        ) : (
          <ChannelAvatar botById={botById} channel={channel} size="lg" />
        )}
      </WorkingAvatar>
      <span className="mt-0.5 flex w-full min-w-0 items-center justify-center gap-1 px-1 text-[12px]">
        {needsAttention ? (
          <span
            aria-label="Needs your input"
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
          />
        ) : unread ? (
          <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-blue-600" />
        ) : null}
        <span className="truncate">{channel.name}</span>
      </span>
    </Button>
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

function VirtualizedPinnedTiles({
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
      scrollToIndex(Math.floor(index / Math.max(1, columns)), {
        align: "center",
      });
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
      className="relative w-full rounded-[12px] p-[6px]"
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
        scrollToIndex(Math.floor(next / Math.max(1, columns)), {
          align: "center",
        });
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

function TransitionDropZone({
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
            "flex h-[102px] items-center justify-center rounded-[12px] border border-dashed border-foreground/25 bg-foreground/[0.018] text-[13px] font-medium text-foreground-secondary transition-[border-color,background-color,color,opacity] duration-180",
            isDropTarget && "border-foreground/35 bg-foreground/[0.04]",
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

function CollapsingPinnedSpacer({ phase }: { phase: "holding" | "collapsing" | null }) {
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

function ChannelGroupSurface({
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
  children: React.ReactNode;
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
        "rounded-[12px] transition-colors duration-150 ease-out",
        active && "bg-foreground/[0.045] dark:bg-hover",
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

function SectionDisclosure({ collapsed, count }: { collapsed: boolean; count: number }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center text-[12px] font-normal">
      {collapsed && (
        <span className="transition-opacity duration-[120ms] ease-out group-hover:opacity-0 group-focus-visible:opacity-0 motion-reduce:transition-none">
          {count}
        </span>
      )}
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "absolute size-3 opacity-0 transition-opacity duration-[120ms] ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none",
          collapsed && "-rotate-90"
        )}
      />
    </span>
  );
}

function SidebarCollapsibleContent({
  children,
  className,
}: {
  children: React.ReactNode;
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

function SectionGroup({
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
  renderRow: (row: ChannelRowData, index: number, group: string) => React.ReactNode;
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
            "pointer-events-none absolute inset-x-0 z-10 h-px bg-foreground/30",
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
              className="group flex h-[30px] items-center rounded-md px-2 transition-colors duration-[170ms] ease-out hover:bg-foreground/[0.045] motion-reduce:transition-none dark:hover:bg-hover"
              data-section-id={section.id}
            >
              <Input
                aria-label="Section name"
                autoFocus
                className="h-[30px] flex-1 -translate-y-[1.5px] rounded-none border-0 bg-transparent p-0 text-[12px] font-normal text-foreground-tertiary shadow-none selection:bg-[#afd3f5] selection:text-foreground-tertiary focus-visible:border-transparent focus-visible:ring-0 dark:text-foreground-secondary"
                maxLength={48}
                onBlur={() => onFinishEditing(true)}
                onChange={(event) => onDraftChange(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onFinishEditing(true);
                  if (event.key === "Escape") onFinishEditing(false);
                }}
                value={draft}
              />
              <SectionDisclosure collapsed={section.collapsed} count={rows.length} />
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Collapsible.Trigger asChild>
                  <button
                    className="group flex h-[30px] w-full touch-none items-center rounded-md px-2 text-[12px] font-normal text-foreground-tertiary outline-none transition-colors duration-[170ms] ease-out hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-ring/30 motion-reduce:transition-none dark:text-foreground-secondary dark:hover:bg-hover"
                    data-section-id={section.id}
                    ref={ref}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 -translate-y-[1.5px] truncate text-left">
                      {section.name}
                    </span>
                    <SectionDisclosure collapsed={section.collapsed} count={rows.length} />
                  </button>
                </Collapsible.Trigger>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[180px]">
                <ContextMenuItem onSelect={onRename}>
                  <Pencil className="size-4" /> Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={sectionIndex === 0} onSelect={() => onMove(-1)}>
                  <ArrowUp className="size-4" /> Move up
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={sectionIndex === sectionCount - 1}
                  onSelect={() => onMove(1)}
                >
                  <ArrowDown className="size-4" /> Move down
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive data-[highlighted]:text-destructive [&_svg]:text-destructive"
                  onSelect={onDelete}
                >
                  <Trash2 className="size-4" /> Delete
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
                className="flex h-7 items-center px-2 text-[12px] font-normal text-foreground-tertiary"
                data-empty-section={section.id}
              >
                Drag chats here
              </div>
            )}
          </div>
        </SidebarCollapsibleContent>
      </Collapsible.Root>
    </ChannelGroupSurface>
  );
}

function VirtualizedSections({
  activeSectionId,
  renderSection,
  rowsBySection,
  scrollRef,
  sections,
  onRegisterJumpHandler,
}: {
  activeSectionId?: string | null;
  renderSection: (section: SidebarSection, index: number) => React.ReactNode;
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

function CompactChannelTile({
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
  const needsAttention = row.running?.status === "waiting_approval";
  const working = sidebarRowIsWorking(row);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`Open ${channel.name}${needsAttention ? ", needs your input" : unread ? ", unread" : ""}`}
          className={cn(
            "relative flex size-[54px] shrink-0 items-center justify-center rounded-[11px] p-0 transition-colors",
            selected ? "bg-selected hover:bg-selected" : "hover:bg-hover"
          )}
          data-compact-channel-id={channel.id}
          onClick={() => onSelect(channel.id)}
          onFocus={onFocus}
          tabIndex={tabIndex}
          type="button"
          variant="ghost"
        >
          <WorkingAvatar
            active={working && !(needsAttention || unread)}
            ringColor={selected ? "var(--selected)" : "var(--sidebar)"}
            size="md"
          >
            <ChannelAvatar botById={botById} channel={channel} />
          </WorkingAvatar>
          {(needsAttention || unread) && (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute bottom-[7px] right-[7px] z-20 size-2 rounded-full border-2",
                selected ? "border-selected" : "border-sidebar",
                needsAttention ? "bg-amber-500" : "bg-[#3062bf]"
              )}
              data-unread-indicator={unread && !needsAttention ? "true" : undefined}
            />
          )}
        </Button>
      </TooltipTrigger>
      <ChannelPreviewTooltipContent botById={botById} row={row} />
    </Tooltip>
  );
}

type CompactVirtualEntry =
  | { type: "separator"; id: string }
  | { type: "channel"; id: string; row: ChannelRowData };

function VirtualizedCompactChannels({
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
        ...group.rows.map((row) => ({
          type: "channel" as const,
          id: row.channel.id,
          row,
        })),
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
              <div aria-hidden="true" className="mx-auto my-2 h-px w-[54px] bg-border" />
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

function CompactSidebarContent({
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
      <div className="electron-drag flex h-[61px] shrink-0 items-end justify-center pb-px">
        <div
          aria-hidden="true"
          className="h-[0.5px] w-[54px] bg-[#dddddd] dark:bg-[#3a3a3a]"
          data-compact-header-divider=""
        />
      </div>
      <nav
        className="grok-scrollbar flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-2 pt-1"
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
                <div aria-hidden="true" className="mx-auto my-2 h-px w-[54px] bg-border" />
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
                aria-label={`Hidden Bots (${hiddenAgentCount})`}
                className="relative mt-2 grid size-[54px] shrink-0 place-items-center rounded-[11px] text-foreground-tertiary hover:bg-subtle"
                onClick={onOpenHiddenAgents}
                type="button"
              >
                <EyeOff className="size-4" strokeWidth={1.8} />
                <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-foreground px-1 text-[9px] leading-4 text-background">
                  {hiddenAgentCount}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Hidden Bots</TooltipContent>
          </Tooltip>
        ) : null}
      </nav>
      <div className="flex shrink-0 flex-col items-center gap-0 pb-2 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Expand sidebar"
              className="size-7 rounded-[7px] p-0 text-foreground-tertiary hover:bg-subtle hover:text-foreground-secondary"
              onClick={onToggleCompact}
              variant="ghost"
            >
              <PanelLeft className="h-3.5 w-[18px]" strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Expand sidebar</TooltipContent>
        </Tooltip>
        <Tooltip>
          <DropdownMenu>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="New Bot or Channel"
                  className="size-7 rounded-[7px] p-0 text-foreground-tertiary hover:bg-subtle hover:text-foreground-secondary"
                  variant="ghost"
                >
                  <Plus className="size-5" strokeWidth={1.8} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <DropdownMenuContent align="start" className="w-[188px] rounded-xl p-1" side="right">
              <DropdownMenuItem className="text-[13px]" onSelect={onNewBot}>
                <BriefcaseBusiness className="size-3.5" /> New Bot
              </DropdownMenuItem>
              <DropdownMenuItem className="text-[13px]" onSelect={onNewGroup}>
                <Hash className="size-3.5" /> New Channel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipContent side="top">New Bot or Channel</TooltipContent>
        </Tooltip>
        <AccountMenu compact onOpenAbout={onOpenAbout} onOpenSettings={onOpenSettings}>
          <Button
            aria-label={`Account: ${account.name}`}
            className="mt-1.5 size-[54px] rounded-[11px] p-0 hover:bg-subtle data-[state=open]:bg-subtle"
            variant="ghost"
          >
            <span className="grid size-9 place-items-center rounded-full border-[0.5px] border-[#cbcbcb] bg-[#e6e6e6] text-[13px] font-medium text-[#575757] dark:border-[#393939] dark:bg-[#232323] dark:text-[#a5a5a5]">
              {account.initials}
            </span>
          </Button>
        </AccountMenu>
      </div>
    </>
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
  const [pinArrival, setPinArrival] = useState<{
    channelId: string;
    first: boolean;
  } | null>(null);
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
    if (pinArrivalTimerRef.current !== null) {
      window.clearTimeout(pinArrivalTimerRef.current);
    }
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
    if (lastUnpinFrameRef.current !== null) {
      window.cancelAnimationFrame(lastUnpinFrameRef.current);
    }
    if (lastUnpinTimerRef.current !== null) {
      window.clearTimeout(lastUnpinTimerRef.current);
    }
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
      if (sidebarSnapTimerRef.current !== null) {
        window.clearTimeout(sidebarSnapTimerRef.current);
      }
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
    if (current >= MIN_EXPANDED_SIDEBAR_WIDTH) {
      lastExpandedWidthRef.current = current;
    }
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
      const next = normalizeSidebarWidth(sidebarWidthRef.current);
      updateSidebarWidth(next);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
      if (sidebarSnapTimerRef.current !== null) {
        window.clearTimeout(sidebarSnapTimerRef.current);
      }
      if (pinArrivalTimerRef.current !== null) {
        window.clearTimeout(pinArrivalTimerRef.current);
      }
      if (lastUnpinFrameRef.current !== null) {
        window.cancelAnimationFrame(lastUnpinFrameRef.current);
      }
      if (lastUnpinTimerRef.current !== null) {
        window.clearTimeout(lastUnpinTimerRef.current);
      }
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
        if (pinned && pinnedCountRef.current === 1) {
          startLastUnpinCollapse();
        } else if (!pinned) {
          startPinArrival(channelId, pinnedCountRef.current === 0);
        }
      }
      onBotAction(bot, action);
    },
    [onBotAction, startLastUnpinCollapse, startPinArrival]
  );

  const handleSidebarGroupAction = useCallback(
    (channel: ChannelView, action: GroupRowAction) => {
      if (action === "togglePin") {
        const pinned = pinnedIdsRef.current.has(channel.id);
        if (pinned && pinnedCountRef.current === 1) {
          startLastUnpinCollapse();
        } else if (!pinned) {
          startPinArrival(channel.id, pinnedCountRef.current === 0);
        }
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
        "relative flex min-w-0 shrink-0 flex-col overflow-hidden bg-sidebar [&_button]:duration-75",
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
          <div className="electron-drag flex h-[47px] shrink-0 items-center justify-end gap-0.5 px-[13px] pt-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Toggle compact sidebar"
                  className="electron-no-drag size-7 rounded-[7px] text-foreground-tertiary hover:bg-subtle hover:text-foreground focus-visible:ring-0 dark:text-foreground-secondary"
                  onClick={toggleCompactSidebar}
                  size="icon-sm"
                  variant="ghost"
                >
                  <PanelLeftClose className="size-[15px]" strokeWidth={1.7} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse sidebar</TooltipContent>
            </Tooltip>
            <Tooltip>
              <DropdownMenu>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label="New Bot or Channel"
                      className="electron-no-drag size-7 rounded-[7px] text-foreground-tertiary hover:bg-subtle hover:text-foreground data-[state=open]:bg-subtle data-[state=open]:text-foreground focus-visible:ring-0 dark:text-foreground-secondary"
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <DropdownMenuContent
                  align="end"
                  alignOffset={3}
                  className="w-[188px] rounded-xl border-input p-1 shadow-[0_8px_18px_rgba(0,0,0,0.24)]"
                  onCloseAutoFocus={(event) => {
                    if (!keepFocusInNewBotPicker.current) return;
                    event.preventDefault();
                    keepFocusInNewBotPicker.current = false;
                  }}
                  sideOffset={-1}
                >
                  <DropdownMenuItem
                    className="text-[13px]"
                    onSelect={() => {
                      keepFocusInNewBotPicker.current = true;
                      onNewBot();
                    }}
                  >
                    <BriefcaseBusiness className="size-3.5" /> New Bot
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-[13px]" onSelect={onNewGroup}>
                    <Hash className="size-3.5" /> New Channel
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <TooltipContent side="bottom">New Bot or Channel</TooltipContent>
            </Tooltip>
          </div>
          <div className="relative px-[12px] pb-[9px]">
            <Search className="pointer-events-none absolute left-5 top-[10px] z-10 size-[14px] text-[#676767] dark:text-[#9d9d9d]" />
            <button
              aria-label="Search"
              className="relative top-px flex h-[32px] w-full items-center rounded-[8px] bg-field pl-[26.5px] pr-2 text-left text-[13.5px] text-[#676767] shadow-[inset_0_0_0_0.5px_var(--input)] outline-none focus-visible:shadow-[inset_0_0_0_0.5px_var(--ring)] dark:text-[#9d9d9d]"
              onClick={onSearch}
              onFocus={onPreloadSearch}
              onPointerEnter={onPreloadSearch}
              type="button"
            >
              Search
            </button>
          </div>
          <DragDropProvider
            sensors={sidebarSensors}
            onDragStart={(event) => {
              setActiveDropGroup(null);
              setOverSectionId(null);
              const sourceData = event.operation.source?.data as
                | {
                    kind?: string;
                    channelId?: string;
                    group?: string;
                    sectionId?: string;
                  }
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
              const targetData = target.data as {
                kind?: string;
                group?: string;
                index?: number;
              };
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
              preferences.moveChannel({
                channelId: sourceData.channelId,
                group: targetData.group,
              });
            }}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="relative flex min-h-0 flex-1">
                  <nav
                    className="grok-scrollbar flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-[12px]"
                    onScroll={scheduleUnreadJumpMeasure}
                    ref={sidebarScrollRef}
                    style={
                      sidebarTopFade
                        ? {
                            WebkitMaskImage:
                              "linear-gradient(to bottom, transparent 0px, black 28px, black 100%)",
                            maskImage:
                              "linear-gradient(to bottom, transparent 0px, black 28px, black 100%)",
                          }
                        : undefined
                    }
                  >
                    {!creating && (
                      <div className="grid">
                        <TransitionDropZone
                          group={PINNED_GROUP_ID}
                          label="Drag here to pin"
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
                                className="grid w-full justify-center gap-x-2 gap-y-3 rounded-[12px] p-[6px]"
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
                      <div className="flex h-[53px] w-full items-center gap-2.5 rounded-[9px] bg-selected px-2 text-[13px] font-medium">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-subtle text-foreground-tertiary">
                          <Plus className="size-4" />
                        </span>
                        Create new
                      </div>
                    )}
                    {pendingBot && (
                      <div
                        aria-current="page"
                        className="flex h-[54px] w-full items-center gap-2 rounded-[10px] bg-selected px-2 text-left"
                        data-pending-bot-row=""
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-subtle text-foreground-tertiary">
                          <UserRound className="size-4 opacity-60" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium">
                            {pendingBot.name}
                          </span>
                          <span className="mt-px block text-[13px] leading-4 text-foreground-secondary">
                            Creating…
                          </span>
                        </span>
                      </div>
                    )}
                    {allSidebarAgentsHidden ? (
                      <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
                        <span className="text-[13px] text-foreground-secondary">
                          All bots are hidden
                        </span>
                        <Button onClick={onOpenHiddenAgents} size="sm" variant="secondary">
                          Show Hidden Bots
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
                                <button
                                  className="group flex h-[30px] w-full items-center rounded-md px-2 text-[12px] font-normal text-foreground-tertiary outline-none transition-colors duration-[170ms] ease-out hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-ring/30 motion-reduce:transition-none dark:text-foreground-secondary dark:hover:bg-hover"
                                  type="button"
                                >
                                  <span className="min-w-0 flex-1 -translate-y-[1.5px] truncate text-left">
                                    Unassigned
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
                            className="mb-1 mt-2 flex h-10 w-full shrink-0 items-center gap-2 rounded-[9px] px-2 text-[13px] text-foreground-secondary hover:bg-subtle"
                            onClick={onOpenHiddenAgents}
                            type="button"
                          >
                            <EyeOff className="size-4" strokeWidth={1.8} />
                            <span className="min-w-0 flex-1 truncate text-left">Hidden Bots</span>
                            <span className="text-[12px] text-foreground-tertiary">
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
                <ContextMenuContent aria-label="Sidebar actions" className="w-[160px]">
                  <ContextMenuItem onSelect={onOpenHiddenAgents}>
                    <EyeOff className="size-4" /> Hidden Bots ({hiddenAgentCount})
                  </ContextMenuItem>
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
            <DragOverlay
              className="pointer-events-none z-[100] flex justify-center overflow-visible"
              dropAnimation={{
                duration: 300,
                easing: "cubic-bezier(0.25, 1.15, 0.4, 1)",
              }}
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
                    <div className="flex h-[30px] max-w-[220px] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-[8px] border-[0.5px] border-foreground/10 bg-popover px-2 pb-1.5 pt-2 text-[12px] leading-4 text-foreground-secondary shadow-lg">
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
          <div className="flex flex-col gap-0.5 pb-3 pl-[7px] pr-[12px] pt-2">
            <Button
              className="h-10 w-full justify-start px-[13px] text-[13.5px] font-normal hover:bg-[#eaeaea] dark:hover:bg-[#232323]"
              onClick={onOpenPlugins}
              variant="ghost"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full border-[0.5px] border-[#e4e4e4] bg-background dark:border-[#393939] dark:bg-[#181818]">
                <Plug className="size-3.5" />
              </span>
              Plugins
            </Button>
            <AccountMenu onOpenAbout={onOpenAbout} onOpenSettings={onOpenSettings}>
              <Button
                className="group/footer-account h-10 w-full justify-start px-[13px] text-[13.5px] font-normal hover:bg-[#eaeaea] dark:hover:bg-[#232323]"
                variant="ghost"
              >
                <span className="grid size-7 place-items-center rounded-full border-[0.5px] border-[#d5d5d5] bg-[#ebebeb] text-[11px] text-muted-foreground transition-colors group-hover/footer-account:bg-[#e0e0e0] dark:border-[#393939] dark:bg-[#232323] dark:text-[#a5a5a5] dark:group-hover/footer-account:bg-[#2f2f2f]">
                  {account.initials}
                </span>
                <span className="min-w-0 flex-1 truncate text-left">{account.name}</span>
              </Button>
            </AccountMenu>
          </div>
        </>
      )}

      <div
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemax={maxSidebarWidth()}
        aria-valuemin={COMPACT_SIDEBAR_WIDTH}
        className={cn(
          "electron-no-drag group absolute inset-y-0 right-0 z-40 w-2 cursor-col-resize touch-none outline-none"
        )}
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
            "absolute inset-y-0 right-0 w-[0.5px] bg-divider transition-colors duration-150 ease-out group-hover:bg-divider-hover group-focus-visible:bg-divider-hover motion-reduce:transition-none",
            sidebarResizing && "!bg-divider-active"
          )}
        />
      </div>

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={Boolean(deleteTarget)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteDialogTarget?.name}”</AlertDialogTitle>
            <AlertDialogDescription>
              Its Bots move to Unassigned. No Bots are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteDialogTarget) preferences.deleteSection(deleteDialogTarget.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
});
