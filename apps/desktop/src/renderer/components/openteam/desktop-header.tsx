import type { BotView, ChannelView } from "@openteam/contracts";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  X,
  Info,
  MessageCircle,
  Settings,
} from "lucide-react";
import { useRef } from "react";
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
  inspectorWidth: number;
  inspectorMode: "summary" | "settings" | "routine";
  selected: ChannelView | null;
  selectedBot?: BotView;
  onDetailsOpenChange: (open: boolean) => void;
  onShowSettings?: () => void;
  onShowSummary: () => void;
}) {
  const computerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusNext = (ref: { current: HTMLButtonElement | null }) =>
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  const showSummary = () => {
    onShowSummary();
    focusNext(closeRef);
  };
  const changeDetails = (open: boolean) => {
    measureUntilNextPaint("view.details-toggle", { opening: open });
    onDetailsOpenChange(open);
    focusNext(
      open
        ? inspectorMode === "summary"
          ? closeRef
          : backRef
        : selected?.kind === "group"
          ? computerRef
          : titleRef
    );
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
    // The whole bar moves the window; buttons opt out via the global no-drag rule.
    <header className="desktop-conversation-header electron-drag pointer-events-none absolute inset-x-0 top-0 z-30 flex h-11 items-center bg-background">
      {selected ? (
        <>
          <div
            className={cn(
              "desktop-conversation-title flex h-full min-w-0 flex-1 items-center",
              selected.kind === "group" ? "px-3" : "px-4"
            )}
          >
            <h2
              aria-label={selected.name}
              className="pointer-events-auto inline-flex h-6 max-w-full items-center gap-1.5 overflow-hidden"
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
                  ref={titleRef}
                  aria-label="View conversation details"
                  aria-expanded={detailsOpen}
                  className="desktop-conversation-pill electron-no-drag inline-flex min-w-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() => {
                    if (detailsOpen && inspectorMode === "summary") changeDetails(false);
                    else {
                      changeDetails(true);
                      showSummary();
                    }
                  }}
                  type="button"
                >
                  {selectedBot ? (
                    <BotAvatar bot={selectedBot} size="xs" />
                  ) : (
                    <MessageCircle className="size-4 text-violet-500" />
                  )}
                  <span className="truncate text-[13px] font-medium">{selected.name}</span>
                  <ChevronRight
                    aria-hidden
                    className="desktop-conversation-chevron size-3 shrink-0"
                  />
                </button>
              ) : (
                <button
                  aria-label="View conversation details"
                  className="electron-no-drag inline-flex min-w-0 items-center gap-1.5 rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  onClick={() => {
                    changeDetails(true);
                    showSummary();
                  }}
                  type="button"
                >
                  {selected.kind === "group" ? (
                    <ChannelAvatar botById={botById} channel={selected} size="sm" compact />
                  ) : (
                    <MessageCircle className="size-4 text-violet-500" />
                  )}
                  <span className="truncate text-[13px] font-medium">{selected.name}</span>
                </button>
              )}
            </h2>
          </div>

          <div
            className={cn(
              "pointer-events-auto relative h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-[var(--ease-details)] motion-reduce:transition-none",
              !detailsOpen && !selectedBot && selected.kind !== "group" && "w-0"
            )}
            style={{
              width: detailsOpen ? inspectorWidth : selected.kind === "group" ? 40 : 0,
            }}
          >
            <div
              aria-hidden={!detailsOpen}
              className={cn(
                "absolute inset-y-0 left-0 grid grid-cols-[40px_1fr_40px] items-center px-3 transition-opacity duration-[var(--motion-reveal)] ease-[var(--ease-pane)]",
                detailsOpen ? "opacity-100" : "pointer-events-none opacity-0"
              )}
              inert={!detailsOpen}
              style={{ width: inspectorWidth }}
            >
              {inspectorMode === "settings" ? (
                <>
                  <Button
                    aria-label="Back to details"
                    ref={backRef}
                    className="rounded-full text-foreground-tertiary"
                    onClick={showSummary}
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
                    ref={backRef}
                    className="rounded-full text-foreground-tertiary"
                    onClick={showSummary}
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
                {selected.kind === "group" && inspectorMode === "summary" && onShowSettings && (
                  <Button
                    aria-label="Conversation settings"
                    className="mr-1 shrink-0 rounded-full text-foreground-secondary"
                    onClick={() => {
                      onShowSettings();
                      focusNext(backRef);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Settings className="size-3.5" />
                  </Button>
                )}
                <Button
                  ref={closeRef}
                  aria-label="Close details"
                  title="Close"
                  className="desktop-elevated-control desktop-details-close"
                  onClick={() => changeDetails(false)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
            {selected.kind === "group" ? (
              <div
                aria-hidden={detailsOpen}
                className={cn(
                  "absolute inset-y-0 right-3 flex items-center transition-opacity duration-[var(--motion-reveal)] ease-[var(--ease-pane)]",
                  detailsOpen ? "pointer-events-none opacity-0" : "opacity-100"
                )}
                inert={detailsOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="View conversation details"
                      className="rounded-full text-foreground-tertiary"
                      ref={computerRef}
                      onClick={() => changeDetails(true)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Info className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Conversation details</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </header>
  );
}
