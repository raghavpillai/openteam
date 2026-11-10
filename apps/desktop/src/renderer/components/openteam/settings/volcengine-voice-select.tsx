import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { VOLCENGINE_VOICE_GROUPS, VOLCENGINE_VOICES } from "../../../lib/volcengine-voices";
import { cn } from "../../../lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { settingsInput, settingsSelect } from "./ui";

const AUTOMATIC = "";

interface Option {
  value: string;
  label: string;
  group: string;
  haystack: string;
}

const labelOf = (voice: { name: string; gender: string }) => `${voice.name}${voice.gender ? ` · ${voice.gender}` : ""}`;

/**
 * Searchable voice picker. Radix Select cannot host a search field because its
 * type-ahead consumes keystrokes, so this is a Popover with a listbox.
 */
export function VolcengineVoiceSelect({
  value,
  defaultVoiceId,
  automaticLabel = "Automatic",
  triggerClassName,
  onChange,
  onClose,
}: {
  value: string;
  defaultVoiceId: string;
  /** Wording for the blank option, e.g. "Server default" where the blank value inherits a global setting. */
  automaticLabel?: string;
  /** Replaces the settings-page trigger styling. */
  triggerClassName?: string;
  onChange: (value: string) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const options = useMemo<Option[]>(() => {
    const defaultName = VOLCENGINE_VOICES.find((voice) => voice.id === defaultVoiceId)?.name;
    const result: Option[] = [
      {
        value: AUTOMATIC,
        label: `${automaticLabel}${defaultName ? ` (${defaultName})` : ""}`,
        group: "",
        haystack: "automatic default",
      },
    ];
    // A voice saved by hand that is not in the catalog stays selectable instead of silently resetting.
    if (value && !VOLCENGINE_VOICES.some((voice) => voice.id === value)) {
      result.push({ value, label: value, group: "Current", haystack: value.toLowerCase() });
    }
    for (const voice of VOLCENGINE_VOICES) {
      result.push({
        value: voice.id,
        label: labelOf(voice),
        group: voice.group,
        haystack: `${voice.name} ${voice.id} ${voice.group} ${voice.gender}`.toLowerCase(),
      });
    }
    return result;
  }, [automaticLabel, defaultVoiceId, value]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length === 0 ? options : options.filter((option) => terms.every((term) => option.haystack.includes(term)));
  }, [options, query]);

  const groups = useMemo(() => {
    const names = ["", "Current", ...VOLCENGINE_VOICE_GROUPS];
    return names
      .map((name) => ({ name, items: filtered.filter((option) => option.group === name) }))
      .filter((group) => group.items.length > 0);
  }, [filtered]);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, filtered]);

  const choose = (option: Option) => {
    onChange(option.value);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[active];
      if (option) choose(option);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          onClose?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label="TTS voice"
          className={cn(
            "flex items-center justify-between gap-2 text-left outline-none",
            triggerClassName ?? `${settingsSelect} w-[330px] max-w-full border`
          )}
          type="button"
        >
          <span className="truncate">{selected?.label ?? value}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[var(--radix-popover-trigger-width)] min-w-[260px] rounded-[12px] border-border/50 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector("input")?.focus();
        }}
      >
        <div className="relative px-1 pb-1 pt-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-[40%] text-muted-foreground" />
          <input
            aria-label="Search voices"
            className={`${settingsInput} w-full pl-7`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search by name, ID or scene"
            value={query}
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto overscroll-contain" ref={list} role="listbox">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">No matching voices</div>
          ) : (
            groups.map((group) => (
              <div key={group.name || "automatic"} role="group">
                {group.name ? (
                  <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">{group.name}</div>
                ) : null}
                {group.items.map((option) => {
                  const index = filtered.indexOf(option);
                  return (
                    <div
                      aria-selected={option.value === value}
                      className={cn(
                        "relative flex w-full cursor-default select-none items-center rounded-[6px] py-1.5 pl-2 pr-8 text-[13px] leading-5",
                        index === active && "bg-accent text-accent-foreground"
                      )}
                      data-active={index === active}
                      key={option.value || "automatic"}
                      onClick={() => choose(option)}
                      onMouseMove={() => setActive(index)}
                      role="option"
                    >
                      <span className="truncate">{option.label}</span>
                      {option.value === value ? <Check className="absolute right-2 size-4" /> : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
