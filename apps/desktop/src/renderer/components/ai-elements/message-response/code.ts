import { highlightAsync, getHighlightEngineStats, clearHighlightEngine } from "./code-worker-client";
import {
  type ThemeRegistrationAny,
  type TokensResult,
} from "shiki/core";
// Metadata only: importing Shiki's registry here also bundles grammar loaders.
import bundledLanguagesInfo from "./code-languages.json";
import type { CodeHighlighterPlugin, ThemeInput as StreamdownThemeInput } from "streamdown";
import { botShikiTheme } from "./code-theme";

const TOKEN_CACHE_ENTRY_LIMIT = 192;
const TOKEN_CACHE_COST_LIMIT = 8 * 1024 * 1024;
const HIGHLIGHTER_CACHE_ENTRY_LIMIT = 24;
const PENDING_HIGHLIGHT_LIMIT = 128;
const PENDING_HIGHLIGHT_CHARACTER_LIMIT = 4 * 1024 * 1024;
const HIGHLIGHT_SOURCE_CHARACTER_LIMIT = 256 * 1024;
const CALLBACKS_PER_HIGHLIGHT_LIMIT = 128;

const languageAliases = Object.fromEntries(
  bundledLanguagesInfo.flatMap((language) =>
    (language.aliases ?? []).map((alias) => [alias, language.id])
  )
) as Record<string, string>;
const supportedLanguages = new Set(bundledLanguagesInfo.map((language) => language.id));

const normalizeLanguage = (language: string) => {
  const normalized = language.trim().toLowerCase();
  return languageAliases[normalized] ?? normalized;
};

const themeRegistrations = {
  "github-dark": { colors: { "editor.background": "#24292e", "editor.foreground": "#e1e4e8" } },
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
  getThemes: () => botShikiTheme,
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
  ...getHighlightEngineStats(),
  pendingCharacters: pendingHighlightCharacters,
  pendingHighlights: pendingHighlights.size,
  tokenCost: tokenCacheCost,
  tokenEntries: tokenCache.size,
});

export const clearCodeHighlighterCaches = () => {
  tokenCache.clear();
  tokenCacheCost = 0;
  clearHighlightEngine();
};

if (import.meta.hot) {
  import.meta.hot.dispose(clearCodeHighlighterCaches);
}
