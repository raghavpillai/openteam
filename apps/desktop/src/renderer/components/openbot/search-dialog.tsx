import type { BotView, ChannelView, SearchCategory, SearchResultView } from "@openbot/contracts";
import {
  createSearchRequestGate,
  normalizeSearchQuery,
  readSearchCache,
  searchCacheKey,
  searchResultKindLabel,
  writeSearchCache,
} from "@openbot/product-core/search";
import {
  Bot,
  Check,
  Clock3,
  CloudDownload,
  EyeOff,
  FileText,
  Hash,
  Link,
  ListRestart,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  Puzzle,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sun,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../client/openbot-api";
import { cn } from "../../lib/cn";
import {
  isDefaultSearchResultKind,
  moveSearchSection,
  moveSearchSelection,
  paletteHighlightSegments,
  rankPaletteItems,
  SEARCH_SECTIONS,
  type SearchSection,
  searchSectionDirectionForKey,
  searchTimeLabel,
} from "../../lib/search";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { BotAvatar, ChannelAvatar } from "./avatar";

const SEARCH_DEBOUNCE_MS = 50;
const CACHE_TTL_MS = 15_000;
const CACHE_LIMIT = 40;
const DEFAULT_SEARCH_KEY = searchCacheKey("", "all", "");

type CachedResults = { createdAt: number; results: SearchResultView[] };
const resultCache = new Map<string, CachedResults>();

export interface SearchAction {
  id: string;
  title: string;
  subtitle: string;
  keywords?: readonly string[];
  icon:
    | "bot"
    | "channel"
    | "settings"
    | "computer"
    | "details"
    | "hidden"
    | "plugins"
    | "theme"
    | "theme-system"
    | "theme-light"
    | "theme-dark"
    | "updates"
    | "refresh";
  current?: boolean;
  run: () => void;
}

type DisplayResult =
  | { type: "document"; value: SearchResultView }
  | { type: "action"; value: SearchAction };

const resultTypeLabel = (result: DisplayResult) => {
  if (result.type === "action") return "Action";
  if (result.value.kind === "channel") return "Group";
  return searchResultKindLabel(result.value.kind);
};

const cacheKey = (query: string, category: SearchCategory) =>
  searchCacheKey("", category, normalizeSearchQuery(query));
const freshCachedResults = (key: string) => {
  const cached = readSearchCache(resultCache, key);
  return cached && Date.now() - cached.createdAt < CACHE_TTL_MS ? cached.results : undefined;
};
const setCachedResults = (key: string, results: SearchResultView[]) => {
  writeSearchCache(resultCache, key, { createdAt: Date.now(), results }, CACHE_LIMIT);
};

function ResultIcon({
  result,
  botById,
  channelById,
}: {
  result: SearchResultView;
  botById: ReadonlyMap<string, BotView>;
  channelById: ReadonlyMap<string, ChannelView>;
}) {
  if (result.kind === "bot") {
    return <BotAvatar bot={result.botId ? botById.get(result.botId) : undefined} size="sm" />;
  }
  if (result.kind === "channel" && result.channelId) {
    const channel = channelById.get(result.channelId);
    if (channel) return <ChannelAvatar botById={botById} channel={channel} size="sm" />;
  }
  if (result.kind === "message" && result.botId) {
    return <BotAvatar bot={botById.get(result.botId)} size="sm" />;
  }
  const Icon =
    result.kind === "message"
      ? UserRound
      : result.kind === "file"
        ? FileText
        : result.kind === "link"
          ? Link
          : result.kind === "routine"
            ? Clock3
            : Hash;
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-subtle text-foreground-secondary">
      <Icon className="size-3.5" />
    </span>
  );
}

function ActionIcon({ action }: { action: SearchAction }) {
  const Icon =
    action.icon === "bot"
      ? Bot
      : action.icon === "channel"
        ? Hash
        : action.icon === "computer"
          ? Monitor
          : action.icon === "theme-system"
            ? Monitor
            : action.icon === "theme-light"
              ? Sun
              : action.icon === "theme-dark"
                ? Moon
                : action.icon === "plugins"
                  ? Puzzle
                  : action.icon === "theme"
                    ? Palette
                    : action.icon === "updates"
                      ? CloudDownload
                      : action.icon === "refresh"
                        ? RefreshCw
                        : action.icon === "hidden"
                          ? EyeOff
                          : action.icon === "details"
                            ? ListRestart
                            : Settings2;
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-subtle text-foreground-secondary">
      <Icon className="size-3.5" />
    </span>
  );
}

export function SearchDialog({
  open,
  actions,
  botById,
  channelById,
  onOpenChange,
  onSelectResult,
}: {
  open: boolean;
  actions: SearchAction[];
  botById: ReadonlyMap<string, BotView>;
  channelById: ReadonlyMap<string, ChannelView>;
  onOpenChange: (open: boolean) => void;
  onSelectResult: (result: SearchResultView) => void;
}) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<SearchSection>("all");
  const [documents, setDocuments] = useState<SearchResultView[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandHeld, setCommandHeld] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [requestGate] = useState(createSearchRequestGate);

  useEffect(() => {
    if (!open) return;
    if (freshCachedResults(DEFAULT_SEARCH_KEY)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (freshCachedResults(DEFAULT_SEARCH_KEY)) return;
      void api
        .search("", "all", controller.signal)
        .then((response) => setCachedResults(DEFAULT_SEARCH_KEY, response.results))
        .catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSection("all");
    setSelectedIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCommandHeld(false);
      return;
    }
    const updateModifier = (event: KeyboardEvent) => setCommandHeld(event.metaKey || event.ctrlKey);
    const releaseModifier = () => setCommandHeld(false);
    window.addEventListener("keydown", updateModifier);
    window.addEventListener("keyup", updateModifier);
    window.addEventListener("blur", releaseModifier);
    return () => {
      window.removeEventListener("keydown", updateModifier);
      window.removeEventListener("keyup", updateModifier);
      window.removeEventListener("blur", releaseModifier);
    };
  }, [open]);

  useEffect(() => {
    requestGate.invalidate();
    if (!open || section === "actions") {
      setLoading(false);
      setError(null);
      return;
    }
    const category = section as SearchCategory;
    const normalizedQuery = normalizeSearchQuery(query);
    const key = cacheKey(normalizedQuery, category);
    const cached = freshCachedResults(key);
    if (cached) {
      setDocuments(cached);
      setLoading(false);
      setError(null);
      return;
    }

    const requestToken = requestGate.begin(key);
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setError(null);
        void api
          .search(normalizedQuery, category, controller.signal)
          .then((response) => {
            if (controller.signal.aborted || !requestGate.isCurrent(requestToken)) return;
            setCachedResults(key, response.results);
            setDocuments(response.results);
          })
          .catch((requestError) => {
            if (controller.signal.aborted || !requestGate.isCurrent(requestToken)) return;
            setDocuments([]);
            setError(requestError instanceof Error ? requestError.message : "Search failed");
          })
          .finally(() => {
            if (!controller.signal.aborted && requestGate.isCurrent(requestToken)) {
              setLoading(false);
            }
          });
      },
      normalizedQuery ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestGate.invalidate();
    };
  }, [open, query, requestGate, section]);

  const matchingActions = useMemo(() => rankPaletteItems(actions, query), [actions, query]);
  const hasQuery = query.trim().length > 0;
  const results = useMemo<DisplayResult[]>(() => {
    if (section === "actions") {
      return matchingActions.map((value) => ({ type: "action", value }));
    }
    const documentResults = documents
      .filter((value) => section !== "all" || hasQuery || isDefaultSearchResultKind(value.kind))
      .map((value): DisplayResult => ({ type: "document", value }));
    if (section === "all" && hasQuery) {
      const agentResults = documentResults.filter(
        (result) =>
          result.type === "document" &&
          (result.value.kind === "bot" || result.value.kind === "channel")
      );
      const otherDocumentResults = documentResults.filter(
        (result) =>
          result.type !== "document" ||
          (result.value.kind !== "bot" && result.value.kind !== "channel")
      );
      return [
        ...agentResults,
        ...matchingActions.map((value): DisplayResult => ({ type: "action", value })),
        ...otherDocumentResults,
      ];
    }
    return documentResults;
  }, [documents, hasQuery, matchingActions, section]);

  useEffect(() => setSelectedIndex(results.length > 0 ? 0 : -1), [results]);
  useEffect(() => {
    if (selectedIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-search-result-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const choose = (result: DisplayResult | undefined) => {
    if (!result) return;
    if (result.type === "action") result.value.run();
    else onSelectResult(result.value);
    onOpenChange(false);
  };

  const emptyState = hasQuery
    ? { title: "No results", description: null, icon: null }
    : section === "messages"
      ? {
          title: "Search messages",
          description: "Type to find messages across your chats.",
          icon: Search,
        }
      : section === "routines"
        ? { title: "No routines yet", description: null, icon: Send }
        : section === "links"
          ? { title: "No links in this chat yet", description: null, icon: Send }
          : section === "files"
            ? { title: "No files yet", description: null, icon: FileText }
            : section === "channels"
              ? { title: "No groups yet", description: null, icon: Hash }
              : section === "bots"
                ? { title: "No bots yet", description: null, icon: Bot }
                : { title: "Nothing here yet", description: null, icon: null };
  const EmptyIcon = emptyState.icon;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(456px,calc(100vh-48px))] max-w-[560px] grid-rows-[auto_auto_1fr] gap-0 overflow-hidden rounded-[15px] border-border/80 bg-popover p-0 shadow-[0_24px_80px_rgba(0,0,0,0.28),0_2px_12px_rgba(0,0,0,0.12)]"
        showCloseButton={false}
      >
        <DialogTitle aria-hidden="true" className="sr-only">
          Search
        </DialogTitle>
        <DialogDescription aria-hidden="true" className="sr-only">
          Search messages, bots, groups, files, links, routines, and actions.
        </DialogDescription>
        <div className="relative border-b border-border/70">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-[15px] -translate-y-1/2 text-foreground-tertiary" />
          <input
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-activedescendant={
              selectedIndex >= 0 && results[selectedIndex]
                ? `search-result-${selectedIndex}`
                : undefined
            }
            aria-expanded={results.length > 0}
            aria-label="Search"
            className="h-[54px] w-full bg-transparent pl-10 pr-4 text-[14px] outline-none placeholder:text-foreground-tertiary"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const sectionDirection = searchSectionDirectionForKey({
                key: event.key,
                query: event.currentTarget.value,
                shiftKey: event.shiftKey,
              });
              if (sectionDirection !== null) {
                event.preventDefault();
                setSection((current) => moveSearchSection(current, sectionDirection));
                return;
              }
              if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
                const index = Number(event.key) - 1;
                if (results[index]) {
                  event.preventDefault();
                  choose(results[index]);
                }
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) =>
                  moveSearchSelection(current, results.length, event.key === "ArrowUp" ? -1 : 1)
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(results[selectedIndex]);
              }
            }}
            placeholder="Search"
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </div>

        <div
          aria-label="Filter results"
          className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]"
          role="tablist"
        >
          {SEARCH_SECTIONS.map((candidate) => (
            <button
              aria-selected={section === candidate.id}
              className={cn(
                "shrink-0 rounded-[8px] px-2 py-1 text-[12.5px] text-foreground-secondary outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
                section === candidate.id && "bg-subtle text-foreground"
              )}
              key={candidate.id}
              onClick={() => setSection(candidate.id)}
              onMouseDown={(event) => event.preventDefault()}
              role="tab"
              tabIndex={-1}
              type="button"
            >
              {candidate.label}
            </button>
          ))}
        </div>

        <div
          className="min-h-0 overflow-y-auto p-2"
          id="search-results"
          ref={listRef}
          aria-label="Results"
          role="listbox"
        >
          {results.length > 0 ? (
            results.map((result, index) => {
              const key = result.type === "action" ? `action:${result.value.id}` : result.value.id;
              return (
                <button
                  aria-selected={selectedIndex === index}
                  className={cn(
                    "group flex min-h-[51px] w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left outline-none",
                    selectedIndex === index
                      ? "bg-[#e5e5e5] dark:bg-selected"
                      : "hover:bg-[#f0f0f0] dark:hover:bg-hover"
                  )}
                  data-search-result-index={index}
                  id={`search-result-${index}`}
                  key={key}
                  onClick={() => choose(result)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  role="option"
                  type="button"
                >
                  {result.type === "action" ? (
                    <ActionIcon action={result.value} />
                  ) : (
                    <ResultIcon botById={botById} channelById={channelById} result={result.value} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-[18px]">
                      {paletteHighlightSegments(result.value.title, query).map((segment) =>
                        segment.isMatch ? (
                          <span className="font-semibold" key={segment.start}>
                            {segment.text}
                          </span>
                        ) : (
                          segment.text
                        )
                      )}
                    </span>
                    <span className="block truncate text-[12px] leading-[17px] text-foreground-secondary">
                      {result.value.subtitle}
                      {result.type === "document" && (
                        <span className="text-foreground-tertiary">
                          {result.value.subtitle ? " · " : ""}
                          {searchTimeLabel(result.value.createdAt)}
                        </span>
                      )}
                    </span>
                  </span>
                  {commandHeld && index < 9 ? (
                    <kbd className="h-[19px] min-w-[26px] shrink-0 rounded-[5px] bg-[#f3f3f3] px-[5px] py-0 text-center font-sans text-[10px] font-normal leading-[19px] text-[#626262] dark:bg-subtle dark:text-foreground-tertiary">
                      ⌘{index + 1}
                    </kbd>
                  ) : result.type === "action" && result.value.current ? (
                    <Check
                      aria-label="Current"
                      className="size-3.5 shrink-0 text-foreground-secondary"
                    />
                  ) : section === "all" ? (
                    <span className="shrink-0 text-[12px] font-normal text-foreground-tertiary">
                      {resultTypeLabel(result)}
                    </span>
                  ) : null}
                </button>
              );
            })
          ) : loading ? (
            <div className="grid h-full place-items-center text-foreground-tertiary">
              <LoaderCircle aria-label="Searching" className="size-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="grid h-full place-items-center px-8 text-center">
              <div>
                <p className="text-sm font-medium">Search is unavailable</p>
                <p className="mt-1 text-xs text-destructive">{error}</p>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center px-8 text-center">
              <div>
                {EmptyIcon && <EmptyIcon className="mx-auto size-5 text-foreground-tertiary/60" />}
                <p
                  className={cn(
                    "text-[12px] font-normal text-foreground-secondary",
                    EmptyIcon && "mt-2",
                    emptyState.description && "text-sm font-medium"
                  )}
                >
                  {emptyState.title}
                </p>
                {emptyState.description && (
                  <p className="mt-1 text-xs text-foreground-tertiary">{emptyState.description}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
