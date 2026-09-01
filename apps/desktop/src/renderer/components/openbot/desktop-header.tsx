import type { BotView, ChannelView } from "@openbot/contracts";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronsRight,
  Info,
  MessageCircle,
  Monitor,
  Settings,
} from "lucide-react";
import type { A2AExchangePhase } from "../../lib/a2a-exchange";
import { cn } from "../../lib/cn";
import { measureUntilNextPaint } from "../../lib/performance";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, ChannelAvatar } from "./avatar";

export function DesktopHeader({
  agentNameById,
  botById,
  detailsOpen,
  directPerspectiveBotId,
  exchange,
  inspectorResizing,
  inspectorWidth,
  inspectorMode,
  selected,
  selectedBot,
  onDetailsOpenChange,
  onShowSettings,
  onShowSummary,
}: {
  agentNameById: ReadonlyMap<string, string>;
  botById: ReadonlyMap<string, BotView>;
  detailsOpen: boolean;
  directPerspectiveBotId?: string;
  exchange?: {
    channel: ChannelView;
    perspectiveBotId: string;
    phase: A2AExchangePhase;
  };
  inspectorResizing: boolean;
  inspectorWidth: number;
  inspectorMode: "summary" | "settings" | "routine";
  selected: ChannelView | null;
  selectedBot?: BotView;
  onDetailsOpenChange: (open: boolean) => void;
  onShowSettings: () => void;
  onShowSummary: () => void;
}) {
  const changeDetails = (open: boolean) => {
    measureUntilNextPaint("view.details-toggle", { opening: open });
    onDetailsOpenChange(open);
  };
  const directChannel = exchange?.channel ?? (selected?.kind === "agent_dm" ? selected : undefined);
  const directNameFallbacks = directChannel?.name.split(" ↔ ") ?? [];
  const directMembers = directChannel
    ? directChannel.members
        .slice(0, 2)
        .map((member, index) => {
          const bot = botById.get(member.botId);
          return {
            bot,
            botId: member.botId,
            name:
              bot?.name ?? agentNameById.get(member.botId) ?? directNameFallbacks[index] ?? "Agent",
          };
        })
        .sort(
          (left, right) =>
            Number(right.botId === (exchange?.perspectiveBotId ?? directPerspectiveBotId)) -
            Number(left.botId === (exchange?.perspectiveBotId ?? directPerspectiveBotId))
        )
    : [];
  const directTail = (
    <>
      <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
      <BotAvatar bot={directMembers[1]?.bot} size="xs" />
      <span className="ml-0.5 text-[13px] font-medium">{directMembers[1]?.name ?? "Agent"}</span>
    </>
  );

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-10 items-center bg-background">
      {selected ? (
        <>
          <div className="flex h-full min-w-0 flex-1 items-center px-4">
            <h2
              aria-label={selected.name}
              className="electron-drag pointer-events-auto inline-flex h-6 max-w-full items-center gap-1.5 overflow-hidden"
              data-chat-header-title=""
            >
              {directChannel ? (
                <div
                  className="inline-flex min-w-max shrink-0 items-center gap-1.5 whitespace-nowrap"
                  data-a2a-header-pair=""
                >
                  <BotAvatar bot={directMembers[0]?.bot} size="xs" />
                  <span className="ml-0.5 text-[13px] font-medium">
                    {directMembers[0]?.name ?? "Agent"}
                  </span>
                  {exchange ? (
                    <span
                      className="a2a-exchange-header-tail shrink-0 whitespace-nowrap"
                      data-a2a-exchange-header-tail=""
                      data-state={exchange.phase}
                    >
                      {directTail}
                    </span>
                  ) : (
                    directTail
                  )}
                </div>
              ) : selected.kind === "bot_dm" ? (
                <button
                  aria-label="View conversation details"
                  className="electron-no-drag inline-flex min-w-0 items-center gap-1.5 rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() => {
                    changeDetails(true);
                    onShowSettings();
                  }}
                  type="button"
                >
                  {selectedBot ? (
                    <BotAvatar bot={selectedBot} size="xs" />
                  ) : (
                    <MessageCircle className="size-4 text-violet-500" />
                  )}
                  <span className="truncate text-[13px] font-medium">{selected.name}</span>
                </button>
              ) : (
                <>
                  {selected.kind === "group" ? (
                    <ChannelAvatar botById={botById} channel={selected} size="sm" />
                  ) : (
                    <MessageCircle className="size-4 text-violet-500" />
                  )}
                  <span className="truncate text-[13px] font-medium">{selected.name}</span>
                </>
              )}
            </h2>
          </div>

          <div
            className={cn(
              "electron-no-drag pointer-events-auto relative h-full shrink-0 overflow-hidden",
              !inspectorResizing && "transition-[width] duration-150 ease-out",
              !detailsOpen && !selectedBot && selected.kind !== "group" && "w-0"
            )}
            style={{
              width: detailsOpen
                ? inspectorWidth
                : selectedBot || selected.kind === "group"
                  ? 40
                  : 0,
            }}
          >
            <div
              aria-hidden={!detailsOpen}
              className={cn(
                "absolute inset-y-0 left-0 grid grid-cols-[40px_1fr_40px] items-center px-1 transition-opacity duration-150",
                detailsOpen ? "opacity-100 delay-100" : "pointer-events-none opacity-0"
              )}
              inert={!detailsOpen}
              style={{ width: inspectorWidth }}
            >
              {inspectorMode === "settings" ? (
                <>
                  <Button
                    aria-label="Back to details"
                    className="rounded-full text-foreground-tertiary"
                    onClick={onShowSummary}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="relative top-0.5 text-center text-[13px] font-medium leading-[18px]">
                    Settings
                  </span>
                </>
              ) : inspectorMode === "routine" ? (
                <>
                  <Button
                    aria-label="Back to Routines"
                    className="rounded-full text-foreground-tertiary"
                    onClick={onShowSummary}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="relative top-0.5 text-center text-[13px] font-medium leading-[18px]">
                    Routine
                  </span>
                </>
              ) : (
                <>
                  <span />
                  <span />
                </>
              )}
              <div className="flex justify-end">
                {inspectorMode === "summary" && (selectedBot || selected.kind === "group") ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selected.kind === "group" ? "Conversation settings" : "Bot settings"
                        }
                        className="rounded-full text-foreground-tertiary"
                        onClick={() => {
                          measureUntilNextPaint("view.inspector-mode", { mode: "settings" });
                          onShowSettings();
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Settings className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {selected.kind === "group" ? "Conversation settings" : "Bot settings"}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Close details"
                      className="rounded-full text-foreground-tertiary hover:bg-transparent hover:text-foreground"
                      onClick={() => changeDetails(false)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ChevronsRight className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Close details</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {selectedBot || selected.kind === "group" ? (
              <div
                aria-hidden={detailsOpen}
                className={cn(
                  "absolute inset-y-0 right-3 flex items-center transition-opacity duration-150",
                  detailsOpen ? "pointer-events-none opacity-0" : "opacity-100 delay-100"
                )}
                inert={detailsOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={
                        selected.kind === "group"
                          ? "View conversation details"
                          : "OpenBot's Computer"
                      }
                      className="rounded-full text-foreground-tertiary"
                      onClick={() => changeDetails(true)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      {selected.kind === "group" ? (
                        <Info className="size-4" />
                      ) : (
                        <Monitor className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {selected.kind === "group" ? "Conversation details" : "OpenBot's Computer"}
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </header>
  );
}
