import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BotAvatarGlyph } from "../components/openteam/avatar-picker-icons";
import type { AppshotBot } from "./types";

export function AppshotBotAvatar({ bot, size }: { bot: AppshotBot; size: number }) {
  if (bot.avatarDataUrl) {
    return <img alt="" className="appshot-avatar-image" src={bot.avatarDataUrl} style={{ width: size, height: size }} />;
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

/** The one choice an appshot offers: which Bot it goes to. */
export function BotPicker({
  bots,
  selected,
  open,
  onOpenChange,
  onSelect,
}: {
  bots: AppshotBot[];
  selected: AppshotBot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (bot: AppshotBot) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const searchable = bots.length >= SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? bots.filter((bot) => `${bot.name} ${bot.title}`.toLowerCase().includes(needle))
      : bots;
  }, [bots, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, bots.findIndex((bot) => bot.id === selected.id)));
    requestAnimationFrame(() => (searchable ? searchRef.current : listRef.current)?.focus());
    // Open with the current choice highlighted; later renders keep the pointer's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (active >= visible.length) setActive(Math.max(0, visible.length - 1));
  }, [active, visible.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (bot: AppshotBot | undefined) => {
    if (!bot) return;
    onSelect(bot);
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % Math.max(1, visible.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
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
    <div className="appshot-picker">
      <button
        ref={chipRef}
        type="button"
        className="appshot-chip"
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
        <AppshotBotAvatar bot={selected} size={18} />
        <span className="appshot-chip-name">{selected.name}</span>
        <ChevronsUpDown aria-hidden="true" size={12} strokeWidth={2.2} />
      </button>
      {open && (
        <div className="appshot-menu" data-hit="" onKeyDown={onKeyDown}>
          <div className="appshot-menu-glass" data-glass="" aria-hidden="true" />
          {searchable && (
            <input
              ref={searchRef}
              className="appshot-menu-search"
              placeholder="Search Bots"
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div
            ref={listRef}
            className="appshot-menu-list"
            role="listbox"
            tabIndex={-1}
            aria-label="Send to"
            aria-activedescendant={visible[active] ? `appshot-bot-${visible[active].id}` : undefined}
          >
            {!searchable && <div className="appshot-menu-heading">Send to</div>}
            {visible.map((bot, index) => {
              const shortcut = bots.indexOf(bot);
              return (
                <div
                  key={bot.id}
                  id={`appshot-bot-${bot.id}`}
                  role="option"
                  aria-selected={bot.id === selected.id}
                  className="appshot-menu-item"
                  data-active={index === active || undefined}
                  data-index={index}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(bot)}
                >
                  <span className="appshot-menu-check" aria-hidden="true">
                    {bot.id === selected.id && <Check size={12} strokeWidth={2.6} />}
                  </span>
                  <AppshotBotAvatar bot={bot} size={20} />
                  <span className="appshot-menu-text">
                    <span className="appshot-menu-name">{bot.name}</span>
                    {bot.title && <span className="appshot-menu-title">{bot.title}</span>}
                  </span>
                  {shortcut < 9 && <kbd className="appshot-menu-key">⌘{shortcut + 1}</kbd>}
                </div>
              );
            })}
            {visible.length === 0 && <div className="appshot-menu-empty">No Bots match</div>}
          </div>
        </div>
      )}
    </div>
  );
}
