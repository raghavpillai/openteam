import githubDark from "@shikijs/themes/github-dark";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeRegistrationAny,
  type TokensResult,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import type { CodeHighlighterPlugin, ThemeInput as StreamdownThemeInput } from "streamdown";
import { grokShikiTheme } from "./config";

const TOKEN_CACHE_ENTRY_LIMIT = 192;
const TOKEN_CACHE_COST_LIMIT = 8 * 1024 * 1024;
const HIGHLIGHTER_CACHE_ENTRY_LIMIT = 24;
const PENDING_HIGHLIGHT_LIMIT = 128;
const PENDING_HIGHLIGHT_CHARACTER_LIMIT = 4 * 1024 * 1024;
const HIGHLIGHT_SOURCE_CHARACTER_LIMIT = 256 * 1024;
const CALLBACKS_PER_HIGHLIGHT_LIMIT = 128;
const HIGHLIGHTER_CREATION_CONCURRENCY = 3;

const languageAliases = Object.fromEntries(
  bundledLanguagesInfo.flatMap((language) =>
    (language.aliases ?? []).map((alias) => [alias, language.id])
  )
) as Record<string, string>;
const supportedLanguages = new Set(Object.keys(bundledLanguages));

const normalizeLanguage = (language: string) => {
  const normalized = language.trim().toLowerCase();
  return languageAliases[normalized] ?? normalized;
};

const themeRegistrations = {
  "github-dark": githubDark,
} as const;

const customThemeIds = new WeakMap<object, number>();
let nextCustomThemeId = 0;

const themeName = (theme: StreamdownThemeInput) =>
  typeof theme === "string" ? theme : (theme.name ?? "custom");

const themeKey = (theme: StreamdownThemeInput) => {
  if (typeof theme === "string") return theme;
  let id = customThemeIds.get(theme);
  if (id === undefined) {
    id = ++nextCustomThemeId;
    customThemeIds.set(theme, id);
  }
  return `${theme.name ?? "custom"}:${id}`;
};

const defaultThemeColor = (theme: StreamdownThemeInput, kind: "background" | "foreground") => {
  const resolved = resolveTheme(theme);
  const key = `editor.${kind}`;
  if (kind === "background" && "bg" in resolved && resolved.bg) return resolved.bg;
  if (kind === "foreground" && "fg" in resolved && resolved.fg) return resolved.fg;
  const color = resolved.colors?.[key];
  if (color) return color;
  const defaults = resolved.settings?.find(
    (setting) => !("scope" in setting) || setting.scope === undefined
  );
  const settingColor = defaults?.settings?.[kind];
  if (settingColor) return settingColor;
  return kind === "background" ? "transparent" : "inherit";
};

const resolveTheme = (theme: StreamdownThemeInput): ThemeRegistrationAny => {
  if (typeof theme !== "string") return theme as ThemeRegistrationAny;
  const registration = themeRegistrations[theme as keyof typeof themeRegistrations];
  if (!registration) {
    throw new Error(`Unsupported bundled code theme: ${theme}`);
  }
  return registration;
};

const createPlainResult = (
  source: string,
  themes: [StreamdownThemeInput, StreamdownThemeInput]
): TokensResult => {
  const lightForeground = defaultThemeColor(themes[0], "foreground");
  const darkForeground = defaultThemeColor(themes[1], "foreground");
  const lightBackground = defaultThemeColor(themes[0], "background");
  const darkBackground = defaultThemeColor(themes[1], "background");
  let offset = 0;
  return {
    bg: `${lightBackground};--shiki-dark-bg:${darkBackground}`,
    fg: `${lightForeground};--shiki-dark:${darkForeground}`,
    tokens: source.split("\n").map((line) => {
      const lineOffset = offset;
      offset += line.length + 1;
      return [
        {
          content: line,
          offset: lineOffset,
          htmlStyle: {
            "--shiki-dark": darkForeground,
            color: lightForeground,
          },
        },
      ];
    }),
  };
};

interface TokenCacheEntry {
  code: string;
  cost: number;
  result: TokensResult;
}

const tokenCache = new Map<string, TokenCacheEntry>();
let tokenCacheCost = 0;

const estimateTokenCost = (codeLength: number, result: TokensResult) => {
  const tokenCount = result.tokens.reduce((total, line) => total + line.length, 0);
  return codeLength * 2 + tokenCount * 96;
};

const getCachedResult = (key: string, source: string) => {
  const entry = tokenCache.get(key);
  if (!entry || entry.code !== source) return null;
  tokenCache.delete(key);
  tokenCache.set(key, entry);
  return entry.result;
};

const cacheResult = (key: string, source: string, result: TokensResult) => {
  const cost = estimateTokenCost(source.length, result);
  if (cost > TOKEN_CACHE_COST_LIMIT) return;

  const existing = tokenCache.get(key);
  if (existing) {
    tokenCacheCost -= existing.cost;
    tokenCache.delete(key);
  }
  tokenCache.set(key, { code: source, cost, result });
  tokenCacheCost += cost;

  while (tokenCache.size > TOKEN_CACHE_ENTRY_LIMIT || tokenCacheCost > TOKEN_CACHE_COST_LIMIT) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = tokenCache.get(oldestKey);
    tokenCache.delete(oldestKey);
    if (oldest) tokenCacheCost -= oldest.cost;
  }
};

const hashSource = (source: string) => {
  let first = 2_166_136_261;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 2_246_822_519) + 3_266_489_917;
  }
  return `${source.length}:${first >>> 0}:${second >>> 0}`;
};

interface PendingHighlight {
  callbacks: Set<(result: TokensResult) => void>;
  characters: number;
  code: string;
}

const pendingHighlights = new Map<string, PendingHighlight>();
let pendingHighlightCharacters = 0;

const cacheKeyFor = (
  source: string,
  language: string,
  themes: [StreamdownThemeInput, StreamdownThemeInput]
) => {
  const base = `${language}:${themeKey(themes[0])}:${themeKey(themes[1])}:${hashSource(source)}`;
  let key = base;
  let collision = 0;
  while (
    (tokenCache.has(key) && tokenCache.get(key)?.code !== source) ||
    (pendingHighlights.has(key) && pendingHighlights.get(key)?.code !== source)
  ) {
    collision += 1;
    key = `${base}:${collision}`;
  }
  return key;
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

const highlightAsync = async (
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

const notifyCallbacks = (callbacks: Set<(result: TokensResult) => void>, result: TokensResult) => {
  for (const callback of callbacks) {
    try {
      callback(result);
    } catch (error) {
      console.error("[OpenTeam Code] Highlight callback failed:", error);
    }
  }
};

export const code: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => Array.from(supportedLanguages),
  getThemes: () => grokShikiTheme,
  supportsLanguage: (language) => supportedLanguages.has(normalizeLanguage(language)),
  highlight({ code: source, language, themes }, callback) {
    const normalizedLanguage = normalizeLanguage(language);
    if (!supportedLanguages.has(normalizedLanguage)) {
      return createPlainResult(source, themes);
    }
    if (source.length > HIGHLIGHT_SOURCE_CHARACTER_LIMIT) {
      return createPlainResult(source, themes);
    }

    const key = cacheKeyFor(source, normalizedLanguage, themes);
    const cached = getCachedResult(key, source);
    if (cached) return cached;

    const pending = pendingHighlights.get(key);
    if (pending) {
      if (callback && pending.callbacks.size < CALLBACKS_PER_HIGHLIGHT_LIMIT) {
        pending.callbacks.add(callback);
      }
      return null;
    }

    if (
      pendingHighlights.size >= PENDING_HIGHLIGHT_LIMIT ||
      pendingHighlightCharacters + source.length > PENDING_HIGHLIGHT_CHARACTER_LIMIT
    ) {
      return createPlainResult(source, themes);
    }

    const callbacks = new Set<(result: TokensResult) => void>();
    if (callback) callbacks.add(callback);
    pendingHighlights.set(key, { callbacks, characters: source.length, code: source });
    pendingHighlightCharacters += source.length;

    void highlightAsync(source, normalizedLanguage, themes)
      .then((result) => {
        cacheResult(key, source, result);
        notifyCallbacks(callbacks, result);
      })
      .catch((error) => {
        console.error("[OpenTeam Code] Failed to highlight code:", error);
        notifyCallbacks(callbacks, createPlainResult(source, themes));
      })
      .finally(() => {
        const pending = pendingHighlights.get(key);
        if (pending) pendingHighlightCharacters -= pending.characters;
        pendingHighlights.delete(key);
      });
    return null;
  },
};

export const codeHighlighterCacheLimits = {
  callbacksPerHighlight: CALLBACKS_PER_HIGHLIGHT_LIMIT,
  highlighterEntries: HIGHLIGHTER_CACHE_ENTRY_LIMIT,
  highlightSourceCharacters: HIGHLIGHT_SOURCE_CHARACTER_LIMIT,
  pendingCharacters: PENDING_HIGHLIGHT_CHARACTER_LIMIT,
  pendingHighlights: PENDING_HIGHLIGHT_LIMIT,
  tokenCost: TOKEN_CACHE_COST_LIMIT,
  tokenEntries: TOKEN_CACHE_ENTRY_LIMIT,
} as const;

export const getCodeHighlighterCacheStats = () => ({
  activeCreations,
  creationQueue: creationQueue.length,
  highlighterEntries: highlighterCache.size,
  pendingCharacters: pendingHighlightCharacters,
  pendingHighlights: pendingHighlights.size,
  tokenCost: tokenCacheCost,
  tokenEntries: tokenCache.size,
});

export const clearCodeHighlighterCaches = () => {
  tokenCache.clear();
  tokenCacheCost = 0;
  for (const entry of highlighterCache.values()) {
    entry.evicted = true;
    disposeEntry(entry);
  }
  highlighterCache.clear();
};

if (import.meta.hot) {
  import.meta.hot.dispose(clearCodeHighlighterCaches);
}
