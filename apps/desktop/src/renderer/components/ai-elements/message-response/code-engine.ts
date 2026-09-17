import githubDark from "@shikijs/themes/github-dark";
import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeRegistrationAny } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import type { ThemeInput as StreamdownThemeInput } from "streamdown";
const HIGHLIGHTER_CACHE_ENTRY_LIMIT = 24;
const HIGHLIGHTER_CREATION_CONCURRENCY = 3;
const themeRegistrations = {
  "github-dark": githubDark,
} as const;

const themeName = (theme: StreamdownThemeInput) => typeof theme === "string" ? theme : (theme.name ?? "custom");
// Worker messages clone registrations, so object identity is not a cache key.
const themeKey = (theme: StreamdownThemeInput) => typeof theme === "string" ? theme : JSON.stringify(theme);

const resolveTheme = (theme: StreamdownThemeInput): ThemeRegistrationAny => {
  if (typeof theme !== "string") return theme as ThemeRegistrationAny;
  const registration = themeRegistrations[theme as keyof typeof themeRegistrations];
  if (!registration) {
    throw new Error(`Unsupported bundled code theme: ${theme}`);
  }
  return registration;
};

interface HighlighterCacheEntry {
  activeLeases: number;
  disposed: boolean;
  evicted: boolean;
  highlighter?: HighlighterCore;
  promise: Promise<HighlighterCore>;
}

const highlighterCache = new Map<string, HighlighterCacheEntry>();
const creationQueue: Array<() => void> = [];
let activeCreations = 0;

const pumpCreationQueue = () => {
  while (activeCreations < HIGHLIGHTER_CREATION_CONCURRENCY && creationQueue.length > 0) {
    creationQueue.shift()?.();
  }
};

const scheduleCreation = <Result>(work: () => Promise<Result>) =>
  new Promise<Result>((resolve, reject) => {
    creationQueue.push(() => {
      activeCreations += 1;
      work()
        .then(resolve, reject)
        .finally(() => {
          activeCreations -= 1;
          pumpCreationQueue();
        });
    });
    pumpCreationQueue();
  });

const disposeEntry = (entry: HighlighterCacheEntry) => {
  if (entry.disposed || !entry.highlighter || entry.activeLeases > 0) return;
  entry.disposed = true;
  entry.highlighter.dispose();
};

const trimHighlighterCache = () => {
  while (highlighterCache.size > HIGHLIGHTER_CACHE_ENTRY_LIMIT) {
    const oldestKey = highlighterCache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = highlighterCache.get(oldestKey);
    highlighterCache.delete(oldestKey);
    if (entry) {
      entry.evicted = true;
      disposeEntry(entry);
    }
  }
};

const acquireHighlighter = (
  language: string,
  themes: [StreamdownThemeInput, StreamdownThemeInput]
) => {
  const key = `${language}:${themeKey(themes[0])}:${themeKey(themes[1])}`;
  let entry = highlighterCache.get(key);
  if (entry) {
    highlighterCache.delete(key);
    highlighterCache.set(key, entry);
  } else {
    const languageLoader = bundledLanguages[language as keyof typeof bundledLanguages] as
      | LanguageInput
      | undefined;
    if (!languageLoader) throw new Error(`Unsupported bundled code language: ${language}`);

    let nextEntry: HighlighterCacheEntry;
    const promise = scheduleCreation(async () => {
      const highlighter = await createHighlighterCore({
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        langs: [languageLoader],
        themes: [resolveTheme(themes[0]), resolveTheme(themes[1])],
      });
      nextEntry.highlighter = highlighter;
      return highlighter;
    });
    nextEntry = {
      activeLeases: 0,
      disposed: false,
      evicted: false,
      promise,
    };
    entry = nextEntry;
    highlighterCache.set(key, entry);
    trimHighlighterCache();
    void promise.catch(() => {
      if (highlighterCache.get(key) === nextEntry) highlighterCache.delete(key);
      nextEntry.evicted = true;
      disposeEntry(nextEntry);
    });
  }

  entry.activeLeases += 1;
  return {
    promise: entry.promise,
    release: () => {
      if (!entry) return;
      entry.activeLeases = Math.max(0, entry.activeLeases - 1);
      if (entry.evicted) disposeEntry(entry);
    },
  };
};

export const highlightAsync = async (
  source: string,
  language: string,
  themes: [StreamdownThemeInput, StreamdownThemeInput]
) => {
  const lease = acquireHighlighter(language, themes);
  try {
    const highlighter = await lease.promise;
    return highlighter.codeToTokens(source, {
      lang: language,
      themes: {
        dark: themeName(themes[1]),
        light: themeName(themes[0]),
      },
    });
  } finally {
    lease.release();
  }
};


export const getEngineStats = () => ({ activeCreations, creationQueue: creationQueue.length, highlighterEntries: highlighterCache.size });
export const clearEngine = () => {
  for (const entry of highlighterCache.values()) { entry.evicted = true; disposeEntry(entry); }
  highlighterCache.clear();
};
