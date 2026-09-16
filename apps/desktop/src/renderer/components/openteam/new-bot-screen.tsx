import type { BotView, ChannelView } from "@openteam/contracts";
import { Plus, UsersRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import {
  desktopDurableSendController,
  discardDesktopDeliveryStages,
  stageDesktopDeliveryFile,
} from "../../lib/durable-sends";
import { PromptInput } from "../ai-elements/prompt-input";
import { ChannelAvatar } from "./avatar";

export function NewBotScreen({
  channels,
  botById,
  onCreateBot,
  onCreateGroup,
  onGroupModeChange,
  onCancel,
  onSelect,
}: {
  channels: ChannelView[];
  botById: ReadonlyMap<string, BotView>;
  onCreateBot: () => void;
  onCreateGroup: (botIds: string[]) => Promise<ChannelView>;
  onGroupModeChange: (group: boolean) => void;
  onCancel: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [group, setGroup] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Reuse a successfully created room if staging/enqueueing the first message fails.
  const createdRoom = useRef<ChannelView | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || submitting) return;
      event.preventDefault();
      if (resultsOpen) setResultsOpen(false);
      else onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, resultsOpen, submitting]);

  const actionCount = group ? 0 : 2;
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return channels.filter(
      (channel) =>
        channel.kind === "bot_dm" &&
        !recipients.includes(channel.members[0]?.botId ?? "") &&
        (!group || botById.get(channel.members[0]?.botId ?? "")?.status === "active") &&
        (!normalized || channel.name.toLowerCase().includes(normalized))
    );
  }, [channels, query, recipients, group, botById]);
  const estimateResultSize = useCallback(() => 38, []);
  const resultKey = useCallback(
    (index: number) => matches[index]?.id ?? `missing:${index}`,
    [matches]
  );
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    activeIndex: activeIndex >= actionCount ? activeIndex - actionCount : undefined,
    count: matches.length,
    estimateSize: estimateResultSize,
    getKey: resultKey,
    initialViewportSize: 320,
    maxItems: 28,
    overscan: 144,
    scrollRef: resultsRef,
  });
  const choose = (channel: ChannelView) => {
    if (!group) {
      onSelect(channel.id);
      return;
    }
    const botId = channel.members[0]?.botId;
    if (!botId || recipients.length >= 6 || createdRoom.current || submitting) return;
    setRecipients((current) => [...current, botId]);
    setQuery("");
    setActiveIndex(0);
    searchRef.current?.focus();
  };
  const startGroup = () => {
    setGroup(true);
    onGroupModeChange(true);
    setActiveIndex(0);
    searchRef.current?.focus();
  };
  const openActiveResult = () => {
    if (!group && activeIndex === 0) {
      onCreateBot();
      return;
    }
    if (!group && activeIndex === 1) {
      startGroup();
      return;
    }
    const channel = matches[activeIndex - actionCount];
    if (channel) choose(channel);
  };
  const recipientLimitReached = group && recipients.length >= 6;
  const resultCount = recipientLimitReached ? 0 : matches.length + actionCount;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="electron-drag relative flex min-h-11 shrink-0 items-center border-b px-3 text-[13px] text-muted-foreground">
        <span className="shrink-0">To:</span>
        <div className="electron-no-drag flex min-w-0 flex-1 flex-wrap items-center gap-1 px-1 py-1.5">
          {recipients.map((id) => (
            <span
              key={id}
              className="flex max-w-[180px] items-center gap-1 rounded-md bg-subtle px-1.5 py-1 text-foreground"
            >
              <span className="truncate">{botById.get(id)?.name ?? "Bot"}</span>
              <button
                type="button"
                disabled={submitting || Boolean(createdRoom.current)}
                aria-label={`Remove ${botById.get(id)?.name ?? "Bot"}`}
                onClick={() => {
                  setRecipients((current) => current.filter((value) => value !== id));
                  setResultsOpen(true);
                  searchRef.current?.focus();
                }}
                className="grid size-4 shrink-0 place-items-center rounded hover:bg-hover"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            aria-controls="new-bot-results"
            aria-activedescendant={
              resultsOpen && !recipientLimitReached
                ? activeIndex >= actionCount
                  ? matches[activeIndex - actionCount]
                    ? `new-bot-result-${matches[activeIndex - actionCount]!.id}`
                    : undefined
                  : `new-chat-action-${activeIndex}`
                : undefined
            }
            aria-expanded={resultsOpen}
            aria-label="Search or create bots"
            role="combobox"
            className="min-w-[100px] flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            disabled={submitting || Boolean(createdRoom.current)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setResultsOpen(true);
              if (resultsRef.current) resultsRef.current.scrollTop = 0;
            }}
            onFocus={() => setResultsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setResultsOpen(true);
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex(
                  (index) => (index + delta + Math.max(1, resultCount)) % Math.max(1, resultCount)
                );
              } else if (
                (event.key === "Enter" || (event.key === "Tab" && group && !event.shiftKey)) &&
                resultsOpen &&
                resultCount > 0
              ) {
                event.preventDefault();
                openActiveResult();
              } else if (event.key === "Backspace" && !query && recipients.length)
                setRecipients((current) => current.slice(0, -1));
            }}
            placeholder={recipients.length ? "Add Bots" : "Search or create Bots"}
            ref={searchRef}
            value={query}
          />
        </div>
        <button
          type="button"
          aria-label="Close New Chat"
          disabled={submitting}
          onClick={onCancel}
          className="electron-no-drag grid size-7 shrink-0 place-items-center rounded-lg text-foreground-tertiary hover:bg-subtle"
        >
          <X className="size-4" />
        </button>
        {resultsOpen && !createdRoom.current && (
          <div
            className="electron-no-drag absolute left-[33px] top-full z-20 w-[560px] max-w-[calc(100%-48px)] overflow-hidden rounded-[13px] border border-input bg-popover text-popover-foreground shadow-[0_12px_30px_rgba(0,0,0,0.16)]"
            id="new-bot-results"
            role="listbox"
            aria-label="Chat recipients"
          >
            <div className="space-y-0.5 p-1.5">
              {!group && (
                <>
                  <button
                    id="new-chat-action-0"
                    role="option"
                    aria-selected={activeIndex === 0}
                    className={`flex h-[38px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${activeIndex === 0 ? "bg-selected" : "hover:bg-hover"}`}
                    onClick={onCreateBot}
                    onMouseEnter={() => setActiveIndex(0)}
                    type="button"
                  >
                    <span className="grid size-5 place-items-center rounded-full bg-subtle text-muted-foreground">
                      <Plus className="size-3.5" />
                    </span>
                    Create new Bot
                  </button>
                  <button
                    id="new-chat-action-1"
                    role="option"
                    aria-selected={activeIndex === 1}
                    className={`flex h-[38px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${activeIndex === 1 ? "bg-selected" : "hover:bg-hover"}`}
                    onClick={startGroup}
                    onMouseEnter={() => setActiveIndex(1)}
                    type="button"
                  >
                    <span className="grid size-5 place-items-center rounded-full bg-subtle text-muted-foreground">
                      <UsersRound className="size-3.5" />
                    </span>
                    Create group chat
                  </button>
                </>
              )}
              <div
                aria-label={`${matches.length} existing Bots`}
                className="bot-scrollbar max-h-[320px] overflow-y-auto"
                ref={resultsRef}
                role="group"
              >
                {group && recipients.length >= 6 ? (
                  <p className="px-2 py-3 text-[12px] text-foreground-secondary">
                    Up to six Bots can join a group chat.
                  </p>
                ) : (
                  <div className="relative w-full" style={{ height: totalSize }}>
                    {virtualItems.map((item) => {
                      const channel = matches[item.index];
                      if (!channel) return null;
                      return (
                        <div
                          className="absolute inset-x-0 top-0"
                          key={item.key}
                          ref={(node) => measureElement(item.index, item.key, node)}
                          style={{ transform: `translateY(${item.start}px)` }}
                        >
                          <button
                            aria-posinset={item.index + 1}
                            aria-selected={activeIndex === item.index + actionCount}
                            aria-setsize={matches.length}
                            className={`flex h-[38px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] ${activeIndex === item.index + actionCount ? "bg-selected" : "hover:bg-hover"}`}
                            id={`new-bot-result-${channel.id}`}
                            onClick={() => choose(channel)}
                            onMouseEnter={() => setActiveIndex(item.index + actionCount)}
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
                )}
                {group && !matches.length && (
                  <p className="px-2 py-3 text-[12px] text-foreground-secondary">
                    {query ? "No matching Bots." : "All available Bots are selected."}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1" onClick={() => setResultsOpen(false)} />
      <div onFocusCapture={() => setResultsOpen(false)}>
        <PromptInput
          disabled={!group || recipients.length === 0 || submitting}
          onSubmit={async (content, attachments, options) => {
            if (!group || !recipients.length || submitting) return;
            setSubmitting(true);
            try {
              const channel = createdRoom.current ?? (await onCreateGroup(recipients));
              createdRoom.current = channel;
              await desktopDurableSendController().enqueue({
                target: { channelId: channel.id, conversationId: null },
                payload: {
                  content,
                  attachments,
                  ...(options?.richText ? { richText: options.richText } : {}),
                  ...(options?.stagedAttachments?.length
                    ? { stagedAttachments: options.stagedAttachments }
                    : {}),
                },
              });
              onSelect(channel.id);
            } finally {
              setSubmitting(false);
            }
          }}
          onStage={stageDesktopDeliveryFile}
          onDiscardStages={discardDesktopDeliveryStages}
          placeholder={
            group && recipients.length
              ? `Message ${recipients.map((id) => botById.get(id)?.name ?? "Bot").join(", ")}`
              : "Message Bot"
          }
        />
      </div>
    </div>
  );
}
