import type { BotView, ChannelView } from "@openbot/contracts";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronsRight,
  LoaderCircle,
  MessageCircle,
  Monitor,
  Pencil,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { A2AExchangePhase } from "../../lib/a2a-exchange";
import { cn } from "../../lib/cn";
import { measureUntilNextPaint } from "../../lib/performance";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  onRename,
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
  onRename: (channelId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(selected?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const finishing = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching chats must cancel editing even when the names match.
  useEffect(() => {
    setEditing(false);
    setDraft(selected?.name ?? "");
    setRenameError(false);
  }, [selected?.id, selected?.name]);

  const finishRename = async (save: boolean) => {
    if (finishing.current || !selected) return;
    const name = draft.replace(/\s+/g, " ").trim();
    if (!save || !name || name === selected.name) {
      if (!save) {
        finishing.current = true;
        window.setTimeout(() => {
          finishing.current = false;
        }, 0);
      }
      setDraft(selected.name);
      setEditing(false);
      setRenameError(false);
      return;
    }
    finishing.current = true;
    setSaving(true);
    setRenameError(false);
    try {
      await onRename(selected.id, name);
      setEditing(false);
    } catch {
      setRenameError(true);
    } finally {
      finishing.current = false;
      setSaving(false);
    }
  };
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
            <div
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
              ) : (
                <>
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
                  {editing ? (
                    <Input
                      aria-invalid={renameError}
                      aria-label="Chat name"
                      autoFocus
                      className="electron-no-drag h-6 w-[min(280px,42vw)] rounded-md border-border bg-background px-1.5 text-[13px] font-medium shadow-none focus-visible:ring-1"
                      disabled={saving}
                      maxLength={80}
                      onBlur={() => void finishRename(true)}
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void finishRename(true);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          void finishRename(false);
                        }
                      }}
                      title={renameError ? "Could not rename this chat" : undefined}
                      value={draft}
                    />
                  ) : selected.kind === "bot_dm" ? (
                    <button
                      aria-label={`Rename ${selected.name}`}
                      className="electron-no-drag group/name inline-flex min-w-0 items-center gap-1 rounded px-0.5 py-0.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/30"
                      onClick={() => setEditing(true)}
                      title="Rename chat"
                      type="button"
                    >
                      <span className="truncate text-[13px] font-medium">{selected.name}</span>
                      <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover/name:opacity-60 group-focus-visible/name:opacity-60" />
                    </button>
                  ) : (
                    <span className="truncate text-[13px] font-medium">{selected.name}</span>
                  )}
                </>
              )}
              {saving && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
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
