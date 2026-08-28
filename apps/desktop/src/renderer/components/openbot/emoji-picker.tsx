import { Search, SmilePlus } from "lucide-react";
import emojiData from "emojibase-data/en/data.json";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";

export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;

const EMOJI_GROUP_SPECS = [
  { id: 0, label: "Smileys & emotion" },
  { id: 1, label: "People & body" },
  { id: 3, label: "Animals & nature" },
  { id: 4, label: "Food & drink" },
  { id: 5, label: "Travel & places" },
  { id: 6, label: "Activities" },
  { id: 7, label: "Objects" },
  { id: 8, label: "Symbols" },
  { id: 9, label: "Flags" },
] as const;

type EmojiEntry = (typeof emojiData)[number];

const EMOJI_ENTRIES = emojiData
  .filter(
    (entry): entry is EmojiEntry & { group: number } =>
      typeof entry.group === "number" && EMOJI_GROUP_SPECS.some(({ id }) => id === entry.group)
  )
  .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

const EMOJI_ENTRY_BY_GLYPH = new Map(EMOJI_ENTRIES.map((entry) => [entry.emoji, entry]));

const EMOJI_GROUPS = EMOJI_GROUP_SPECS.map(({ id, label }) => ({
  label,
  emojis: EMOJI_ENTRIES.filter((entry) => entry.group === id).map((entry) => entry.emoji),
}));

const ALL_EMOJIS = EMOJI_ENTRIES.map((entry) => entry.emoji);

const normalizeEmojiQuery = (value: string) =>
  value.trim().toLocaleLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");

export const searchEmojis = (query: string): string[] => {
  const normalizedQuery = normalizeEmojiQuery(query);
  if (!normalizedQuery) return [...ALL_EMOJIS];
  const queryTokens = normalizedQuery.split(" ");

  return EMOJI_ENTRIES.map((entry, index) => {
    const emoticons = Array.isArray(entry.emoticon)
      ? entry.emoticon
      : entry.emoticon
        ? [entry.emoticon]
        : [];
    const terms = normalizeEmojiQuery(
      [entry.emoji, entry.label, ...(entry.tags ?? []), ...emoticons].join(" ")
    );
    const termTokens = terms.split(" ");
    if (!queryTokens.every((token) => terms.includes(token))) return null;

    const score =
      entry.emoji === normalizedQuery
        ? 0
        : termTokens.includes(normalizedQuery)
          ? 1
          : termTokens.some((term) => term.startsWith(normalizedQuery))
            ? 2
            : 3;
    return { emoji: entry.emoji, index, score };
  })
    .filter((result) => result !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ emoji }) => emoji);
};

const emojiLabel = (emoji: string) => EMOJI_ENTRY_BY_GLYPH.get(emoji)?.label ?? emoji;

export function EmojiGrid({
  onSelect,
  selectedEmojis,
  query = "",
}: {
  onSelect: (emoji: string) => void;
  selectedEmojis?: ReadonlySet<string>;
  query?: string;
}) {
  const hasQuery = query.trim().length > 0;
  const groups = useMemo(() => {
    if (!hasQuery) return EMOJI_GROUPS;
    return [{ label: "Results", emojis: searchEmojis(query) }];
  }, [hasQuery, query]);
  return (
    <div className="grok-scrollbar h-[266px] overflow-y-auto px-3 pb-3">
      {groups.map((group) => (
        <section key={group.label}>
          <div className="sticky top-0 z-10 bg-popover py-2 text-[12px] font-medium text-muted-foreground">
            {group.label}
          </div>
          <div className="grid grid-cols-8 gap-0.5">
            {group.emojis.map((emoji) => (
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
          {group.emojis.length === 0 && (
            <div className="px-1 py-2 text-[13px] text-muted-foreground">No emoji found.</div>
          )}
        </section>
      ))}
    </div>
  );
}

export function EmojiPanel({
  onSelect,
  selectedEmojis,
}: {
  onSelect: (emoji: string) => void;
  selectedEmojis?: ReadonlySet<string>;
}) {
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

export function EmojiPicker({
  children,
  compactFirst = false,
  onSelect,
  selectedEmojis,
}: {
  children: ReactNode;
  compactFirst?: boolean;
  onSelect: (emoji: string) => void;
  selectedEmojis?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(!compactFirst);
  const setPickerOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setExpanded(!compactFirst);
  };
  return (
    <PopoverPrimitive.Root onOpenChange={setPickerOpen} open={open}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="center"
          className={cn(
            "z-[110] overflow-hidden border border-input bg-popover text-popover-foreground shadow-[0_14px_35px_rgba(0,0,0,0.2)] outline-none animate-in fade-in-0 zoom-in-95",
            expanded ? "w-[296px] rounded-xl" : "w-auto rounded-xl p-2"
          )}
          sideOffset={8}
        >
          {expanded ? (
            <EmojiPanel
              onSelect={(emoji) => {
                onSelect(emoji);
                setOpen(false);
              }}
              selectedEmojis={selectedEmojis}
            />
          ) : (
            <div className="flex items-center gap-1">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  aria-label={`React with ${emoji}`}
                  className={cn(
                    "flex size-[30px] items-center justify-center rounded-lg text-[20px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    selectedEmojis?.has(emoji) && "bg-accent ring-1 ring-input"
                  )}
                  key={emoji}
                  onClick={() => {
                    onSelect(emoji);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {emoji}
                </button>
              ))}
              <button
                aria-label="Open emoji picker"
                className="flex size-[30px] items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => setExpanded(true)}
                type="button"
              >
                <MoreEmojiIcon />
              </button>
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function MoreEmojiIcon() {
  return <SmilePlus className="size-4" />;
}
