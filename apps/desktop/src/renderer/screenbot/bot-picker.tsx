import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BotAvatarGlyph } from "../components/openteam/avatar-picker-icons";
import type { ScreenBotBot } from "./types";

export function ScreenBotBotAvatar({ bot, size }: { bot: ScreenBotBot; size: number }) {
  if (bot.avatarDataUrl) {
    return <img alt="" className="screenbot-avatar-image" src={bot.avatarDataUrl} style={{ width: size, height: size }} />;
  }
  return (
    <BotAvatarGlyph
      color={bot.color}
      shape={normalizeRobotAvatarShape(bot.icon)}
      style={{ width: size, height: size, flex: "none" }}
    />
  );
}

const SEARCH_THRESHOLD = 7;
/** The list's tallest, and the gap kept from the screen's edge. */
const LIST_MAX = 296;
const EDGE = 12;
const GAP = 8;

/** The one choice a ScreenBot offers: which Bot it goes to. */
export function BotPicker({
  bots,
  selected,
  open,
  onOpenChange,
  onSelect,
}: {
  bots: ScreenBotBot[];
  selected: ScreenBotBot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (bot: ScreenBotBot) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** Only a highlight moved by the keyboard scrolls the list; one under the pointer stays put,
   * or hovering a half-hidden Bot at the edge would yank the list while you aim. */
  const scrollToActive = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchable = bots.length >= SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    // Every word typed must appear somewhere ("help 1" finds "Helper 1"), in any order.
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length
      ? bots.filter((bot) => {
          const haystack = `${bot.name} ${bot.title}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
      : bots;
  }, [bots, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    scrollToActive.current = true;
    setActive(Math.max(0, bots.findIndex((bot) => bot.id === selected.id)));
    requestAnimationFrame(() => (searchable ? searchRef.current : listRef.current)?.focus());
    // Open with the current choice highlighted; later renders keep the pointer's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (active >= visible.length) setActive(Math.max(0, visible.length - 1));
  }, [active, visible.length]);

  /** Fades the list's edge where more Bots are scrolled out of view. */
  const markOverflow = () => {
    const list = listRef.current;
    if (!list) return;
    const more = list.scrollHeight - list.clientHeight > 1;
    list.style.setProperty("--fade-top", more && list.scrollTop > 1 ? "18px" : "0px");
    list.style.setProperty("--fade-bottom", more && list.scrollTop < list.scrollHeight - list.clientHeight - 1 ? "18px" : "0px");
  };

  // Opens above the chip, or below it when the card sits near the top of the screen, with
  // the list no taller than the room there. Before paint, and before the card measures the
  // menu's frosted backdrop.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const list = listRef.current;
    const chip = chipRef.current;
    if (!open || !menu || !list || !chip) return;
    const box = chip.getBoundingClientRect();
    const chrome = menu.offsetHeight - list.offsetHeight;
    const natural = Math.min(LIST_MAX, list.scrollHeight);
    const above = box.top - GAP - EDGE - chrome;
    const below = window.innerHeight - box.bottom - GAP - EDGE - chrome;
    const up = above >= natural || above >= below;
    list.style.maxHeight = `${Math.max(120, Math.min(LIST_MAX, up ? above : below))}px`;
    menu.dataset.side = up ? "above" : "below";
    markOverflow();
    // Chosen once per opening: a search narrowing the list mustn't flip the menu mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) markOverflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visible.length]);

  useEffect(() => {
    if (!scrollToActive.current) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (bot: ScreenBotBot | undefined) => {
    if (!bot) return;
    onSelect(bot);
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      scrollToActive.current = true;
      setActive((index) => (index + 1) % Math.max(1, visible.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      scrollToActive.current = true;
      setActive((index) => (index - 1 + visible.length) % Math.max(1, visible.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(visible[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      chipRef.current?.focus();
    } else if (event.key === "Tab") {
      onOpenChange(false);
    }
  };

  return (
    <div className="screenbot-picker">
      <button
        ref={chipRef}
        type="button"
        className="screenbot-chip"
        data-open={open || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Send to ${selected.name}. Change Bot`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <ScreenBotBotAvatar bot={selected} size={18} />
        <span className="screenbot-chip-name">{selected.name}</span>
        <ChevronsUpDown aria-hidden="true" size={12} strokeWidth={2.2} />
      </button>
      {open && (
        <div ref={menuRef} className="screenbot-menu" data-hit="" data-side="above" onKeyDown={onKeyDown}>
          <div className="screenbot-menu-glass" data-glass="" aria-hidden="true" />
          {searchable && (
            <input
              ref={searchRef}
              className="screenbot-menu-search"
              placeholder="Search Bots"
              value={query}
              spellCheck={false}
              onChange={(event) => {
                // A new search starts from its first match, with the list back at the top.
                setQuery(event.target.value);
                scrollToActive.current = true;
                setActive(0);
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
            />
          )}
          <div
            ref={listRef}
            className="screenbot-menu-list"
            role="listbox"
            tabIndex={-1}
            aria-label="Send to"
            aria-activedescendant={visible[active] ? `screenbot-bot-${visible[active].id}` : undefined}
            onScroll={markOverflow}
          >
            {!searchable && <div className="screenbot-menu-heading">Send to</div>}
            {visible.map((bot, index) => {
              const shortcut = bots.indexOf(bot);
              return (
                <div
                  key={bot.id}
                  id={`screenbot-bot-${bot.id}`}
                  role="option"
                  aria-selected={bot.id === selected.id}
                  className="screenbot-menu-item"
                  data-active={index === active || undefined}
                  data-index={index}
                  onPointerMove={() => {
                    if (index === active) return;
                    scrollToActive.current = false;
                    setActive(index);
                  }}
                  onClick={() => choose(bot)}
                >
                  <span className="screenbot-menu-check" aria-hidden="true">
                    {bot.id === selected.id && <Check size={12} strokeWidth={2.6} />}
                  </span>
                  <ScreenBotBotAvatar bot={bot} size={20} />
                  <span className="screenbot-menu-text">
                    <span className="screenbot-menu-name">{bot.name}</span>
                    {bot.title && <span className="screenbot-menu-title">{bot.title}</span>}
                  </span>
                  {shortcut < 9 && <kbd className="screenbot-menu-key">⌘{shortcut + 1}</kbd>}
                </div>
              );
            })}
            {visible.length === 0 && <div className="screenbot-menu-empty">No Bots match</div>}
          </div>
        </div>
      )}
    </div>
  );
}
