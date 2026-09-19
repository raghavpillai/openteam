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

export const FETCH_PROVIDERS = {
  builtin: "Built-in HTTP fetch (no key)",
  exa: "Exa Contents",
  tavily: "Tavily Extract",
} as const;
export type FetchProvider = keyof typeof FETCH_PROVIDERS;
export function isFetchProvider(value: unknown): value is FetchProvider {
  return typeof value === "string" && Object.hasOwn(FETCH_PROVIDERS, value);
}
export interface WebFetchSettingsView {
  provider: FetchProvider | null;
  hasApiKey: boolean;
  configured: boolean;
}
export interface WebFetchSettingsInput {
  provider: FetchProvider | null;
  apiKey?: string | null;
}
