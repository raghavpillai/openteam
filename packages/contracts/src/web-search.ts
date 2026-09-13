export const SEARCH_PROVIDERS = {
  exa: "Exa",
  tavily: "Tavily",
  brave: "Brave Search",
  "bing-serpapi": "Bing via SerpApi",
} as const;

export type SearchProvider = keyof typeof SEARCH_PROVIDERS;

export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === "string" && Object.hasOwn(SEARCH_PROVIDERS, value);
}

export interface WebSearchSettingsView {
  provider: SearchProvider | null;
  hasApiKey: boolean;
  configured: boolean;
}

export interface WebSearchSettingsInput {
  provider: SearchProvider | null;
  /** Omit to retain a key for the same provider; null removes it. */
  apiKey?: string | null;
}
