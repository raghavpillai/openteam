import type { InferenceModelView } from "@openteam/contracts/inference";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../../ui/popover";
import "./model-picker.css";

// Model makers as OpenRouter names them in model ids ("anthropic/claude-…").
const MAKERS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  cohere: "Cohere",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  amazon: "Amazon",
  moonshotai: "Moonshot",
  "z-ai": "Z.ai",
  minimax: "MiniMax",
  perplexity: "Perplexity",
  nousresearch: "Nous",
  openrouter: "OpenRouter",
};

type Option = { modelId: string; name: string; maker: string; recommended: boolean };

/** A model's display name and maker: "Anthropic: Claude Sonnet" becomes the two parts. */
export function modelOption(model: InferenceModelView, providerName: string): Option {
  const prefix = model.modelId.includes("/") ? (model.modelId.split("/")[0] ?? "") : "";
  const named = model.name.match(/^([^:]{2,24}):\s+(.+)$/);
  const maker =
    named?.[1] ?? (prefix ? (MAKERS[prefix] ?? prefix[0]?.toUpperCase() + prefix.slice(1)) : "");
  return {
    modelId: model.modelId,
    name: named?.[2] ?? model.name,
    maker: maker || providerName,
    recommended: Boolean(model.recommended),
  };
}

/** Every word of the query appears in the model's name, maker or id. */
export const matchesQuery = (option: Option, query: string) => {
  const haystack = `${option.name} ${option.maker} ${option.modelId}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

/**
 * The model the catalog recommends: the one it marks, or else its first. The server lists
 * each provider's models in the provider's own order with its recommendation first.
 */
export const recommendedModelId = (options: readonly Option[]): string | undefined =>
  (options.find((option) => option.recommended) ?? options[0])?.modelId;

// Longer lists open with a filter field at the top.
export const FILTER_AT = 10;
// Enough to scroll through; more than this asks for a narrower filter.
const SHOWN = 60;

/**
 * The model select: a field showing the chosen model that opens a list of the provider's
 * models, in the order the server's catalog gives them. Long lists (OpenRouter) get a filter
 * field at the top. Arrows move, Enter picks, Esc closes without leaving the screen.
 */
export function ModelPicker({
  models,
  value,
  providerName,
  disabled = false,
  onChange,
  variant = "setup",
}: {
  models: InferenceModelView[];
  value: string;
  providerName: string;
  disabled?: boolean;
  onChange: (modelId: string) => void;
  variant?: "setup" | "settings";
}) {
  const listId = useId();
  const options = useMemo(
    () => models.map((model) => modelOption(model, providerName)),
    [models, providerName]
  );
  const recommended = recommendedModelId(options);
  const selected = options.find((option) => option.modelId === value);
  const filterable = options.length > FILTER_AT;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(
    () => (filterable ? options.filter((option) => matchesQuery(option, query)) : options),
    [filterable, options, query]
  );
  const shown = matches.slice(0, SHOWN);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.modelId === value)
      )
    );
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (option: Option | undefined) => {
    if (!option) return;
    close();
    if (option.modelId !== value) onChange(option.modelId);
  };

  // An open list takes focus: its filter field, or the list itself.
  useLayoutEffect(() => {
    if (open) (filter.current ?? list.current)?.focus({ preventScroll: true });
  }, [open]);

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open || variant === "settings") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, variant]);

  // Keep the highlighted model in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onListKeyDown = (event: KeyboardEvent) => {
    const last = Math.max(shown.length - 1, 0);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => Math.min(Math.max(index + step, 0), last));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter") {
      // Picks the highlighted model instead of submitting the screen.
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Escape") {
      // Closes the list; it doesn't also go back a screen.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close(false);
    }
  };
  const activeId = open && shown[active] ? `${listId}-${active}` : undefined;

  const triggerButton = (
    <button
      aria-controls={open ? listId : undefined}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-label="Model"
      className={variant === "setup" ? "setup-input setup-picker-trigger" : "setup-picker-trigger"}
      disabled={disabled}
      onClick={() => (open ? close() : openList())}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          openList();
        } else if (event.key === "Enter" && !event.repeat) {
          // Enter keeps meaning the screen's main action; Space or the arrows open the list.
          event.preventDefault();
          if (variant === "settings") open ? close() : openList();
          else event.currentTarget.form?.requestSubmit();
        }
      }}
      ref={trigger}
      role="combobox"
      type="button"
    >
      <span className="setup-picker-value">{selected?.name ?? (value || "No models available")}</span>
      {selected && selected.modelId === recommended ? <em>Recommended</em> : null}
      {selected && selected.maker !== providerName ? <small>{selected.maker}</small> : null}
      <ChevronDown aria-hidden="true" className="setup-picker-chevron" />
    </button>
  );
  const menu = (
    <>
      {filterable ? (
        <div className="setup-picker-filter">
          <Search aria-hidden="true" className="setup-picker-search" />
          <input
            aria-activedescendant={activeId}
            aria-controls={listId}
            aria-label="Filter models"
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder={`Filter ${options.length} models`}
            ref={filter}
            spellCheck={false}
            value={query}
          />
        </div>
      ) : null}
      <div
        aria-activedescendant={filterable ? undefined : activeId}
        aria-label={`${providerName} models`}
        className="setup-picker-list"
        id={listId}
        ref={list}
        role="listbox"
        tabIndex={filterable ? -1 : 0}
      >
        {shown.map((option, index) => (
          <div
            aria-selected={option.modelId === value}
            data-active={index === active || undefined}
            data-index={index}
            id={`${listId}-${index}`}
            key={option.modelId}
            // Focus stays in the filter field or the list, so a press only picks.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(option);
            }}
            onMouseEnter={() => setActive(index)}
            role="option"
            tabIndex={-1}
          >
            <span className="setup-picker-check">
              {option.modelId === value ? (
                <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
              ) : null}
            </span>
            <span className="setup-picker-name">{option.name}</span>
            {option.modelId === recommended ? <em>Recommended</em> : null}
            {option.maker !== providerName ? <small>{option.maker}</small> : null}
          </div>
        ))}
        {matches.length > shown.length ? (
          <div className="setup-picker-note">
            {matches.length - shown.length} more — keep typing to narrow it down
          </div>
        ) : null}
        {matches.length === 0 ? (
          <div className="setup-picker-note">No models match “{query}”</div>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      className={variant === "settings" ? "setup-picker setup-picker-settings" : "setup-picker"}
      data-open={open || undefined}
      ref={root}
    >
      {variant === "settings" ? (
        <Popover open={open} onOpenChange={(next) => (next ? openList() : close(false))}>
          <PopoverAnchor asChild>{triggerButton}</PopoverAnchor>
          {open ? (
            <PopoverContent
              align="end"
              aria-label="Choose a model"
              className="setup-picker-pop setup-picker-settings setup-picker-settings-pop"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                (filter.current ?? list.current)?.focus({ preventScroll: true });
              }}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
              onKeyDown={onListKeyDown}
              sideOffset={6}
            >
              {menu}
            </PopoverContent>
          ) : null}
        </Popover>
      ) : (
        <>
          {triggerButton}
          {open ? (
            <div className="setup-picker-pop" onKeyDown={onListKeyDown}>
              {menu}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
