"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowDown, ArrowUp, ArrowUpRight, CornerDownLeft, FileText, Hash, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DocsSearch, SearchResult } from "@/lib/docs-search";

let cachedSearch: DocsSearch | undefined;
let searchPromise: Promise<DocsSearch> | undefined;
function loadSearch() {
  return searchPromise ??= Promise.all([
    import("@/lib/docs-search"),
    import("@/.generated/docs-search.json"),
  ]).then(([{ createDocsSearch }, { default: index }]) => {
    cachedSearch = createDocsSearch(index);
    return cachedSearch;
  }).catch((error) => {
    searchPromise = undefined;
    throw error;
  });
}

function Highlight({ text, matches }: { text: string; matches: string[] }) {
  if (!matches.length) return text;
  // Search terms are alphanumeric; keep original text and let React escape it.
  const pattern = new RegExp(`(${matches.slice().sort((a, b) => b.length - a.length).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part);
}

export function DocsSearchButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [engine, setEngine] = useState<DocsSearch | undefined>(() => cachedSearch);
  const [failed, setFailed] = useState(false);
  const [mac, setMac] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const navigating = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const results = useMemo(() => engine?.(query) ?? [], [engine, query]);

  const warmSearch = useCallback(() => {
    setFailed(false);
    void loadSearch().then((search) => setEngine(() => search)).catch(() => setFailed(true));
  }, []);

  const changeOpen = useCallback((next: boolean) => {
    if (next) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      navigating.current = false;
      setQuery("");
      setActive(0);
      warmSearch();
    }
    setOpen(next);
  }, [warmSearch]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.altKey && !event.isComposing) {
        // Do not interrupt the mobile navigation drawer or another modal.
        if (!open && document.querySelector('[role="dialog"][data-open]')) return;
        event.preventDefault();
        if (!event.repeat) changeOpen(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, changeOpen]);

  useEffect(() => {
    // The small, separate index chunk warms after the page becomes idle or on intent.
    const prepare = () => {
      setMac(/Mac|iPhone|iPad/.test(navigator.platform));
      warmSearch();
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(prepare, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(prepare, 500);
    return () => clearTimeout(timer);
  }, [warmSearch]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, results, open]);

  const select = (result: SearchResult) => {
    navigating.current = true;
    setOpen(false);
    router.push(result.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results[active]) select(results[active]);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger
        id="docs-search-trigger"
        className="docs-search-trigger"
        aria-label="Search documentation"
        aria-keyshortcuts="Meta+K Control+K"
        onPointerEnter={warmSearch}
        onFocus={warmSearch}
      >
        <Search size={18} aria-hidden="true" />
        <span>Search docs…</span>
        <span className="docs-search-shortcut" aria-hidden="true"><kbd>{mac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd></span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="docs-search-backdrop" />
        <Dialog.Popup
          id="docs-search-dialog"
          className="docs-search-dialog"
          initialFocus={input}
          finalFocus={() => navigating.current ? false : previousFocus.current ?? true}
          aria-describedby={undefined}
        >
          <Dialog.Title id="docs-search-title" className="docs-search-sr">Search documentation</Dialog.Title>
          <div className="docs-search-input-row">
            <Search size={21} aria-hidden="true" />
            <input
              ref={input}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              id="docs-search-input"
              role="combobox"
              aria-label="Search documentation"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="docs-search-results"
              aria-activedescendant={results[active] ? `docs-search-result-${active}` : undefined}
              placeholder="Search the documentation…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              enterKeyHint="go"
              type="text"
            />
            <Dialog.Close className="docs-search-close" aria-label="Close search"><span>Esc</span><X size={18} aria-hidden="true" /></Dialog.Close>
          </div>
          <div className="docs-search-body">
            <div className="docs-search-results-label" aria-hidden="true">{query.trim() ? "Search results" : "Jump to"}</div>
            <p className="docs-search-sr" role="status" aria-live="polite" aria-atomic="true">
              {failed ? "Search could not load." : !engine ? "Loading search." : query.trim() ? `${results.length}${results.length === 8 ? " top" : ""} results for ${query}` : "Suggested pages. Use arrow keys to navigate and Enter to open."}
            </p>
            <ul id="docs-search-results" ref={list} role="listbox" data-suggestions={!query.trim() || undefined} aria-label={query.trim() ? "Search results" : "Suggested pages"} aria-busy={!engine && !failed}>
              {results.map((result, i) => {
                const section = result.href.includes("#");
                const Icon = section ? Hash : FileText;
                return (
                  <li
                    key={result.href}
                    id={`docs-search-result-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onPointerMove={() => setActive(i)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(result)}
                    className="docs-search-result"
                  >
                    <span className="docs-search-result-icon"><Icon size={18} aria-hidden="true" /></span>
                    <span className="docs-search-result-copy">
                      <span className="docs-search-result-path">{result.group}{section && <> <span>/</span> {result.pageTitle}</>}</span>
                      <span className="docs-search-result-title"><Highlight text={result.title} matches={result.matches} /></span>
                      {query.trim() && result.snippet && <span className="docs-search-result-snippet"><Highlight text={result.snippet} matches={result.matches} /></span>}
                    </span>
                    <CornerDownLeft className="docs-search-result-enter" size={16} aria-hidden="true" />
                  </li>
                );
              })}
            </ul>
            {!engine && !failed && <div className="docs-search-empty"><span className="docs-search-loading" />Loading documentation…</div>}
            {failed && <div className="docs-search-empty"><strong>Search couldn’t load</strong><span>Check your connection and try again.</span><button type="button" onClick={warmSearch}>Try again <ArrowUpRight size={14} /></button></div>}
            {engine && results.length === 0 && <div className="docs-search-empty"><Search size={25} aria-hidden="true" /><strong>No results for “{query}”</strong><span>Try a topic like “installation”, “plugins”, or “remote access”.</span></div>}
          </div>
          <footer className="docs-search-footer">
            <span><kbd><ArrowUp size={12} /><ArrowDown size={12} /></kbd> navigate <kbd><CornerDownLeft size={12} /></kbd> open</span>
            <span>OpenTeam docs</span>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
