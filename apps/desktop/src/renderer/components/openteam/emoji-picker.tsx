import { SmilePlus } from "lucide-react";
import { QUICK_REACTIONS } from "@openteam/product-core/messages";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { lazy, Suspense, useState } from "react";
import { cn } from "../../lib/cn";
import type { EmojiPanelProps } from "./emoji-panel";

export { QUICK_REACTIONS } from "@openteam/product-core/messages";

let emojiPanelModule: ReturnType<typeof importEmojiPanel> | undefined;
const importEmojiPanel = () => import("./emoji-panel");
const loadEmojiPanel = () => (emojiPanelModule ??= importEmojiPanel());
const LazyEmojiPanel = lazy(loadEmojiPanel);

export const preloadEmojiPanel = () => void loadEmojiPanel();

export function EmojiPanel(props: EmojiPanelProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-label="Loading emoji"
          className="grid h-[310px] place-items-center text-[13px] text-muted-foreground"
          role="status"
        >
          Loading emoji…
        </div>
      }
    >
      <LazyEmojiPanel {...props} />
    </Suspense>
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
    if (nextOpen && !compactFirst) preloadEmojiPanel();
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
                onClick={() => {
                  preloadEmojiPanel();
                  setExpanded(true);
                }}
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
