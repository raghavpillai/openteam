import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { computeVirtualRange } from "../../../lib/virtual-window";
import { EMOJI_GROUPS, emojiLabel, searchEmojis } from "./data";
import { buildEmojiVirtualRows, emojiVirtualRowHeight } from "./virtual-grid";

export type EmojiPanelProps = {
  onSelect: (emoji: string) => void;
  selectedEmojis?: ReadonlySet<string>;
};

function EmojiGrid({ onSelect, selectedEmojis, query = "" }: EmojiPanelProps & { query?: string }) {
  const hasQuery = query.trim().length > 0;
  const groups = useMemo(() => {
    if (!hasQuery) return EMOJI_GROUPS;
    return [{ label: "Results", emojis: searchEmojis(query) }];
  }, [hasQuery, query]);
  const rows = useMemo(() => buildEmojiVirtualRows(groups), [groups]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const range = useMemo(
    () =>
      computeVirtualRange({
        count: rows.length,
        scrollOffset,
        viewportSize: 266,
        overscan: 170,
        maxItems: 40,
        sizeAt: (index) => emojiVirtualRowHeight(rows[index]!),
      }),
    [rows, scrollOffset]
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollOffset(0);
  }, [query]);

  let stickyLabel = groups[0]?.label ?? "Emoji";
  for (let index = 0; index < rows.length; index += 1) {
    if ((range.offsets[index] ?? 0) > scrollOffset) break;
    const row = rows[index];
    if (row?.kind === "header") stickyLabel = row.label;
  }

  return (
    <div
      className="bot-scrollbar relative h-[266px] overflow-y-auto px-3 pb-3"
      onScroll={(event) => setScrollOffset(event.currentTarget.scrollTop)}
      ref={scrollRef}
    >
      <div
        aria-hidden="true"
        className="sticky top-0 z-20 -mx-0 bg-popover py-2 text-[12px] font-medium text-muted-foreground"
      >
        {stickyLabel}
      </div>
      <div className="relative -mt-8" style={{ height: range.totalSize }}>
        {Array.from(
          { length: range.endIndex - range.startIndex },
          (_, offset) => range.startIndex + offset
        ).map((index) => {
          const row = rows[index]!;
          const top = range.offsets[index] ?? 0;
          if (row.kind === "header") {
            return (
              <div
                className="absolute left-0 top-0 flex h-8 w-full items-center bg-popover text-[12px] font-medium text-muted-foreground"
                key={row.key}
                style={{ transform: `translateY(${top}px)` }}
              >
                {row.label}
              </div>
            );
          }
          if (row.kind === "empty") {
            return (
              <div
                className="absolute left-0 top-0 h-12 w-full px-1 py-2 text-[13px] text-muted-foreground"
                key={row.key}
                style={{ transform: `translateY(${top}px)` }}
              >
                No emoji found.
              </div>
            );
          }
          return (
            <div
              className="absolute left-0 top-0 grid h-[34px] w-full grid-cols-8 gap-0.5"
              key={row.key}
              style={{ transform: `translateY(${top}px)` }}
            >
              {row.emojis.map((emoji) => (
                <button
                  aria-label={`React with ${emojiLabel(emoji)}`}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg text-[20px] transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    selectedEmojis?.has(emoji) && "bg-accent ring-1 ring-input"
                  )}
                  key={emoji}
                  onClick={() => onSelect(emoji)}
                  type="button"
                >
                  {emoji}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function EmojiPanel({ onSelect, selectedEmojis }: EmojiPanelProps) {
  const [query, setQuery] = useState("");
  return (
    <>
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <Search className="size-4 text-muted-foreground" />
        <input
          aria-label="Search emoji"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          value={query}
        />
      </div>
      <EmojiGrid onSelect={onSelect} query={query} selectedEmojis={selectedEmojis} />
    </>
  );
}
