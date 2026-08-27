import { Search, SmilePlus } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";

export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;

const EMOJI_GROUPS = [
  {
    label: "Smileys & emotion",
    emojis: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "🤣",
      "😂",
      "🙂",
      "🙃",
      "🫠",
      "😉",
      "😊",
      "😇",
      "🥰",
      "😍",
      "🤩",
      "😘",
      "😗",
      "☺️",
      "😚",
      "😙",
      "🥲",
      "😋",
      "😛",
      "😜",
      "🤪",
      "😝",
      "🤑",
      "🤗",
      "🤭",
      "🫢",
      "🫣",
      "🤫",
      "🤔",
      "🫡",
      "🤐",
      "🤨",
      "😐",
      "😑",
      "😶",
      "🫥",
      "😏",
      "😒",
      "🙄",
      "😬",
      "😮‍💨",
      "🤥",
      "🫨",
      "🙂‍↔️",
      "🙂‍↕️",
      "😌",
      "😔",
      "😪",
      "🤤",
      "😴",
      "😷",
      "🤒",
      "🤕",
      "🤢",
      "🤮",
      "🤧",
      "🥳",
    ],
  },
  {
    label: "Gestures & symbols",
    emojis: [
      "👍",
      "👎",
      "👏",
      "🙌",
      "🫶",
      "🤝",
      "🙏",
      "💪",
      "👌",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "👀",
      "🧠",
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "💯",
      "✨",
      "🔥",
      "🎉",
      "🎊",
      "🚀",
      "✅",
      "❌",
      "❗",
    ],
  },
] as const;

export function EmojiGrid({
  onSelect,
  selectedEmoji,
  query = "",
}: {
  onSelect: (emoji: string) => void;
  selectedEmoji?: string | null;
  query?: string;
}) {
  const groups = useMemo(
    () =>
      query.trim()
        ? [{ label: "Emoji", emojis: EMOJI_GROUPS.flatMap((group) => group.emojis) }]
        : EMOJI_GROUPS,
    [query]
  );
  return (
    <div className="grok-scrollbar max-h-[266px] overflow-y-auto px-3 pb-3">
      {groups.map((group) => (
        <section key={group.label}>
          <div className="sticky top-0 z-10 bg-popover py-2 text-[12px] font-medium text-muted-foreground">
            {group.label}
          </div>
          <div className="grid grid-cols-8 gap-0.5">
            {group.emojis.map((emoji) => (
              <button
                aria-label={`React with ${emoji}`}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg text-[20px] transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                  selectedEmoji === emoji && "bg-accent ring-1 ring-input"
                )}
                key={emoji}
                onClick={() => onSelect(emoji)}
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function EmojiPanel({
  onSelect,
  selectedEmoji,
}: {
  onSelect: (emoji: string) => void;
  selectedEmoji?: string | null;
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
      <EmojiGrid onSelect={onSelect} query={query} selectedEmoji={selectedEmoji} />
    </>
  );
}

export function EmojiPicker({
  children,
  compactFirst = false,
  onSelect,
  selectedEmoji,
}: {
  children: ReactNode;
  compactFirst?: boolean;
  onSelect: (emoji: string) => void;
  selectedEmoji?: string | null;
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
              selectedEmoji={selectedEmoji}
            />
          ) : (
            <div className="flex items-center gap-1">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  aria-label={`React with ${emoji}`}
                  className={cn(
                    "flex size-[30px] items-center justify-center rounded-lg text-[20px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    selectedEmoji === emoji && "bg-accent ring-1 ring-input"
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
