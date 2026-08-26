import type { BotView, ChannelView } from "@openbot/contracts";
import { ChevronLeft, ChevronsRight, MessageCircle, Monitor, Settings } from "lucide-react";
import { measureUntilNextPaint } from "../../lib/performance";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, ChannelAvatar } from "./avatar";

export function DesktopHeader({
  botById,
  detailsOpen,
  inspectorMode,
  selected,
  selectedBot,
  onDetailsOpenChange,
  onShowSettings,
  onShowSummary,
}: {
  botById: ReadonlyMap<string, BotView>;
  detailsOpen: boolean;
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
    <header className="electron-drag flex h-11 shrink-0 items-center border-b bg-background">
      {selected ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
            {selected.kind === "bot_dm" ? (
              selectedBot ? (
                <BotAvatar bot={selectedBot} size="sm" />
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

          {detailsOpen ? (
            <div className="electron-no-drag grid h-full w-80 shrink-0 grid-cols-[40px_1fr_40px] items-center border-l px-1">
              {inspectorMode === "settings" ? (
                <>
                  <Button
                    aria-label="Back to bot details"
                    className="rounded-full text-[#777]"
                    onClick={onShowSummary}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="relative top-0.5 text-center text-[12px] font-medium">
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
                        className="rounded-full text-[#777]"
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
                      className="rounded-full text-[#777]"
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
          ) : selectedBot ? (
            <div className="electron-no-drag pr-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Show computer"
                    className="rounded-full text-[#777]"
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
        </>
      ) : null}
    </header>
  );
}
