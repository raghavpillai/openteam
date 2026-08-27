import type { BotView, ChannelView } from "@openbot/contracts";
import { ChevronLeft, ChevronsRight, MessageCircle, Monitor, Settings } from "lucide-react";
import { cn } from "../../lib/cn";
import { measureUntilNextPaint } from "../../lib/performance";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, ChannelAvatar } from "./avatar";

export function DesktopHeader({
  botById,
  detailsOpen,
  inspectorResizing,
  inspectorWidth,
  inspectorMode,
  selected,
  selectedBot,
  onDetailsOpenChange,
  onShowSettings,
  onShowSummary,
}: {
  botById: ReadonlyMap<string, BotView>;
  detailsOpen: boolean;
  inspectorResizing: boolean;
  inspectorWidth: number;
  inspectorMode: "summary" | "settings";
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

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-10 items-center bg-background">
      {selected ? (
        <>
          <div className="min-w-0 flex-1 px-4">
            <div className="electron-drag pointer-events-auto inline-flex max-w-full items-center gap-1.5">
              {selected.kind === "bot_dm" ? (
                selectedBot ? (
                  <BotAvatar bot={selectedBot} size="xs" />
                ) : (
                  <MessageCircle className="size-4 text-violet-500" />
                )
              ) : selected.kind === "group" ? (
                <ChannelAvatar botById={botById} channel={selected} size="sm" />
              ) : (
                <MessageCircle className="size-4 text-violet-500" />
              )}
              <span className="truncate text-[13px] font-medium">{selected.name}</span>
            </div>
          </div>

          <div
            className={cn(
              "electron-no-drag pointer-events-auto relative h-full shrink-0 overflow-hidden",
              !inspectorResizing && "transition-[width] duration-150 ease-out",
              !detailsOpen && !selectedBot && "w-0"
            )}
            style={{ width: detailsOpen ? inspectorWidth : selectedBot ? 40 : 0 }}
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
                    aria-label="Back to bot details"
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
              ) : (
                <>
                  <span />
                  <span />
                </>
              )}
              <div className="flex justify-end">
                {inspectorMode === "summary" && selectedBot ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Bot settings"
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
                    <TooltipContent>Bot settings</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Hide details"
                      className="rounded-full text-foreground-tertiary"
                      onClick={() => changeDetails(false)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ChevronsRight className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Hide details</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {selectedBot ? (
              <div
                aria-hidden={detailsOpen}
                className={cn(
                  "absolute inset-y-0 right-1 flex items-center transition-opacity duration-150",
                  detailsOpen ? "pointer-events-none opacity-0" : "opacity-100 delay-100"
                )}
                inert={detailsOpen}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Show computer"
                      className="rounded-full text-foreground-tertiary"
                      onClick={() => changeDetails(true)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Monitor className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Show computer</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </header>
  );
}
