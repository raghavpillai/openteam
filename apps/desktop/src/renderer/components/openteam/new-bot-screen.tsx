import type { BotView, ChannelView } from "@openteam/contracts";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { PromptInput } from "../ai-elements/prompt-input";
import { ChannelAvatar } from "./avatar";

export function NewBotScreen({
  channels,
  botById,
  onCreateBot,
  onCancel,
  onSelect,
}: {
  channels: ChannelView[];
  botById: ReadonlyMap<string, BotView>;
  onCreateBot: () => void;
  onCancel: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (resultsOpen) {
        setResultsOpen(false);
        return;
      }
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, resultsOpen]);

  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return channels.filter(
      (channel) =>
        channel.kind === "bot_dm" &&
        (!normalized || channel.name.toLowerCase().includes(normalized))
    );
  }, [channels, query]);
  const estimateResultSize = useCallback(() => 36, []);
  const resultKey = useCallback(
    (index: number) => matches[index]?.id ?? `missing:${index}`,
    [matches]
  );
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    activeIndex: activeIndex > 0 ? activeIndex - 1 : undefined,
    count: matches.length,
    estimateSize: estimateResultSize,
    getKey: resultKey,
    initialViewportSize: 360,
    maxItems: 28,
    overscan: 144,
    scrollRef: resultsRef,
  });

  const openActiveResult = () => {
    if (activeIndex === 0) {
      onCreateBot();
      return;
    }
    const channel = matches[activeIndex - 1];
    if (channel) onSelect(channel.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="electron-drag relative flex h-11 shrink-0 items-center border-b px-2 text-[13px] text-muted-foreground">
        <span className="shrink-0">To:</span>
        <input
          aria-controls="new-bot-results"
          aria-activedescendant={
            activeIndex > 0 ? `new-bot-result-${matches[activeIndex - 1]?.id}` : undefined
          }
          aria-expanded={resultsOpen}
          aria-label="Search or create bots"
          className="electron-no-drag min-w-0 flex-1 bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setResultsOpen(true);
            if (resultsRef.current) resultsRef.current.scrollTop = 0;
          }}
          onFocus={() => setResultsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % (matches.length + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + matches.length + 1) % (matches.length + 1));
            } else if (event.key === "Enter" && resultsOpen) {
              event.preventDefault();
              openActiveResult();
            }
          }}
          placeholder="Search or create Bots"
          ref={searchRef}
          value={query}
        />
        {resultsOpen && (
          <div
            className="absolute left-[33px] top-[35px] z-20 w-[560px] max-w-[calc(100%-48px)] overflow-hidden rounded-[13px] border border-input bg-popover text-popover-foreground shadow-[0_12px_30px_rgba(0,0,0,0.24)]"
            id="new-bot-results"
          >
            <div className="space-y-0.5 p-1.5">
              <button
                className={`flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${activeIndex === 0 ? "bg-selected" : "hover:bg-hover"}`}
                onClick={onCreateBot}
                onMouseEnter={() => setActiveIndex(0)}
                type="button"
              >
                <span className="grid size-5 place-items-center rounded-full bg-subtle text-muted-foreground">
                  <Plus className="size-3.5" />
                </span>
                Create new Bot
              </button>
              <div
                aria-label={`${matches.length} existing Bots`}
                className="grok-scrollbar max-h-[360px] overflow-y-auto"
                ref={resultsRef}
                role="listbox"
              >
                <div className="relative w-full" style={{ height: totalSize }}>
                  {virtualItems.map((virtualItem) => {
                    const channel = matches[virtualItem.index];
                    if (!channel) return null;
                    return (
                      <div
                        className="absolute inset-x-0 top-0"
                        key={virtualItem.key}
                        ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <button
                          aria-posinset={virtualItem.index + 1}
                          aria-selected={activeIndex === virtualItem.index + 1}
                          aria-setsize={matches.length}
                          className={`flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${activeIndex === virtualItem.index + 1 ? "bg-selected" : "hover:bg-hover"}`}
                          id={`new-bot-result-${channel.id}`}
                          onClick={() => onSelect(channel.id)}
                          onMouseEnter={() => setActiveIndex(virtualItem.index + 1)}
                          role="option"
                          type="button"
                        >
                          <ChannelAvatar botById={botById} channel={channel} size="sm" />
                          <span className="truncate">{channel.name}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flex h-10 items-center justify-end gap-2 border-t px-2.5 text-[10px] text-muted-foreground">
              <kbd className="rounded border border-input bg-sunken px-1 py-0.5 font-sans text-foreground-secondary">
                Tab
              </kbd>
              <span>add</span>
              <kbd className="rounded border border-input bg-sunken px-1 py-0.5 font-sans text-foreground-secondary">
                ↵
              </kbd>
              <span>open</span>
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1" />
      <PromptInput
        disabled
        onSubmit={() => undefined}
        onStage={() => Promise.reject(new Error("Create the bot before attaching files."))}
        placeholder="Message Bot"
      />
    </div>
  );
}
