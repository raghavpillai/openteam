import type { BotView, ChannelMessageView, ChannelView, RunView } from "@openbot/contracts";
import {
  Archive,
  BriefcaseBusiness,
  Cable,
  FileClock,
  Hash,
  LoaderCircle,
  Monitor,
  Plus,
  RotateCw,
  Search,
  Settings,
} from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { ChannelAvatar } from "./avatar";

export type BotRowAction = "computer" | "settings" | "transcript" | "retry" | "archive";

function timeLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startValue === startToday - 86_400_000) return "Yesterday";
  if (startValue !== startToday) {
    return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

const ChannelRow = memo(function ChannelRow({
  channel,
  botById,
  latest,
  running,
  selected,
  onSelect,
  onBotAction,
}: {
  channel: ChannelView;
  botById: ReadonlyMap<string, BotView>;
  latest?: ChannelMessageView;
  running?: RunView;
  selected: boolean;
  onSelect: (id: string) => void;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
}) {
  const author = latest?.senderBotId ? botById.get(latest.senderBotId)?.name : null;
  const bot = channel.kind === "bot_dm" ? botById.get(channel.members[0]?.botId ?? "") : undefined;
  const row = (
    <Button
      className={cn(
        "group flex h-[53px] w-full items-center gap-2.5 rounded-[9px] px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
        selected ? "bg-[#dadada]" : "hover:bg-[#e6e6e6]"
      )}
      onClick={() => onSelect(channel.id)}
      type="button"
      variant="ghost"
    >
      <ChannelAvatar botById={botById} channel={channel} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{channel.name}</span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-[#505050]">
            {timeLabel(latest?.createdAt ?? channel.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] font-normal leading-4 text-[#535353]">
          {running
            ? "Working…"
            : bot?.status === "provisioning"
              ? "Starting up…"
              : bot?.status === "failed"
                ? "Setup needs attention"
                : latest
                  ? `${author ? `${author}: ` : ""}${latest.content}`
                  : channel.kind === "agent_dm"
                    ? "Private bot exchange"
                    : "No messages yet"}
        </span>
      </span>
    </Button>
  );
  if (!bot) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onBotAction(bot, "computer")}>
          <Monitor className="size-4" /> Open computer
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onBotAction(bot, "settings")}>
          <Settings className="size-4" /> Settings
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onBotAction(bot, "transcript")}>
          <FileClock className="size-4" /> View transcript
        </ContextMenuItem>
        {bot.status === "failed" && (
          <ContextMenuItem onSelect={() => onBotAction(bot, "retry")}>
            <RotateCw className="size-4" /> Retry setup
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onBotAction(bot, "archive")}
        >
          <Archive className="size-4" /> Archive bot
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export const Sidebar = memo(function Sidebar({
  channels,
  botById,
  latestMessageByChannel,
  activeRunByChannel,
  selectedId,
  search,
  creating,
  onSearch,
  onSelect,
  onNewBot,
  onNewGroup,
  onBotAction,
  pendingBot,
}: {
  channels: ChannelView[];
  botById: ReadonlyMap<string, BotView>;
  latestMessageByChannel: ReadonlyMap<string, ChannelMessageView>;
  activeRunByChannel: ReadonlyMap<string, RunView>;
  selectedId: string | null;
  search: string;
  creating?: boolean;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  onBotAction: (bot: BotView, action: BotRowAction) => void;
  pendingBot?: { name: string; color: string } | null;
}) {
  const rows = useMemo(
    () =>
      channels.map((channel) => ({
        channel,
        latest: latestMessageByChannel.get(channel.id),
        running: activeRunByChannel.get(channel.id),
      })),
    [activeRunByChannel, channels, latestMessageByChannel]
  );
  return (
    <aside className="flex w-[265px] shrink-0 flex-col border-r bg-[#f5f5f5]">
      <div className="electron-drag flex h-[47px] shrink-0 items-center justify-end px-[13px] pt-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Create"
              className="electron-no-drag rounded-full text-[#666] hover:bg-transparent focus-visible:ring-0"
              size="icon-sm"
              variant="ghost"
            >
              <Plus className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            alignOffset={3}
            align="end"
            className="w-[188px] rounded-xl border-[#d0d0d0] p-1 shadow-[0_8px_18px_rgba(0,0,0,0.14)]"
            sideOffset={-1}
          >
            <DropdownMenuItem className="text-[13px]" onSelect={onNewBot}>
              <BriefcaseBusiness className="size-3.5" /> New Bot
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[13px]" onSelect={onNewGroup}>
              <Hash className="size-3.5" /> New Channel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative px-3 pb-2.5">
        <Search className="pointer-events-none absolute left-5 top-[11px] size-3.5 text-[#818181]" />
        <Input
          className="relative top-0.5 h-8 rounded-[8px] border border-[#cbcbcb] bg-[#e6e6e6] pl-7 text-[13px] shadow-none placeholder:text-[#545454] focus-visible:border-[#c3c3c3] focus-visible:ring-0"
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search"
          value={search}
        />
      </div>
      <nav className="grok-scrollbar min-h-0 flex-1 overflow-y-auto px-3">
        {creating && (
          <div className="flex h-[53px] w-full items-center gap-2.5 rounded-[9px] bg-[#dadada] px-2 text-[13px] font-medium">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#cfcfcf] text-[#666]">
              <Plus className="size-4" />
            </span>
            Create new
          </div>
        )}
        {pendingBot && (
          <div className="flex h-14 w-full items-center gap-2.5 rounded-[9px] px-2 text-left opacity-70">
            <div
              className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
              style={{ backgroundColor: pendingBot.color }}
            >
              ●
            </div>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{pendingBot.name}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin text-blue-500" /> Creating…
              </span>
            </span>
          </div>
        )}
        {rows.map(({ channel, latest, running }) => (
          <ChannelRow
            botById={botById}
            channel={channel}
            key={channel.id}
            latest={latest}
            onSelect={onSelect}
            onBotAction={onBotAction}
            running={running}
            selected={channel.id === selectedId}
          />
        ))}
      </nav>
      <div className="flex flex-col gap-2.5 px-3 pb-[22px] pt-2">
        <Button className="h-8 w-full justify-start px-2 text-[13px] font-normal" variant="ghost">
          <span className="grid size-7 shrink-0 place-items-center rounded-full border bg-background">
            <Cable className="size-3.5" />
          </span>
          Plugins
        </Button>
        <Button className="h-8 w-full justify-start px-2 text-[13px] font-normal" variant="ghost">
          <span className="grid size-7 place-items-center rounded-full bg-[#e7e7e7] text-[9px] text-[#969696]">
            RP
          </span>
          <span className="min-w-0 flex-1 text-left">Raghav Pillai</span>
        </Button>
      </div>
    </aside>
  );
});
