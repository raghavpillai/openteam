import { PointerActivationConstraints } from "@dnd-kit/dom";
import { KeyboardSensor, PointerSensor } from "@dnd-kit/react";
import type { BotView, ChannelView } from "@openteam/contracts";
import type { ReactNode } from "react";
import { channelMessageSummary } from "../../../lib/channel-events";
import { cn } from "../../../lib/cn";
import {
  type SidebarChannelRow as ChannelRowData,
  sidebarRowIsWorking,
} from "../../../lib/sidebar-rows";
import { TooltipContent } from "../../ui/tooltip";
import { BotAvatar, ChannelAvatar } from "../avatar";
import { type BotPresence, botPresence, presenceLabel, StatusDot } from "../status";

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

export type SidebarVirtualJumpHandler = (id: string) => boolean;
export const VIRTUAL_SECTIONS_JUMP_KEY = "virtual-sections";

export const SHOW_INTERNAL_ASYNC_TASKS =
  import.meta.env.VITE_OPENTEAM_INTERNAL_ASYNC_TASKS === "true";

export function isPinnableChannel(channel: ChannelView | undefined) {
  return channel?.kind === "bot_dm" || channel?.kind === "group";
}

export const sidebarSensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
  KeyboardSensor,
];

/** "4:12 PM" today, "Yesterday", otherwise "9/1". */
export function timeLabel(value: string) {
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

/** Same as timeLabel but names the weekday inside the last week. */
export function compactTimeLabel(value: string) {
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

export function rowBot(row: ChannelRowData, botById: ReadonlyMap<string, BotView>) {
  return row.channel.kind === "bot_dm"
    ? botById.get(row.channel.members[0]?.botId ?? "")
    : undefined;
}

export function rowPresence(row: ChannelRowData, botById: ReadonlyMap<string, BotView>) {
  return botPresence(rowBot(row, botById), row.running, row.hasActiveTask);
}

/**
 * The one-line description shown under a channel name. Status wins over the
 * latest message so a working or blocked bot is obvious at a glance.
 */
export function rowPreview(
  row: ChannelRowData,
  botById: ReadonlyMap<string, BotView>
): { text: string; presence: BotPresence | null } {
  const { channel, latest } = row;
  const bot = rowBot(row, botById);
  const author = latest?.senderBotId ? botById.get(latest.senderBotId)?.name : null;
  const latestPreview = latest
    ? `${author && channel.kind !== "bot_dm" ? `${author}: ` : ""}${channelMessageSummary(latest)}`
    : "";
  const onboardingInProgress = Boolean(
    bot && ["pending", "queued", "running"].includes(bot.onboardingStatus)
  );
  const presence = rowPresence(row, botById);
  if (onboardingInProgress && latestPreview) return { text: latestPreview, presence: null };
  if (presence !== "idle") return { text: presenceLabel[presence], presence };
  return {
    text: latestPreview || (channel.kind === "agent_dm" ? "Bot-to-bot chat" : "No messages yet"),
    presence: null,
  };
}

/** Avatar with a presence dot in its corner. The ring matches the row surface. */
export function PresenceAvatar({
  presence,
  children,
  ringColor,
  size,
}: {
  presence: BotPresence;
  children: ReactNode;
  ringColor: string;
  size: "sm" | "md" | "pin";
}) {
  const show = presence === "working" || presence === "attention";
  return (
    <span className="relative grid shrink-0">
      {children}
      {show ? (
        <StatusDot
          className={cn(
            "pointer-events-none absolute z-10",
            size === "sm" && "-bottom-px -right-px",
            size === "md" && "bottom-0 right-0",
            size === "pin" && "bottom-0.5 right-0.5"
          )}
          data-working-indicator={presence === "working" ? "" : undefined}
          presence={presence}
          pulse={false}
          size={size === "sm" ? 7 : size === "md" ? 9 : 11}
          style={{ boxShadow: `0 0 0 2px ${ringColor}` }}
        />
      ) : null}
    </span>
  );
}

export function ChannelPreviewTooltipContent({
  row,
  botById,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
}) {
  const { channel, latest } = row;
  const preview = rowPreview(row, botById);
  return (
    <TooltipContent
      align="start"
      className="w-[260px] rounded-lg border border-line bg-raised px-3 py-2.5 text-ink shadow-pop"
      collisionPadding={8}
      side="right"
      sideOffset={10}
    >
      <div className="flex min-w-0 items-center gap-2">
        <PresenceAvatar presence={rowPresence(row, botById)} ringColor="var(--raised)" size="sm">
          <ChannelAvatar botById={botById} channel={channel} size="sm" />
        </PresenceAvatar>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{channel.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-3">
          {compactTimeLabel(latest?.createdAt ?? channel.createdAt)}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[12.5px] leading-[18px] text-ink-2">{preview.text}</p>
    </TooltipContent>
  );
}

export function SidebarDragPreview({
  row,
  botById,
}: {
  row: ChannelRowData;
  botById: ReadonlyMap<string, BotView>;
}) {
  const { channel } = row;
  const working = sidebarRowIsWorking(row);
  const bot = rowBot(row, botById);
  const groupBots =
    channel.kind === "bot_dm"
      ? []
      : channel.members.slice(0, 2).map((member) => botById.get(member.botId));

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex -translate-y-2 flex-col items-center rounded-lg border border-line bg-raised/95 px-1.5 py-1.5 text-ink shadow-pop backdrop-blur-xl",
        bot ? "h-[94px] w-[84px] gap-0.5" : "min-h-[112px] w-[116px] justify-center gap-2"
      )}
      data-sidebar-drag-preview=""
    >
      <PresenceAvatar presence={working ? "working" : "idle"} ringColor="var(--raised)" size="pin">
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
      </PresenceAvatar>
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
